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
