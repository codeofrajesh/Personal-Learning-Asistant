//! IPC commands for the Ambient Sound Hub (online search, offline caching, favorites).
//!
//! WHY these live in Rust rather than the webview: the app's CSP (`tauri.conf.json`) does not
//! grant `connect-src https:`, so the webview cannot fetch the FreeSound / Internet Archive
//! JSON APIs or download audio bytes directly. Doing it here keeps that CSP locked AND keeps the
//! FreeSound API token server-side (read from the `settings` table, never shipped to the client).
//! `media-src` IS widened to the trusted audio hosts, so once we hand the frontend a remote
//! preview/stream URL (or a locally-cached file path) an `<audio>` element can play it.
//!
//! SomaFM is intentionally absent here — it's a tiny static catalog of keyless 24/7 streams the
//! frontend holds directly; only the searchable sources (FreeSound, Archive.org) need a broker.

use std::io::Write;

use futures_util::future::join_all;
use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::db::queries::{self, AmbientFavorite};
use crate::db::Db;
use crate::utils::errors::{AppError, AppResult};

/// Settings key holding the user's FreeSound APIv2 token (entered in Settings).
const FREESOUND_TOKEN_KEY: &str = "ambient.freesound_token";

/// A normalized search hit, uniform across sources. `preview_url` is a remote URL a CSP-allowed
/// `<audio>` can stream directly; `cache_ambient_audio` can later persist it for offline use.
#[derive(Debug, Serialize)]
pub struct AmbientResult {
    pub source: String,
    pub external_id: String,
    pub name: String,
    pub duration_secs: Option<f64>,
    pub preview_url: String,
    pub attribution: Option<String>,
    pub tags: Option<String>,
}

/// Build a reqwest client with a sane timeout + identifying UA (Archive.org asks callers to
/// identify themselves; a bare client sometimes gets throttled).
fn http_client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(25))
        .user_agent("PLE-LearningApp/0.1 (ambient-hub)")
        .build()
        .map_err(|e| AppError::Other(format!("failed to build HTTP client: {e}")))
}

// ── Search ───────────────────────────────────────────────────────────────────

/// Search an online source for ambient/nature/SFX audio. `source` is 'freesound' | 'archive'.
/// Returns up to ~20 normalized hits. Network/parse failures surface as `AppError::Other`; a
/// missing FreeSound token surfaces as `AppError::Invalid` so the UI can prompt for it.
#[tauri::command]
pub async fn ambient_search(
    db: State<'_, Db>,
    source: String,
    query: String,
    page: Option<i64>,
) -> AppResult<Vec<AmbientResult>> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let page = page.unwrap_or(1).max(1);

    match source.as_str() {
        "freesound" => {
            // Read the token synchronously BEFORE any await — never hold the DB guard across it.
            let token = db
                .with(|c| queries::get_setting(c, FREESOUND_TOKEN_KEY))?
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
                .ok_or_else(|| {
                    AppError::Invalid(
                        "FreeSound API token not set. Add it in Settings → Ambient.".into(),
                    )
                })?;
            search_freesound(&query, page, &token).await
        }
        "archive" => search_archive(&query, page).await,
        other => Err(AppError::Invalid(format!("unknown ambient source: {other}"))),
    }
}

/// FreeSound APIv2 text search. The `preview-hq-mp3` field is a 128kbps stereo stream URL.
async fn search_freesound(query: &str, page: i64, token: &str) -> AppResult<Vec<AmbientResult>> {
    let client = http_client()?;
    let resp = client
        .get("https://freesound.org/apiv2/search/text/")
        .query(&[
            ("query", query),
            ("filter", "duration:[5.0 TO 600.0]"),
            ("fields", "id,name,previews,duration,username,tags,license"),
            ("page_size", "20"),
            ("page", &page.to_string()),
            ("token", token),
        ])
        .send()
        .await
        .map_err(|e| AppError::Other(format!("FreeSound request failed: {e}")))?;

    if resp.status() == reqwest::StatusCode::UNAUTHORIZED
        || resp.status() == reqwest::StatusCode::FORBIDDEN
    {
        return Err(AppError::Invalid(
            "FreeSound rejected the API token. Check it in Settings → Ambient.".into(),
        ));
    }
    if !resp.status().is_success() {
        return Err(AppError::Other(format!(
            "FreeSound returned HTTP {}",
            resp.status()
        )));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| AppError::Other(format!("FreeSound response was not valid JSON: {e}")))?;

    let mut out = Vec::new();
    if let Some(results) = body.get("results").and_then(|r| r.as_array()) {
        for r in results {
            let id = match r.get("id").and_then(|v| v.as_i64()) {
                Some(id) => id,
                None => continue,
            };
            // Prefer the HQ mp3 preview; fall back to the LQ one.
            let preview_url = r
                .get("previews")
                .and_then(|p| {
                    p.get("preview-hq-mp3")
                        .or_else(|| p.get("preview-lq-mp3"))
                })
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let preview_url = match preview_url {
                Some(u) => u,
                None => continue,
            };
            let name = r
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("Untitled")
                .to_string();
            let duration_secs = r.get("duration").and_then(|v| v.as_f64());
            let username = r.get("username").and_then(|v| v.as_str()).unwrap_or("");
            let license = r.get("license").and_then(|v| v.as_str()).unwrap_or("");
            let attribution = if username.is_empty() {
                None
            } else {
                Some(format!("{username} · FreeSound{}", if license.is_empty() { String::new() } else { format!(" ({license})") }))
            };
            let tags = r
                .get("tags")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|t| t.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                });

            out.push(AmbientResult {
                source: "freesound".into(),
                external_id: id.to_string(),
                name,
                duration_secs,
                preview_url,
                attribution,
                tags,
            });
        }
    }
    Ok(out)
}

/// Internet Archive search. `advancedsearch.php` yields identifiers + titles; we then resolve
/// each item's first playable audio file via the `metadata` endpoint (concurrently, since
/// Archive imposes no rate limit) to build a direct download/stream URL.
async fn search_archive(query: &str, page: i64) -> AppResult<Vec<AmbientResult>> {
    let client = http_client()?;
    // Constrain to audio media; filter out access-restricted items (which reject direct streams with 401).
    let q = format!("({query}) AND mediatype:audio AND -access-restricted-item:true");
    let resp = client
        .get("https://archive.org/advancedsearch.php")
        .query(&[
            ("q", q.as_str()),
            ("fl[]", "identifier"),
            ("fl[]", "title"),
            ("fl[]", "creator"),
            ("rows", "12"),
            ("page", &page.to_string()),
            ("output", "json"),
        ])
        .send()
        .await
        .map_err(|e| AppError::Other(format!("Archive.org request failed: {e}")))?;

    if !resp.status().is_success() {
        return Err(AppError::Other(format!(
            "Archive.org returned HTTP {}",
            resp.status()
        )));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| AppError::Other(format!("Archive.org response was not valid JSON: {e}")))?;

    let docs = body
        .get("response")
        .and_then(|r| r.get("docs"))
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();

    // Resolve each item's playable file concurrently.
    let futures = docs.into_iter().map(|doc| {
        let client = client.clone();
        async move {
            let identifier = doc.get("identifier").and_then(|v| v.as_str())?.to_string();
            let title = doc
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or(&identifier)
                .to_string();
            let creator = doc
                .get("creator")
                .and_then(|v| match v {
                    serde_json::Value::String(s) => Some(s.clone()),
                    serde_json::Value::Array(a) => {
                        a.first().and_then(|x| x.as_str()).map(|s| s.to_string())
                    }
                    _ => None,
                });
            let (file_name, duration_secs) = resolve_archive_file(&client, &identifier).await?;
            let preview_url = format!(
                "https://archive.org/download/{}/{}",
                identifier,
                percent_encode_path(&file_name)
            );
            let attribution = creator
                .map(|c| format!("{c} · Internet Archive"))
                .or_else(|| Some("Internet Archive".into()));
            Some(AmbientResult {
                source: "archive".into(),
                external_id: identifier,
                name: title,
                duration_secs,
                preview_url,
                attribution,
                tags: None,
            })
        }
    });

    let resolved = join_all(futures).await;
    Ok(resolved.into_iter().flatten().collect())
}

/// Fetch an Archive item's metadata and pick the first streamable audio file (prefer MP3, then
/// OGG). Returns `(file_name, duration_secs)`, or `None` if the item has no usable audio file.
async fn resolve_archive_file(
    client: &reqwest::Client,
    identifier: &str,
) -> Option<(String, Option<f64>)> {
    let url = format!("https://archive.org/metadata/{identifier}");
    let body: serde_json::Value = client.get(&url).send().await.ok()?.json().await.ok()?;

    // Drop items marked as access-restricted (they reject unauthenticated streams with 401).
    if body
        .get("metadata")
        .and_then(|m| m.get("access-restricted-item"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return None;
    }

    let files = body.get("files")?.as_array()?;

    // Prefer a real MP3; accept OGG as a fallback. Skip derivative/spectrogram junk.
    let mut mp3: Option<(String, Option<f64>)> = None;
    let mut ogg: Option<(String, Option<f64>)> = None;
    for f in files {
        let name = match f.get("name").and_then(|v| v.as_str()) {
            Some(n) => n,
            None => continue,
        };
        let lower = name.to_ascii_lowercase();
        let dur = f
            .get("length")
            .and_then(|v| v.as_str())
            .and_then(parse_archive_length);
        if lower.ends_with(".mp3") && mp3.is_none() {
            mp3 = Some((name.to_string(), dur));
        } else if lower.ends_with(".ogg") && ogg.is_none() {
            ogg = Some((name.to_string(), dur));
        }
    }
    mp3.or(ogg)
}

/// Archive `length` is either seconds ("213.53") or "MM:SS" / "H:MM:SS".
fn parse_archive_length(raw: &str) -> Option<f64> {
    if let Ok(secs) = raw.parse::<f64>() {
        return Some(secs);
    }
    let mut total = 0.0;
    for part in raw.split(':') {
        let n: f64 = part.parse().ok()?;
        total = total * 60.0 + n;
    }
    Some(total)
}

/// Percent-encode a single URL path segment (Archive file names contain spaces, parentheses,
/// etc.). Encodes everything outside the unreserved set — avoids pulling in a urlencoding crate.
fn percent_encode_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// ── Offline caching ────────────────────────────────────────────────────────────

/// Download an online sound to `app_data_dir/ambient_cache/` for offline study and return the
/// absolute local path. Streams to disk (no full-file buffering, per the low-RAM target). If the
/// sound is already a favorite, its `cached_path` is updated so the UI can play it offline.
#[tauri::command]
pub async fn cache_ambient_audio(
    app: AppHandle,
    db: State<'_, Db>,
    url: String,
    name: String,
    source: String,
    external_id: String,
) -> AppResult<String> {
    let cache_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Other(format!("failed to resolve app_data_dir: {e}")))?
        .join("ambient_cache");
    std::fs::create_dir_all(&cache_dir)?;

    // Deterministic file name keyed on the natural id, so re-caching overwrites rather than
    // duplicating. Extension guessed from the URL (default mp3).
    let ext = url
        .rsplit('.')
        .next()
        .map(|e| e.split(&['?', '#'][..]).next().unwrap_or("mp3"))
        .filter(|e| e.len() <= 4 && e.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or("mp3");
    let file_name = format!("{}_{}.{ext}", sanitize(&source), sanitize(&external_id));
    let dest = cache_dir.join(&file_name);

    let client = http_client()?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| AppError::Other(format!("download failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::Other(format!(
            "download returned HTTP {}",
            resp.status()
        )));
    }

    let mut file = std::fs::File::create(&dest)?;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppError::Other(format!("download stream error: {e}")))?;
        file.write_all(&chunk)?;
    }
    file.flush()?;

    let path_str = dest.to_string_lossy().to_string();
    // Best-effort: record the cache path on the favorite if this sound is starred. `name` is
    // accepted so a future caller could upsert a favorite here; today it only labels logs.
    let _ = name;
    db.with(|c| queries::set_ambient_cached_path(c, &source, &external_id, Some(&path_str)))?;
    Ok(path_str)
}

/// Delete a cached file from disk and clear the favorite's `cached_path`. No-op if the file is
/// already gone. Used by the offline-cache management UI to reclaim space.
#[tauri::command]
pub fn delete_cached_ambient(
    db: State<'_, Db>,
    source: String,
    external_id: String,
    path: String,
) -> AppResult<()> {
    if !path.is_empty() && std::path::Path::new(&path).exists() {
        let _ = std::fs::remove_file(&path);
    }
    db.with(|c| queries::set_ambient_cached_path(c, &source, &external_id, None))
}

/// Replace any character that isn't safe in a file name with `_`.
fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' })
        .collect()
}

// ── Favorites ────────────────────────────────────────────────────────────────

/// All starred sounds, newest first.
#[tauri::command]
pub fn list_ambient_favorites(db: State<'_, Db>) -> AppResult<Vec<AmbientFavorite>> {
    db.with(|c| queries::list_ambient_favorites(c))
}

/// Star a sound (idempotent on its natural key). Returns the row id.
#[tauri::command]
pub fn add_ambient_favorite(db: State<'_, Db>, favorite: AmbientFavorite) -> AppResult<i64> {
    db.with(|c| queries::add_ambient_favorite(c, &favorite))
}

/// Unstar a sound. Does not delete any cached file (use `delete_cached_ambient` for that).
#[tauri::command]
pub fn remove_ambient_favorite(
    db: State<'_, Db>,
    source: String,
    external_id: String,
) -> AppResult<()> {
    db.with(|c| queries::remove_ambient_favorite(c, &source, &external_id))
}
