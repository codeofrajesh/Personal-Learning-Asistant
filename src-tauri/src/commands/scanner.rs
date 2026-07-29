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
use crate::scanner::walker::{self, ChapterGroup};
use crate::utils::errors::{AppError, AppResult};

/// Event channel name for scan progress (frontend listens via `listen`).
const SCAN_PROGRESS_EVENT: &str = "scan://progress";

/// Input from the wizard's "Scan & Import" action.
#[derive(Debug, Deserialize)]
pub struct WizardImport {
    /// Absolute path of the folder the user picked.
    pub path: String,
    /// Goal to file this under (created if it doesn't exist).
    pub goal_name: String,
    /// Subject within the goal (created if it doesn't exist).
    pub subject_name: String,
}

/// One sub-folder → chapter mapping row shown in the preview pane.
#[derive(Debug, Serialize)]
pub struct ChapterMapping {
    /// Cleaned chapter name that will be created.
    pub chapter: String,
    /// How many supported files fall under it.
    pub file_count: i64,
}

/// Read-only summary returned by [`preview_folder`].
#[derive(Debug, Serialize)]
pub struct FolderPreview {
    /// The folder that was previewed.
    pub path: String,
    /// Suggested subject name (the folder's own base name, cleaned).
    pub suggested_subject: String,
    /// Sub-folder → chapter mapping, in discovery order.
    pub chapters: Vec<ChapterMapping>,
    /// Total supported files found.
    pub total_files: i64,
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

/// Outcome returned to the wizard when the import finishes.
#[derive(Debug, Serialize)]
pub struct ImportResult {
    pub goal_id: i64,
    pub subject_id: i64,
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

/// Roll scanned groups up into the preview DTO (chapter mappings + type tallies).
fn summarize(path: &str, groups: &[ChapterGroup]) -> FolderPreview {
    let mut chapters = Vec::with_capacity(groups.len());
    let mut total_files = 0i64;
    // Preserve first-seen order for the type tally too.
    let mut type_counts: Vec<TypeCount> = Vec::new();

    for group in groups {
        let count = group.files.len() as i64;
        total_files += count;
        chapters.push(ChapterMapping {
            chapter: group.chapter.clone(),
            file_count: count,
        });
        for file in &group.files {
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
        type_counts,
    }
}

/// Dry-run: walk the folder and report the chapter mapping without touching the DB.
#[tauri::command]
pub fn preview_folder(path: String) -> AppResult<FolderPreview> {
    let dir = ensure_dir(&path)?;
    let groups = walker::scan_dir(dir);
    Ok(summarize(&path, &groups))
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

    if import.goal_name.trim().is_empty() {
        return Err(AppError::Invalid("goal name is required".into()));
    }
    if import.subject_name.trim().is_empty() {
        return Err(AppError::Invalid("subject name is required".into()));
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
    let groups = walker::scan_dir(dir);
    let files_total: i64 = groups.iter().map(|g| g.files.len() as i64).sum();

    // Create goal + subject.
    let (goal_id, subject_id) = db.with(|conn| {
        let goal_id = queries::upsert_goal(conn, import.goal_name.trim())?;
        let subject_id = queries::upsert_subject(conn, goal_id, import.subject_name.trim())?;
        Ok((goal_id, subject_id))
    })?;

    // Batch-import all groups in one transaction, emitting progress per chapter.
    let app_for_cb = app.clone();
    let counts = db.with_mut(|conn| {
        queries::import_chapter_groups(conn, subject_id, &groups, |chapter, imported| {
            let _ = app_for_cb.emit(
                SCAN_PROGRESS_EVENT,
                ScanProgress {
                    stage: chapter.to_string(),
                    files_imported: imported,
                    files_total,
                    done: false,
                },
            );
        })
    })?;

    // Record the registered directory (category_level "subject": the picked folder
    // maps to one subject, its sub-folders to chapters).
    let dir_id = db.with(|conn| {
        queries::insert_registered_dir(conn, &import.path, "subject", goal_id, subject_id)
    })?;

    // Begin watching the new folder immediately (live watcher, Section 3).
    crate::scanner::watcher::WatcherManager::add_watch(&app, dir_id, &import.path, subject_id);

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
        goal_id,
        subject_id,
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
