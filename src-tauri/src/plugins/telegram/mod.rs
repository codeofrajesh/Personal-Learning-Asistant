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

/// Register the Telegram plugin's managed state. Does NOT connect to Telegram yet —
/// the client is created lazily on the first auth command, and the stream server binds
/// nothing until the first lesson is played.
pub fn init(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(TgState::new());
    app.manage(TgServer::new());
    Ok(())
}