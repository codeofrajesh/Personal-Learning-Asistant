//! Telegram plugin module.
//!
//! Registers the `tg_*` IPC commands and manages the `TgState` lifecycle.

pub mod auth;
pub mod import;
pub mod link;
pub mod reader;
pub mod server;
pub mod session;

use crate::plugins::telegram::server::TgServer;
use crate::plugins::telegram::session::TgState;
use tauri::Manager;

/// Ensure the local stream server is running and return its base URL.
///
/// Called by the frontend's source adapter just before playback. Starting lazily (rather than
/// at boot) means a user who never opens a Telegram lesson never has a socket bound, and the
/// base URL is stable for the app's lifetime so a mounted player's URL can't go stale.
#[tauri::command]
pub async fn tg_stream_base(
    app: tauri::AppHandle,
    server: tauri::State<'_, TgServer>,
) -> crate::utils::errors::AppResult<String> {
    server.ensure_started(app).await
}

/// Reset the error state for a Telegram stream so the player can retry it.
///
/// Called by the frontend when the user clicks "Retry" on a fatal/network error. Clears the
/// reader's per-file retry state (FloodWait budget, learned DC, auth flag, in-flight claims)
/// while keeping its chunk cache, so the retry re-fetches from Telegram without re-resolving
/// already-downloaded data. Returns true if the stream was found and reset.
#[tauri::command]
pub async fn tg_retry_stream(
    server: tauri::State<'_, TgServer>,
    chat_id: i64,
    message_id: i32,
) -> crate::utils::errors::AppResult<bool> {
    Ok(server.retry_stream(chat_id, message_id).await)
}

/// Register the Telegram plugin's managed state. Does NOT connect to Telegram yet —
/// the client is created lazily on the first auth command, and the stream server binds
/// nothing until the first lesson is played.
pub fn init(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(TgState::new());
    app.manage(TgServer::new());
    Ok(())
}