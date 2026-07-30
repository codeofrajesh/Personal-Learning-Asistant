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

use tauri::State;

use crate::db::queries::{self, MaterialRow, NodeCard, NodeCrumb};
use crate::db::Db;
use crate::utils::errors::AppResult;

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
