//! Telegram plugin module.
//!
//! Registers the `tg_*` IPC commands and manages the `TgState` lifecycle.

pub mod auth;
pub mod import;
pub mod link;
pub mod session;

use crate::plugins::telegram::session::TgState;
use tauri::Manager;

/// Register the Telegram plugin's managed state. Does NOT connect to Telegram yet —
/// the client is created lazily on the first auth command.
pub fn init(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let state = TgState::new();
    app.manage(state);
    Ok(())
}