//! IPC commands for materials (Section 8 Page 8 search + future material actions).
//!
//! The Ctrl+K search modal calls [`search_materials`] to query the FTS5 index. Filters
//! by file type when the modal's filter pill is set; an empty/all-whitespace query
//! returns an empty list. Follows the established pattern: `db: State<Db>`, work inside
//! `db.with`, return `AppResult<T>`.

use tauri::State;

use crate::db::queries::{self, SearchResult};
use crate::db::Db;
use crate::utils::errors::AppResult;

/// Full-text search over materials for the Ctrl+K palette.
///
/// - `query` — free text; tokenized into a safe FTS5 MATCH expression (implicit AND).
/// - `file_type` — `"video"`, `"pdf"`, `"note"`, `"image"`, `"audio"`, or `"all"`/empty
///   /`None` for no filter.
#[tauri::command]
pub fn search_materials(
    db: State<'_, Db>,
    query: String,
    file_type: Option<String>,
) -> AppResult<Vec<SearchResult>> {
    db.with(|conn| queries::search_materials(conn, &query, file_type.as_deref()))
}
