//! IPC commands for the Video Player + material viewers (Section 8 Page 6, Section 10).
//!
//! Playback streams local files via the Tauri asset protocol — the frontend calls
//! `convertFileSrc(path)` and hands the resulting `asset://` URL to a `<video>` /
//! `<audio>` / `<iframe>` / `<img>`. The asset protocol supports HTTP range requests,
//! so seeking works natively with no custom HTTP server. That keeps the runtime
//! footprint small (the 4 GB / VLC-ish target) — there is no streaming code here.
//!
//! These commands cover only what the player UI can't do from the webview alone:
//! open + resume a material (one lookup), persist watch progress, toggle bookmark /
//! completion, and log a study session so the Dashboard activity chart + streak get
//! real data. Each follows the established pattern: `db: State<Db>`, work inside
//! `db.with` / `db.with_mut`, return `AppResult<T>`.

use serde::Serialize;
use tauri::State;

use crate::db::queries::{self, MaterialRow, Note, PlayerMaterial, Recommendation};
use crate::db::Db;
use crate::utils::errors::AppResult;

/// One player load: the material to open + its sibling materials (for the chapter
/// sidebar), in a single round-trip (mirrors `dashboard_data`, Section 11).
#[derive(Debug, Serialize)]
pub struct PlayerView {
    pub material: PlayerMaterial,
    pub siblings: Vec<MaterialRow>,
}

/// Open a material: fetch its file path + ancestry + saved resume position, plus the
/// sibling materials in the same chapter for the sidebar. Also stamps
/// `last_opened_at = now` (inside `material_for_player`) so Continue-Learning recency
/// updates. `NotFound` if the id doesn't exist.
#[tauri::command]
pub fn open_material(db: State<'_, Db>, material_id: i64) -> AppResult<PlayerView> {
    db.with(|conn| {
        let material = queries::material_for_player(conn, material_id)?;
        let siblings = queries::list_materials(conn, material.chapter_id)?;
        Ok(PlayerView { material, siblings })
    })
}

/// Persist watch progress (called on pause / seek / finish + a periodic safety flush).
/// Mirrors completion onto `materials` so rollups stay consistent.
#[tauri::command]
pub fn save_progress(
    db: State<'_, Db>,
    material_id: i64,
    position_secs: f64,
    duration_secs: f64,
) -> AppResult<()> {
    db.with_mut(|conn| queries::save_progress(conn, material_id, position_secs, duration_secs))
}

/// Toggle a material's bookmark flag (the row bookmark control).
#[tauri::command]
pub fn set_bookmark(db: State<'_, Db>, material_id: i64, bookmarked: bool) -> AppResult<()> {
    db.with(|conn| queries::set_bookmark(conn, material_id, bookmarked))
}

/// Explicitly set a material's completed flag (the `M` shortcut + control button).
#[tauri::command]
pub fn set_completed(db: State<'_, Db>, material_id: i64, completed: bool) -> AppResult<()> {
    db.with_mut(|conn| queries::mark_complete(conn, material_id, completed))
}

/// Log a study session of `seconds` ending now — feeds the Dashboard activity chart +
/// streak with genuine data. No-op for non-positive durations.
///
/// `material_id` is optional (a Pomodoro focus block need not target a file) and
/// `session_type` (`work` | `short_break` | `long_break`, default `work`) lets the
/// Pomodoro timer record breaks separately from study time. Player playback calls this
/// with a material id and the default `work` type.
#[tauri::command]
pub fn log_session(
    db: State<'_, Db>,
    material_id: Option<i64>,
    seconds: f64,
    session_type: Option<String>,
) -> AppResult<()> {
    let stype = session_type.as_deref().unwrap_or("work");
    db.with(|conn| queries::log_study_session(conn, material_id, seconds, stype))
}

// ── Timestamped notes (v5) ───────────────────────────────────────────────────

/// All notes for a material, earliest timestamp first.
#[tauri::command]
pub fn list_notes(db: State<'_, Db>, material_id: i64) -> AppResult<Vec<Note>> {
    db.with(|conn| queries::list_notes(conn, material_id))
}

/// Create a note at `timestamp_secs` (seconds into the material) with `body`. Returns id.
#[tauri::command]
pub fn create_note(
    db: State<'_, Db>,
    material_id: i64,
    timestamp_secs: f64,
    body: String,
) -> AppResult<i64> {
    db.with(|conn| queries::create_note(conn, material_id, timestamp_secs, &body))
}

/// Update a note's body.
#[tauri::command]
pub fn update_note(db: State<'_, Db>, id: i64, body: String) -> AppResult<()> {
    db.with(|conn| queries::update_note(conn, id, &body))
}

/// Delete a note.
#[tauri::command]
pub fn delete_note(db: State<'_, Db>, id: i64) -> AppResult<()> {
    db.with(|conn| queries::delete_note(conn, id))
}

/// Suggested lectures below the current video (next-in-series → same course → same goal).
#[tauri::command]
pub fn recommended_materials(
    db: State<'_, Db>,
    material_id: i64,
    limit: Option<i64>,
) -> AppResult<Vec<Recommendation>> {
    let limit = limit.unwrap_or(8).clamp(1, 24);
    db.with(|conn| queries::recommended_materials(conn, material_id, limit))
}

/// Read a local file and return its contents as a base64-encoded string.
/// Used by the PDF viewer: WebView2 blocks PDFs loaded via `asset://`,
/// so we read the bytes in Rust and hand them to the frontend as base64,
/// which creates a `blob:` URL that WebView2's PDF plugin can render.
#[tauri::command]
pub fn read_file_base64(path: String) -> AppResult<String> {
    use std::fs;
    let bytes = fs::read(&path)?;
    Ok(base64_encode(&bytes))
}

/// Read a local file and return its **raw bytes** via `tauri::ipc::Response` — no
/// base64 encoding/decoding, so a large PDF transfers ~1.3× faster and skips the
/// `atob` cost on the JS side. This is the fast path the PDF viewer uses: the bytes
/// arrive as an `ArrayBuffer`/`Uint8Array` and go straight to PDF.js
/// (`<Document file={{data}}>`). Falls back to `read_file_base64` if a caller needs a
/// string.
#[tauri::command]
pub fn read_file_bytes(path: String) -> AppResult<tauri::ipc::Response> {
    let bytes = std::fs::read(&path)?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Open a file with the OS's default application (the "system player" for videos).
///
/// The integrated HTML5 `<video>` player uses the WebView2/Chromium media engine, which
/// can't decode some formats — notably the **MKV/Matroska container** and the
/// **HEVC/H.265 codec** (common in downloaded lectures). For those, the file is handed
/// to the OS default app (VLC, Windows Media, mpv, …) which handles them fine. This is
/// the "Default Player: Integrated / mpv / VLC" path from Section 8 Page 7.
#[tauri::command]
pub fn open_in_system_player(path: String) -> AppResult<()> {
    #[cfg(target_os = "windows")]
    {
        // `cmd /C start "" "<path>"` opens with the default associated app. The empty
        // title arg ("") is required so a quoted path isn't treated as the title.
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &path])
            .spawn()?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(&path).spawn()?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open").arg(&path).spawn()?;
    }
    Ok(())
}

/// Simple base64 encoder (standard alphabet, no padding needed for data URIs,
/// but we include it for correctness). Avoids adding the `base64` crate
/// dependency for a single use.
fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(CHARS[((n >> 18) & 0x3F) as usize] as char);
        out.push(CHARS[((n >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            out.push(CHARS[((n >> 6) & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(CHARS[(n & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}
