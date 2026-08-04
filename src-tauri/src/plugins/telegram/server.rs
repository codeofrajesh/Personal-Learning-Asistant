//! Local HTTP server that streams Telegram media to the players.
//!
//! Binds `127.0.0.1` on an ephemeral port and serves `/tg/<token>/<chat>/<msg>`. This exists
//! because both playback engines already speak HTTP with byte ranges — mpv natively, and
//! `<video>`/PDF.js through the WebView — so a local origin lets a streamed lesson reuse the
//! *entire* existing player, including seeking, without either engine learning what Telegram
//! is. That is the decoupling `telegram.md` §4 is built around.
//!
//! ## Security
//!
//! Any process on the machine can reach a loopback port, so the URL carries a random 256-bit
//! token generated per app run. Without it the endpoint 404s. The token is never persisted:
//! a stale URL from a previous run cannot be replayed.
//!
//! ## Range handling
//!
//! Correct `206` semantics are not optional here. mpv seeks by issuing a fresh ranged GET,
//! and `<video>` refuses to expose a seek bar at all unless the first response advertises
//! `Accept-Ranges`. Getting `Content-Range` off by one byte produces exactly the "video plays
//! but seeking is broken / goes black" class of bug, so the parser is unit-tested against the
//! forms real clients send.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt, Empty, StreamBody};
use hyper::body::{Bytes, Frame};
use hyper::header::{
    ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE,
};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;
use tokio::sync::Mutex;

use crate::plugins::telegram::reader::{new_semaphore, resolve_file, TgReader, CHUNK_SIZE};
use crate::utils::errors::{AppError, AppResult};

/// How much to serve for an open-ended range (`bytes=0-`).
///
/// Deliberately NOT the whole file: a player opening a 2 GB lecture would otherwise wait for
/// the entire download before the first frame.
///
/// 8 MB rather than 1 MB, because the size directly sets how often the player must come back.
/// mpv fills a large read-ahead cache, so a 1 MB slice made it re-request every 1 MB — dozens
/// of HTTP round trips (and, before the `dc_id` fix, dozens of wasted `FILE_MIGRATE`
/// redirects) in the first few seconds of playback. That request amplification is what walks
/// an account into `FLOOD_WAIT`. 8 MB is 16 chunks: still a fast first frame, far fewer trips.
const OPEN_RANGE_SERVE: u64 = CHUNK_SIZE * 16;

/// One reader per `(chat_id, message_id)`, so seeking within a lesson reuses its chunk cache.
type ReaderMap = Arc<Mutex<HashMap<(i64, i32), Arc<TgReader>>>>;

/// Maximum open readers. Each holds up to 32 MB of cached chunks; this bounds memory use.
const MAX_OPEN_READERS: usize = 16;

/// Why a `Range` header could not be satisfied — the caller answers with `416`.
#[derive(Debug, PartialEq, Eq)]
pub struct RangeNotSatisfiable;

/// A parsed `Range: bytes=…` header, resolved against a known file size.
#[derive(Debug, PartialEq, Eq)]
pub struct ByteRange {
    pub start: u64,
    /// Inclusive, per RFC 7233.
    pub end: u64,
}

/// Parse a single-range `Range` header.
///
/// Returns `Ok(None)` when there is no header (serve the whole file), and
/// `Err(RangeNotSatisfiable)` when the range cannot be served (→ `416`). Multi-range requests
/// are deliberately unsupported: no media client sends them, and a wrong multipart body is
/// worse than a correct single-range answer.
pub fn parse_range(
    header: Option<&str>,
    size: u64,
) -> Result<Option<ByteRange>, RangeNotSatisfiable> {
    let Some(raw) = header else {
        return Ok(None);
    };
    let Some(spec) = raw.trim().strip_prefix("bytes=") else {
        // A unit we don't understand — RFC says ignore the header entirely.
        return Ok(None);
    };
    // Only the first range of a set is honored; see above.
    let spec = spec.split(',').next().unwrap_or("").trim();

    let (from, to) = spec.split_once('-').ok_or(RangeNotSatisfiable)?;

    let range = match (from.trim(), to.trim()) {
        // `bytes=-N` — the LAST n bytes. mp4 clients use this to find a trailing moov atom,
        // so getting it wrong breaks playback of exactly the files it exists to help.
        ("", last) => {
            let n: u64 = last.parse().map_err(|_| RangeNotSatisfiable)?;
            if n == 0 || size == 0 {
                return Err(RangeNotSatisfiable);
            }
            let n = n.min(size);
            ByteRange {
                start: size - n,
                end: size - 1,
            }
        }
        // `bytes=N-` — from N to the end. Served in bounded slices (see OPEN_RANGE_SERVE).
        (first, "") => {
            let start: u64 = first.parse().map_err(|_| RangeNotSatisfiable)?;
            if start >= size {
                return Err(RangeNotSatisfiable);
            }
            let end = (start + OPEN_RANGE_SERVE - 1).min(size - 1);
            ByteRange { start, end }
        }
        // `bytes=N-M` — explicit, inclusive on both ends.
        (first, last) => {
            let start: u64 = first.parse().map_err(|_| RangeNotSatisfiable)?;
            let end: u64 = last.parse().map_err(|_| RangeNotSatisfiable)?;
            if start > end || start >= size {
                return Err(RangeNotSatisfiable);
            }
            ByteRange {
                start,
                // Clamp rather than reject: clients routinely ask past EOF, and RFC 7233
                // says to serve what exists.
                end: end.min(size - 1),
            }
        }
    };
    Ok(Some(range))
}

/// The response body type.
///
/// `StreamBody` rather than `Full`, because the difference is felt directly by the player.
/// Buffering the whole slice meant the client received NOTHING until the last byte arrived —
/// on a slow link an 8 MB slice is several seconds of silence, long enough for mpv to consider
/// the connection stalled. Streaming yields each 512 KB chunk the moment it lands, so playback
/// starts on the first chunk and continues while the rest is still in flight.
type StreamedBody = UnsyncBoxBody<Bytes, std::io::Error>;

/// An empty body of the streamed type — for HEAD, 404, 416 and friends.
fn empty_body() -> StreamedBody {
    Empty::<Bytes>::new()
        .map_err(|never| match never {})
        .boxed_unsync()
}

/// Build a body that fetches and yields one chunk at a time.
///
/// Chunk boundaries are the natural unit: `read_range` already assembles from whole 512 KB
/// chunks, so streaming them costs nothing extra and gives the player steady progress.
fn stream_range(reader: Arc<TgReader>, start: u64, len: u64) -> StreamedBody {
    // Step by chunk, but honour the caller's exact start/end so the bytes on the wire match
    // the Content-Range header exactly — an off-by-one here is a corrupt stream.
    let stream = futures_util::stream::unfold(
        (reader, start, len),
        |(reader, offset, remaining)| async move {
            if remaining == 0 {
                return None;
            }
            // One chunk per poll, clipped to what the range still needs.
            let want = remaining.min(CHUNK_SIZE);
            match reader.read_range(offset, want).await {
                Ok(bytes) if bytes.is_empty() => None, // EOF
                Ok(bytes) => {
                    let read = bytes.len() as u64;
                    let frame = Frame::data(Bytes::from(bytes));
                    Some((Ok(frame), (reader, offset + read, remaining - read)))
                }
                Err(e) => {
                    // The client sees a truncated body and can retry the range; the
                    // alternative (hanging) is what the timeout work exists to prevent.
                    log::warn!("telegram: stream aborted at offset {offset}: {e}");
                    Some((
                        Err(std::io::Error::other(e.to_string())),
                        (reader, offset, 0),
                    ))
                }
            }
        },
    );
    StreamBody::new(stream).boxed_unsync()
}

/// Streaming server state, held in Tauri's managed state.
pub struct TgServer {
    /// `None` until the first stream is requested — nothing is bound at app boot.
    inner: Mutex<Option<Running>>,
}

struct Running {
    port: u16,
    token: String,
}

impl Default for TgServer {
    fn default() -> Self {
        Self::new()
    }
}

impl TgServer {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    /// Ensure the server is listening and return its base URL (`http://127.0.0.1:<port>/tg/<token>`).
    ///
    /// Idempotent: repeated calls return the same base for the app's lifetime, so a URL held
    /// by a mounted player never goes stale.
    pub async fn ensure_started(&self, app: tauri::AppHandle) -> AppResult<String> {
        let mut guard = self.inner.lock().await;
        if let Some(running) = guard.as_ref() {
            return Ok(base_url(running.port, &running.token));
        }

        // Port 0 = let the OS choose a free ephemeral port. Binding 127.0.0.1 explicitly
        // (never "localhost", which can resolve to ::1 and mismatch the CSP origin).
        let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
            .await
            .map_err(|e| AppError::Other(format!("could not start the Telegram stream server: {e}")))?;
        let port = listener
            .local_addr()
            .map_err(|e| AppError::Other(format!("stream server address: {e}")))?
            .port();

        let token = random_token();
        // One reader per (chat, message), so seeking within a lesson reuses its chunk cache.
        // Owned solely by the serving task — the URL is the only handle callers need.
        let readers: ReaderMap =
            Arc::new(Mutex::new(HashMap::new()));

        let ctx = Arc::new(ServeCtx {
            app,
            token: token.clone(),
            readers,
            semaphore: new_semaphore(),
        });

        tokio::spawn(async move {
            loop {
                let (stream, _) = match listener.accept().await {
                    Ok(pair) => pair,
                    Err(e) => {
                        log::warn!("telegram: stream server accept failed: {e}");
                        continue;
                    }
                };
                let ctx = ctx.clone();
                // Per-connection task: a slow chunk fetch for one lesson must not stall
                // another connection's headers.
                tokio::spawn(async move {
                    let service =
                        service_fn(move |req| { let ctx = ctx.clone(); async move { handle(ctx, req).await } });
                    if let Err(e) = http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .await
                    {
                        // Clients abort connections constantly while seeking; this is normal.
                        log::debug!("telegram: stream connection closed: {e}");
                    }
                });
            }
        });

        log::info!("telegram: stream server listening on 127.0.0.1:{port}");
        *guard = Some(Running {
            port,
            token: token.clone(),
        });
        Ok(base_url(port, &token))
    }
}

struct ServeCtx {
    app: tauri::AppHandle,
    token: String,
    readers: ReaderMap,
    semaphore: Arc<tokio::sync::Semaphore>,
}

fn base_url(port: u16, token: &str) -> String {
    format!("http://127.0.0.1:{port}/tg/{token}")
}

/// 256 bits from the OS CSPRNG, hex-encoded.
///
/// `getrandom` comes in transitively and is the right source here — a predictable token would
/// let any local process enumerate the endpoint.
fn random_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("OS randomness unavailable");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Route `/tg/<token>/<chat>/<msg>`.
async fn handle(
    ctx: Arc<ServeCtx>,
    req: Request<hyper::body::Incoming>,
) -> Result<Response<StreamedBody>, std::convert::Infallible> {
    Ok(match route(ctx, req).await {
        Ok(response) => response,
        Err(status) => empty(status),
    })
}

async fn route(
    ctx: Arc<ServeCtx>,
    req: Request<hyper::body::Incoming>,
) -> Result<Response<StreamedBody>, StatusCode> {
    // Only reads. A stream endpoint has no reason to accept anything else.
    if !matches!(*req.method(), Method::GET | Method::HEAD) {
        return Err(StatusCode::METHOD_NOT_ALLOWED);
    }

    let path = req.uri().path();
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let (token, chat, msg) = match segments.as_slice() {
        ["tg", token, chat, msg] => (*token, *chat, *msg),
        _ => return Err(StatusCode::NOT_FOUND),
    };

    // Constant-time-ish comparison isn't warranted (a local attacker has better options), but
    // a mismatch must be indistinguishable from a bad path — hence 404, not 403.
    if token != ctx.token {
        return Err(StatusCode::NOT_FOUND);
    }

    let chat_id: i64 = chat.parse().map_err(|_| StatusCode::BAD_REQUEST)?;
    let message_id: i32 = msg.parse().map_err(|_| StatusCode::BAD_REQUEST)?;

    let reader = reader_for(&ctx, chat_id, message_id)
        .await
        .map_err(|e| {
            log::warn!("telegram: could not open stream for {chat_id}/{message_id}: {e}");
            StatusCode::NOT_FOUND
        })?;

    let size = reader.size().await;
    let mime = reader.mime().await;

    let range = match parse_range(
        req.headers().get(RANGE).and_then(|v| v.to_str().ok()),
        size,
    ) {
        Ok(range) => range,
        // Unsatisfiable: RFC 7233 requires the total size in the response so the client can
        // correct itself instead of retrying the same bad range forever.
        Err(RangeNotSatisfiable) => {
            let mut response = empty(StatusCode::RANGE_NOT_SATISFIABLE);
            response
                .headers_mut()
                .insert(CONTENT_RANGE, format!("bytes */{size}").parse().unwrap());
            return Ok(response);
        }
    };

    let is_head = req.method() == Method::HEAD;

    let mut builder = Response::builder()
        .header(CONTENT_TYPE, mime)
        // Advertised on EVERY response, including 200. `<video>` decides whether it can seek
        // from the first reply; omitting it here disables the seek bar for the whole session.
        .header(ACCEPT_RANGES, "bytes");

    let (status, start, end) = match &range {
        Some(r) => {
            builder = builder.header(
                CONTENT_RANGE,
                format!("bytes {}-{}/{}", r.start, r.end, size),
            );
            (StatusCode::PARTIAL_CONTENT, r.start, r.end)
        }
        None => (StatusCode::OK, 0, size.saturating_sub(1)),
    };

    let length = end.saturating_sub(start) + 1;
    builder = builder.header(CONTENT_LENGTH, length);

    // HEAD must carry identical headers with no body — this is how mpv and PDF.js probe for
    // size and range support before committing to a download.
    if is_head {
        return builder
            .status(status)
            .body(empty_body())
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR);
    }

    // For a whole-file GET, still serve a bounded slice: a client that ignores ranges would
    // otherwise pull gigabytes into memory before the first frame.
    let want = if range.is_some() {
        length
    } else {
        length.min(OPEN_RANGE_SERVE)
    };

    // `Content-Length` must match what the body actually delivers, and the body is produced
    // lazily now — so the length is committed here and `stream_range` is bounded to exactly
    // that many bytes. (The previous buffered version could correct the header after a short
    // read at EOF; a stream cannot, so the range was already clamped to the file size by
    // `parse_range` and `read_range` stops at EOF.)
    if want != length {
        builder = builder.header(CONTENT_LENGTH, want);
        if range.is_some() {
            builder = builder.header(
                CONTENT_RANGE,
                format!("bytes {}-{}/{}", start, start + want.saturating_sub(1), size),
            );
        }
    }

    builder
        .status(status)
        .body(stream_range(reader, start, want))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

/// Get or create the reader for a lesson.
///
/// The lock is held across creation on purpose. mpv opens several connections at once, so
/// without it two concurrent requests for the same lesson both miss the cache, both spend a
/// `resolve_file` round trip, and one of the two readers (with its warmed chunk cache and
/// learned `dc_id`) is immediately discarded — doubling the request count at exactly the moment
/// playback starts. Creation is network-bound, but only for the FIRST request of a lesson;
/// every later one takes the fast path above.
async fn reader_for(ctx: &ServeCtx, chat_id: i64, message_id: i32) -> AppResult<Arc<TgReader>> {
    let mut readers = ctx.readers.lock().await;

    if let Some(existing) = readers.get(&(chat_id, message_id)) {
        return Ok(existing.clone());
    }

    let state = {
        use tauri::Manager;
        ctx.app
            .state::<crate::plugins::telegram::session::TgState>()
    };
    let client = state
        .get_client()
        .await
        .ok_or_else(|| AppError::Other("Telegram isn't connected.".into()))?;
    let session = state
        .get_session()
        .await
        .ok_or_else(|| AppError::Other("Telegram session is not initialized.".into()))?;

    let peer_id = grammers_client::session::types::PeerId::channel(chat_id)
        .ok_or_else(|| AppError::Invalid("Invalid channel id.".into()))?;
    let peer = crate::plugins::telegram::import::resolve_peer_ref(
        &client,
        &session,
        peer_id.to_ambient_ref(),
    )
    .await?;

    let file = resolve_file(&client, peer, chat_id, message_id).await?;
    let reader = Arc::new(TgReader::new(
        client,
        peer,
        file,
        ctx.semaphore.clone(),
        session,
    ));

    // Bound the map. Each reader holds up to 32 MB of cached chunks, so an afternoon of
    // browsing lessons would otherwise accumulate hundreds of megabytes on the 4 GB machines
    // this app targets. Evicting an arbitrary entry only costs it its cache; the next request
    // for that lesson rebuilds it. A strict LRU isn't worth a second data structure here —
    // the map only ever holds a handful of entries, and the one being played is the one the
    // player keeps requesting, so it is the least likely to be evicted anyway.
    if readers.len() >= MAX_OPEN_READERS {
        if let Some(&victim) = readers
            .keys()
            .find(|key| **key != (chat_id, message_id))
        {
            readers.remove(&victim);
        }
    }

    readers.insert((chat_id, message_id), reader.clone());
    Ok(reader)
}

fn empty(status: StatusCode) -> Response<StreamedBody> {
    Response::builder()
        .status(status)
        .body(empty_body())
        .expect("static response builds")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIZE: u64 = 10_000;

    #[test]
    fn no_range_header_means_whole_file() {
        assert_eq!(parse_range(None, SIZE), Ok(None));
    }

    #[test]
    fn explicit_range_is_inclusive_on_both_ends() {
        // The classic off-by-one. `bytes=0-99` is 100 bytes, ending AT index 99.
        assert_eq!(
            parse_range(Some("bytes=0-99"), SIZE),
            Ok(Some(ByteRange { start: 0, end: 99 }))
        );
    }

    #[test]
    fn open_ended_range_is_bounded_not_whole_file() {
        // Serving to EOF here would make a 2 GB lecture buffer entirely before playing.
        // The file must be larger than one slice, or this would be testing EOF clamping
        // instead (which `open_ended_range_clamps_at_eof` covers).
        let big = OPEN_RANGE_SERVE * 4;
        let r = parse_range(Some("bytes=0-"), big).unwrap().unwrap();
        assert_eq!(r.start, 0);
        assert_eq!(r.end, OPEN_RANGE_SERVE - 1);
        // Whatever the slice size, it must stay a whole number of chunks so every network
        // read remains Telegram-aligned.
        assert_eq!(OPEN_RANGE_SERVE % CHUNK_SIZE, 0);
    }

    #[test]
    fn open_ended_range_clamps_at_eof() {
        let r = parse_range(Some("bytes=9000-"), SIZE).unwrap().unwrap();
        assert_eq!(r, ByteRange { start: 9000, end: SIZE - 1 });
    }

    #[test]
    fn suffix_range_returns_the_last_n_bytes() {
        // mp4 clients use `bytes=-N` to locate a trailing moov atom; misreading it as
        // "from N" breaks playback of exactly the files it exists to fix.
        assert_eq!(
            parse_range(Some("bytes=-500"), SIZE),
            Ok(Some(ByteRange { start: 9500, end: 9999 }))
        );
        // A suffix longer than the file yields the whole file, not a negative start.
        assert_eq!(
            parse_range(Some("bytes=-99999"), SIZE),
            Ok(Some(ByteRange { start: 0, end: 9999 }))
        );
    }

    #[test]
    fn range_past_eof_is_clamped_not_rejected() {
        assert_eq!(
            parse_range(Some("bytes=9990-99999"), SIZE),
            Ok(Some(ByteRange { start: 9990, end: 9999 }))
        );
    }

    #[test]
    fn unsatisfiable_ranges_are_rejected() {
        // Start beyond EOF, and an inverted range.
        assert_eq!(parse_range(Some("bytes=10000-"), SIZE), Err(RangeNotSatisfiable));
        assert_eq!(parse_range(Some("bytes=500-100"), SIZE), Err(RangeNotSatisfiable));
        assert_eq!(parse_range(Some("bytes=-0"), SIZE), Err(RangeNotSatisfiable));
    }

    #[test]
    fn malformed_ranges_do_not_panic() {
        assert_eq!(parse_range(Some("bytes=abc-def"), SIZE), Err(RangeNotSatisfiable));
        assert_eq!(parse_range(Some("bytes="), SIZE), Err(RangeNotSatisfiable));
        // An unknown unit is ignored per RFC, not treated as an error.
        assert_eq!(parse_range(Some("items=0-10"), SIZE), Ok(None));
    }

    #[test]
    fn only_the_first_range_of_a_set_is_served() {
        // Multi-range would need a multipart body; answering the first range is valid and is
        // what every media client actually expects.
        assert_eq!(
            parse_range(Some("bytes=0-99,200-299"), SIZE),
            Ok(Some(ByteRange { start: 0, end: 99 }))
        );
    }

    #[test]
    fn token_is_long_and_unpredictable() {
        let a = random_token();
        let b = random_token();
        assert_eq!(a.len(), 64, "256 bits hex-encoded");
        assert_ne!(a, b);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn base_url_binds_the_loopback_literal() {
        // NEVER "localhost": it can resolve to ::1, which is a different CSP origin than the
        // 127.0.0.1 the listener is bound to.
        let url = base_url(1234, "abc");
        assert!(url.starts_with("http://127.0.0.1:1234/tg/abc"), "{url}");
    }
}
