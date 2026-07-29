//! IPC commands for the To-Do list (Tasks) + the Planning Hub + Consistency engine.
//!
//! Tasks are a lightweight list with an optional due DATETIME, priority, effort
//! estimate, and a deep-link to a material. The Planning Hub reads the same `tasks`
//! data (no fragmented table). The Consistency engine reads pre-aggregated daily
//! snapshots from `consistency_log`. Follows the established pattern: `db: State<Db>`,
//! work inside `db.with`, return `AppResult<T>`. Registered in `lib.rs`.

use tauri::State;

use crate::db::queries::{self, ConsistencySummary, Task};
use crate::db::Db;
use crate::utils::errors::{AppError, AppResult};

/// List all tasks (unfinished first, then priority, due date, manual order).
#[tauri::command]
pub fn list_tasks(db: State<'_, Db>) -> AppResult<Vec<Task>> {
    db.with(|conn| queries::list_tasks(conn))
}

/// Create a task. `priority` 0-3; `due_at` (ISO datetime) / `material_id` /
/// `estimated_mins` optional. Returns the new id.
#[tauri::command]
pub fn create_task(
    db: State<'_, Db>,
    title: String,
    priority: i64,
    due_at: Option<String>,
    material_id: Option<i64>,
    estimated_mins: Option<i64>,
) -> AppResult<i64> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::Invalid("task title is required".into()));
    }
    let priority = priority.clamp(0, 3);
    db.with(|conn| {
        queries::create_task(
            conn,
            title,
            priority,
            due_at.as_deref(),
            material_id,
            estimated_mins,
        )
    })
}

/// Update a task's editable fields (title, priority, due date, material link, estimate).
#[tauri::command]
pub fn update_task(
    db: State<'_, Db>,
    id: i64,
    title: String,
    priority: i64,
    due_at: Option<String>,
    material_id: Option<i64>,
    estimated_mins: Option<i64>,
) -> AppResult<()> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::Invalid("task title is required".into()));
    }
    let priority = priority.clamp(0, 3);
    db.with(|conn| {
        queries::update_task(
            conn,
            id,
            title,
            priority,
            due_at.as_deref(),
            material_id,
            estimated_mins,
        )
    })
}

/// Set a task's done flag (stamps/clears `completed_at`). Re-snapshots today's
/// consistency row so completing a task immediately reflects in the score.
#[tauri::command]
pub fn set_task_done(db: State<'_, Db>, id: i64, done: bool) -> AppResult<()> {
    db.with(|conn| {
        queries::set_task_done(conn, id, done)?;
        // Cheap single upsert — keeps today's snapshot fresh without a background loop.
        let today: String = conn.query_row("SELECT date('now')", [], |r| r.get(0))?;
        let _ = queries::snapshot_day(conn, &today);
        Ok(())
    })
}

/// Delete a task.
#[tauri::command]
pub fn delete_task(db: State<'_, Db>, id: i64) -> AppResult<()> {
    db.with(|conn| queries::delete_task(conn, id))
}

/// The Consistency summary (headline score, streak, per-day series) for the last
/// `window_days` days (default 91 ≈ 13 weeks, a full heatmap). Runs whether or not the
/// strict UI is enabled — the `enabled` flag in the payload gates the UI, not the data.
#[tauri::command]
pub fn consistency_summary(
    db: State<'_, Db>,
    window_days: Option<i64>,
) -> AppResult<ConsistencySummary> {
    let days = window_days.unwrap_or(91);
    db.with(|conn| queries::consistency_summary(conn, days))
}
