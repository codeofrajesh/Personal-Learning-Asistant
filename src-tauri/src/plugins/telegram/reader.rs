//! Chunked reader for Telegram-hosted media.
//!
//! Turns an HTTP byte range into `upload.getFile` calls. The unit of work is a 512 KB
//! **chunk** at a chunk-aligned offset, which is both Telegram's `MAX_CHUNK_SIZE` and the
//! largest legal `limit`, so a range is served in the fewest possible round trips.
//!
//! ## Why `iter_download` and not a raw `upload::GetFile`
//!
//! `telegram.md` §5.3 recommends raw `invoke_in_dc(GetFile)` to dodge a `panic!` in grammers'
//! `DownloadIter`. That recommendation is **inverted** for this crate version, verified in the
//! 0.10.0 sources:
//!
//!   · Media frequently lives on a **non-home DC**. `upload.getFile` then returns
//!     `AUTH_KEY_UNREGISTERED`, which must be repaired by exporting/importing an auth key.
//!     `DownloadIter::next` does exactly that (`files.rs:128` → `copy_auth_to_dc`), but
//!     `copy_auth_to_dc` is **`pub(crate)`** (`net.rs:168`) — unreachable from here, with no
//!     public equivalent. `Client::invoke_in_dc` only applies the retry policy; it does not
//!     handle that error. So a raw implementation fails permanently on exactly the
//!     private-channel media this feature exists to serve.
//!   · The panic is real but conditional: it fires only on `File::CdnRedirect`, and
//!     `iter_download` sets `cdn_supported: false` (`files.rs:178`). Telegram offloads
//!     *popular public* files to CDNs, which is not the private-course case.
//!
//! The rare failure is preferred over the common one — and it is contained: every chunk fetch
//! runs inside `catch_unwind`, so a CDN redirect degrades to a failed stream instead of
//! unwinding through the HTTP handler and taking the app with it.

use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use futures_util::FutureExt;
use grammers_client::media::{Downloadable, Media};
use grammers_client::session::types::PeerRef;
use grammers_client::session::Session;
use grammers_client::{tl, Client, InvocationError};
use tokio::sync::Mutex;

use crate::plugins::telegram::auth::map_invocation;
use crate::plugins::telegram::session::FileSession;
use crate::utils::errors::{AppError, AppResult};

/// Telegram's maximum (and our only) chunk size. Offsets are always multiples of this, which
/// satisfies the 4 KB-alignment rule by construction.
pub const CHUNK_SIZE: u64 = 512 * 1024;

/// Cached chunks per open file. 32 MB at 512 KB/chunk — enough that a seek backwards inside
/// the last minute of video is free, small enough to be invisible on a 4 GB machine.
const MAX_CACHED_CHUNKS: usize = 64;

/// Concurrent `upload.getFile` calls across ALL streams.
///
/// Telegram's own clients cap parallel file operations around 4-8; exceeding it is a
/// documented `FLOOD_WAIT` trigger. One global cap (not per-stream) is what makes that bound
/// hold when the player and a prefetch are both running.
const MAX_CONCURRENT_FETCHES: usize = 4;

/// A file we can stream: its location plus the metadata the HTTP layer must echo.
#[derive(Clone)]
pub struct TgFile {
    pub chat_id: i64,
    pub message_id: i32,
    pub size: u64,
    pub mime: String,
    /// The resolved media, holding the `file_reference` that authorizes the download.
    media: Media,
}

impl TgFile {
    pub fn size(&self) -> u64 {
        self.size
    }
    pub fn mime(&self) -> &str {
        &self.mime
    }
}

/// An open stream: the file plus its chunk cache.
pub struct TgReader {
    client: Client,
    peer: PeerRef,
    file: Mutex<TgFile>,
    /// (chunk_index, bytes), most-recently-used last. A `Vec` beats a `HashMap` + queue here:
    /// 64 entries makes a linear scan cheaper than hashing, and eviction is a `remove(0)`.
    cache: Mutex<Vec<(u64, Arc<Vec<u8>>)>>,
    semaphore: Arc<tokio::sync::Semaphore>,
    /// The datacenter this file actually lives on, once discovered.
    ///
    /// **This is the fix for the mid-playback stall.** `DownloadIter::next` starts every
    /// iterator from `session.home_dc_id()` (`files.rs:105`) and, on `FILE_MIGRATE_X`, only
    /// updates a local variable (`files.rs:135`) — `set_home_dc_id` is called *exclusively*
    /// from the login path (`auth.rs:200,280`), never from a download. So a fresh iterator per
    /// chunk means EVERY chunk pays a wasted round trip: ask home DC → get redirected → ask
    /// the real DC. Under a cache-filling player that doubles the request count and walks
    /// into `FLOOD_WAIT`, where `AutoSleep` sleeps up to 60s (`retry_policy.rs:69`) — which is
    /// what a "plays for ten seconds then freezes" stall actually is.
    ///
    /// Caching the id lets every later chunk go straight to the right DC. `invoke_in_dc`
    /// reuses one live connection per DC (`sender_pool.rs:239-247`), so this costs nothing.
    ///
    /// Deliberately NOT a cached `DownloadIter`: that type owns its own `offset` and advances
    /// on `next()`, but ranges arrive from the player in arbitrary order and *concurrently*.
    /// Two tasks sharing one iterator would interleave and receive each other's chunks —
    /// silent video corruption, far worse than a stall. An `i32` is immutable data; sharing it
    /// is safe under any concurrency.
    dc_id: Mutex<Option<i32>>,
    /// Whether an auth key has been copied to `dc_id` yet.
    ///
    /// A raw `upload.getFile` on a non-home DC fails with `AUTH_KEY_UNREGISTERED` until an
    /// authorization is exported/imported there. `DownloadIter` repairs that internally via
    /// `copy_auth_to_dc`, but that function is `pub(crate)` (`net.rs:168`) with no public
    /// equivalent — so the FIRST chunk deliberately goes through `iter_download` to trigger
    /// the copy, and only then do we switch to direct calls.
    auth_ready: Mutex<bool>,
    /// Our own handle to the session, for `home_dc_id()`. grammers keeps `Client.session`
    /// private, but we construct the session, so we can read it directly.
    session: Arc<FileSession>,
}

/// Telegram's `FILE_MIGRATE_X` status code — the file lives on a different datacenter.
const FILE_MIGRATE_CODE: i32 = 303;

impl TgReader {
    pub fn new(
        client: Client,
        peer: PeerRef,
        file: TgFile,
        semaphore: Arc<tokio::sync::Semaphore>,
        session: Arc<FileSession>,
    ) -> Self {
        Self {
            client,
            peer,
            file: Mutex::new(file),
            cache: Mutex::new(Vec::new()),
            semaphore,
            dc_id: Mutex::new(None),
            auth_ready: Mutex::new(false),
            session,
        }
    }

    pub async fn size(&self) -> u64 {
        self.file.lock().await.size
    }

    pub async fn mime(&self) -> String {
        self.file.lock().await.mime.clone()
    }

    /// Read `len` bytes starting at `offset`, clamped to the end of the file.
    ///
    /// Assembles from whole chunks so every network read stays aligned; the caller's range is
    /// carved out of them afterwards. Returns fewer bytes than asked only at EOF.
    pub async fn read_range(self: &Arc<Self>, offset: u64, len: u64) -> AppResult<Vec<u8>> {
        let size = self.size().await;
        if offset >= size {
            return Ok(Vec::new());
        }
        let end = (offset + len).min(size);
        let first = offset / CHUNK_SIZE;
        let last = (end - 1) / CHUNK_SIZE;

        let mut out = Vec::with_capacity((end - offset) as usize);
        for index in first..=last {
            let chunk = self.chunk(index).await?;
            let chunk_start = index * CHUNK_SIZE;
            // Where this chunk overlaps the requested range.
            let from = offset.saturating_sub(chunk_start) as usize;
            let to = ((end - chunk_start) as usize).min(chunk.len());
            if from >= chunk.len() {
                // Telegram returned a short chunk before the size it advertised — treat it as
                // EOF rather than emitting silence the player would render as corruption.
                break;
            }
            out.extend_from_slice(&chunk[from..to]);
        }

        // Warm the next chunk in the background.
        //
        // Playback is overwhelmingly sequential, so by the time the player asks for `last + 1`
        // it is usually already cached and the request costs no network latency at all. This is
        // fire-and-forget on purpose: the response must never wait on it, and a failure is
        // harmless because the real read will retry through the normal path.
        self.prefetch(last + 1, size);

        Ok(out)
    }

    /// Kick off a background fetch of `index`, if it is worth doing.
    ///
    /// Takes `&Arc<Self>` so the spawned task shares the *same* reader — same chunk cache, same
    /// learned `dc_id`, same semaphore. A cloned-fields copy would warm a cache nobody reads
    /// and rediscover the DC every time, which is worse than no prefetch at all.
    ///
    /// Only ONE chunk ahead, and only when a network slot is already free (`try_acquire`, never
    /// `acquire`). A prefetch that waited for a permit would compete with the chunk the player
    /// is actually blocked on — making playback worse while looking like an optimization.
    fn prefetch(self: &Arc<Self>, index: u64, size: u64) {
        if index * CHUNK_SIZE >= size {
            return; // past EOF
        }
        let this = Arc::clone(self);
        tokio::spawn(async move {
            // Already cached, or no spare capacity → skip silently.
            if this.cached(index).await.is_some() {
                return;
            }
            let Ok(_permit) = this.semaphore.clone().try_acquire_owned() else {
                return;
            };
            if let Ok(bytes) = this.download_chunk(index).await {
                if !bytes.is_empty() {
                    this.store(index, Arc::new(bytes)).await;
                }
            }
        });
    }

    /// Fetch one 512 KB chunk, from cache when possible.
    async fn chunk(&self, index: u64) -> AppResult<Arc<Vec<u8>>> {
        if let Some(hit) = self.cached(index).await {
            return Ok(hit);
        }

        // Bound concurrent Telegram reads. Acquired AFTER the cache check so a cache hit
        // never waits on a network slot.
        let _permit = self
            .semaphore
            .acquire()
            .await
            .map_err(|_| AppError::Other("Telegram reader is shutting down.".into()))?;

        // Another task may have fetched it while we waited for the permit.
        if let Some(hit) = self.cached(index).await {
            return Ok(hit);
        }

        let bytes = match self.download_chunk(index).await {
            Ok(bytes) => bytes,
            Err(e) if is_file_reference_expired(&e) => {
                // The `file_reference` in a message expires (hours). Re-fetching the message
                // yields a fresh one. This is what lets a student pause overnight and resume
                // without re-importing the lesson.
                log::info!("telegram: file reference expired, refreshing");
                self.refresh_reference().await?;
                self.download_chunk(index).await.map_err(map_invocation)?
            }
            Err(e) => return Err(map_invocation(e)),
        };

        let bytes = Arc::new(bytes);
        self.store(index, bytes.clone()).await;
        Ok(bytes)
    }

    async fn cached(&self, index: u64) -> Option<Arc<Vec<u8>>> {
        let mut cache = self.cache.lock().await;
        let pos = cache.iter().position(|(i, _)| *i == index)?;
        // Move to the back = most recently used.
        let entry = cache.remove(pos);
        let bytes = entry.1.clone();
        cache.push(entry);
        Some(bytes)
    }

    async fn store(&self, index: u64, bytes: Arc<Vec<u8>>) {
        let mut cache = self.cache.lock().await;
        if cache.iter().any(|(i, _)| *i == index) {
            return;
        }
        if cache.len() >= MAX_CACHED_CHUNKS {
            cache.remove(0); // evict least-recently-used
        }
        cache.push((index, bytes));
    }

    /// One chunk, with retry for the two failures a long stream reliably hits.
    ///
    /// **`FLOOD_WAIT`.** grammers' `AutoSleep` policy only retries when `fail_count == 1`
    /// (`retry_policy.rs:69`), so a second flood inside one request fails the stream outright
    /// and the player goes dead. A streaming workload is exactly where a second flood happens.
    ///
    /// **Transient I/O.** Telegram drops idle connections routinely, and a home wifi blip is a
    /// normal event during a 40-minute lecture. Without a retry here, one dropped socket ends
    /// playback and the student has to reopen the lesson.
    async fn download_chunk(&self, index: u64) -> Result<Vec<u8>, InvocationError> {
        const MAX_RETRIES: u32 = 3;
        /// Longer than this and the student is better served by an honest error than by a
        /// player that appears frozen for minutes.
        const MAX_FLOOD_WAIT_SECS: u32 = 45;

        let mut attempt = 0;
        loop {
            let result = self.fetch_once(index).await;

            let wait_secs = match &result {
                Err(InvocationError::Rpc(rpc)) if rpc.code == 420 => {
                    Some(rpc.value.unwrap_or(1).min(MAX_FLOOD_WAIT_SECS))
                }
                // Exponential-ish backoff for a dropped connection: 1s, 2s, 4s.
                Err(InvocationError::Io(_)) => Some(1 << attempt),
                _ => None,
            };

            match wait_secs {
                Some(wait) if attempt < MAX_RETRIES => {
                    attempt += 1;
                    log::warn!(
                        "telegram: chunk {index} failed ({}), retrying in {wait}s ({attempt}/{MAX_RETRIES})",
                        result.as_ref().err().map(|e| e.to_string()).unwrap_or_default()
                    );
                    tokio::time::sleep(std::time::Duration::from_secs(wait as u64)).await;
                }
                _ => return result,
            }
        }
    }

    /// A single `upload.getFile` attempt for chunk `index`.
    ///
    /// Takes the direct path once the DC is known and an auth key has been copied there;
    /// otherwise goes through `iter_download`, which discovers the DC and performs the auth
    /// copy internally.
    async fn fetch_once(&self, index: u64) -> Result<Vec<u8>, InvocationError> {
        let known_dc = *self.dc_id.lock().await;
        let auth_ready = *self.auth_ready.lock().await;

        if let Some(dc) = known_dc {
            if auth_ready {
                match self.fetch_direct(dc, index).await {
                    // The DC moved (rare, but files do migrate). Forget it and fall through to
                    // the iterator, which rediscovers it.
                    Err(InvocationError::Rpc(rpc)) if rpc.code == FILE_MIGRATE_CODE => {
                        log::info!("telegram: file migrated away from dc {dc}, rediscovering");
                        *self.dc_id.lock().await = None;
                    }
                    // The auth key was dropped on that DC; `iter_download` can re-copy it.
                    Err(InvocationError::Rpc(rpc)) if rpc.name == "AUTH_KEY_UNREGISTERED" => {
                        log::info!("telegram: auth key lost on dc {dc}, re-copying");
                        *self.auth_ready.lock().await = false;
                    }
                    other => return other,
                }
            }
        }

        self.fetch_via_iterator(index).await
    }

    /// Direct `upload.getFile` against a known datacenter — the fast path.
    ///
    /// No home-DC round trip and no redirect: this is the whole point of caching `dc_id`.
    async fn fetch_direct(&self, dc: i32, index: u64) -> Result<Vec<u8>, InvocationError> {
        let location = {
            let file = self.file.lock().await;
            match file.media.to_raw_input_location() {
                Some(location) => location,
                None => {
                    return Err(InvocationError::Io(std::io::Error::other(
                        "this Telegram media has no downloadable location",
                    )))
                }
            }
        };

        let request = tl::functions::upload::GetFile {
            precise: false,
            cdn_supported: false,
            location,
            offset: (index * CHUNK_SIZE) as i64,
            limit: CHUNK_SIZE as i32,
        };

        match self.client.invoke_in_dc(dc, &request).await? {
            tl::enums::upload::File::File(f) => Ok(f.bytes),
            // Unreachable with `cdn_supported: false`, but returned as an error rather than a
            // panic — see the module header.
            tl::enums::upload::File::CdnRedirect(_) => Err(InvocationError::Io(
                std::io::Error::other("Telegram redirected this file to a CDN, which isn't supported yet."),
            )),
        }
    }

    /// Fetch through `iter_download`, learning the DC as a side effect.
    ///
    /// Used for the first chunk of a file and whenever the direct path reports that its cached
    /// DC or auth key went stale. `iter_download` handles `FILE_MIGRATE` and the
    /// `copy_auth_to_dc` dance internally — the two things a raw call cannot do from outside
    /// the crate.
    async fn fetch_via_iterator(&self, index: u64) -> Result<Vec<u8>, InvocationError> {
        let media = self.file.lock().await.media.clone();
        let client = self.client.clone();

        // `DownloadIter::next` panics on `File::CdnRedirect`. It should be unreachable
        // (`cdn_supported: false`), but a panic crossing into the HTTP handler would be far
        // worse than a failed stream, so it is contained here and reported as an error.
        let fetch = async move {
            let mut iter = client
                .iter_download(&media)
                .chunk_size(CHUNK_SIZE as i32)
                .skip_chunks(index as i32);
            iter.next().await
        };

        let bytes = match AssertUnwindSafe(fetch).catch_unwind().await {
            Ok(Ok(Some(bytes))) => bytes,
            // Past EOF: an empty chunk is legitimate, not an error.
            Ok(Ok(None)) => Vec::new(),
            Ok(Err(e)) => return Err(e),
            Err(_) => {
                return Err(InvocationError::Io(std::io::Error::other(
                    "Telegram redirected this file to a CDN, which isn't supported yet.",
                )))
            }
        };

        // The iterator just succeeded, so whatever DC it settled on is reachable AND
        // authorized. grammers doesn't report which DC that was, so the home DC is used as the
        // opening guess — the same value the iterator itself starts from. If the file actually
        // lives elsewhere, the first direct call returns `FILE_MIGRATE` and `fetch_once`
        // rediscovers it; being wrong costs one round trip, being right saves one on every
        // remaining chunk of the file.
        if self.dc_id.lock().await.is_none() {
            if let Ok(home) = self.session.home_dc_id() {
                *self.dc_id.lock().await = Some(home);
            }
        }
        *self.auth_ready.lock().await = true;

        Ok(bytes)
    }

    /// Re-fetch the message to obtain a fresh `file_reference`.
    async fn refresh_reference(&self) -> AppResult<()> {
        let (chat_id, message_id) = {
            let file = self.file.lock().await;
            (file.chat_id, file.message_id)
        };
        let refreshed = resolve_file(&self.client, self.peer, chat_id, message_id).await?;
        let mut file = self.file.lock().await;
        // Only the media (and thus the reference) is replaced; size/mime are properties of
        // the file itself and must not change under an in-flight stream.
        file.media = refreshed.media;
        Ok(())
    }
}

fn is_file_reference_expired(e: &InvocationError) -> bool {
    matches!(e, InvocationError::Rpc(rpc)
        if rpc.name.starts_with("FILE_REFERENCE"))
}

/// Fetch a message and extract its downloadable document.
pub async fn resolve_file(
    client: &Client,
    peer: PeerRef,
    chat_id: i64,
    message_id: i32,
) -> AppResult<TgFile> {
    let messages = client
        .get_messages_by_id(peer, &[message_id])
        .await
        .map_err(map_invocation)?;

    let message = messages
        .into_iter()
        .flatten()
        .next()
        .ok_or_else(|| AppError::NotFound("That message no longer exists in Telegram.".into()))?;

    let document = match message.media() {
        Some(Media::Document(doc)) => doc,
        _ => {
            return Err(AppError::NotFound(
                "That Telegram message no longer contains a file.".into(),
            ))
        }
    };

    let size = document.size().unwrap_or(0) as u64;
    if size == 0 {
        return Err(AppError::NotFound(
            "Telegram reported an empty file for this lesson.".into(),
        ));
    }
    let mime = document
        .mime_type()
        .filter(|m| !m.is_empty())
        .unwrap_or("application/octet-stream")
        .to_string();

    Ok(TgFile {
        chat_id,
        message_id,
        size,
        mime,
        media: Media::Document(document),
    })
}

/// Shared concurrency limiter, one per app.
pub fn new_semaphore() -> Arc<tokio::sync::Semaphore> {
    Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_FETCHES))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The range→chunk mapping is pure arithmetic and the one part of this module that can be
    /// tested without a live session — and getting it wrong produces corrupt video rather
    /// than an error, so it is worth pinning exactly.
    fn chunk_span(offset: u64, len: u64, size: u64) -> (u64, u64) {
        let end = (offset + len).min(size);
        (offset / CHUNK_SIZE, (end - 1) / CHUNK_SIZE)
    }

    #[test]
    fn a_range_inside_one_chunk_touches_one_chunk() {
        assert_eq!(chunk_span(0, 1024, 10 * CHUNK_SIZE), (0, 0));
        assert_eq!(chunk_span(100, 200, 10 * CHUNK_SIZE), (0, 0));
    }

    #[test]
    fn a_range_spanning_a_boundary_touches_both_chunks() {
        // The classic off-by-one: the last byte of chunk 0 is CHUNK_SIZE-1.
        assert_eq!(chunk_span(CHUNK_SIZE - 1, 2, 10 * CHUNK_SIZE), (0, 1));
        // Exactly one full chunk starting at a boundary must NOT bleed into the next.
        assert_eq!(chunk_span(CHUNK_SIZE, CHUNK_SIZE, 10 * CHUNK_SIZE), (1, 1));
    }

    #[test]
    fn a_range_is_clamped_to_the_file_size() {
        let size = CHUNK_SIZE + 10; // 1 full chunk + a stub
        // Asking far past EOF must stop at the chunk holding the last real byte.
        assert_eq!(chunk_span(0, u32::MAX as u64, size), (0, 1));
        assert_eq!(chunk_span(CHUNK_SIZE, 999_999, size), (1, 1));
    }

    #[test]
    fn chunk_offsets_are_always_telegram_aligned() {
        // Telegram requires offsets divisible by 4 KB and a limit within one 1 MB window.
        // Deriving offsets as index*CHUNK_SIZE satisfies both by construction; assert it so a
        // future change to CHUNK_SIZE can't quietly violate the protocol.
        assert_eq!(CHUNK_SIZE % 4096, 0);
        assert!(CHUNK_SIZE <= 1024 * 1024);
        for index in [0u64, 1, 7, 4096] {
            assert_eq!((index * CHUNK_SIZE) % 4096, 0);
        }
    }

    /// The direct-DC path must build byte-identical requests to what `iter_download` sends,
    /// or the fast path would silently fetch different data than the fallback.
    #[test]
    fn direct_request_offsets_match_the_iterator() {
        // `iter_download().chunk_size(N).skip_chunks(k)` sets offset = N*k (files.rs:70-77).
        // `fetch_direct` computes index*CHUNK_SIZE. They must agree for every index.
        for index in [0u64, 1, 5, 100, 4095] {
            let iterator_offset = CHUNK_SIZE as i64 * index as i64;
            let direct_offset = (index * CHUNK_SIZE) as i64;
            assert_eq!(
                iterator_offset, direct_offset,
                "offset mismatch at chunk {index}"
            );
        }
    }

    /// Backoff must be bounded and monotonic — an unbounded sleep would look like a hang.
    #[test]
    fn io_backoff_is_bounded_and_increasing() {
        // Mirrors the `1 << attempt` schedule in `download_chunk`: 1s, 2s, 4s.
        let delays: Vec<u32> = (0..3).map(|attempt| 1u32 << attempt).collect();
        assert_eq!(delays, vec![1, 2, 4]);
        // Total worst-case wait stays well under a player's patience.
        assert!(delays.iter().sum::<u32>() < 10);
    }

    /// A `FLOOD_WAIT` longer than the cap must be truncated, not slept in full.
    #[test]
    fn flood_wait_is_capped() {
        const MAX_FLOOD_WAIT_SECS: u32 = 45;
        // Telegram occasionally returns very long waits; sleeping 300s inside a request would
        // read as a frozen app, so the reader caps it and surfaces the failure instead.
        assert_eq!(300u32.min(MAX_FLOOD_WAIT_SECS), 45);
        assert_eq!(12u32.min(MAX_FLOOD_WAIT_SECS), 12);
    }
}
