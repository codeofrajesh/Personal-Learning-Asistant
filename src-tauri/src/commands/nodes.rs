//! IPC commands for the infinite-depth node tree browser (Section 11, v6).
//!
//! The unified file-explorer browser drills through the `nodes` adjacency tree
//! directly (no goal/subject/chapter shim):
//!
//! - [`node_children`] — direct child folders of a node (or the root goals when the
//!   parent is null), each with rolled-up subtree counts + a cover thumbnail.
//! - [`node_ancestors`] — the root-first ancestry chain for the breadcrumb.
//! - [`node_materials`] — the materials sitting directly under a node.
//!
//! Each follows the established pattern: `db: State<Db>`, work inside `db.with`,
//! return `AppResult<T>`.

use tauri::{AppHandle, Emitter, State};

use crate::db::queries::{self, MaterialRow, NodeCard, NodeCrumb, RemoveOutcome};
use crate::db::Db;
use crate::scanner::watcher::WatcherManager;
use crate::utils::errors::AppResult;

/// Fired after a successful delete so every open page (Courses, Dashboard, Library,
/// Explore) refetches — the same event the live watcher emits after a rescan.
const LIBRARY_CHANGED_EVENT: &str = "library://changed";

/// Best-effort removal of local material files from disk, then removal of the
/// now-empty directory skeleton above them (bottom-up, stopping at the first
/// non-empty directory or the drive root). `tg://` keys and missing/read-only
/// files are skipped, and all IO errors are swallowed: the DB delete is the
/// source of truth, disk cleanup is a courtesy so a later watcher rescan can't
/// silently re-import a row the user deleted.
fn remove_local_files(paths: &[String]) -> i64 {
    let mut deleted_files: i64 = 0;

    for p in paths {
        let path = std::path::Path::new(p);
        // Only real local files are touched (`tg://` keys are never disk paths).
        if !path.is_file() || std::fs::remove_file(path).is_err() {
            continue;
        }
        deleted_files += 1;

        // Climb the ancestry, dropping every directory that is now empty. On Windows
        // the drive root's `parent()` is None, so the walk naturally stops there, and
        // `remove_dir` FAILS on a non-empty directory — so a sibling file, a
        // Telegram-only folder, or any other real content halts the climb safely.
        let mut dir = path.parent().map(|d| d.to_path_buf());
        while let Some(d) = dir {
            match std::fs::remove_dir(&d) {
                Ok(()) => dir = d.parent().map(|p| p.to_path_buf()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    // Someone (an earlier file in this batch) already removed it —
                    // keep climbing so shared parents still collapse.
                    dir = d.parent().map(|p| p.to_path_buf());
                }
                // Non-empty / missing parent / permissions / drive root → stop.
                Err(_) => break,
            }
        }
    }

    deleted_files
}

// ── Courses hub sections (v8) ──────────────────────────────────────────────────
// The redesigned Courses page is a multi-section hub. Each section is a capped grid of
// NodeCards; "Explore ›" drills into a full-list page. These three feeds back the
// Pinned / In-Progress / Recently-Added sections (Continue Learning reuses
// `dashboard_data`, All Courses reuses `node_children(null)`).

/// Direct child folder nodes of `parent_id`, or the root goals when `parent_id` is
/// `None`. Each carries rolled-up subtree material/completed counts + a cover.
#[tauri::command]
pub fn node_children(db: State<'_, Db>, parent_id: Option<i64>) -> AppResult<Vec<NodeCard>> {
    db.with(|conn| queries::node_children(conn, parent_id))
}

/// The ancestry chain of `node_id`, root-first, for the breadcrumb.
#[tauri::command]
pub fn node_ancestors(db: State<'_, Db>, node_id: i64) -> AppResult<Vec<NodeCrumb>> {
    db.with(|conn| queries::node_ancestors(conn, node_id))
}

/// Materials sitting directly under `node_id`.
#[tauri::command]
pub fn node_materials(db: State<'_, Db>, node_id: i64) -> AppResult<Vec<MaterialRow>> {
    db.with(|conn| queries::node_materials(conn, node_id))
}

/// Nodes the user has pinned to the Courses hub ("Pinned" section + Explore Pinned).
#[tauri::command]
pub fn pinned_nodes(db: State<'_, Db>) -> AppResult<Vec<NodeCard>> {
    db.with(queries::pinned_nodes)
}

/// Root courses partway done ("In Progress" section + Explore).
#[tauri::command]
pub fn nodes_in_progress(db: State<'_, Db>) -> AppResult<Vec<NodeCard>> {
    db.with(queries::nodes_in_progress)
}

/// Root courses newest-first ("Recently Added" section + Explore).
#[tauri::command]
pub fn recent_nodes(db: State<'_, Db>) -> AppResult<Vec<NodeCard>> {
    db.with(queries::recent_nodes)
}

/// Pin or unpin a node (the hub "Pin" control). Mirrors `set_bookmark` for materials.
#[tauri::command]
pub fn set_node_pinned(db: State<'_, Db>, node_id: i64, pinned: bool) -> AppResult<()> {
    db.with(|conn| queries::set_node_pinned(conn, node_id, pinned))
}

/// Delete a folder node and its ENTIRE subtree — every descendant subfolder and every
/// material inside them — in one transaction.
///
/// After the DB commit: any OS watcher rooted inside the deleted subtree is dropped (a
/// deleted `registered_dirs` row can't be rescanned), local material files are
/// best-effort removed from disk so a future rescan can't re-import them, and
/// `library://changed` is emitted so open pages refresh.
#[tauri::command]
pub fn remove_node(app: AppHandle, db: State<'_, Db>, node_id: i64) -> AppResult<RemoveOutcome> {
    let result = db.with_mut(|conn| queries::remove_node(conn, node_id))?;
    for dir_id in &result.unwatch_dir_ids {
        WatcherManager::remove_watch(&app, *dir_id);
    }
    let _ = app.emit(LIBRARY_CHANGED_EVENT, node_id);
    Ok(RemoveOutcome {
        nodes_deleted: result.outcome.nodes_deleted,
        materials_deleted: result.outcome.materials_deleted,
        files_deleted: remove_local_files(&result.local_files),
    })
}

/// Delete a single material (lesson) row. Study sessions detach (FK safety), local
/// files are best-effort removed from disk, and `library://changed` is emitted.
#[tauri::command]
pub fn remove_material(
    app: AppHandle,
    db: State<'_, Db>,
    material_id: i64,
) -> AppResult<RemoveOutcome> {
    let result = db.with_mut(|conn| queries::remove_material(conn, material_id))?;
    let _ = app.emit(LIBRARY_CHANGED_EVENT, material_id);
    Ok(RemoveOutcome {
        nodes_deleted: 0,
        materials_deleted: result.outcome.materials_deleted,
        files_deleted: remove_local_files(&result.local_files),
    })
}
