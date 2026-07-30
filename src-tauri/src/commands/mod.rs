//! Tauri IPC commands.
//!
//! Each `#[tauri::command]` here is invokable from the React frontend via
//! `invoke("name", args)`. For the foundation milestone we expose the health-check
//! roundtrip; feature commands live in their respective submodules and are added
//! as those features are built (Section 12 structure).

pub mod chapters;
pub mod goals;
pub mod library;
pub mod materials;
pub mod nodes;
pub mod player;
pub mod progress;
pub mod scanner;
pub mod settings;
pub mod subjects;
pub mod tasks;

use serde::Serialize;
use tauri::State;

use crate::db::{queries, Db};
use crate::utils::errors::AppResult;

/// Result of the IPC roundtrip smoke test (Section 14, step 3).
#[derive(Debug, Serialize)]
pub struct HealthReport {
    /// Echo of the token we wrote and read back — proves write+read works.
    pub echo: String,
    /// Number of goals currently in the DB — proves a real table query works.
    pub goal_count: i64,
    /// Backend version string.
    pub version: String,
}

/// Write a token to the DB and read it back, plus report basic DB state.
///
/// This is the canonical "does the whole stack work?" command: React → Tauri IPC
/// → Rust → SQLite (write) → SQLite (read) → Rust → React.
#[tauri::command]
pub fn health_check(db: State<'_, Db>, token: String) -> AppResult<HealthReport> {
    db.with(|conn| {
        let echo = queries::health_check(conn, &token)?;
        let goal_count = queries::count_rows(conn, "nodes")?;
        Ok(HealthReport {
            echo,
            goal_count,
            version: env!("CARGO_PKG_VERSION").to_string(),
        })
    })
}

/// Aggregated data for the Dashboard bento grid (Section 8, Page 1 / Section 11
/// "Dashboard Load"): progress stats, Continue Learning, bookmarks, 7-day activity,
/// and the weekly streak — all real rows, honest zeros where a feature has no data.
#[tauri::command]
pub fn dashboard_data(db: State<'_, Db>) -> AppResult<queries::DashboardData> {
    db.with(|conn| queries::dashboard_data(conn))
}
