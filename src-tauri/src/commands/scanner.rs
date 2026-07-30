//! IPC commands for the folder-registration + scan pipeline.
//!
//! Three commands back the Add-Folder wizard (Section 2 / Section 8 Library page):
//!
//! - [`preview_folder`] — a read-only dry run that shows how a folder's sub-folders
//!   will map to chapters, so the user sees the result *before* committing.
//! - [`scan_and_import`] — the real import: create the goal/subject, walk the folder,
//!   batch-insert materials, register the directory, emitting live progress events.
//! - [`list_library`] — the goals-with-counts feed for the Library grid.
//!
//! All three follow the established command pattern: take `db: State<Db>`, do work
//! inside `db.with`/`db.with_mut`, and return `AppResult<T>`.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::db::queries::{self, GoalSummary};
use crate::db::Db;
use crate::scanner::walker::{self, ScannedNode};
use crate::utils::errors::{AppError, AppResult};

/// Event channel name for scan progress (frontend listens via `listen`).
const SCAN_PROGRESS_EVENT: &str = "scan://progress";

/// Input from the wizard's "Scan & Import" action. The picked folder attaches EITHER
/// under an existing node (`parent_node_id`) OR as a brand-new root goal
/// (`new_root_name`). Exactly one should be set; if both are, `parent_node_id` wins.
#[derive(Debug, Deserialize)]
pub struct WizardImport {
    /// Absolute path of the folder the user picked.
    pub path: String,
    /// Existing node to nest the imported folder under (None → create a new root).
    #[serde(default)]
    pub parent_node_id: Option<i64>,
    /// Name for a new root ("Goal") when `parent_node_id` is None.
    #[serde(default)]
    pub new_root_name: Option<String>,
}

/// One preview tree row: a folder that will become a node, at `depth` below the import
/// root, with the count of files directly inside it.
#[derive(Debug, Serialize)]
pub struct ChapterMapping {
    /// Cleaned folder name that will become a node (the deepest segment).
    pub chapter: String,
    /// Nesting depth below the import root (0 = the import root itself).
    pub depth: i64,
    /// How many supported files sit directly in this folder.
    pub file_count: i64,
}

/// Read-only summary returned by [`preview_folder`].
#[derive(Debug, Serialize)]
pub struct FolderPreview {
    /// The folder that was previewed.
    pub path: String,
    /// Suggested name for the import (the folder's own base name, cleaned).
    pub suggested_subject: String,
    /// Depth-aware folder tree that will be created, in discovery order.
    pub chapters: Vec<ChapterMapping>,
    /// Total supported files found (whole subtree).
    pub total_files: i64,
    /// Deepest nesting level detected (for the depth-cap warning in the UI).
    pub max_depth: i64,
    /// Per-type counts (video/pdf/note/image/audio) for the little tally row.
    pub type_counts: Vec<TypeCount>,
}

/// A `(file_type, count)` tally entry.
#[derive(Debug, Serialize)]
pub struct TypeCount {
    pub file_type: String,
    pub count: i64,
}

/// Progress event payload emitted during a scan.
#[derive(Debug, Clone, Serialize)]
pub struct ScanProgress {
    /// Chapter currently being written (or a status word like "walking").
    pub stage: String,
    /// Materials imported so far.
    pub files_imported: i64,
    /// Total materials expected (known after the walk completes).
    pub files_total: i64,
    /// True on the final event.
    pub done: bool,
}

/// Outcome returned to the wizard when the import finishes. `root_node_id` is the node the
/// folder was imported under (a new root, or the chosen existing parent).
#[derive(Debug, Serialize)]
pub struct ImportResult {
    pub root_node_id: i64,
    pub chapters_created: i64,
    pub materials_imported: i64,
}

/// Validate the path exists and is a directory, returning a typed error otherwise.
fn ensure_dir(path: &str) -> AppResult<&Path> {
    let p = Path::new(path);
    if !p.exists() {
        return Err(AppError::NotFound(format!("folder does not exist: {path}")));
    }
    if !p.is_dir() {
        return Err(AppError::Invalid(format!("not a folder: {path}")));
    }
    Ok(p)
}

/// The folder's own base name, cleaned, as a subject suggestion.
fn suggested_subject_name(path: &Path) -> String {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(walker::strip_chapter_prefix)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Untitled".to_string())
}

/// Roll scanned nodes up into the preview DTO (depth-aware folder tree + type tallies).
fn summarize(path: &str, nodes: &[ScannedNode]) -> FolderPreview {
    let mut chapters = Vec::with_capacity(nodes.len());
    let mut total_files = 0i64;
    let mut max_depth = 0i64;
    let mut type_counts: Vec<TypeCount> = Vec::new();

    for node in nodes {
        let count = node.files.len() as i64;
        total_files += count;
        // depth = number of folder segments below the import root (0 = root itself).
        let depth = node.rel_segments.len() as i64;
        max_depth = max_depth.max(depth);
        let label = node
            .rel_segments
            .last()
            .cloned()
            .unwrap_or_else(|| suggested_subject_name(Path::new(path)));
        chapters.push(ChapterMapping {
            chapter: label,
            depth,
            file_count: count,
        });
        for file in &node.files {
            match type_counts
                .iter_mut()
                .find(|t| t.file_type == file.file_type)
            {
                Some(t) => t.count += 1,
                None => type_counts.push(TypeCount {
                    file_type: file.file_type.clone(),
                    count: 1,
                }),
            }
        }
    }

    FolderPreview {
        path: path.to_string(),
        suggested_subject: suggested_subject_name(Path::new(path)),
        chapters,
        total_files,
        max_depth,
        type_counts,
    }
}

/// Dry-run: walk the folder and report the folder tree without touching the DB.
#[tauri::command]
pub fn preview_folder(path: String) -> AppResult<FolderPreview> {
    let dir = ensure_dir(&path)?;
    let nodes = walker::scan_tree(dir);
    Ok(summarize(&path, &nodes))
}

/// Full import: create goal/subject, scan, batch-insert materials, register the dir.
/// Emits [`ScanProgress`] events on [`SCAN_PROGRESS_EVENT`] throughout.
#[tauri::command]
pub fn scan_and_import(
    app: AppHandle,
    db: State<'_, Db>,
    import: WizardImport,
) -> AppResult<ImportResult> {
    let dir = ensure_dir(&import.path)?;

    // Resolve the destination: an existing parent node, or a new root goal.
    let root_name = import
        .new_root_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if import.parent_node_id.is_none() && root_name.is_none() {
        return Err(AppError::Invalid(
            "choose a destination: an existing folder or a new goal name".into(),
        ));
    }

    // Walk first (no lock held) so the scan doesn't block other DB access.
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

    // Resolve the root node id (existing parent or a freshly-created root).
    let root_node_id = db.with(|conn| match import.parent_node_id {
        Some(pid) => Ok(pid),
        None => queries::upsert_root_node(conn, root_name.unwrap()),
    })?;

    // Batch-import the whole folder tree in one transaction, emitting progress per folder.
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

    // Record the registered directory rooted at this node.
    let dir_id =
        db.with(|conn| queries::insert_registered_dir(conn, &import.path, root_node_id))?;

    // Begin watching the new folder immediately (live watcher, Section 3).
    crate::scanner::watcher::WatcherManager::add_watch(&app, dir_id, &import.path, root_node_id);

    let _ = app.emit(
        SCAN_PROGRESS_EVENT,
        ScanProgress {
            stage: "done".into(),
            files_imported: counts.materials_imported,
            files_total,
            done: true,
        },
    );

    // Spawn background metadata extraction for the newly imported files
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = crate::scanner::metadata::extract_missing_metadata(app_clone).await;
    });

    Ok(ImportResult {
        root_node_id,
        chapters_created: counts.chapters_created,
        materials_imported: counts.materials_imported,
    })
}

/// Goals-with-counts feed for the Library grid.
#[tauri::command]
pub fn list_library(db: State<'_, Db>) -> AppResult<Vec<GoalSummary>> {
    db.with(|conn| queries::list_goals_with_counts(conn))
}

/// Triggers background metadata extraction for missing durations and thumbnails.
#[tauri::command]
pub async fn extract_library_metadata(app: AppHandle) -> Result<(), String> {
    crate::scanner::metadata::extract_missing_metadata(app)
        .await
        .map_err(|e| e.to_string())
}
