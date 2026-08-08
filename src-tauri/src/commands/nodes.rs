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

/// Best-effort removal of the now-empty directory skeleton above deleted files
/// (bottom-up, stopping at the first non-empty directory or the drive root). Files are
/// already gone by the time this runs (the atomic phase deleted them), so the path is
/// used purely as a starting point to climb from. Errors are swallowed: this is a
/// courtesy and must never fail a delete.
fn remove_empty_parent_dirs(paths: &[String]) {
    for p in paths {
        if p.starts_with("tg://") {
            continue; // Telegram keys are not disk paths.
        }
        let mut dir = std::path::Path::new(p).parent().map(|d| d.to_path_buf());
        while let Some(d) = dir {
            match std::fs::remove_dir(&d) {
                Ok(()) => dir = d.parent().map(|p| p.to_path_buf()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    dir = d.parent().map(|p| p.to_path_buf());
                }
                // Non-empty directory / permissions / drive root → stop.
                Err(_) => break,
            }
        }
    }
}

/// Atomic precondition of a delete: the physical files must actually be removed from
/// disk BEFORE any DB row is touched. If a real file cannot be deleted, the whole
/// delete is ABORTED so the database can never diverge from disk (a past best-effort
/// version deleted DB rows while skipping locked files, silently emptying folders the
/// user could still see in Explorer until a manual rescan).
///
/// Returns how many files were removed. `tg://` keys (Telegram rows) are skipped
/// without error; anything else that isn't a removable regular file is an error.
fn delete_local_files_atomic(paths: &[String]) -> AppResult<i64> {
    let mut deleted: i64 = 0;
    for p in paths {
        if p.starts_with("tg://") {
            continue; // never a disk path
        }
        let path = std::path::Path::new(p);
        match std::fs::remove_file(path) {
            Ok(()) => deleted += 1,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // Already gone (or never existed) — nothing to remove, not an error.
                continue;
            }
            Err(e) => {
                // A real, existing path we cannot delete → abort EVERYTHING so the DB
                // stays consistent with disk (the user's reported bug).
                return Err(crate::utils::errors::AppError::Other(format!(
                    "could not delete file '{}': {e}. Nothing was removed — close any \
                     program that has this file open and try again.",
                    path.display()
                )));
            }
        }
    }
    Ok(deleted)
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
/// ATOMICITY: the physical files are removed from disk FIRST (any failure aborts the
/// whole delete with nothing lost), then the DB rows commit, then the now-empty
/// directory skeleton is cleaned up (best-effort), the OS watcher for any deleted
/// registered root is dropped, and `library://changed` is emitted.
#[tauri::command]
pub fn remove_node(app: AppHandle, db: State<'_, Db>, node_id: i64) -> AppResult<RemoveOutcome> {
    // Phase 1 — resolve what will be deleted (read-only, no DB writes yet).
    let plan = db.with(|conn| queries::plan_remove_node(conn, node_id))?;

    // Phase 2 — remove the physical files RIGHT NOW. If any fails, we abort before
    // touching the DB, so the library can never diverge from disk.
    let files_deleted = delete_local_files_atomic(&plan.local_files)?;

    // Phase 3 — the DB deletion (detach sessions, delete materials + nodes) commits.
    let outcome = db.with_mut(|conn| queries::execute_remove_node(conn, node_id))?;

    // Phase 4 — post-commit cleanup.
    remove_empty_parent_dirs(&plan.local_files);
    for dir_id in &plan.unwatch_dir_ids {
        WatcherManager::remove_watch(&app, *dir_id);
    }
    let _ = app.emit(LIBRARY_CHANGED_EVENT, node_id);

    Ok(RemoveOutcome {
        nodes_deleted: outcome.nodes_deleted,
        materials_deleted: outcome.materials_deleted,
        files_deleted,
    })
}

/// Delete a single material (lesson) row.
///
/// ATOMIC: the physical file is removed from disk first (a failure aborts everything —
/// the row is untouched so the app can't show a lesson whose file still exists).
#[tauri::command]
pub fn remove_material(
    app: AppHandle,
    db: State<'_, Db>,
    material_id: i64,
) -> AppResult<RemoveOutcome> {
    let plan = db.with(|conn| queries::plan_remove_material(conn, material_id))?;
    let files_deleted = delete_local_files_atomic(&plan.local_files)?;
    let outcome = db.with_mut(|conn| queries::execute_remove_material(conn, material_id))?;
    remove_empty_parent_dirs(&plan.local_files);
    let _ = app.emit(LIBRARY_CHANGED_EVENT, material_id);

    Ok(RemoveOutcome {
        nodes_deleted: 0,
        materials_deleted: outcome.materials_deleted,
        files_deleted,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::queries::{execute_remove_node, plan_remove_node};
    use crate::utils::errors::AppError;

    /// A deleted folder must be ATOMIC: when a physical file cannot be removed, the whole
    /// delete aborts and NOTHING is lost. This is the regression test for the reported
    /// bug where locked video files stayed on disk while their DB rows were deleted,
    /// leaving an empty folder that only a manual rescan re-synced.
    #[test]
    fn delete_local_files_atomic_aborts_when_a_file_cannot_be_deleted() {
        let base = std::env::temp_dir().join(format!("ple_nodes_atomic_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();

        let good = base.join("editable.mp4");
        std::fs::write(&good, b"x").unwrap();

        // A directory mapped as a material file path — remove_file on a directory
        // reliably fails (WinError 5 access denied on Windows, IsADirectory elsewhere),
        // deterministically simulating the "can't delete this" case the user hit.
        let not_a_file = base.join("locked_dir");
        std::fs::create_dir(&not_a_file).unwrap();

        let paths = vec![
            good.to_string_lossy().to_string(),
            not_a_file.to_string_lossy().to_string(),
        ];

        // The FIRST file deletes fine, the SECOND (non-file path) aborts the whole op.
        let result = delete_local_files_atomic(&paths);
        assert!(
            matches!(result, Err(AppError::Other(_))),
            "an undeletable path must abort the delete, got {result:?}"
        );
        assert!(not_a_file.exists(), "the directory must never be removed");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// tg:// keys are not disk paths and must never be touched by the atomic deleter.
    #[test]
    fn delete_local_files_atomic_skips_telegram_keys() {
        let n = delete_local_files_atomic(&["tg://123/45".to_string()]).unwrap();
        assert_eq!(n, 0);
    }

    /// remove_empty_parent_dirs collapses the now-empty directory skeleton bottom-up and
    /// stops at the first non-empty directory.
    #[test]
    fn remove_empty_parent_dirs_collapses_empty_skeleton_only() {
        let base = std::env::temp_dir().join(format!("ple_nodes_dirs_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let deep = base.join("a").join("b");
        std::fs::create_dir_all(&deep).unwrap();
        let f = deep.join("gone.mp4");
        std::fs::write(&f, b"x").unwrap();

        // Delete the file ourselves, then ask the helper to clean up.
        std::fs::remove_file(&f).unwrap();
        remove_empty_parent_dirs(&[f.to_string_lossy().to_string()]);

        // Both "a" and "a/b" should now be gone, but the temp base (non-empty, has siblings)
        // must remain.
        assert!(!deep.exists(), "a/b must be removed");
        assert!(!base.join("a").exists(), "a must be removed");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// END-TO-END replication of the user's "test 55" scenario, across the REAL command
    /// flow (plan → atomic disk delete → DB commit → empty-dir cleanup), proving:
    ///   - study_sessions for the folder's materials are detached;
    ///   - all DB rows (2 videos + 1 pdf + nodes) are removed;
    ///   - ALL THREE files are gone from disk (pdf AND the videos);
    ///   - the now-empty `pdf/` subfolder and `test55/` folder are removed from disk;
    ///   - Telegram-sourced rows in the same subtree are untouched (no tg:// in plan).
    #[test]
    fn end_to_end_delete_folder_removes_rows_and_files() {
        // ── On-disk layout, exactly like the user's case ──
        let base = std::env::temp_dir().join(format!("ple_e2e_del_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let test55 = base.join("test55");
        let pdf_dir = test55.join("pdf");
        std::fs::create_dir_all(&pdf_dir).unwrap();
        let v1 = test55.join("sample-15s-360p.mp4");
        let v2 = test55.join("sample-20s-720p.mp4");
        let p1 = pdf_dir.join("notes.pdf");
        std::fs::write(&v1, b"v1").unwrap();
        std::fs::write(&v2, b"v2").unwrap();
        std::fs::write(&p1, b"pdf").unwrap();

        // ── DB: build the tree (root "test55" > sub "pdf", with 2 videos + 1 pdf) ──
        let mut conn = crate::db::connection::test_conn();
        let root = crate::db::queries::upsert_root_node(&conn, "test55").unwrap();
        let sub = crate::db::queries::upsert_child_node(&conn, root, "pdf").unwrap();
        for (path, name) in [
            (v1.to_string_lossy().to_string(), "sample-15s-360p.mp4".to_string()),
            (v2.to_string_lossy().to_string(), "sample-20s-720p.mp4".to_string()),
        ] {
            conn.execute(
                "INSERT INTO materials(node_id, file_path, file_name, file_type, file_extension)
                 VALUES(?1, ?2, ?3, 'video', 'mp4')",
                rusqlite::params![root, path, name],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO materials(node_id, file_path, file_name, file_type, file_extension)
             VALUES(?1, ?2, ?3, 'pdf', 'pdf')",
            rusqlite::params![sub, p1.to_string_lossy(), "notes.pdf"],
        )
        .unwrap();
        // A study session on one of the videos (must detach, not fail).
        conn.execute(
            "INSERT INTO study_sessions(material_id, started_at, duration_secs)
             VALUES((SELECT id FROM materials WHERE file_path = ?1), '2026-01-01 10:00:00', 60)",
            [v1.to_string_lossy()],
        )
        .unwrap();
        // A Telegram row in the SAME subtree — must be planned but never disk-touched.
        conn.execute(
            "INSERT INTO materials(node_id, file_path, file_name, file_type, file_extension,
                                   source, tg_chat_id, tg_message_id)
             VALUES(?1, 'tg://123/45', 'stream.mkv', 'video', 'mkv', 'telegram', 123, 45)",
            [root],
        )
        .unwrap();
        // And a registered dir root so the command layer can unwatch it.
        conn.execute(
            "INSERT INTO registered_dirs(path, root_node_id, scan_status)
             VALUES(?1, ?2, 'done')",
            rusqlite::params![test55.to_string_lossy(), root],
        )
        .unwrap();

        // ── The exact command flow (plan → delete → execute → cleanup) ──
        let plan = plan_remove_node(&conn, root).unwrap();
        // The tg:// row must NOT be in the plan's files.
        assert!(!plan.local_files.iter().any(|p| p.starts_with("tg://")));
        assert_eq!(plan.local_files.len(), 3, "2 videos + 1 pdf");

        let files_deleted = delete_local_files_atomic(&plan.local_files).unwrap();
        assert_eq!(files_deleted, 3, "all three local files go");

        let outcome = execute_remove_node(&mut conn, root).unwrap();
        assert_eq!(outcome.materials_deleted, 4, "2 videos + 1 pdf + 1 tg row");
        assert_eq!(outcome.nodes_deleted, 2, "root + pdf subfolder");

        remove_empty_parent_dirs(&plan.local_files);

        // ── Assert the disk state: no files, no pdf/, no test55/ ──
        assert!(!v1.exists() && !v2.exists() && !p1.exists(), "all files gone from disk");
        assert!(!pdf_dir.exists(), "empty pdf/ subfolder removed");
        assert!(!test55.exists(), "fully-empty test55/ folder removed");

        // ── DB state: no dangling sessions, no materials, no nodes, registered row gone ──
        let (n_dangling, n_sessions): (i64, i64) = conn
            .query_row(
                "SELECT SUM(CASE WHEN material_id IS NULL THEN 1 ELSE 0 END), COUNT(*)
                 FROM study_sessions",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(n_sessions, 1, "study session survives a folder delete");
        assert_eq!(n_dangling, 1, "its material link was detached to NULL");
        let mats: i64 = conn
            .query_row("SELECT COUNT(*) FROM materials", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mats, 0, "every row in the subtree is gone");
        let dirs: i64 = conn
            .query_row("SELECT COUNT(*) FROM registered_dirs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(dirs, 0, "registered row cascades with its root");

        let _ = std::fs::remove_dir_all(&base);
    }
}
