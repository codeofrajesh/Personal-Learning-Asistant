//! Telegram import — turn a message link or a channel listing into library materials.
//!
//! An imported material is a normal row in `materials`: same id space, same
//! `watch_progress` / `notes` / `tasks` relationships, same node tree. Only three columns
//! differ (`source`, `tg_chat_id`, `tg_message_id`, schema v11), and `file_path` holds a
//! synthetic `tg://<chat>/<msg>` key instead of a real path. Everything downstream —
//! progress, the Study Meter, schedule attribution, search — keys on `materials.id` and is
//! therefore source-agnostic by construction.
//!
//! Resolving a peer is the subtle part. A `t.me/c/<id>/<msg>` link carries **no access
//! hash**, so the channel can only be addressed if this session already knows it (i.e. the
//! account is a member and the peer is cached). That is exactly the intended use case —
//! importing your own private-channel material — but it means a "not found" here usually
//! means "not a member", and the error says so rather than blaming the link.

use grammers_client::media::Media;
use grammers_client::message::Message;
use grammers_client::session::types::PeerId;
use grammers_client::{Client, InvocationError};
use tauri::{AppHandle, State};

use crate::db::Db;
use crate::plugins::telegram::auth::map_invocation;
use crate::plugins::telegram::link::{parse_message_link, synthetic_path, LinkTarget};
use crate::plugins::telegram::session::TgState;
use crate::utils::errors::{AppError, AppResult};

/// One importable media message.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TgMediaItem {
    pub chat_id: i64,
    pub message_id: i32,
    /// Best available display name (document filename, else a synthesized one).
    pub file_name: String,
    /// PLE's own classification: video | audio | pdf | image | note.
    pub file_type: String,
    pub file_extension: String,
    pub size_bytes: i64,
    pub duration_secs: Option<f64>,
    pub mime_type: Option<String>,
    /// The message's text/caption, when it has one (used as a fallback title).
    pub caption: Option<String>,
    /// True once a material row for this (chat, message) exists in the library.
    pub already_imported: bool,
}

/// Result of importing one link.
#[derive(Debug, serde::Serialize)]
pub struct TgImportResult {
    pub material_id: i64,
    pub file_name: String,
    /// False when the row already existed and was updated rather than created.
    pub created: bool,
    /// The node the material landed in, for the "imported into X" confirmation.
    pub node_id: i64,
}

/// Resolve a link's target into something `get_messages_by_id` accepts.
///
/// Public usernames need a network round trip; a private `/c/` id is turned into an ambient
/// `PeerRef`, which works because the sender pool fills in the access hash from the session's
/// cached peers. If the account has never seen the channel, the request fails — handled by
/// the caller with a membership-flavored message rather than a raw RPC error.
async fn resolve_target(client: &Client, target: &LinkTarget) -> AppResult<PeerId> {
    match target {
        LinkTarget::PrivateChannel { channel_id } => PeerId::channel(*channel_id).ok_or_else(|| {
            AppError::Invalid("That channel id is outside Telegram's valid range.".into())
        }),
        LinkTarget::Username { username } => {
            let peer = client
                .resolve_username(username)
                .await
                .map_err(map_invocation)?
                .ok_or_else(|| {
                    AppError::NotFound(format!("No Telegram channel called @{username}."))
                })?;
            Ok(peer.id())
        }
    }
}

/// Classify a Telegram document into PLE's own file-type vocabulary.
///
/// Extension first, MIME second. The extension is what the uploader chose and what the
/// player's own routing already understands (`classify_extension` is the single source of
/// truth for local files, and reusing it keeps a `.mkv` behaving identically whether it came
/// from disk or from Telegram). MIME is the fallback for a file uploaded with no useful name.
fn classify(name: &str, mime: Option<&str>) -> (String, String) {
    let extension = name
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .filter(|ext| !ext.is_empty() && ext.len() <= 5)
        .unwrap_or_default();

    if let Some(kind) = crate::scanner::walker::classify_extension(&extension) {
        return (kind.to_string(), extension);
    }

    // MIME fallback. Only the top-level type is trusted: Telegram sets
    // `application/octet-stream` on plenty of real videos, so a specific subtype is not
    // reliable enough to override an extension we already understood above.
    let kind = match mime.map(|m| m.to_ascii_lowercase()) {
        Some(m) if m.starts_with("video/") => "video",
        Some(m) if m.starts_with("audio/") => "audio",
        Some(m) if m.starts_with("image/") => "image",
        Some(m) if m == "application/pdf" => "pdf",
        Some(m) if m.starts_with("text/") => "note",
        _ => "video",
    };

    // Derive a usable extension from the MIME subtype when the filename had none, so the
    // player's extension-based routing still has something to work with.
    let ext = if extension.is_empty() {
        mime.and_then(|m| m.rsplit_once('/').map(|(_, sub)| sub.to_ascii_lowercase()))
            .filter(|s| s.chars().all(|c| c.is_ascii_alphanumeric()) && s.len() <= 5)
            .unwrap_or_else(|| default_extension(kind).to_string())
    } else {
        extension
    };

    (kind.to_string(), ext)
}

fn default_extension(kind: &str) -> &'static str {
    match kind {
        "audio" => "mp3",
        "image" => "jpg",
        "pdf" => "pdf",
        "note" => "txt",
        _ => "mp4",
    }
}

/// Build a display name for a document that was uploaded without a filename.
///
/// Falls back to the caption's first line (usually the lesson title in a course channel),
/// then to the message id — never to an empty string, which would render as a blank row.
fn display_name(raw_name: Option<&str>, caption: Option<&str>, message_id: i32, ext: &str) -> String {
    if let Some(name) = raw_name.map(str::trim).filter(|n| !n.is_empty()) {
        return name.to_string();
    }
    if let Some(line) = caption
        .and_then(|c| c.lines().next())
        .map(str::trim)
        .filter(|l| !l.is_empty())
    {
        // Cap the length: a caption can be a paragraph, and the whole thing as a filename
        // would blow out every list row that renders it.
        let title: String = line.chars().take(80).collect();
        return format!("{title}.{ext}");
    }
    format!("Telegram {message_id}.{ext}")
}

/// Extract the importable metadata from a message, or `None` if it carries no usable media.
fn media_item(
    message: &Message,
    chat_id: i64,
    already_imported: bool,
) -> Option<TgMediaItem> {
    let caption = {
        let text = message.text().trim();
        (!text.is_empty()).then(|| text.to_string())
    };

    // Only documents are importable. A Photo has no filename/duration and is not a lesson;
    // stickers, polls and geo obviously aren't either. Being strict here keeps a channel
    // listing free of rows the player could not open.
    let document = match message.media()? {
        Media::Document(doc) => doc,
        _ => return None,
    };

    let mime = document.mime_type().map(|s| s.to_string());
    let raw_name = document.name().map(|s| s.to_string());
    let (file_type, file_extension) = classify(raw_name.as_deref().unwrap_or(""), mime.as_deref());
    let file_name = display_name(
        raw_name.as_deref(),
        caption.as_deref(),
        message.id(),
        &file_extension,
    );

    Some(TgMediaItem {
        chat_id,
        message_id: message.id(),
        file_name,
        file_type,
        file_extension,
        size_bytes: document.size().unwrap_or(0) as i64,
        duration_secs: document.duration(),
        mime_type: mime,
        caption,
        already_imported,
    })
}

/// Insert (or refresh) a material row for a Telegram message.
///
/// Keyed on `(tg_chat_id, tg_message_id)` — the v11 partial UNIQUE index — so re-importing the
/// same link updates the existing lesson instead of creating a duplicate. The material id is
/// preserved on update, which is what keeps watch progress, notes and any scheduled block
/// pointing at the same lesson.
fn upsert_material(
    conn: &rusqlite::Connection,
    node_id: i64,
    item: &TgMediaItem,
) -> AppResult<(i64, bool)> {
    use rusqlite::OptionalExtension;

    let path = synthetic_path(item.chat_id, item.message_id);

    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM materials WHERE tg_chat_id = ?1 AND tg_message_id = ?2",
            rusqlite::params![item.chat_id, item.message_id],
            |r| r.get(0),
        )
        .optional()?;

    if let Some(id) = existing {
        conn.execute(
            "UPDATE materials SET
                 node_id         = ?1,
                 file_name       = ?2,
                 file_type       = ?3,
                 file_extension  = ?4,
                 file_size_bytes = ?5,
                 duration_secs   = COALESCE(?6, duration_secs),
                 status          = 'active',
                 updated_at      = datetime('now')
             WHERE id = ?7",
            rusqlite::params![
                node_id,
                item.file_name,
                item.file_type,
                item.file_extension,
                item.size_bytes,
                item.duration_secs,
                id,
            ],
        )?;
        return Ok((id, false));
    }

    conn.execute(
        "INSERT INTO materials(
             node_id, file_path, file_name, file_type, file_extension,
             file_size_bytes, duration_secs, source, tg_chat_id, tg_message_id
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, 'telegram', ?8, ?9)",
        rusqlite::params![
            node_id,
            path,
            item.file_name,
            item.file_type,
            item.file_extension,
            item.size_bytes,
            item.duration_secs,
            item.chat_id,
            item.message_id,
        ],
    )?;
    Ok((conn.last_insert_rowid(), true))
}

/// Map the "this session can't address that peer" errors to a membership-flavored message.
///
/// For a `/c/` link these three RPC names all mean the same practical thing: the account
/// isn't a member, or has never opened the channel so it isn't in the session's peer cache.
/// Surfacing `CHANNEL_INVALID` verbatim would send the student looking for a broken link
/// instead of a missing membership. Takes the error by value because `InvocationError` is not
/// `Clone`, so it can't be inspected and then forwarded.
fn unreachable_peer_or(e: InvocationError) -> AppError {
    if let InvocationError::Rpc(rpc) = &e {
        if matches!(
            rpc.name.as_str(),
            "CHANNEL_INVALID" | "CHANNEL_PRIVATE" | "PEER_ID_INVALID"
        ) {
            return AppError::NotFound(
                "Can't open that channel. Make sure this Telegram account is a member of it, then open the channel in Telegram once and try again."
                    .into(),
            );
        }
    }
    map_invocation(e)
}

/// Fetch one message, mapping the "peer unknown to this session" case to a useful message.
async fn fetch_message(
    client: &Client,
    peer: PeerId,
    message_id: i32,
) -> AppResult<Message> {
    let messages = client
        .get_messages_by_id(peer.to_ambient_ref(), &[message_id])
        .await
        .map_err(unreachable_peer_or)?;

    messages
        .into_iter()
        .flatten()
        .next()
        .ok_or_else(|| AppError::NotFound("That message no longer exists.".into()))
}

/// Import a single `t.me` link into `node_id`.
#[tauri::command]
pub async fn tg_import_link(
    app: AppHandle,
    db: State<'_, Db>,
    state: State<'_, TgState>,
    url: String,
    node_id: i64,
) -> AppResult<TgImportResult> {
    let link = parse_message_link(&url)?;
    let client = state.ensure_client(&app, &db).await?;

    // Validate the destination before spending a network round trip — importing into a node
    // that was deleted in another tab would otherwise fail on the FK *after* the fetch.
    let node_exists: bool = db.with(|conn| {
        Ok(conn
            .query_row(
                "SELECT 1 FROM nodes WHERE id = ?1",
                [node_id],
                |_| Ok(()),
            )
            .is_ok())
    })?;
    if !node_exists {
        return Err(AppError::NotFound(
            "That destination folder no longer exists.".into(),
        ));
    }

    let peer = resolve_target(&client, &link.target).await?;
    let message = fetch_message(&client, peer, link.message_id).await?;

    // Store the BARE channel id, matching what a `/c/` link carries and what
    // `synthetic_path` builds. Storing the Bot-API form here would make the same channel
    // look like two different ones depending on which link shape was imported.
    let chat_id = peer.bare_id().ok_or_else(|| {
        AppError::Invalid("That link doesn't point at a channel.".into())
    })?;

    let item = media_item(&message, chat_id, false).ok_or_else(|| {
        AppError::Invalid(
            "That message has no downloadable file. Link a message containing a video, PDF or audio file.".into(),
        )
    })?;

    let (material_id, created) = db.with(move |conn| upsert_material(conn, node_id, &item))?;

    // Re-read the stored name rather than moving `item` into the result: the row is the
    // source of truth once written, and this keeps the confirmation honest if the UPDATE
    // path preserved something different.
    let file_name: String = db.with(|conn| {
        Ok(conn.query_row(
            "SELECT file_name FROM materials WHERE id = ?1",
            [material_id],
            |r| r.get(0),
        )?)
    })?;

    Ok(TgImportResult {
        material_id,
        file_name,
        created,
        node_id,
    })
}

/// List recent media messages in a channel, for the browse view.
#[tauri::command]
pub async fn tg_channel_media(
    app: AppHandle,
    db: State<'_, Db>,
    state: State<'_, TgState>,
    url: String,
    limit: Option<u32>,
) -> AppResult<Vec<TgMediaItem>> {
    // The same parser serves both: a student can paste any message link from the channel they
    // want to browse, which is far easier than finding its numeric id.
    let link = parse_channel_reference(&url)?;
    let client = state.ensure_client(&app, &db).await?;
    let peer = resolve_target(&client, &link).await?;

    // Bounded: an unbounded iteration over a large channel is a flood-wait risk and would
    // render a list nobody scrolls. 200 is well within one page of history.
    let limit = limit.unwrap_or(60).clamp(1, 200) as usize;

    let chat_id = peer
        .bare_id()
        .ok_or_else(|| AppError::Invalid("That link doesn't point at a channel.".into()))?;

    let mut items = Vec::new();
    let mut iter = client.iter_messages(peer.to_ambient_ref());
    // Scan a bounded window of history rather than `limit` messages: a course channel
    // interleaves text announcements with the actual lessons, so stopping after `limit`
    // *messages* could return almost no media.
    let mut scanned = 0usize;
    let scan_cap = limit * 5;

    loop {
        match iter.next().await {
            Ok(Some(message)) => {
                scanned += 1;
                if let Some(item) = media_item(&message, chat_id, false) {
                    items.push(item);
                    if items.len() >= limit {
                        break;
                    }
                }
                if scanned >= scan_cap {
                    break;
                }
            }
            Ok(None) => break,
            Err(e) => return Err(unreachable_peer_or(e)),
        }
    }

    // Mark what's already in the library in ONE query rather than per item — a per-row
    // lookup would take the DB mutex `limit` times on the UI's hot path.
    let keys: Vec<i32> = items.iter().map(|i| i.message_id).collect();
    if !keys.is_empty() {
        let imported = db.with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT tg_message_id FROM materials WHERE tg_chat_id = ?1 AND tg_message_id IS NOT NULL",
            )?;
            let rows = stmt.query_map([chat_id], |r| r.get::<_, i32>(0))?;
            let mut set = std::collections::HashSet::new();
            for row in rows {
                set.insert(row?);
            }
            Ok(set)
        })?;
        for item in &mut items {
            item.already_imported = imported.contains(&item.message_id);
        }
    }

    Ok(items)
}

/// Parse either a full message link or a bare channel reference for the browse view.
///
/// Accepts `t.me/c/<id>/<msg>` (message link — the channel part is what matters here),
/// `t.me/c/<id>`, `t.me/<username>` and a bare `@username`.
fn parse_channel_reference(input: &str) -> AppResult<LinkTarget> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err(AppError::Invalid("Paste a channel link or @username.".into()));
    }

    // A bare @username never parses as a URL, so handle it before trying.
    if let Some(name) = raw.strip_prefix('@') {
        return Ok(LinkTarget::Username {
            username: name.to_string(),
        });
    }

    // A full message link is the most common paste — reuse the real parser so every shape it
    // understands (forum topics, query strings, -100 ids) works here too.
    if let Ok(link) = parse_message_link(raw) {
        return Ok(link.target);
    }

    // Channel-only links: append a dummy message id so the same parser can validate the
    // channel half, then discard it.
    if let Ok(link) = parse_message_link(&format!("{}/1", raw.trim_end_matches('/'))) {
        return Ok(link.target);
    }

    Err(AppError::Invalid(
        "That doesn't look like a Telegram channel link or @username.".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_by_extension_first() {
        // The extension is what the player's routing already understands, and Telegram sets
        // application/octet-stream on plenty of real videos.
        assert_eq!(
            classify("lecture.mkv", Some("application/octet-stream")),
            ("video".to_string(), "mkv".to_string())
        );
        assert_eq!(
            classify("notes.pdf", None),
            ("pdf".to_string(), "pdf".to_string())
        );
    }

    #[test]
    fn falls_back_to_mime_when_the_name_has_no_useful_extension() {
        assert_eq!(
            classify("lecture", Some("video/mp4")),
            ("video".to_string(), "mp4".to_string())
        );
        assert_eq!(
            classify("", Some("audio/mpeg")),
            ("audio".to_string(), "mpeg".to_string())
        );
    }

    #[test]
    fn unknown_media_defaults_to_video_not_an_empty_type() {
        // An empty file_type would render as an unopenable row; video is the overwhelmingly
        // common case in a course channel and the player falls back gracefully.
        let (kind, ext) = classify("mystery", None);
        assert_eq!(kind, "video");
        assert!(!ext.is_empty());
    }

    #[test]
    fn display_name_prefers_the_real_filename() {
        assert_eq!(
            display_name(Some("Lesson 1.mp4"), Some("caption"), 5, "mp4"),
            "Lesson 1.mp4"
        );
    }

    #[test]
    fn display_name_falls_back_to_the_caption_then_the_message_id() {
        assert_eq!(
            display_name(None, Some("Thermodynamics — Part 2\nmore text"), 5, "mp4"),
            "Thermodynamics — Part 2.mp4"
        );
        assert_eq!(display_name(None, None, 5, "mp4"), "Telegram 5.mp4");
        // Whitespace-only inputs must not produce a blank row.
        assert_eq!(display_name(Some("  "), Some("  "), 7, "mp4"), "Telegram 7.mp4");
    }

    #[test]
    fn display_name_caps_a_long_caption() {
        let long = "x".repeat(500);
        let name = display_name(None, Some(&long), 1, "mp4");
        assert!(name.chars().count() <= 85, "was {} chars", name.chars().count());
    }

    #[test]
    fn parses_channel_references_in_every_accepted_shape() {
        assert_eq!(
            parse_channel_reference("@somechannel").unwrap(),
            LinkTarget::Username {
                username: "somechannel".into()
            }
        );
        assert_eq!(
            parse_channel_reference("https://t.me/c/1234567890/42").unwrap(),
            LinkTarget::PrivateChannel {
                channel_id: 1234567890
            }
        );
        // Channel-only link (no message id).
        assert_eq!(
            parse_channel_reference("https://t.me/c/1234567890").unwrap(),
            LinkTarget::PrivateChannel {
                channel_id: 1234567890
            }
        );
        assert!(parse_channel_reference("   ").is_err());
    }
}
