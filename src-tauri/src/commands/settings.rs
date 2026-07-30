//! IPC commands for Settings (Section 8 Page 7) + Data management (Section 10).
//!
//! Covers: registered-directory listing / removal / rescan, key/value settings get/set,
//! export-to-JSON-file, database backup (copy `ple.db`), and JSON import/merge. Each
//! follows the established pattern: `db: State<Db>`, work inside `db.with` /
//! `db.with_mut`, return `AppResult<T>`.
//!
//! Rescan reuses the walker + batched-import pipeline (`import_chapter_groups`) and
//! emits the same `scan://progress` events as the initial import, so the wizard's
//! progress UI could be reused if desired.

use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::queries::{self, ExportPayload, ImportCounts, ImportSummary, RegisteredDir};
use crate::db::Db;
use crate::scanner::walker;
use crate::utils::errors::{AppError, AppResult};

const SCAN_PROGRESS_EVENT: &str = "scan://progress";

/// A `scan://progress` payload (kept structurally identical to `scanner::ScanProgress`
/// so the same frontend listener handles both initial import and rescan).
#[derive(Debug, Clone, Serialize)]
pub struct ScanProgress {
    pub stage: String,
    pub files_imported: i64,
    pub files_total: i64,
    pub done: bool,
}

// ── Registered folders ───────────────────────────────────────────────────────

/// List registered folders for the Manage Folders panel.
#[tauri::command]
pub fn list_registered_dirs(db: State<'_, Db>) -> AppResult<Vec<RegisteredDir>> {
    db.with(|conn| queries::list_registered_dirs(conn))
}

/// Unregister a folder (delete its `registered_dirs` row). Materials stay in the
/// library. Also stops watching the folder.
#[tauri::command]
pub fn remove_registered_dir(app: AppHandle, db: State<'_, Db>, id: i64) -> AppResult<()> {
    db.with(|conn| queries::remove_registered_dir(conn, id))?;
    crate::scanner::watcher::WatcherManager::remove_watch(&app, id);
    Ok(())
}

/// Re-scan a registered folder: walk it and upsert any new/changed materials under its
/// existing subject. Emits `scan://progress` events like the initial import. Returns the
/// scanner's `ImportCounts` (chapters touched + materials imported).
#[tauri::command]
pub fn rescan_folder(app: AppHandle, db: State<'_, Db>, id: i64) -> AppResult<ImportCounts> {
    let (path, root_node_id) = db.with(|conn| queries::registered_dir_for_rescan(conn, id))?;

    let dir = Path::new(&path);
    if !dir.exists() {
        return Err(AppError::NotFound(format!(
            "folder no longer exists: {path}"
        )));
    }

    let _ = app.emit(
        SCAN_PROGRESS_EVENT,
        ScanProgress {
            stage: "walking".into(),
            files_imported: 0,
            files_total: 0,
            done: false,
        },
    );
    let nodes = walker::scan_tree(dir);
    let files_total: i64 = nodes.iter().map(|g| g.files.len() as i64).sum();

    let app_for_cb = app.clone();
    let counts = db.with_mut(|conn| {
        queries::import_tree(conn, root_node_id, &nodes, |folder, imported| {
            let _ = app_for_cb.emit(
                SCAN_PROGRESS_EVENT,
                ScanProgress {
                    stage: folder.to_string(),
                    files_imported: imported,
                    files_total,
                    done: false,
                },
            );
        })
    })?;

    db.with(|conn| queries::mark_dir_scanned(conn, id))?;

    let _ = app.emit(
        SCAN_PROGRESS_EVENT,
        ScanProgress {
            stage: "done".into(),
            files_imported: counts.materials_imported,
            files_total,
            done: true,
        },
    );

    Ok(counts)
}

// ── Key/value settings ───────────────────────────────────────────────────────

/// Read a setting (`None` if unset).
#[tauri::command]
pub fn get_setting(db: State<'_, Db>, key: String) -> AppResult<Option<String>> {
    db.with(|conn| queries::get_setting(conn, &key))
}

/// Write a setting (upsert).
#[tauri::command]
pub fn set_setting(db: State<'_, Db>, key: String, value: String) -> AppResult<()> {
    db.with(|conn| queries::set_setting(conn, &key, &value))
}

// ── Data management (Section 10) ─────────────────────────────────────────────

/// Export the full content tree + settings to a JSON file at `path`.
#[tauri::command]
pub fn export_data_to_file(db: State<'_, Db>, path: String) -> AppResult<()> {
    let payload = db.with(|conn| queries::build_export(conn))?;
    let json = serde_json::to_string_pretty(&payload)
        .map_err(|e| AppError::Other(format!("failed to serialize export: {e}")))?;
    std::fs::write(&path, json).map_err(|e| AppError::Io(e))
}

/// Backup the database: checkpoint WAL, then copy `ple.db` to `dest`.
#[tauri::command]
pub fn backup_database(app: AppHandle, db: State<'_, Db>, dest: String) -> AppResult<()> {
    // Flush the WAL into the main db file so the copy is complete.
    db.with(|conn| {
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
        Ok(())
    })?;

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Other(format!("failed to resolve app_data_dir: {e}")))?;
    let src = data_dir.join("ple.db");
    std::fs::copy(&src, &dest).map_err(|e| AppError::Io(e))?;
    Ok(())
}

/// Merge a JSON export file into the DB (duplicates resolve via upserts).
#[tauri::command]
pub fn import_data_from_file(db: State<'_, Db>, path: String) -> AppResult<ImportSummary> {
    let content = std::fs::read_to_string(&path).map_err(|e| AppError::Io(e))?;
    let payload: ExportPayload = serde_json::from_str(&content)
        .map_err(|e| AppError::Other(format!("invalid export file: {e}")))?;
    db.with_mut(|conn| queries::merge_import(conn, &payload))
}
