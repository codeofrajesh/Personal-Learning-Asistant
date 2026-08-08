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
use grammers_client::session::types::{PeerAuth, PeerId, PeerRef};
use grammers_client::session::Session;
use grammers_client::{tl, Client, InvocationError};
use tauri::{AppHandle, State};

use crate::db::Db;
use crate::plugins::telegram::auth::map_invocation;
use crate::plugins::telegram::link::{
    parse_channel_link, parse_message_link, synthetic_path, LinkTarget,
};
use crate::plugins::telegram::session::{FileSession, TgState};
use crate::utils::errors::{AppError, AppResult};
use rusqlite::Connection;

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
async fn resolve_target(client: &Client, target: &LinkTarget) -> AppResult<PeerRef> {
    match target {
        // Bare id only — no access hash in the link, so the hash has to come from the session
        // peer cache. Returns an ambient ref here; `resolve_peer_ref` upgrades it.
        LinkTarget::PrivateChannel { channel_id } => PeerId::channel(*channel_id)
            .map(PeerId::to_ambient_ref)
            .ok_or_else(|| {
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
            // `contacts.resolveUsername` returns the access hash, so this ref is complete and
            // needs no cache lookup.
            peer.to_ref().await.ok().flatten().ok_or_else(|| {
                AppError::NotFound(format!("Couldn't resolve @{username}."))
            })
        }
        LinkTarget::Invite { hash } => resolve_invite(client, hash).await,
    }
}

/// Exchange an invite hash for a real `PeerRef` via `messages.checkChatInvite`.
///
/// This is what makes a username-less private channel reachable at all — including one the
/// user owns, where the invite link is the only handle that exists. `checkChatInvite` is a
/// read-only lookup: it does NOT join anything (that would be `importChatInvite`), so pasting
/// a link can never silently change the account's memberships.
///
/// Telegram answers in three shapes, and the distinction is the whole point:
///   · `ChatInviteAlready` / `ChatInvitePeek` — already a member (or allowed to peek), and the
///     response carries the full `Chat` **with its access hash**. This is the success path.
///   · `ChatInvite` — a *preview* for a channel the account has NOT joined. It deliberately
///     carries no id or hash, so the channel cannot be read. Reported as "join first".
async fn resolve_invite(client: &Client, hash: &str) -> AppResult<PeerRef> {
    use tl::enums::ChatInvite as CI;

    let result = client
        .invoke(&tl::functions::messages::CheckChatInvite {
            hash: hash.to_string(),
        })
        .await
        .map_err(|e| {
            if let InvocationError::Rpc(rpc) = &e {
                if rpc.name == "INVITE_HASH_EXPIRED" {
                    return AppError::Invalid(
                        "That invite link has expired. Generate a fresh one in Telegram.".into(),
                    );
                }
                if rpc.name == "INVITE_HASH_INVALID" {
                    return AppError::Invalid("That invite link isn't valid.".into());
                }
            }
            map_invocation(e)
        })?;

    let chat = match result {
        CI::Already(already) => already.chat,
        CI::Peek(peek) => peek.chat,
        CI::Invite(preview) => {
            return Err(AppError::NotFound(format!(
                "You haven't joined “{}” yet. Open the invite link in Telegram and join, then paste it here again.",
                preview.title
            )))
        }
    };

    // Pull the id + access hash straight out of the returned Chat.
    match chat {
        tl::enums::Chat::Channel(c) => {
            let id = PeerId::channel(c.id).ok_or_else(|| {
                AppError::Invalid("That channel id is outside Telegram's valid range.".into())
            })?;
            let access_hash = c.access_hash.ok_or_else(|| {
                AppError::NotFound(
                    "Telegram didn't return access to that channel. Join it in Telegram and try again."
                        .into(),
                )
            })?;
            Ok(PeerRef {
                id,
                auth: PeerAuth::from_hash(access_hash),
            })
        }
        // Basic groups and forbidden channels can't host a course library.
        _ => Err(AppError::Invalid(
            "That invite is for a group, not a channel. Only channels can be imported.".into(),
        )),
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

/// Walk the dialog list so every joined chat lands in the session's peer cache.
///
/// This is the only way to learn a private channel's `access_hash` without an invite link:
/// `messages.getDialogs` returns the full `Chat` objects, and `build_peer_map` feeds each one
/// through `Session::cache_peer` (grammers' `auto_cache_peers` defaults to true). The account
/// must already be a member — which is exactly the case we're serving.
///
/// Bounded at ~200 dialogs: enough to cover any realistic account, and a hard stop so a
/// pathological list can't spin here. Best-effort by contract; the caller reports the failure.
async fn prime_peer_cache(client: &Client) {
    log::info!("telegram: peer cache miss, priming via iter_dialogs");
    let mut dialogs = client.iter_dialogs();
    for _ in 0..200 {
        match dialogs.next().await {
            Ok(Some(_)) => {}
            Ok(None) => break,
            Err(e) => {
                log::warn!("telegram: dialog priming stopped early: {e}");
                break;
            }
        }
    }
}

/// Resolve a bare channel id into a `PeerRef` carrying a REAL `access_hash`.
///
/// This is the crux of private-channel support, and the reason a retry-the-same-request
/// approach cannot work. A `t.me/c/<id>/<msg>` link carries only the bare id, so the only
/// available `PeerRef` is `PeerId::to_ambient_ref()` — and that is defined as
/// `PeerAuth::default()`, i.e. **`access_hash: 0`**. `channels.getMessages` rejects that with
/// `CHANNEL_INVALID` for any channel that isn't public.
///
/// Crucially, `get_messages_by_id` does `channel: peer.into()` with no session lookup at all.
/// So priming the cache and then re-issuing the *same* ambient call rebuilds byte-identical
/// wire data and fails identically — the primed `access_hash` is never read. The fix is to ask
/// the session for the hash and send a `PeerRef` that actually carries it.
///
/// Order matters: check the cache first (free), and only walk the dialog list if that misses.
pub async fn resolve_peer_ref(
    client: &Client,
    session: &FileSession,
    peer: PeerRef,
) -> AppResult<PeerRef> {
    // A username or invite link already produced a real hash — nothing to look up.
    if peer.auth != PeerAuth::default() {
        return Ok(peer);
    }

    if let Ok(Some(cached)) = session.peer_ref(peer.id).await {
        return Ok(cached);
    }

    prime_peer_cache(client).await;

    if let Ok(Some(cached)) = session.peer_ref(peer.id).await {
        return Ok(cached);
    }

    // Still unknown after enumerating every joined dialog: the account genuinely can't see
    // this channel, or the id in the link is wrong. An invite link is the remaining option, so
    // the message points there rather than dead-ending.
    Err(AppError::NotFound(
        "This Telegram account can't see that channel. If you're a member, open the channel in Telegram once and retry — otherwise paste the channel's invite link (t.me/+…) instead.".into(),
    ))
}

/// Fetch one message using a cache-resolved peer reference.
async fn fetch_message(
    client: &Client,
    peer_ref: PeerRef,
    message_id: i32,
) -> AppResult<Message> {
    let messages = client
        .get_messages_by_id(peer_ref, &[message_id])
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
    // Resolve through the session cache so the request carries a real `access_hash`; an
    // ambient ref (hash 0) is rejected by every private channel.
    let session = state.get_session().await.ok_or_else(|| {
        AppError::Other("Telegram session is not initialized.".into())
    })?;
    let peer_ref = resolve_peer_ref(&client, &session, peer).await?;
    let message = fetch_message(&client, peer_ref, link.message_id).await?;

    // Store the BARE channel id, matching what a `/c/` link carries and what
    // `synthetic_path` builds. Storing the Bot-API form here would make the same channel
    // look like two different ones depending on which link shape was imported.
    let chat_id = peer_ref.id.bare_id().ok_or_else(|| {
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

/// Import multiple `t.me` links from the same channel in bulk.
///
/// Chunks the ids to respect Telegram's limits (typically 100 per call for `get_messages`),
/// and uses a single SQLite transaction to ensure atomic and fast inserts.
#[tauri::command]
pub async fn tg_import_batch(
    app: AppHandle,
    db: State<'_, Db>,
    state: State<'_, TgState>,
    url: String, // channel url or any message url from that channel
    message_ids: Vec<i32>,
    node_id: i64,
) -> AppResult<Vec<TgImportResult>> {
    if message_ids.is_empty() {
        return Ok(Vec::new());
    }

    let link = parse_channel_link(&url)?;
    let client = state.ensure_client(&app, &db).await?;

    // Validate the destination first.
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

    let peer = resolve_target(&client, &link).await?;
    let session = state.get_session().await.ok_or_else(|| {
        AppError::Other("Telegram session is not initialized.".into())
    })?;
    let peer_ref = resolve_peer_ref(&client, &session, peer).await?;
    let chat_id = peer_ref.id.bare_id().ok_or_else(|| {
        AppError::Invalid("That link doesn't point at a channel.".into())
    })?;

    let mut all_fetched_messages = Vec::new();

    // Fetch messages in chunks of 100 to avoid limits or payload size bounds.
    for chunk in message_ids.chunks(100) {
        let messages = client
            .get_messages_by_id(peer_ref.clone(), chunk)
            .await
            .map_err(unreachable_peer_or)?;
        
        all_fetched_messages.extend(messages.into_iter().flatten());
    }

    // Prepare items to be imported.
    let mut importable_items = Vec::new();
    for message in all_fetched_messages {
        if let Some(item) = media_item(&message, chat_id, false) {
            importable_items.push(item);
        }
    }

    if importable_items.is_empty() {
        return Err(AppError::Invalid(
            "None of the selected messages contained downloadable media.".into(),
        ));
    }

    // Execute bulk upsert in a single database transaction.
    let results: AppResult<Vec<TgImportResult>> = db.with_mut(move |conn| {
        let tx = conn.transaction()?;
        let mut batch_results = Vec::with_capacity(importable_items.len());

        for item in &importable_items {
            let (material_id, created) = upsert_material(&tx, node_id, item)?;
            
            let file_name: String = tx.query_row(
                "SELECT file_name FROM materials WHERE id = ?1",
                [material_id],
                |r| r.get(0),
            )?;

            batch_results.push(TgImportResult {
                material_id,
                file_name,
                created,
                node_id,
            });
        }
        
        tx.commit()?;
        Ok(batch_results)
    });

    results
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
    let link = parse_channel_link(&url)?;
    let client = state.ensure_client(&app, &db).await?;
    let peer = resolve_target(&client, &link).await?;

    // Bounded: an unbounded iteration over a large channel is a flood-wait risk and would
    // render a list nobody scrolls. 200 is well within one page of history.
    let limit = limit.unwrap_or(60).clamp(1, 200) as usize;

    // Same resolution as the import path: an ambient ref carries `access_hash: 0`, which any
    // private channel rejects, so the hash has to come from the session's peer cache.
    let session = state
        .get_session()
        .await
        .ok_or_else(|| AppError::Other("Telegram session is not initialized.".into()))?;
    let peer_ref = resolve_peer_ref(&client, &session, peer).await?;

    let chat_id = peer_ref
        .id
        .bare_id()
        .ok_or_else(|| AppError::Invalid("That link doesn't point at a channel.".into()))?;

    let mut items = Vec::new();
    let mut iter = client.iter_messages(peer_ref);
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

/// One row of the "Since you imported from Telegram" library view.
///
/// Read-only by construction: this is a plain `materials` read — no session, no network,
/// no writes. The folder ancestry is flattened (root-first) so the UI can render a
/// Goal ▸ Subject ▸ Chapter breadcrumb from a single round trip.
#[derive(Debug, serde::Serialize)]
pub struct TgImportedMaterial {
    pub material_id: i64,
    pub node_id: i64,
    /// "Goal / Subject / Chapter" ancestry, root-first.
    pub node_path: String,
    pub file_name: String,
    pub file_type: String,
    pub file_extension: String,
    pub duration_secs: Option<f64>,
    pub file_size_bytes: i64,
    /// 0-100 watch completion from `watch_progress` (0 for a never-opened file).
    pub progress_pct: f64,
    pub is_completed: bool,
    pub is_bookmarked: bool,
    /// ISO `last_opened_at`, or null if the file was never opened in the player.
    pub last_opened_at: Option<String>,
    pub tg_chat_id: Option<i64>,
    pub tg_message_id: Option<i32>,
}

/// Root-first slash path for a node (its name plus every ancestor).
fn ancestry_path(conn: &Connection, node_id: i64) -> AppResult<String> {
    let names = node_ancestor_names(conn, node_id)?;
    let path = names.join(" / ");
    Ok(if path.is_empty() {
        "Library".to_string()
    } else {
        path
    })
}

/// Collect a node's own name + all ancestor names, root-first (or an empty vec when the
/// node doesn't exist).
fn node_ancestor_names(conn: &Connection, node_id: i64) -> AppResult<Vec<String>> {
    let mut names = Vec::new();
    let mut current: Option<i64> = Some(node_id);
    let mut guard = 0u32;
    while let Some(id) = current {
        guard += 1;
        if guard > 1000 {
            break; // cycle guard — the graph is a tree, but never trust that blindly
        }
        let row = conn.query_row(
            "SELECT id, parent_id, name FROM nodes WHERE id = ?1",
            [id],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<i64>>(1)?, r.get::<_, String>(2)?)),
        )?;
        let (_, parent, name) = row;
        names.push(name);
        current = parent;
    }
    names.reverse();
    Ok(names)
}

/// List the materials previously imported from Telegram, newest-first.
///
/// Richens each row with its watch progress (so a student can resume exactly where they
/// left off) and its folder ancestry (so the list can say where each lesson lives).
/// `limit` clamps the list; the UI drives sorting/filtering client-side, so the backend
/// only does the WHERE + the bounded fetch.
#[tauri::command]
pub fn tg_import_history(
    db: State<'_, Db>,
    limit: Option<u32>,
) -> AppResult<Vec<TgImportedMaterial>> {
    let limit = limit.unwrap_or(200).clamp(1, 1000) as usize;

    db.with(move |conn| {
        let sql = r#"
            SELECT m.id, m.node_id, m.file_name, m.file_type, m.file_extension,
                   m.duration_secs, m.file_size_bytes,
                   COALESCE(wp.completion_pct, 0.0)                 AS progress_pct,
                   COALESCE(wp.completed, 0)                        AS is_completed,
                   COALESCE(m.is_bookmarked, 0)                     AS is_bookmarked,
                   m.last_opened_at,
                   m.tg_chat_id, m.tg_message_id
            FROM materials m
            LEFT JOIN watch_progress wp ON wp.material_id = m.id
            WHERE m.source = 'telegram'
            ORDER BY COALESCE(m.last_opened_at, m.created_at) DESC
            LIMIT ?1
        "#;
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map([limit as i64], |r| {
            Ok(TgImportedMaterial {
                material_id: r.get(0)?,
                node_id: r.get(1)?,
                node_path: String::new(), // filled below
                file_name: r.get(2)?,
                file_type: r.get(3)?,
                file_extension: r.get(4)?,
                duration_secs: r.get(5)?,
                file_size_bytes: r.get(6)?,
                progress_pct: r.get(7)?,
                is_completed: r.get(8)?,
                is_bookmarked: r.get(9)?,
                last_opened_at: r.get(10)?,
                tg_chat_id: r.get(11)?,
                tg_message_id: r.get(12)?,
            })
        })?;
        let mut items = Vec::with_capacity(limit.min(64));
        for row in rows {
            let mut item = row?;
            item.node_path = ancestry_path(conn, item.node_id)?;
            items.push(item);
        }
        Ok(items)
    })
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

    // Channel-reference parsing now lives in `link.rs` as `parse_channel_link` (it grew invite
    // support), and is tested there.
}

#[cfg(test)]
mod peer_ref_tests {
    use super::*;

    /// The whole reason Gemini's retry could not work.
    ///
    /// `to_ambient_ref()` is defined as `PeerAuth::default()`, which is `PeerAuth(0)` — and
    /// `get_messages_by_id` serializes `channel: peer.into()` with NO session lookup. So
    /// priming the cache and re-issuing the same ambient call rebuilds byte-identical wire
    /// data and fails identically. If this assertion ever breaks, the ambient ref started
    /// carrying real authority and `resolve_peer_ref`'s early return must be re-examined.
    #[test]
    fn ambient_ref_carries_no_access_hash() {
        let id = PeerId::channel(3718178315).expect("valid channel id");
        assert_eq!(
            id.to_ambient_ref().auth,
            PeerAuth::default(),
            "an ambient ref must be the zero authority — this is what private channels reject"
        );
        assert_eq!(PeerAuth::default().hash(), 0);
    }

    /// A resolved hash must survive into the PeerRef unchanged; a truncated or re-derived
    /// hash would fail exactly like the ambient one and look like the same bug.
    #[test]
    fn resolved_hash_is_preserved_verbatim() {
        let id = PeerId::channel(3718178315).expect("valid channel id");
        let hash = -8_223_372_036_854_775_123_i64; // large negative: the common real shape
        let peer_ref = PeerRef {
            id,
            auth: PeerAuth::from_hash(hash),
        };
        assert_eq!(peer_ref.auth.hash(), hash);
        assert_ne!(peer_ref.auth, PeerAuth::default());
    }
}
