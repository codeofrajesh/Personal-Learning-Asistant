//! SQL query functions.
//!
//! Section 12 designates this module as the home for "all SQL queries as
//! functions". For the foundation milestone it holds just the health-check used
//! by the IPC roundtrip verification; goal/subject/chapter/material CRUD will be
//! added here as those commands are built.

use rusqlite::{Connection, OptionalExtension};

use crate::scanner::walker::{ScannedFile, ScannedNode};
use crate::utils::errors::AppResult;

/// Round-trip proof: write a key into `settings`, read it back, return it.
///
/// Exercises the full stack — a write, the FTS-independent path, and a read —
/// so a successful call confirms the schema applied and the connection is live.
pub fn health_check(conn: &Connection, token: &str) -> AppResult<String> {
    conn.execute(
        "INSERT INTO settings(key, value) VALUES('__healthcheck', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [token],
    )?;
    let value: String = conn.query_row(
        "SELECT value FROM settings WHERE key = '__healthcheck'",
        [],
        |row| row.get(0),
    )?;
    Ok(value)
}

/// Count rows in a table — a trivial read used to report DB state to the UI.
pub fn count_rows(conn: &Connection, table: &str) -> AppResult<i64> {
    // `table` is not user-supplied; callers pass a fixed literal.
    let sql = format!("SELECT count(*) FROM {table}");
    let n: i64 = conn.query_row(&sql, [], |row| row.get(0))?;
    Ok(n)
}

// ── Content hierarchy upserts ───────────────────────────────────────────────
//
// The wizard/scanner needs "get or create" semantics keyed on the schema's UNIQUE
// constraints (goals.name, subjects(goal_id,name), chapters(subject_id,name)). Each
// helper INSERTs, or on conflict bumps `updated_at` and returns the existing id, so
// re-importing the same folder is idempotent and never duplicates rows.

/// Get-or-create a ROOT node ("Goal") by name, returning its id. Roots have
/// `parent_id IS NULL`, `depth = 0`, `kind = 'root'`.
pub fn upsert_root_node(conn: &Connection, name: &str) -> AppResult<i64> {
    // UNIQUE(parent_id, name) treats NULL parents as distinct in SQLite, so we can't rely
    // on ON CONFLICT here — look up an existing root by name first.
    if let Some(id) = conn
        .query_row(
            "SELECT id FROM nodes WHERE parent_id IS NULL AND name = ?1",
            [name],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
    {
        return Ok(id);
    }
    conn.execute(
        "INSERT INTO nodes(parent_id, name, kind, depth) VALUES(NULL, ?1, 'root', 0)",
        [name],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Get-or-create a child node named `name` under `parent_id`, returning its id. Depth is
/// derived from the parent (`parent.depth + 1`). Idempotent on `UNIQUE(parent_id, name)`.
pub fn upsert_child_node(conn: &Connection, parent_id: i64, name: &str) -> AppResult<i64> {
    let parent_depth: i64 = conn
        .query_row("SELECT depth FROM nodes WHERE id = ?1", [parent_id], |r| {
            r.get(0)
        })
        .optional()?
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO nodes(parent_id, name, kind, depth) VALUES(?1, ?2, 'folder', ?3)
         ON CONFLICT(parent_id, name) DO UPDATE SET updated_at = datetime('now')",
        rusqlite::params![parent_id, name, parent_depth + 1],
    )?;
    let id: i64 = conn.query_row(
        "SELECT id FROM nodes WHERE parent_id = ?1 AND name = ?2",
        rusqlite::params![parent_id, name],
        |r| r.get(0),
    )?;
    Ok(id)
}

/// Insert (or refresh) a single material row under `node_id`. Keyed on the UNIQUE
/// `file_path` so a rescan updates the existing row instead of erroring or duplicating.
pub fn insert_material(conn: &Connection, node_id: i64, file: &ScannedFile) -> AppResult<()> {
    conn.execute(
        "INSERT INTO materials(node_id, file_path, file_name, file_type, file_extension, file_size_bytes)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(file_path) DO UPDATE SET
             node_id         = excluded.node_id,
             file_name       = excluded.file_name,
             file_type       = excluded.file_type,
             file_extension  = excluded.file_extension,
             file_size_bytes = excluded.file_size_bytes,
             status          = 'active',
             updated_at      = datetime('now')",
        rusqlite::params![
            node_id,
            file.path,
            file.name,
            file.file_type,
            file.extension,
            file.size_bytes,
        ],
    )?;
    Ok(())
}

/// Number of materials imported.
#[derive(Debug, serde::Serialize)]
pub struct ImportCounts {
    pub chapters_created: i64,
    pub materials_imported: i64,
}

/// Persist a scanned folder tree under `root_node_id` in a **single transaction**. Each
/// `ScannedNode`'s `rel_segments` are upserted as a chain of child nodes (cached so each
/// folder is created once), then its files inserted under the deepest node. `on_progress`
/// fires per folder group with the running material count.
pub fn import_tree(
    conn: &mut Connection,
    root_node_id: i64,
    nodes: &[ScannedNode],
    mut on_progress: impl FnMut(&str, i64),
) -> AppResult<ImportCounts> {
    use std::collections::HashMap;
    let tx = conn.transaction()?;
    let mut folders_created = 0i64;
    let mut materials_imported = 0i64;
    // Cache "rel-path-key" → node_id so a folder shared by many files is upserted once.
    let mut node_cache: HashMap<String, i64> = HashMap::new();

    for group in nodes {
        // Resolve (creating as needed) the node chain for this folder's segments.
        let mut parent = root_node_id;
        let mut key = String::new();
        for seg in &group.rel_segments {
            key.push('/');
            key.push_str(seg);
            let node_id = if let Some(&cached) = node_cache.get(&key) {
                cached
            } else {
                let id = upsert_child_node(&tx, parent, seg)?;
                node_cache.insert(key.clone(), id);
                folders_created += 1;
                id
            };
            parent = node_id;
        }
        let label = group.rel_segments.last().cloned().unwrap_or_default();
        for file in &group.files {
            insert_material(&tx, parent, file)?;
            materials_imported += 1;
        }
        on_progress(&label, materials_imported);
    }

    tx.commit()?;
    Ok(ImportCounts {
        chapters_created: folders_created,
        materials_imported,
    })
}

/// Record a registered directory rooted at `root_node_id`. Idempotent on the UNIQUE
/// `path`. Returns the row id.
pub fn insert_registered_dir(conn: &Connection, path: &str, root_node_id: i64) -> AppResult<i64> {
    conn.execute(
        "INSERT INTO registered_dirs(path, root_node_id, scan_status, last_scanned_at)
         VALUES(?1, ?2, 'done', datetime('now'))
         ON CONFLICT(path) DO UPDATE SET
             root_node_id    = excluded.root_node_id,
             scan_status     = 'done',
             last_scanned_at = datetime('now')",
        rusqlite::params![path, root_node_id],
    )?;
    let id: i64 = conn.query_row(
        "SELECT id FROM registered_dirs WHERE path = ?1",
        [path],
        |r| r.get(0),
    )?;
    Ok(id)
}

// ── Node tree helpers (v6) ───────────────────────────────────────────────────
//
// A shared recursive-ancestor CTE resolves, for any material, its immediate parent node
// (its "chapter"), its root ancestor (its "goal"), and its depth-1 ancestor (its
// "subject"). This lets the existing dashboard/library DTOs keep their goal/subject/
// chapter field names while the underlying store is an infinite-depth tree. For shallow
// trees (a casual learner's single root with files directly under it) the root doubles as
// the subject, so cards still render sensibly.

/// SQL fragment (a set of CTEs) exposing per-material ancestry columns, usable by any
/// query that then `JOIN mat_anc ON mat_anc.mid = m.id`. Columns:
///   mid, chapter_id (parent node), chapter_name, subject_id, subject_name,
///   goal_id, goal_name, root_id.
pub const MAT_ANC_CTE: &str = "
node_anc AS (
    WITH RECURSIVE up(base_node, curr_node, parent, name, depth) AS (
        SELECT id, id, parent_id, name, depth FROM nodes
        UNION ALL
        SELECT up.base_node, n.id, n.parent_id, n.name, n.depth
        FROM up JOIN nodes n ON n.id = up.parent
    )
    SELECT
        n.id AS node_id,
        n.id AS chapter_id,
        n.name AS chapter_name,
        COALESCE(sub.curr_node, root.curr_node) AS subject_id,
        COALESCE(sub.name, root.name) AS subject_name,
        root.curr_node AS goal_id,
        root.name AS goal_name
    FROM nodes n
    LEFT JOIN up root ON root.base_node = n.id AND root.depth = 0
    LEFT JOIN up sub  ON sub.base_node = n.id AND sub.depth = 1
),
mat_anc AS (
    SELECT m.id AS mid, a.chapter_id, a.chapter_name, a.subject_id, a.subject_name, a.goal_id, a.goal_name, a.goal_id AS root_id
    FROM materials m
    JOIN node_anc a ON a.node_id = m.node_id
)";

/// A goal row plus rolled-up counts, for the Library grid.
#[derive(Debug, serde::Serialize)]
pub struct GoalSummary {
    pub id: i64,
    pub name: String,
    pub icon: String,
    pub color: String,
    pub subject_count: i64,
    pub material_count: i64,
    pub completed_count: i64,
}

/// List every goal with rolled-up subject / material / completed counts, newest goal
/// first. Powers the Library page grid.
pub fn list_goals_with_counts(conn: &Connection) -> AppResult<Vec<GoalSummary>> {
    // For each root node (goal): its direct-child count (≈ "subjects") and the rolled-up
    // material counts across its ENTIRE subtree, via a recursive descendants CTE.
    let mut stmt = conn.prepare(
        "WITH RECURSIVE
         subtree(root_id, id) AS (
             SELECT id, id FROM nodes WHERE parent_id IS NULL
             UNION ALL
             SELECT st.root_id, n.id FROM nodes n JOIN subtree st ON n.parent_id = st.id
         )
         SELECT
            g.id,
            g.name,
            COALESCE(g.icon, '🎯') AS icon,
            COALESCE(g.color, '#AAFF00') AS color,
            (SELECT COUNT(*) FROM nodes c WHERE c.parent_id = g.id) AS subject_count,
            COUNT(m.id) AS material_count,
            COALESCE(SUM(CASE WHEN m.is_completed = 1 THEN 1 ELSE 0 END), 0) AS completed_count
         FROM nodes g
         LEFT JOIN subtree st ON st.root_id = g.id
         LEFT JOIN materials m ON m.node_id = st.id AND m.status = 'active'
         WHERE g.parent_id IS NULL
         GROUP BY g.id
         ORDER BY g.id DESC",
    )?;

    let rows = stmt.query_map([], |r| {
        Ok(GoalSummary {
            id: r.get(0)?,
            name: r.get(1)?,
            icon: r.get(2)?,
            color: r.get(3)?,
            subject_count: r.get(4)?,
            material_count: r.get(5)?,
            completed_count: r.get(6)?,
        })
    })?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

// ── Dashboard aggregates (Section 8, Page 1) ────────────────────────────────
//
// Everything here reads REAL rows. Where a feature has produced no data yet
// (no study sessions, nothing watched), the query returns zeros / empty lists
// rather than fabricated numbers — honest empty states are the design rule.

/// Headline counts for the Progress Statistics card.
#[derive(Debug, Default, serde::Serialize)]
pub struct ProgressStats {
    pub total_materials: i64,
    pub completed: i64,
    pub in_progress: i64,
    pub bookmarked: i64,
    /// 0-100, share of materials completed (0 when there are none).
    pub activity_pct: i64,
}

/// A material to resume, with the context needed to render + navigate to it.
#[derive(Debug, serde::Serialize)]
pub struct RecentMaterial {
    pub id: i64,
    pub file_name: String,
    pub file_type: String,
    pub chapter_id: i64,
    pub chapter_name: String,
    pub subject_name: String,
    pub goal_name: String,
    /// 0-100 watch completion (0 if never opened / not a video).
    pub progress_pct: i64,
    pub is_completed: bool,
    pub is_bookmarked: bool,
    /// Parent subject id (Courses "Continue Learning" → "To the course" link).
    pub subject_id: i64,
    /// Parent goal id (lets the Courses page highlight the active goal pill).
    pub goal_id: i64,
    /// The subject's cover thumbnail (one random video material's thumbnail; null
    /// if the subject has no video materials with an extracted thumbnail).
    pub thumbnail_path: Option<String>,
}

/// One day in the 7-day activity chart.
#[derive(Debug, serde::Serialize)]
pub struct ActivityDay {
    /// ISO date `YYYY-MM-DD`.
    pub date: String,
    /// Hours studied that day (may be fractional).
    pub hours: f64,
}

/// Everything the Dashboard needs, in one round-trip (Section 11: "Dashboard Load").
#[derive(Debug, serde::Serialize)]
pub struct DashboardData {
    pub stats: ProgressStats,
    pub continue_learning: Vec<RecentMaterial>,
    pub bookmarks: Vec<RecentMaterial>,
    pub activity: Vec<ActivityDay>,
    /// Distinct dates (YYYY-MM-DD) with any study activity in the last 7 days —
    /// powers the weekly streak indicator.
    pub active_days: Vec<String>,
    /// The next unstarted lesson per active course (scheduling algorithm) — powers
    /// the "Next Up" widget. Distinct from `continue_learning` (recent/opened items).
    pub next_up: Vec<NextUpItem>,
}

/// One "Next Up" suggestion: the first not-completed lesson of a course (subject),
/// with the context needed to render + deep-link into the player.
#[derive(Debug, serde::Serialize)]
pub struct NextUpItem {
    pub id: i64,
    pub file_name: String,
    pub file_type: String,
    pub chapter_name: String,
    pub subject_id: i64,
    pub subject_name: String,
    pub goal_name: String,
    /// Subject cover thumbnail (one random video material's thumbnail; null if none).
    pub thumbnail_path: Option<String>,
    /// How many active, not-completed lessons remain in this course.
    pub remaining: i64,
}

/// Compute the headline progress statistics.
pub fn progress_stats(conn: &Connection) -> AppResult<ProgressStats> {
    // Single pass over materials for the counts.
    let (total, completed, bookmarked): (i64, i64, i64) = conn.query_row(
        "SELECT
            COUNT(*),
            COALESCE(SUM(CASE WHEN is_completed = 1 THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN is_bookmarked = 1 THEN 1 ELSE 0 END), 0)
         FROM materials
         WHERE status = 'active'",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;

    // "In progress": has watch_progress with some position but not completed.
    let in_progress: i64 = conn.query_row(
        "SELECT COUNT(*)
         FROM watch_progress wp
         JOIN materials m ON m.id = wp.material_id
         WHERE m.status = 'active'
           AND wp.completed = 0
           AND wp.position_secs > 0",
        [],
        |r| r.get(0),
    )?;

    let activity_pct = if total > 0 {
        ((completed as f64 / total as f64) * 100.0).round() as i64
    } else {
        0
    };

    Ok(ProgressStats {
        total_materials: total,
        completed,
        in_progress,
        bookmarked,
        activity_pct,
    })
}

/// Shared SELECT that joins a material up to its goal and its watch progress.
/// Carries `subject_id` / `goal_id` (for the Courses "Continue Learning" card's
/// "To the course" link + active-goal-pill highlight) and a subject cover thumbnail.
fn recent_select() -> String {
    format!(
        "WITH {MAT_ANC_CTE}
         SELECT
            m.id, m.file_name, m.file_type, a.chapter_id,
            a.chapter_name, a.subject_name, a.goal_name,
            COALESCE(CAST(wp.completion_pct AS INTEGER), 0),
            m.is_completed, m.is_bookmarked,
            a.subject_id, a.goal_id,
            m.thumbnail_path
         FROM materials m
         JOIN mat_anc a ON a.mid = m.id
         LEFT JOIN watch_progress wp ON wp.material_id = m.id
         WHERE m.status = 'active'"
    )
}

fn map_recent(r: &rusqlite::Row) -> rusqlite::Result<RecentMaterial> {
    Ok(RecentMaterial {
        id: r.get(0)?,
        file_name: r.get(1)?,
        file_type: r.get(2)?,
        chapter_id: r.get(3)?,
        chapter_name: r.get(4)?,
        subject_name: r.get(5)?,
        goal_name: r.get(6)?,
        progress_pct: r.get(7)?,
        is_completed: r.get::<_, i64>(8)? != 0,
        is_bookmarked: r.get::<_, i64>(9)? != 0,
        subject_id: r.get(10)?,
        goal_id: r.get(11)?,
        thumbnail_path: r.get(12)?,
    })
}

/// Most recently opened materials for "Continue Learning" (most recent first).
/// Falls back to newest-added when nothing has been opened yet.
pub fn continue_learning(conn: &Connection, limit: i64) -> AppResult<Vec<RecentMaterial>> {
    let sql = format!(
        "{}
           AND m.last_opened_at IS NOT NULL
         ORDER BY m.last_opened_at DESC
         LIMIT ?1",
        recent_select()
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([limit], map_recent)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Bookmarked materials for the Quick Access list (most recent first).
pub fn bookmarked(conn: &Connection, limit: i64) -> AppResult<Vec<RecentMaterial>> {
    let sql = format!(
        "{}
           AND m.is_bookmarked = 1
         ORDER BY m.updated_at DESC
         LIMIT ?1",
        recent_select()
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([limit], map_recent)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Study hours per day for the last 7 days (today inclusive), oldest first.
/// Days with no sessions are still present with `hours = 0` so the chart has a
/// fixed 7-bar shape.
pub fn weekly_activity(conn: &Connection) -> AppResult<Vec<ActivityDay>> {
    // Sum session seconds grouped by local date, for the last 7 days.
    let mut stmt = conn.prepare(
        "SELECT session_date, COALESCE(SUM(duration_secs), 0)
         FROM study_sessions
         WHERE session_date >= date('now', '-6 days')
           AND session_type = 'work'
         GROUP BY session_date",
    )?;
    let mut by_date: Vec<(String, f64)> = Vec::new();
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?)))?;
    for row in rows {
        by_date.push(row?);
    }

    // Build the fixed 7-slot window date('now','-6..0 days') in order.
    let mut out = Vec::with_capacity(7);
    for offset in (0..7).rev() {
        let date: String =
            conn.query_row("SELECT date('now', ?1)", [format!("-{offset} days")], |r| {
                r.get(0)
            })?;
        let secs = by_date
            .iter()
            .find(|(d, _)| d == &date)
            .map(|(_, s)| *s)
            .unwrap_or(0.0);
        out.push(ActivityDay {
            date,
            hours: secs / 3600.0,
        });
    }
    Ok(out)
}

/// Distinct dates with study activity in the last 7 days (for the streak indicator).
pub fn active_days(conn: &Connection) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT session_date
         FROM study_sessions
         WHERE session_date >= date('now', '-6 days')
           AND session_type = 'work'
         ORDER BY session_date",
    )?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// The next unstarted lesson for each active course (subject), for the "Next Up" widget.
///
/// Scheduling algorithm (distinct from Continue-Learning's recency): for every subject
/// that still has at least one active, not-completed material, pick its FIRST such
/// material in course order (chapter `sort_order`/name, then material `sort_order`/name)
/// — i.e. "the next thing to study in this course". Courses whose most-recent activity
/// is freshest surface first, so the list tracks what the learner is actively working
/// through. One row per subject; capped by `limit`.
pub fn next_up(conn: &Connection, limit: i64) -> AppResult<Vec<NextUpItem>> {
    // Per subject: the next lesson = the min-ordered active, not-completed material.
    // We rank materials within each subject by course order and take rank 1, then order
    // subjects by their latest `last_opened_at` (active courses first), then by newest.
    let sql = format!(
        "WITH {MAT_ANC_CTE},
         ranked AS (
            SELECT
                m.id, m.file_name, m.file_type,
                a.chapter_name AS chapter_name,
                a.subject_id AS subject_id, a.subject_name AS subject_name,
                a.goal_name AS goal_name,
                ROW_NUMBER() OVER (
                    PARTITION BY a.subject_id
                    ORDER BY m.sort_order, m.file_name
                ) AS rn,
                COUNT(*) OVER (PARTITION BY a.subject_id) AS remaining,
                (SELECT MAX(m3.last_opened_at)
                   FROM materials m3 JOIN mat_anc a3 ON a3.mid = m3.id
                   WHERE a3.subject_id = a.subject_id) AS subject_last_opened,
                m.thumbnail_path AS thumbnail_path
            FROM materials m
            JOIN mat_anc a ON a.mid = m.id
            WHERE m.status = 'active' AND m.is_completed = 0
         )
         SELECT id, file_name, file_type, chapter_name,
                subject_id, subject_name, goal_name, thumbnail_path, remaining
         FROM ranked
         WHERE rn = 1
         ORDER BY (subject_last_opened IS NULL), subject_last_opened DESC, subject_id DESC
         LIMIT ?1"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([limit], |r| {
        Ok(NextUpItem {
            id: r.get(0)?,
            file_name: r.get(1)?,
            file_type: r.get(2)?,
            chapter_name: r.get(3)?,
            subject_id: r.get(4)?,
            subject_name: r.get(5)?,
            goal_name: r.get(6)?,
            thumbnail_path: r.get(7)?,
            remaining: r.get(8)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Assemble the full dashboard payload in one call.
pub fn dashboard_data(conn: &Connection) -> AppResult<DashboardData> {
    Ok(DashboardData {
        stats: progress_stats(conn)?,
        continue_learning: continue_learning(conn, 4)?,
        bookmarks: bookmarked(conn, 6)?,
        activity: weekly_activity(conn)?,
        active_days: active_days(conn)?,
        next_up: next_up(conn, 5)?,
    })
}

// ── Library drill-down (Section 8, Pages 2–5) ───────────────────────────────
//
// Goal → Subject → Chapter → Material navigation. Each level has a child-list query
// (with rolled-up counts, honest zeros) plus a lightweight detail accessor that also
// carries ancestor ids/names so a page can render its breadcrumb from one round-trip.

/// A goal's own header fields (no children).
#[derive(Debug, serde::Serialize)]
pub struct GoalDetail {
    pub id: i64,
    pub name: String,
    pub icon: String,
    pub color: String,
}

/// A subject under a goal, with rolled-up counts, for the Goal page grid.
#[derive(Debug, serde::Serialize)]
pub struct SubjectSummary {
    pub id: i64,
    pub name: String,
    pub icon: String,
    pub chapter_count: i64,
    pub material_count: i64,
    pub completed_count: i64,
    /// Cover image: one random video material's thumbnail (null if the subject has no
    /// video materials with an extracted thumbnail). Powers the Courses grid covers.
    pub thumbnail_path: Option<String>,
}

/// A subject's header plus its parent goal, for the Subject page breadcrumb.
#[derive(Debug, serde::Serialize)]
pub struct SubjectDetail {
    pub id: i64,
    pub name: String,
    pub goal_id: i64,
    pub goal_name: String,
}

/// A chapter under a subject, with rolled-up counts, for the Subject page list.
#[derive(Debug, serde::Serialize)]
pub struct ChapterSummary {
    pub id: i64,
    pub name: String,
    pub material_count: i64,
    pub completed_count: i64,
}

/// A chapter's header plus its full ancestry, for the Chapter page breadcrumb.
#[derive(Debug, serde::Serialize)]
pub struct ChapterDetail {
    pub id: i64,
    pub name: String,
    pub subject_id: i64,
    pub subject_name: String,
    pub goal_id: i64,
    pub goal_name: String,
}

/// A material row for the Chapter page list.
#[derive(Debug, serde::Serialize)]
pub struct MaterialRow {
    pub id: i64,
    pub file_name: String,
    pub file_type: String,
    pub file_extension: String,
    pub file_size_bytes: i64,
    /// Duration in seconds (null until metadata extraction runs — a later milestone).
    pub duration_secs: Option<f64>,
    pub thumbnail_path: Option<String>,
    /// 0-100 watch completion (0 if never opened / not a video).
    pub progress_pct: i64,
    pub is_bookmarked: bool,
    pub is_completed: bool,
    /// `active` or `missing` (file no longer on disk — the watcher marks it, never
    /// hard-deletes; Section 3).
    pub status: String,
}

/// Fetch a goal's header fields. `NotFound` if the id doesn't exist.
pub fn goal_detail(conn: &Connection, goal_id: i64) -> AppResult<GoalDetail> {
    conn.query_row(
        "SELECT id, name, COALESCE(icon, '🎯'), COALESCE(color, '#AAFF00') FROM nodes WHERE id = ?1",
        [goal_id],
        |r| {
            Ok(GoalDetail {
                id: r.get(0)?,
                name: r.get(1)?,
                icon: r.get(2)?,
                color: r.get(3)?,
            })
        },
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => {
            crate::utils::errors::AppError::NotFound(format!("goal {goal_id} not found"))
        }
        other => other.into(),
    })
}

/// Subjects of a goal with chapter / material / completed counts.
///
/// `thumbnail_path` is a correlated subquery that picks ONE random video material's
/// thumbnail from each subject (the subject's cover image). Aliased `m2`/`c2` keep it
/// independent of the outer aggregate join. Subjects per goal are few, so the per-row
/// subquery is cheap; NULL when the subject has no video materials with thumbnails.
pub fn list_subjects(conn: &Connection, goal_id: i64) -> AppResult<Vec<SubjectSummary>> {
    // Each direct child of the goal node is a "subject". Its `chapter_count` is its own
    // direct-child count; material/completed counts roll up its whole subtree; the cover
    // is one video material's own thumbnail from anywhere in that subtree.
    let mut stmt = conn.prepare(
        "WITH RECURSIVE
         subtree(sub_id, id) AS (
             SELECT id, id FROM nodes WHERE parent_id = ?1
             UNION ALL
             SELECT st.sub_id, n.id FROM nodes n JOIN subtree st ON n.parent_id = st.id
         )
         SELECT
            s.id, s.name, COALESCE(s.icon, '📚') AS icon,
            (SELECT COUNT(*) FROM nodes cc WHERE cc.parent_id = s.id) AS chapter_count,
            COUNT(m.id) AS material_count,
            COALESCE(SUM(CASE WHEN m.is_completed = 1 THEN 1 ELSE 0 END), 0) AS completed_count,
            (SELECT m2.thumbnail_path
               FROM materials m2
               JOIN subtree st2 ON st2.id = m2.node_id
               WHERE st2.sub_id = s.id
                 AND m2.file_type = 'video'
                 AND m2.thumbnail_path IS NOT NULL
                 AND m2.status = 'active'
               ORDER BY RANDOM() LIMIT 1) AS thumbnail_path
         FROM nodes s
         LEFT JOIN subtree st ON st.sub_id = s.id
         LEFT JOIN materials m ON m.node_id = st.id AND m.status = 'active'
         WHERE s.parent_id = ?1
         GROUP BY s.id
         ORDER BY s.sort_order, s.name",
    )?;
    let rows = stmt.query_map([goal_id], |r| {
        Ok(SubjectSummary {
            id: r.get(0)?,
            name: r.get(1)?,
            icon: r.get(2)?,
            chapter_count: r.get(3)?,
            material_count: r.get(4)?,
            completed_count: r.get(5)?,
            thumbnail_path: r.get(6)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Fetch a subject's header + its parent goal. `NotFound` if absent.
pub fn subject_detail(conn: &Connection, subject_id: i64) -> AppResult<SubjectDetail> {
    // The node's root ancestor is its "goal". For a depth-1 node the parent IS the root;
    // a recursive climb handles deeper nodes too (and a root asked as a subject → itself).
    conn.query_row(
        "WITH RECURSIVE up(id, parent_id, name, depth) AS (
             SELECT id, parent_id, name, depth FROM nodes WHERE id = ?1
             UNION ALL
             SELECT n.id, n.parent_id, n.name, n.depth FROM nodes n JOIN up ON n.id = up.parent_id
         )
         SELECT
            (SELECT name FROM nodes WHERE id = ?1),
            (SELECT id FROM up WHERE depth = 0),
            (SELECT name FROM up WHERE depth = 0)",
        [subject_id],
        |r| {
            Ok(SubjectDetail {
                id: subject_id,
                name: r.get(0)?,
                goal_id: r.get::<_, Option<i64>>(1)?.unwrap_or(subject_id),
                goal_name: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            })
        },
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => {
            crate::utils::errors::AppError::NotFound(format!("subject {subject_id} not found"))
        }
        other => other.into(),
    })
}

/// Chapters of a subject with material / completed counts.
pub fn list_chapters(conn: &Connection, subject_id: i64) -> AppResult<Vec<ChapterSummary>> {
    // Direct child nodes of the subject node = its "chapters"; counts roll up each
    // chapter's subtree.
    let mut stmt = conn.prepare(
        "WITH RECURSIVE
         subtree(chap_id, id) AS (
             SELECT id, id FROM nodes WHERE parent_id = ?1
             UNION ALL
             SELECT st.chap_id, n.id FROM nodes n JOIN subtree st ON n.parent_id = st.id
         )
         SELECT
            c.id, c.name,
            COUNT(m.id) AS material_count,
            COALESCE(SUM(CASE WHEN m.is_completed = 1 THEN 1 ELSE 0 END), 0) AS completed_count
         FROM nodes c
         LEFT JOIN subtree st ON st.chap_id = c.id
         LEFT JOIN materials m ON m.node_id = st.id AND m.status = 'active'
         WHERE c.parent_id = ?1
         GROUP BY c.id
         ORDER BY c.sort_order, c.name",
    )?;
    let rows = stmt.query_map([subject_id], |r| {
        Ok(ChapterSummary {
            id: r.get(0)?,
            name: r.get(1)?,
            material_count: r.get(2)?,
            completed_count: r.get(3)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Fetch a chapter's header + its full ancestry (subject + goal). `NotFound` if absent.
pub fn chapter_detail(conn: &Connection, chapter_id: i64) -> AppResult<ChapterDetail> {
    // Climb from this node to its root; the immediate parent is the "subject", the
    // depth-0 ancestor is the "goal". Shallow trees fall back sensibly to the parent.
    conn.query_row(
        "WITH RECURSIVE up(id, parent_id, name, depth) AS (
             SELECT id, parent_id, name, depth FROM nodes WHERE id = ?1
             UNION ALL
             SELECT n.id, n.parent_id, n.name, n.depth FROM nodes n JOIN up ON n.id = up.parent_id
         )
         SELECT
            (SELECT name FROM nodes WHERE id = ?1),
            (SELECT parent_id FROM nodes WHERE id = ?1),
            (SELECT name FROM nodes WHERE id = (SELECT parent_id FROM nodes WHERE id = ?1)),
            (SELECT id FROM up WHERE depth = 0),
            (SELECT name FROM up WHERE depth = 0)",
        [chapter_id],
        |r| {
            let name: String = r.get(0)?;
            let subject_id: Option<i64> = r.get(1)?;
            let subject_name: Option<String> = r.get(2)?;
            let goal_id: Option<i64> = r.get(3)?;
            let goal_name: Option<String> = r.get(4)?;
            Ok(ChapterDetail {
                id: chapter_id,
                name,
                subject_id: subject_id.unwrap_or(chapter_id),
                subject_name: subject_name.unwrap_or_default(),
                goal_id: goal_id.unwrap_or(chapter_id),
                goal_name: goal_name.unwrap_or_default(),
            })
        },
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => {
            crate::utils::errors::AppError::NotFound(format!("chapter {chapter_id} not found"))
        }
        other => other.into(),
    })
}

/// Materials of a chapter (active only), with watch progress.
pub fn list_materials(conn: &Connection, chapter_id: i64) -> AppResult<Vec<MaterialRow>> {
    // Include `missing` rows (file no longer on disk) so the UI can show a ⚠️ badge
    // rather than silently dropping them (Section 3). Active rows sort first.
    let mut stmt = conn.prepare(
        "SELECT
            m.id, m.file_name, m.file_type, m.file_extension, m.file_size_bytes,
            m.duration_secs, m.thumbnail_path,
            COALESCE(CAST(wp.completion_pct AS INTEGER), 0),
            m.is_bookmarked, m.is_completed, m.status
         FROM materials m
         LEFT JOIN watch_progress wp ON wp.material_id = m.id
         WHERE m.node_id = ?1 AND m.status IN ('active', 'missing')
         ORDER BY (m.status = 'missing'), m.sort_order, m.file_name",
    )?;
    let rows = stmt.query_map([chapter_id], |r| {
        Ok(MaterialRow {
            id: r.get(0)?,
            file_name: r.get(1)?,
            file_type: r.get(2)?,
            file_extension: r.get(3)?,
            file_size_bytes: r.get(4)?,
            duration_secs: r.get(5)?,
            thumbnail_path: r.get(6)?,
            progress_pct: r.get(7)?,
            is_bookmarked: r.get::<_, i64>(8)? != 0,
            is_completed: r.get::<_, i64>(9)? != 0,
            status: r.get(10)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

// ── Infinite-depth node tree browser (v6) ─────────────────────────────────────
//
// The unified file-explorer browser drills through the `nodes` tree directly (no
// goal/subject/chapter shim): `node_children` lists a node's direct child folders with
// rolled-up subtree counts + a cover, `node_ancestors` climbs to the root for the
// breadcrumb, and `node_materials` lists the files directly under a node (an alias of
// `list_materials`).

/// A child folder node with rolled-up subtree counts + a cover, for the tree browser
/// grid. `parent_id` is NULL for root goals.
#[derive(Debug, serde::Serialize)]
pub struct NodeCard {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub name: String,
    pub icon: String,
    pub color: String,
    pub depth: i64,
    /// Direct child folder count (not materials).
    pub child_count: i64,
    /// Materials rolled up across this node's whole subtree.
    pub material_count: i64,
    pub completed_count: i64,
    /// One random video material's thumbnail from the subtree (null if none).
    pub thumbnail_path: Option<String>,
}

/// One breadcrumb rung (root-first) for the tree browser.
#[derive(Debug, serde::Serialize)]
pub struct NodeCrumb {
    pub id: i64,
    pub name: String,
    pub depth: i64,
}

/// Direct child folder nodes of `parent_id` (or the root goals when `None`), each with
/// its direct-child count, whole-subtree material/completed rollups, and a cover
/// thumbnail. Mirrors the count+cover pattern of `list_subjects`; the only difference is
/// the root case keys on `parent_id IS NULL`.
pub fn node_children(conn: &Connection, parent_id: Option<i64>) -> AppResult<Vec<NodeCard>> {
    // Bind `parent_id` once as a nullable param and let `?1 IS NULL` pick the root set.
    // The `subtree` CTE seeds from each candidate node and walks its descendants so
    // material counts roll up the ENTIRE subtree (consistent with list_subjects/goals).
    let sql = "WITH RECURSIVE
         subtree(top_id, id) AS (
             SELECT id, id FROM nodes
              WHERE (?1 IS NULL AND parent_id IS NULL) OR (parent_id = ?1)
             UNION ALL
             SELECT st.top_id, n.id FROM nodes n JOIN subtree st ON n.parent_id = st.id
         )
         SELECT
            s.id, s.parent_id, s.name,
            COALESCE(s.icon, CASE WHEN s.parent_id IS NULL THEN '🎯' ELSE '📚' END) AS icon,
            COALESCE(s.color, '#AAFF00') AS color,
            s.depth,
            (SELECT COUNT(*) FROM nodes cc WHERE cc.parent_id = s.id) AS child_count,
            COUNT(m.id) AS material_count,
            COALESCE(SUM(CASE WHEN m.is_completed = 1 THEN 1 ELSE 0 END), 0) AS completed_count,
            (SELECT m2.thumbnail_path
               FROM materials m2
               JOIN subtree st2 ON st2.id = m2.node_id
               WHERE st2.top_id = s.id
                 AND m2.file_type = 'video'
                 AND m2.thumbnail_path IS NOT NULL
                 AND m2.status = 'active'
               ORDER BY RANDOM() LIMIT 1) AS thumbnail_path
         FROM nodes s
         LEFT JOIN subtree st ON st.top_id = s.id
         LEFT JOIN materials m ON m.node_id = st.id AND m.status = 'active'
         WHERE (?1 IS NULL AND s.parent_id IS NULL) OR (s.parent_id = ?1)
         GROUP BY s.id
         ORDER BY s.sort_order, s.name";
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([parent_id], |r| {
        Ok(NodeCard {
            id: r.get(0)?,
            parent_id: r.get(1)?,
            name: r.get(2)?,
            icon: r.get(3)?,
            color: r.get(4)?,
            depth: r.get(5)?,
            child_count: r.get(6)?,
            material_count: r.get(7)?,
            completed_count: r.get(8)?,
            thumbnail_path: r.get(9)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// The ancestry chain of `node_id`, ROOT-FIRST (root … node), for the breadcrumb.
/// Empty if the node doesn't exist.
pub fn node_ancestors(conn: &Connection, node_id: i64) -> AppResult<Vec<NodeCrumb>> {
    let mut stmt = conn.prepare(
        "WITH RECURSIVE up(id, parent_id, name, depth) AS (
             SELECT id, parent_id, name, depth FROM nodes WHERE id = ?1
             UNION ALL
             SELECT n.id, n.parent_id, n.name, n.depth
               FROM nodes n JOIN up ON n.id = up.parent_id
         )
         SELECT id, name, depth FROM up ORDER BY depth ASC",
    )?;
    let rows = stmt.query_map([node_id], |r| {
        Ok(NodeCrumb {
            id: r.get(0)?,
            name: r.get(1)?,
            depth: r.get(2)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Materials sitting directly under a node. Alias of [`list_materials`] (same shape and
/// ordering) exposed under the tree-browser vocabulary.
pub fn node_materials(conn: &Connection, node_id: i64) -> AppResult<Vec<MaterialRow>> {
    list_materials(conn, node_id)
}

// ── Courses (LMS re-architecture) ─────────────────────────────────────────────
//
// `course_view` flattens every material across a subject's chapters into one
// sequence-ordered list (the Course detail page's lesson list), and `get_recent_goal`
// finds the goal the learner last watched, so the Courses page can default its goal
// pill tab to the active goal.

/// One lesson in a flattened course view. Carries its chapter id/name so the detail
/// page can group lessons under sticky chapter headers without a second round-trip.
#[derive(Debug, serde::Serialize)]
pub struct CourseLesson {
    pub id: i64,
    pub file_name: String,
    pub file_type: String,
    pub file_extension: String,
    pub duration_secs: Option<f64>,
    pub thumbnail_path: Option<String>,
    /// 0-100 watch completion (0 if never opened / not a video).
    pub progress_pct: i64,
    pub is_bookmarked: bool,
    pub is_completed: bool,
    pub status: String,
    pub chapter_id: i64,
    pub chapter_name: String,
    /// Chapter sequence (for ordering + grouping under sticky headers).
    pub chapter_sort_order: i64,
    /// Material sequence within its chapter.
    pub sort_order: i64,
}

/// Every material across a subject's chapters, flattened and ordered by chapter
/// sequence then material sequence (missing files sort last within their chapter, so
/// the ⚠️ badge stays grouped but doesn't displace available lessons).
pub fn course_lessons(conn: &Connection, subject_id: i64) -> AppResult<Vec<CourseLesson>> {
    // Walk the subject's subtree, tagging every descendant node with the "chapter" it
    // rolls up to = the direct child of `subject_id` that is its ancestor-or-self. A
    // material directly under the subject uses the subject itself as its chapter.
    let mut stmt = conn.prepare(
        "WITH RECURSIVE tagged(id, chap_id, chap_name, chap_sort) AS (
             -- Seed: the subject's direct children are their own chapter.
             SELECT id, id, name, sort_order FROM nodes WHERE parent_id = ?1
             UNION ALL
             -- Descend: children inherit their parent's chapter tag.
             SELECT n.id, t.chap_id, t.chap_name, t.chap_sort
             FROM nodes n JOIN tagged t ON n.parent_id = t.id
         ),
         chap_map(id, chap_id, chap_name, chap_sort) AS (
             SELECT id, chap_id, chap_name, chap_sort FROM tagged
             UNION ALL
             -- Materials directly under the subject node → chapter = the subject itself.
             SELECT ?1, ?1, (SELECT name FROM nodes WHERE id = ?1), -1
         )
         SELECT
            m.id, m.file_name, m.file_type, m.file_extension,
            m.duration_secs, m.thumbnail_path,
            COALESCE(CAST(wp.completion_pct AS INTEGER), 0),
            m.is_bookmarked, m.is_completed, m.status,
            cm.chap_id, cm.chap_name, cm.chap_sort, m.sort_order
         FROM materials m
         JOIN chap_map cm ON cm.id = m.node_id
         LEFT JOIN watch_progress wp ON wp.material_id = m.id
         WHERE m.status IN ('active', 'missing')
         ORDER BY cm.chap_sort, cm.chap_name, (m.status = 'missing'), m.sort_order, m.file_name",
    )?;
    let rows = stmt.query_map([subject_id], |r| {
        Ok(CourseLesson {
            id: r.get(0)?,
            file_name: r.get(1)?,
            file_type: r.get(2)?,
            file_extension: r.get(3)?,
            duration_secs: r.get(4)?,
            thumbnail_path: r.get(5)?,
            progress_pct: r.get(6)?,
            is_bookmarked: r.get::<_, i64>(7)? != 0,
            is_completed: r.get::<_, i64>(8)? != 0,
            status: r.get(9)?,
            chapter_id: r.get(10)?,
            chapter_name: r.get(11)?,
            chapter_sort_order: r.get(12)?,
            sort_order: r.get(13)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// One "Suggested lecture" below the video, with a human reason for the recommendation.
#[derive(Debug, serde::Serialize)]
pub struct Recommendation {
    pub id: i64,
    pub file_name: String,
    pub file_type: String,
    pub thumbnail_path: Option<String>,
    pub duration_secs: Option<f64>,
    pub progress_pct: i64,
    pub is_completed: bool,
    pub subject_id: i64,
    pub subject_name: String,
    /// Why this was suggested: "next" | "course" | "goal".
    pub reason: String,
}

/// Suggested lectures to show below the current video, ranked:
///   1. "next"   — the next lessons in the SAME chapter (by sort order), i.e. next-in-series.
///   2. "course" — other not-completed lessons in the same subject.
///   3. "goal"   — lessons from sibling subjects under the same goal (prefer unstarted).
/// The current material and duplicates are excluded; capped at `limit`. A stable rank
/// keeps ordering deterministic across calls.
pub fn recommended_materials(
    conn: &Connection,
    material_id: i64,
    limit: i64,
) -> AppResult<Vec<Recommendation>> {
    // "chapter" = the material's parent node, "subject" = its depth-1 ancestor, "goal" =
    // its root. `cur` captures those for the current material; candidates are ranked by
    // how closely they share that ancestry.
    let sql = format!(
        "WITH {MAT_ANC_CTE},
         cur AS (
            SELECT a.mid, a.chapter_id, m.sort_order, a.subject_id, a.goal_id
            FROM materials m JOIN mat_anc a ON a.mid = m.id
            WHERE m.id = ?1
         )
         SELECT
            m.id, m.file_name, m.file_type, m.thumbnail_path, m.duration_secs,
            COALESCE(CAST(wp.completion_pct AS INTEGER), 0) AS progress_pct,
            m.is_completed,
            a.subject_id AS subject_id, a.subject_name AS subject_name,
            CASE
                WHEN a.chapter_id = cur.chapter_id THEN 'next'
                WHEN a.subject_id = cur.subject_id THEN 'course'
                ELSE 'goal'
            END AS reason,
            CASE
                WHEN a.chapter_id = cur.chapter_id THEN 0
                WHEN a.subject_id = cur.subject_id THEN 1
                ELSE 2
            END AS rank_bucket
         FROM materials m
         JOIN mat_anc a ON a.mid = m.id
         JOIN cur
         LEFT JOIN watch_progress wp ON wp.material_id = m.id
         WHERE m.status = 'active'
           AND m.id <> cur.mid
           AND a.goal_id = cur.goal_id
           AND m.is_completed = 0
           AND NOT (a.chapter_id = cur.chapter_id AND m.sort_order < cur.sort_order)
         ORDER BY rank_bucket,
                  CASE WHEN a.chapter_id = cur.chapter_id THEN m.sort_order ELSE 0 END,
                  m.last_opened_at IS NOT NULL,
                  m.sort_order, m.file_name
         LIMIT ?2"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params![material_id, limit], |r| {
        Ok(Recommendation {
            id: r.get(0)?,
            file_name: r.get(1)?,
            file_type: r.get(2)?,
            thumbnail_path: r.get(3)?,
            duration_secs: r.get(4)?,
            progress_pct: r.get(5)?,
            is_completed: r.get::<_, i64>(6)? != 0,
            subject_id: r.get(7)?,
            subject_name: r.get(8)?,
            reason: r.get(9)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// The goal id of the most recently watched material (by `materials.last_opened_at`),
/// or `None` if nothing has been opened yet. Used by the Courses page to default the
/// goal pill tab to the learner's currently active goal.
pub fn get_recent_goal(conn: &Connection) -> AppResult<Option<i64>> {
    let sql = format!(
        "WITH {MAT_ANC_CTE}
         SELECT a.goal_id
         FROM materials m JOIN mat_anc a ON a.mid = m.id
         WHERE m.last_opened_at IS NOT NULL AND m.status = 'active'
         ORDER BY m.last_opened_at DESC
         LIMIT 1"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query_map([], |r| r.get::<_, i64>(0))?;
    match rows.next() {
        Some(v) => Ok(Some(v?)),
        None => Ok(None),
    }
}

// ── Player: material lookup + progress persistence (Section 8 Page 6, Section 10) ──
//
// Playback streams local files via the Tauri asset protocol (frontend `convertFileSrc`),
// so there is no streaming SQL here — only the lookup a player needs to open + resume a
// file, and the writes that persist watch progress / bookmarks / completion / study
// sessions. Progress is mirrored onto `materials` (is_completed, last_opened_at) so the
// Library + Dashboard rollups, which read `materials`, stay consistent.

/// The single material a player opens, plus its ancestry + saved resume position.
#[derive(Debug, serde::Serialize)]
pub struct PlayerMaterial {
    pub id: i64,
    pub file_path: String,
    pub file_name: String,
    pub file_type: String,
    pub file_extension: String,
    /// DB-known duration (may be null until metadata extraction runs); the media
    /// element reports its own duration, so playback works regardless.
    pub duration_secs: Option<f64>,
    pub thumbnail_path: Option<String>,
    pub chapter_id: i64,
    pub chapter_name: String,
    pub subject_id: i64,
    pub subject_name: String,
    pub goal_id: i64,
    pub goal_name: String,
    /// Saved resume position in seconds (0 if never watched).
    pub position_secs: f64,
    pub is_completed: bool,
    pub is_bookmarked: bool,
}

/// Fetch everything a player needs to open + resume a material. Also stamps
/// `last_opened_at = now` so Continue-Learning orders correctly. `NotFound` on bad id.
pub fn material_for_player(conn: &Connection, material_id: i64) -> AppResult<PlayerMaterial> {
    let sql = format!(
        "WITH {MAT_ANC_CTE}
             SELECT
                m.id, m.file_path, m.file_name, m.file_type, m.file_extension,
                m.duration_secs, m.thumbnail_path,
                a.chapter_id, a.chapter_name, a.subject_id, a.subject_name,
                a.goal_id, a.goal_name,
                COALESCE(wp.position_secs, 0.0),
                m.is_completed, m.is_bookmarked
             FROM materials m
             JOIN mat_anc a ON a.mid = m.id
             LEFT JOIN watch_progress wp ON wp.material_id = m.id
             WHERE m.id = ?1"
    );
    let material = conn
        .query_row(
            &sql,
            [material_id],
            |r| {
                Ok(PlayerMaterial {
                    id: r.get(0)?,
                    file_path: r.get(1)?,
                    file_name: r.get(2)?,
                    file_type: r.get(3)?,
                    file_extension: r.get(4)?,
                    duration_secs: r.get(5)?,
                    thumbnail_path: r.get(6)?,
                    chapter_id: r.get(7)?,
                    chapter_name: r.get(8)?,
                    subject_id: r.get(9)?,
                    subject_name: r.get(10)?,
                    goal_id: r.get(11)?,
                    goal_name: r.get(12)?,
                    position_secs: r.get(13)?,
                    is_completed: r.get::<_, i64>(14)? != 0,
                    is_bookmarked: r.get::<_, i64>(15)? != 0,
                })
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => crate::utils::errors::AppError::NotFound(
                format!("material {material_id} not found"),
            ),
            other => other.into(),
        })?;

    // Mark it as just opened (drives Continue-Learning recency).
    conn.execute(
        "UPDATE materials SET last_opened_at = datetime('now') WHERE id = ?1",
        [material_id],
    )?;

    // Count a genuine *view* here (on open) — NOT on every progress save. If a
    // watch_progress row already exists, bump its watch_count once; otherwise the row
    // is created by the first save_progress with watch_count = 1.
    conn.execute(
        "UPDATE watch_progress SET watch_count = watch_count + 1 WHERE material_id = ?1",
        [material_id],
    )?;

    Ok(material)
}

/// Fraction of a video at/after which we treat it as completed.
const COMPLETION_THRESHOLD: f64 = 0.95;

/// Upsert watch progress for a material and mirror completion onto `materials`.
///
/// Runs in one transaction (`with_mut`): writes position/duration into `watch_progress`
/// (refreshing `last_watched_at`), flips `completed` when watched past the threshold, and
/// mirrors `is_completed` onto the `materials` row. `watch_count` is NOT touched here — a
/// genuine view is counted once on open (`material_for_player`), not on every save.
pub fn save_progress(
    conn: &mut Connection,
    material_id: i64,
    position_secs: f64,
    duration_secs: f64,
) -> AppResult<()> {
    let completed = duration_secs > 0.0 && (position_secs / duration_secs) >= COMPLETION_THRESHOLD;
    let completed_i = i64::from(completed);

    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO watch_progress(material_id, position_secs, duration_secs, completed, last_watched_at, watch_count)
         VALUES(?1, ?2, ?3, ?4, datetime('now'), 1)
         ON CONFLICT(material_id) DO UPDATE SET
             position_secs   = excluded.position_secs,
             duration_secs   = MAX(watch_progress.duration_secs, excluded.duration_secs),
             completed       = MAX(watch_progress.completed, excluded.completed),
             last_watched_at = datetime('now')",
        rusqlite::params![material_id, position_secs, duration_secs, completed_i],
    )?;

    // Mirror completion onto materials so rollups reflect it; only ever set (never unset)
    // here — an explicit un-complete goes through `mark_complete`.
    if completed {
        tx.execute(
            "UPDATE materials SET is_completed = 1, updated_at = datetime('now') WHERE id = ?1",
            [material_id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Toggle a material's bookmark flag.
pub fn set_bookmark(conn: &Connection, material_id: i64, bookmarked: bool) -> AppResult<()> {
    conn.execute(
        "UPDATE materials SET is_bookmarked = ?2, updated_at = datetime('now') WHERE id = ?1",
        rusqlite::params![material_id, i64::from(bookmarked)],
    )?;
    Ok(())
}

/// Explicitly set a material's completed flag (the `M` shortcut / control button).
/// Keeps any `watch_progress` row's `completed` in sync.
pub fn mark_complete(conn: &mut Connection, material_id: i64, completed: bool) -> AppResult<()> {
    let c = i64::from(completed);
    let tx = conn.transaction()?;
    tx.execute(
        "UPDATE materials SET is_completed = ?2, updated_at = datetime('now') WHERE id = ?1",
        rusqlite::params![material_id, c],
    )?;
    tx.execute(
        "UPDATE watch_progress SET completed = ?2 WHERE material_id = ?1",
        rusqlite::params![material_id, c],
    )?;
    tx.commit()?;
    Ok(())
}

/// Log a study session of `seconds` ending now, so the Dashboard activity chart + streak
/// get genuine data. No-op for non-positive durations (nothing was actually watched).
///
/// `material_id` is optional (a Pomodoro focus block may not target a specific file).
/// `session_type` is `work` | `short_break` | `long_break`; only `work` sessions count
/// as study time in the activity/streak aggregates (breaks are recorded but excluded
/// there — see `weekly_activity`/`active_days`).
pub fn log_study_session(
    conn: &Connection,
    material_id: Option<i64>,
    seconds: f64,
    session_type: &str,
) -> AppResult<()> {
    if seconds <= 0.0 {
        return Ok(());
    }
    let stype = match session_type {
        "short_break" | "long_break" => session_type,
        _ => "work",
    };
    conn.execute(
        "INSERT INTO study_sessions(material_id, started_at, ended_at, duration_secs, session_type)
         VALUES(?1, datetime('now', ?2), datetime('now'), ?3, ?4)",
        rusqlite::params![material_id, format!("-{seconds} seconds"), seconds, stype],
    )?;
    Ok(())
}

// ── Timestamped notes (v5) ───────────────────────────────────────────────────

/// A note tied to a point in a material's playback.
#[derive(Debug, serde::Serialize)]
pub struct Note {
    pub id: i64,
    pub material_id: i64,
    pub timestamp_secs: f64,
    pub body: String,
    pub created_at: String,
    pub updated_at: String,
}

/// All notes for a material, earliest timestamp first.
pub fn list_notes(conn: &Connection, material_id: i64) -> AppResult<Vec<Note>> {
    let mut stmt = conn.prepare(
        "SELECT id, material_id, timestamp_secs, body, created_at, updated_at
         FROM notes WHERE material_id = ?1
         ORDER BY timestamp_secs ASC, id ASC",
    )?;
    let rows = stmt.query_map([material_id], |r| {
        Ok(Note {
            id: r.get(0)?,
            material_id: r.get(1)?,
            timestamp_secs: r.get(2)?,
            body: r.get(3)?,
            created_at: r.get(4)?,
            updated_at: r.get(5)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Create a note at `timestamp_secs` with `body` (trimmed, non-empty). Returns its id.
pub fn create_note(
    conn: &Connection,
    material_id: i64,
    timestamp_secs: f64,
    body: &str,
) -> AppResult<i64> {
    let body = body.trim();
    if body.is_empty() {
        return Err(crate::utils::errors::AppError::Invalid(
            "note body cannot be empty".into(),
        ));
    }
    let ts = timestamp_secs.max(0.0);
    conn.execute(
        "INSERT INTO notes(material_id, timestamp_secs, body) VALUES(?1, ?2, ?3)",
        rusqlite::params![material_id, ts, body],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Update a note's body (trimmed, non-empty) + bump `updated_at`.
pub fn update_note(conn: &Connection, id: i64, body: &str) -> AppResult<()> {
    let body = body.trim();
    if body.is_empty() {
        return Err(crate::utils::errors::AppError::Invalid(
            "note body cannot be empty".into(),
        ));
    }
    conn.execute(
        "UPDATE notes SET body = ?2, updated_at = datetime('now') WHERE id = ?1",
        rusqlite::params![id, body],
    )?;
    Ok(())
}

/// Delete a note by id.
pub fn delete_note(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM notes WHERE id = ?1", [id])?;
    Ok(())
}

// ── Full-text search (Section 8 Page 8, Ctrl+K) ──────────────────────────────
//
// The `materials_fts` FTS5 index (file_name + file_path) is kept in sync with
// `materials` by triggers in the schema, so a search is a MATCH against the index plus
// a join back to the row for context. Results carry a highlighted snippet (markers the
// frontend splits into <mark> spans — never raw HTML, to avoid injection).

/// One search hit, with enough context to render + navigate to the material.
#[derive(Debug, serde::Serialize)]
pub struct SearchResult {
    pub id: i64,
    pub file_name: String,
    pub file_type: String,
    pub chapter_id: i64,
    pub chapter_name: String,
    pub subject_name: String,
    pub goal_name: String,
    pub is_completed: bool,
    /// Match snippet around the hit, with ``/`` around the matched terms
    /// (the frontend splits on these into highlighted spans — no HTML injection).
    pub snippet: String,
}

/// Build a safe FTS5 MATCH expression from free user text: tokenize on whitespace,
/// strip quotes, quote each token, join with spaces (implicit AND). Returns `None` when
/// there's nothing searchable, so the caller can short-circuit to an empty result list
/// instead of hitting FTS5 with an empty/malformed query.
fn build_match_query(raw: &str) -> Option<String> {
    let tokens: Vec<&str> = raw
        .split_whitespace()
        .map(|t| t.trim_matches('"'))
        .filter(|t| !t.is_empty())
        .collect();
    if tokens.is_empty() {
        return None;
    }
    Some(
        tokens
            .iter()
            .map(|t| format!("\"{}\"", t.replace('"', "")))
            .collect::<Vec<_>>()
            .join(" "),
    )
}

/// Full-text search over materials. `file_type` filters by type when it's a non-empty,
/// non-"all" value. Results are ranked by `bm25` (best first) and capped so the palette
/// stays snappy; an empty/all-whitespace query returns an empty list (no error).
pub fn search_materials(
    conn: &Connection,
    query: &str,
    file_type: Option<&str>,
) -> AppResult<Vec<SearchResult>> {
    let Some(match_expr) = build_match_query(query) else {
        return Ok(Vec::new());
    };

    // snippet() markers:  /  wrap the matched terms; "…" for ellipsis.
    let sql = format!(
        "WITH {MAT_ANC_CTE}
         SELECT
            m.id, m.file_name, m.file_type,
            a.chapter_id, a.chapter_name, a.subject_name, a.goal_name,
            m.is_completed,
            snippet(materials_fts, 0, char(1), char(2), '…', 24)
         FROM materials_fts
         JOIN materials m ON m.id = materials_fts.rowid
         JOIN mat_anc a ON a.mid = m.id
         WHERE materials_fts MATCH ?1 AND m.status = 'active'
         ORDER BY bm25(materials_fts)
         LIMIT 50"
    );

    let mut stmt = if let Some(ft) = file_type {
        if ft.eq_ignore_ascii_case("all") || ft.is_empty() {
            conn.prepare(&sql)?
        } else {
            // Re-prepare with the type filter appended. (Prepared-statement cache key
            // differs by SQL text, so this is fine to do per-call.)
            let filtered = format!(
                "{sql}
                 AND m.file_type = ?2"
            );
            conn.prepare(&filtered)?
        }
    } else {
        conn.prepare(&sql)?
    };

    let rows = if let Some(ft) = file_type {
        if ft.eq_ignore_ascii_case("all") || ft.is_empty() {
            stmt.query_map([&match_expr], map_search)?
        } else {
            stmt.query_map(rusqlite::params![&match_expr, ft], map_search)?
        }
    } else {
        stmt.query_map([&match_expr], map_search)?
    };

    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

fn map_search(r: &rusqlite::Row) -> rusqlite::Result<SearchResult> {
    Ok(SearchResult {
        id: r.get(0)?,
        file_name: r.get(1)?,
        file_type: r.get(2)?,
        chapter_id: r.get(3)?,
        chapter_name: r.get(4)?,
        subject_name: r.get(5)?,
        goal_name: r.get(6)?,
        is_completed: r.get::<_, i64>(7)? != 0,
        snippet: r.get(8)?,
    })
}

// ── Settings + folder management + data export/import (Section 8 Page 7, §10) ──
//
// `settings` is a simple key/value table. `registered_dirs` tracks imported folders;
// here we list them (with goal/subject context), unregister one, or look one up for a
// rescan. Export/import serialize the whole content tree (by name, so an import can
// re-resolve the hierarchy via the existing upserts and merge duplicates gracefully).

/// Read a setting by key (`None` if absent).
pub fn get_setting(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
    let mut rows = stmt.query_map([key], |r| r.get::<_, String>(0))?;
    match rows.next() {
        Some(v) => Ok(Some(v?)),
        None => Ok(None),
    }
}

/// Upsert a setting (key → value).
pub fn set_setting(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO settings(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
    )?;
    Ok(())
}

/// A registered directory row, with its goal/subject names for the Manage Folders list.
#[derive(Debug, serde::Serialize)]
pub struct RegisteredDir {
    pub id: i64,
    pub path: String,
    pub is_active: bool,
    pub scan_status: String,
    pub last_scanned_at: Option<String>,
    /// Id of the root node this folder imports into (NULL only for un-repaired legacy rows).
    pub root_node_id: Option<i64>,
    /// Display name of the root node (the "Goal") this folder belongs to.
    pub root_name: Option<String>,
}

/// List all registered directories newest-first, with their root-node (v6) context.
pub fn list_registered_dirs(conn: &Connection) -> AppResult<Vec<RegisteredDir>> {
    let mut stmt = conn.prepare(
        "SELECT
            r.id, r.path, r.is_active, r.scan_status, r.last_scanned_at,
            r.root_node_id, n.name
         FROM registered_dirs r
         LEFT JOIN nodes n ON n.id = r.root_node_id
         ORDER BY r.id DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(RegisteredDir {
            id: r.get(0)?,
            path: r.get(1)?,
            is_active: r.get::<_, i64>(2)? != 0,
            scan_status: r.get(3)?,
            last_scanned_at: r.get(4)?,
            root_node_id: r.get(5)?,
            root_name: r.get(6)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Internal row with the ids a rescan needs (not serialized).
struct RegisteredDirRef {
    path: String,
    root_node_id: Option<i64>,
}

/// Look up a registered directory by id for rescanning. `NotFound` if absent.
fn registered_dir_ref(conn: &Connection, id: i64) -> AppResult<RegisteredDirRef> {
    conn.query_row(
        "SELECT path, root_node_id FROM registered_dirs WHERE id = ?1",
        [id],
        |r| {
            Ok(RegisteredDirRef {
                path: r.get(0)?,
                root_node_id: r.get(1)?,
            })
        },
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => {
            crate::utils::errors::AppError::NotFound(format!("registered dir {id} not found"))
        }
        other => other.into(),
    })
}

/// Ensure a registered dir has a valid `root_node_id`. Legacy rows migrated from a pre-v6
/// DB whose old `subject_id` didn't map keep a NULL `root_node_id`; rescanning those would
/// try to import under a non-existent node and FK-fail. Self-heal by creating (or reusing)
/// a root node named after the folder and persisting it back onto the row.
fn ensure_dir_root_node(conn: &Connection, dir_id: i64, path: &str) -> AppResult<i64> {
    let name = std::path::Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("Imported")
        .to_string();
    let root_id = upsert_root_node(conn, &name)?;
    conn.execute(
        "UPDATE registered_dirs SET root_node_id = ?1 WHERE id = ?2",
        rusqlite::params![root_id, dir_id],
    )?;
    Ok(root_id)
}

/// Unregister a folder (delete the `registered_dirs` row). Imported materials stay in
/// the library — this only stops tracking/rescanning the folder.
pub fn remove_registered_dir(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM registered_dirs WHERE id = ?1", [id])?;
    Ok(())
}

/// Re-scan a registered folder: walk it and upsert materials under its existing root node
/// (idempotent, so new files are added and nothing duplicates). Returns the path + the
/// root node id the caller needs; the actual walk+import happens in the command layer.
/// Legacy rows with a NULL `root_node_id` are self-healed to a folder-named root so the
/// rescan can't FK-fail.
pub fn registered_dir_for_rescan(conn: &Connection, id: i64) -> AppResult<(String, i64)> {
    let r = registered_dir_ref(conn, id)?;
    let root_node_id = match r.root_node_id {
        Some(root_id) => root_id,
        None => ensure_dir_root_node(conn, id, &r.path)?,
    };
    Ok((r.path, root_node_id))
}

/// Stamp a registered dir's scan status after a rescan.
pub fn mark_dir_scanned(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute(
        "UPDATE registered_dirs SET scan_status = 'done', last_scanned_at = datetime('now')
         WHERE id = ?1",
        [id],
    )?;
    Ok(())
}

/// A watch root for the live watcher: (registered_dir id, absolute path, root_node_id).
pub fn active_watch_roots(conn: &Connection) -> AppResult<Vec<(i64, String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT id, path, root_node_id FROM registered_dirs
         WHERE is_active = 1 AND root_node_id IS NOT NULL
         ORDER BY id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Mark materials in a registered root's subtree whose `file_path` is NOT in `seen` as
/// `status='missing'` (Section 3: don't hard-delete — show "File not found" in the UI).
/// Materials already missing stay missing; active ones not seen on disk flip to missing.
/// `root_node_id` is the registered dir's root node; the subtree CTE covers all depths.
pub fn mark_subject_missing_except(
    conn: &Connection,
    root_node_id: i64,
    seen: &std::collections::HashSet<String>,
) -> AppResult<()> {
    const SUBTREE_CTE: &str = "WITH RECURSIVE subtree(id) AS (
            SELECT ?1
            UNION ALL
            SELECT n.id FROM nodes n JOIN subtree st ON n.parent_id = st.id
        )";
    if seen.is_empty() {
        // No files on disk at all → mark every active material in the subtree missing.
        conn.execute(
            &format!(
                "{SUBTREE_CTE}
                 UPDATE materials SET status='missing', updated_at=datetime('now')
                 WHERE node_id IN (SELECT id FROM subtree) AND status='active'"
            ),
            [root_node_id],
        )?;
        return Ok(());
    }

    let placeholders = (0..seen.len()).map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "{SUBTREE_CTE}
         UPDATE materials SET status='missing', updated_at=datetime('now')
         WHERE node_id IN (SELECT id FROM subtree)
           AND status='active'
           AND file_path NOT IN ({placeholders})"
    );
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(root_node_id)];
    for p in seen {
        params.push(Box::new(p.clone()));
    }
    conn.execute(&sql, rusqlite::params_from_iter(params))?;
    Ok(())
}

// ── Tasks (dashboard to-do list) ─────────────────────────────────────────────
//
// A lightweight task list with optional due date, priority, and a deep-link to a
// material (the "link a video to a task" feature). `material_id` is ON DELETE SET
// NULL so removing a file keeps the task, just drops its link. Ordering: unfinished
// first, then by priority (high→low), then due date (soonest first, nulls last),
// then manual sort_order.

/// One task row, with resolved material context when linked.
#[derive(Debug, serde::Serialize)]
pub struct Task {
    pub id: i64,
    pub title: String,
    pub done: bool,
    /// 0 none / 1 low / 2 medium / 3 high.
    pub priority: i64,
    /// ISO date (YYYY-MM-DD) or datetime; null when no due date.
    pub due_at: Option<String>,
    /// Linked material id (null when unlinked).
    pub material_id: Option<i64>,
    /// Linked material's file name (null when unlinked / missing).
    pub material_name: Option<String>,
    /// Linked material's type (for the row glyph).
    pub material_type: Option<String>,
    pub sort_order: i64,
    /// Optional effort estimate in minutes (schedule view "time budget").
    pub estimated_mins: Option<i64>,
    pub completed_at: Option<String>,
    pub created_at: String,
}

fn map_task(r: &rusqlite::Row) -> rusqlite::Result<Task> {
    Ok(Task {
        id: r.get(0)?,
        title: r.get(1)?,
        done: r.get::<_, i64>(2)? != 0,
        priority: r.get(3)?,
        due_at: r.get(4)?,
        material_id: r.get(5)?,
        material_name: r.get(6)?,
        material_type: r.get(7)?,
        sort_order: r.get(8)?,
        estimated_mins: r.get(9)?,
        completed_at: r.get(10)?,
        created_at: r.get(11)?,
    })
}

/// Columns for a task row (+ joined material context), shared by list queries.
const TASK_SELECT: &str = "SELECT
        t.id, t.title, t.done, t.priority, t.due_at,
        t.material_id, m.file_name, m.file_type,
        t.sort_order, t.estimated_mins, t.completed_at, t.created_at
     FROM tasks t
     LEFT JOIN materials m ON m.id = t.material_id";

/// List all tasks (unfinished first, then by priority, due date, manual order).
pub fn list_tasks(conn: &Connection) -> AppResult<Vec<Task>> {
    let sql = format!(
        "{TASK_SELECT}
         ORDER BY
            t.done,
            t.priority DESC,
            (t.due_at IS NULL), t.due_at,
            t.sort_order, t.id DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], map_task)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Create a task. Returns the new row id.
pub fn create_task(
    conn: &Connection,
    title: &str,
    priority: i64,
    due_at: Option<&str>,
    material_id: Option<i64>,
    estimated_mins: Option<i64>,
) -> AppResult<i64> {
    conn.execute(
        "INSERT INTO tasks(title, priority, due_at, material_id, estimated_mins)
         VALUES(?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![title, priority, due_at, material_id, estimated_mins],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Update a task's editable fields (title, priority, due date, material link, estimate).
pub fn update_task(
    conn: &Connection,
    id: i64,
    title: &str,
    priority: i64,
    due_at: Option<&str>,
    material_id: Option<i64>,
    estimated_mins: Option<i64>,
) -> AppResult<()> {
    conn.execute(
        "UPDATE tasks SET
            title          = ?2,
            priority       = ?3,
            due_at         = ?4,
            material_id    = ?5,
            estimated_mins = ?6,
            updated_at     = datetime('now')
         WHERE id = ?1",
        rusqlite::params![id, title, priority, due_at, material_id, estimated_mins],
    )?;
    Ok(())
}

/// Toggle/set a task's done flag; stamps/clears `completed_at`.
pub fn set_task_done(conn: &Connection, id: i64, done: bool) -> AppResult<()> {
    conn.execute(
        "UPDATE tasks SET
            done = ?2,
            completed_at = CASE WHEN ?2 = 1 THEN datetime('now') ELSE NULL END,
            updated_at = datetime('now')
         WHERE id = ?1",
        rusqlite::params![id, i64::from(done)],
    )?;
    Ok(())
}

/// Delete a task.
pub fn delete_task(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM tasks WHERE id = ?1", [id])?;
    Ok(())
}

// ── Consistency engine (Planning Hub) ────────────────────────────────────────
//
// APPEND-ONLY daily snapshots in `consistency_log`, written lazily on app boot (no
// background loop, ~0 idle CPU). Each row captures that day's task punctuality +
// study presence and a 0-100 score. Because it's a snapshot, editing/deleting a task
// later never rewrites past days. Reads are pre-aggregated (cheap). The whole engine
// runs regardless of the on/off setting so enabling it later shows real history — the
// setting only gates the UI (per the product decision).

/// Raw daily facts computed from `tasks` + `study_sessions` for one calendar day.
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct DayFacts {
    pub tasks_due: i64,
    pub tasks_completed_on_time: i64,
    pub tasks_completed_late: i64,
    pub tasks_missed: i64,
    pub study_minutes: f64,
}

/// One snapshot row (a day on the heatmap / trend).
#[derive(Debug, Clone, serde::Serialize)]
pub struct ConsistencyDay {
    pub day: String,
    pub score: f64,
    pub tasks_due: i64,
    pub tasks_completed_on_time: i64,
    pub tasks_completed_late: i64,
    pub tasks_missed: i64,
    pub study_minutes: f64,
}

/// Compute a 0-100 consistency score from a day's facts.
///
/// - Days WITH deadlines: 60% punctuality (on-time / due) + 40% completion
///   (on-time+late / due). A missed deadline drags both down.
/// - Days with NO deadlines: driven by study presence — studied → 100 ("showed up"),
///   idle → returns `None` (a neutral day, excluded from the trailing average so users
///   aren't punished for days they didn't schedule anything).
///
/// Returns `None` for a fully-neutral day (no tasks due, no study) so callers can skip it.
pub fn score_for_day(f: &DayFacts) -> Option<f64> {
    if f.tasks_due > 0 {
        let due = f.tasks_due as f64;
        let punctuality = f.tasks_completed_on_time as f64 / due;
        let completion = (f.tasks_completed_on_time + f.tasks_completed_late) as f64 / due;
        Some(((0.6 * punctuality + 0.4 * completion) * 100.0).clamp(0.0, 100.0))
    } else if f.study_minutes > 0.0 {
        Some(100.0)
    } else {
        None
    }
}

/// Compute the raw facts for a single day (YYYY-MM-DD) from the live tables.
///
/// A task "belongs" to a day if its `due_at` date == that day. On-time =
/// completed_at <= due_at; late = completed after due_at; missed = still not done AND
/// the day is in the past (a task due later today isn't "missed" yet). Study minutes =
/// sum of `work` study_sessions on that date.
pub fn day_facts(conn: &Connection, day: &str) -> AppResult<DayFacts> {
    // Task punctuality for tasks whose due date is `day`.
    let (due, on_time, late, missed): (i64, i64, i64, i64) = conn.query_row(
        "SELECT
            COUNT(*),
            COALESCE(SUM(CASE WHEN done = 1 AND completed_at IS NOT NULL
                                   AND completed_at <= due_at THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN done = 1 AND completed_at IS NOT NULL
                                   AND completed_at > due_at THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN done = 0 AND date(due_at) < date('now') THEN 1 ELSE 0 END), 0)
         FROM tasks
         WHERE due_at IS NOT NULL AND date(due_at) = ?1",
        [day],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;

    let study_secs: f64 = conn.query_row(
        "SELECT COALESCE(SUM(duration_secs), 0) FROM study_sessions
         WHERE session_date = ?1 AND session_type = 'work'",
        [day],
        |r| r.get(0),
    )?;

    Ok(DayFacts {
        tasks_due: due,
        tasks_completed_on_time: on_time,
        tasks_completed_late: late,
        tasks_missed: missed,
        study_minutes: study_secs / 60.0,
    })
}

/// Upsert the snapshot row for `day` from its current facts (idempotent).
pub fn snapshot_day(conn: &Connection, day: &str) -> AppResult<()> {
    let f = day_facts(conn, day)?;
    let score = score_for_day(&f).unwrap_or(0.0);
    conn.execute(
        "INSERT INTO consistency_log(
            day, tasks_due, tasks_completed_on_time, tasks_completed_late,
            tasks_missed, study_minutes, score)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(day) DO UPDATE SET
            tasks_due               = excluded.tasks_due,
            tasks_completed_on_time = excluded.tasks_completed_on_time,
            tasks_completed_late    = excluded.tasks_completed_late,
            tasks_missed            = excluded.tasks_missed,
            study_minutes           = excluded.study_minutes,
            score                   = excluded.score",
        rusqlite::params![
            day,
            f.tasks_due,
            f.tasks_completed_on_time,
            f.tasks_completed_late,
            f.tasks_missed,
            f.study_minutes,
            score
        ],
    )?;
    Ok(())
}

/// Lazy backfill: snapshot every day from the earliest relevant activity (or the last
/// logged day) up to today. Called once on boot — O(days since last open), no loop.
/// Re-snapshots the most recent logged day + today so recent edits are reflected.
pub fn backfill_consistency(conn: &Connection) -> AppResult<()> {
    // The window start: the earliest of (first task due date, first study session date,
    // last logged day). We only need to (re)snapshot from the last logged day forward,
    // but we also re-do the last logged day itself in case that day's tasks changed.
    let last_logged: Option<String> =
        conn.query_row("SELECT MAX(day) FROM consistency_log", [], |r| r.get(0))
            .optional()?
            .flatten();

    let start: Option<String> = match last_logged {
        Some(d) => Some(d), // re-snapshot from the last logged day forward
        None => {
            // First ever run: start from the earliest activity we can find.
            conn.query_row(
                "SELECT MIN(d) FROM (
                    SELECT MIN(date(due_at)) AS d FROM tasks WHERE due_at IS NOT NULL
                    UNION ALL
                    SELECT MIN(session_date) AS d FROM study_sessions
                 )",
                [],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten()
        }
    };

    let Some(start) = start else {
        // No activity at all yet — nothing to snapshot. Cheapest possible path.
        return Ok(());
    };

    // Enumerate day = start .. today (inclusive) using SQLite date math, capped to a
    // sane window (365 days) so a very old first-activity date can't explode the loop.
    let days: Vec<String> = {
        let mut stmt = conn.prepare(
            "WITH RECURSIVE d(day) AS (
                SELECT date(?1)
                UNION ALL
                SELECT date(day, '+1 day') FROM d
                WHERE day < date('now') AND day >= date('now', '-365 days')
             )
             SELECT day FROM d",
        )?;
        let rows = stmt.query_map([&start], |r| r.get::<_, String>(0))?;
        let mut v = Vec::new();
        for row in rows {
            v.push(row?);
        }
        v
    };

    for day in days {
        snapshot_day(conn, &day)?;
    }
    Ok(())
}

/// Summary payload for the Consistency card: the headline score, a status label, and
/// the per-day series (for the heatmap + trend). `days` is how far back to return.
#[derive(Debug, serde::Serialize)]
pub struct ConsistencySummary {
    /// Trailing weighted score 0-100 (recent days weighted heavier). Null if no data.
    pub score: Option<f64>,
    /// Current streak of consecutive days scoring >= 60 ending today/yesterday.
    pub streak: i64,
    /// Per-day rows, oldest first, for the heatmap + trend line.
    pub days: Vec<ConsistencyDay>,
    /// Whether the strict tracking UI is enabled (mirrors the setting).
    pub enabled: bool,
}

/// Read the consistency summary for the last `window_days` days.
pub fn consistency_summary(conn: &Connection, window_days: i64) -> AppResult<ConsistencySummary> {
    let enabled = get_setting(conn, "consistency.enabled")?
        .map(|v| v == "true" || v == "1")
        .unwrap_or(false);

    let mut stmt = conn.prepare(
        "SELECT day, score, tasks_due, tasks_completed_on_time, tasks_completed_late,
                tasks_missed, study_minutes
         FROM consistency_log
         WHERE day >= date('now', ?1)
         ORDER BY day",
    )?;
    let offset = format!("-{} days", window_days.max(1) - 1);
    let rows = stmt.query_map([offset], |r| {
        Ok(ConsistencyDay {
            day: r.get(0)?,
            score: r.get(1)?,
            tasks_due: r.get(2)?,
            tasks_completed_on_time: r.get(3)?,
            tasks_completed_late: r.get(4)?,
            tasks_missed: r.get(5)?,
            study_minutes: r.get(6)?,
        })
    })?;
    let mut days = Vec::new();
    for row in rows {
        days.push(row?);
    }

    // Trailing weighted average: only days that actually have signal (tasks due or study)
    // count; recent days weighted heavier (linear ramp). Neutral days are skipped.
    let mut wsum = 0.0f64;
    let mut wtot = 0.0f64;
    for (i, d) in days.iter().enumerate() {
        let has_signal = d.tasks_due > 0 || d.study_minutes > 0.0;
        if !has_signal {
            continue;
        }
        let w = (i + 1) as f64; // more recent → larger weight
        wsum += d.score * w;
        wtot += w;
    }
    let score = if wtot > 0.0 { Some(wsum / wtot) } else { None };

    // Streak: consecutive trailing days (from the end) scoring >= 60 with signal.
    let mut streak = 0i64;
    for d in days.iter().rev() {
        let has_signal = d.tasks_due > 0 || d.study_minutes > 0.0;
        if !has_signal {
            // A neutral day neither extends nor breaks the streak — skip it.
            continue;
        }
        if d.score >= 60.0 {
            streak += 1;
        } else {
            break;
        }
    }

    Ok(ConsistencySummary {
        score,
        streak,
        days,
        enabled,
    })
}

// ── Export / import (§10) ────────────────────────────────────────────────────
//
// The export format is name-keyed for the hierarchy (goal/subject/chapter names, not
// ids) so an import can re-resolve via the existing upserts and merge duplicates. A
// material is keyed by its UNIQUE file_path. Watch progress rides along keyed by
// file_path too (resolved to the material after upsert).

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct ExportGoal {
    pub name: String,
    pub icon: String,
    pub color: String,
    pub subjects: Vec<ExportSubject>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct ExportSubject {
    pub name: String,
    pub icon: String,
    pub chapters: Vec<ExportChapter>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct ExportChapter {
    pub name: String,
    pub materials: Vec<ExportMaterial>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct ExportMaterial {
    pub file_path: String,
    pub file_name: String,
    pub file_type: String,
    pub file_extension: String,
    pub file_size_bytes: i64,
    pub is_bookmarked: bool,
    pub is_completed: bool,
    /// Watch position in seconds (0 if never watched).
    pub position_secs: f64,
    pub duration_secs: f64,
}

/// The full export payload (goals tree + settings). Section 10: "all goals, subjects,
/// chapters, progress, settings".
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct ExportPayload {
    pub version: i64,
    pub exported_at: String,
    pub goals: Vec<ExportGoal>,
    pub settings: std::collections::BTreeMap<String, String>,
}

/// Assemble the full export payload.
pub fn build_export(conn: &Connection) -> AppResult<ExportPayload> {
    let mut goals_out: Vec<ExportGoal> = Vec::new();

    // Export walks the tree's top THREE levels into the legacy goal/subject/chapter JSON
    // shape (roots → children → grandchildren). Materials at any depth are attached to
    // the nearest of those three ancestors so nothing is lost; deeper folder names beyond
    // depth 2 are flattened into their depth-2 ancestor's chapter. (Round-trips the common
    // case exactly; a full tree export format is a later enhancement.)
    let mut g_stmt = conn.prepare(
        "SELECT id, name, COALESCE(icon,'🎯'), COALESCE(color,'#AAFF00')
         FROM nodes WHERE parent_id IS NULL ORDER BY name",
    )?;
    let g_rows = g_stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
        ))
    })?;
    for g in g_rows {
        let (gid, gname, gicon, gcolor) = g?;
        let mut subjects_out: Vec<ExportSubject> = Vec::new();

        let mut s_stmt = conn.prepare(
            "SELECT id, name, COALESCE(icon,'📚') FROM nodes WHERE parent_id = ?1 ORDER BY name",
        )?;
        let s_rows = s_stmt.query_map([gid], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        for s in s_rows {
            let (sid, sname, sicon) = s?;
            let mut chapters_out: Vec<ExportChapter> = Vec::new();

            let mut c_stmt =
                conn.prepare("SELECT id, name FROM nodes WHERE parent_id = ?1 ORDER BY name")?;
            let c_rows =
                c_stmt.query_map([sid], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
            for c in c_rows {
                let (cid, cname) = c?;
                let mut mats_out: Vec<ExportMaterial> = Vec::new();

                // Materials in this chapter node's whole subtree (covers depth >2 too).
                let mut m_stmt = conn.prepare(
                    "WITH RECURSIVE subtree(id) AS (
                        SELECT ?1 UNION ALL
                        SELECT n.id FROM nodes n JOIN subtree st ON n.parent_id = st.id
                     )
                     SELECT
                        m.file_path, m.file_name, m.file_type, m.file_extension, m.file_size_bytes,
                        m.is_bookmarked, m.is_completed,
                        COALESCE(wp.position_secs, 0.0), COALESCE(wp.duration_secs, 0.0)
                     FROM materials m
                     LEFT JOIN watch_progress wp ON wp.material_id = m.id
                     WHERE m.node_id IN (SELECT id FROM subtree) AND m.status = 'active'
                     ORDER BY m.file_name",
                )?;
                let m_rows = m_stmt.query_map([cid], |r| {
                    Ok(ExportMaterial {
                        file_path: r.get(0)?,
                        file_name: r.get(1)?,
                        file_type: r.get(2)?,
                        file_extension: r.get(3)?,
                        file_size_bytes: r.get(4)?,
                        is_bookmarked: r.get::<_, i64>(5)? != 0,
                        is_completed: r.get::<_, i64>(6)? != 0,
                        position_secs: r.get(7)?,
                        duration_secs: r.get(8)?,
                    })
                })?;
                for m in m_rows {
                    mats_out.push(m?);
                }
                chapters_out.push(ExportChapter {
                    name: cname,
                    materials: mats_out,
                });
            }
            subjects_out.push(ExportSubject {
                name: sname,
                icon: sicon,
                chapters: chapters_out,
            });
        }
        goals_out.push(ExportGoal {
            name: gname,
            icon: gicon,
            color: gcolor,
            subjects: subjects_out,
        });
    }

    let mut settings = std::collections::BTreeMap::new();
    let mut set_stmt = conn.prepare("SELECT key, value FROM settings ORDER BY key")?;
    let set_rows =
        set_stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for s in set_rows {
        let (k, v) = s?;
        settings.insert(k, v);
    }

    let exported_at: String = conn.query_row("SELECT datetime('now')", [], |r| r.get(0))?;
    Ok(ExportPayload {
        version: 1,
        exported_at,
        goals: goals_out,
        settings,
    })
}

/// Counts from a JSON import/merge, for the UI confirmation.
#[derive(Debug, Default, serde::Serialize)]
pub struct ImportSummary {
    pub goals: i64,
    pub subjects: i64,
    pub chapters: i64,
    pub materials: i64,
}

/// Merge an export payload into the DB. Duplicates resolve via the existing UNIQUE
/// constraints + upserts (goal by name, subject by goal+name, chapter by subject+name,
/// material by file_path). Watch progress is restored by file_path. Runs in one
/// transaction so a partial import doesn't leave the DB half-merged.
pub fn merge_import(conn: &mut Connection, payload: &ExportPayload) -> AppResult<ImportSummary> {
    let tx = conn.transaction()?;
    let mut counts = ImportSummary::default();

    for g in &payload.goals {
        // Goal → root node. Roots use NULL parent, so we can't ON CONFLICT — look up first.
        let goal_id: i64 = if let Some(id) = tx
            .query_row(
                "SELECT id FROM nodes WHERE parent_id IS NULL AND name = ?1",
                [&g.name],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
        {
            tx.execute(
                "UPDATE nodes SET icon = COALESCE(icon, ?2), color = COALESCE(color, ?3),
                     updated_at = datetime('now') WHERE id = ?1",
                rusqlite::params![id, g.icon, g.color],
            )?;
            id
        } else {
            tx.execute(
                "INSERT INTO nodes(parent_id, name, kind, icon, color, depth)
                 VALUES(NULL, ?1, 'root', ?2, ?3, 0)",
                rusqlite::params![g.name, g.icon, g.color],
            )?;
            tx.last_insert_rowid()
        };
        counts.goals += 1;

        for s in &g.subjects {
            tx.execute(
                "INSERT INTO nodes(parent_id, name, kind, icon, depth) VALUES(?1, ?2, 'folder', ?3, 1)
                 ON CONFLICT(parent_id, name) DO UPDATE SET updated_at = datetime('now')",
                rusqlite::params![goal_id, s.name, s.icon],
            )?;
            let subject_id: i64 = tx.query_row(
                "SELECT id FROM nodes WHERE parent_id = ?1 AND name = ?2",
                rusqlite::params![goal_id, s.name],
                |r| r.get(0),
            )?;
            counts.subjects += 1;

            for c in &s.chapters {
                tx.execute(
                    "INSERT INTO nodes(parent_id, name, kind, depth) VALUES(?1, ?2, 'folder', 2)
                     ON CONFLICT(parent_id, name) DO UPDATE SET updated_at = datetime('now')",
                    rusqlite::params![subject_id, c.name],
                )?;
                let chapter_id: i64 = tx.query_row(
                    "SELECT id FROM nodes WHERE parent_id = ?1 AND name = ?2",
                    rusqlite::params![subject_id, c.name],
                    |r| r.get(0),
                )?;
                counts.chapters += 1;

                for m in &c.materials {
                    tx.execute(
                        "INSERT INTO materials(
                            node_id, file_path, file_name, file_type, file_extension,
                            file_size_bytes, is_bookmarked, is_completed
                         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                         ON CONFLICT(file_path) DO UPDATE SET
                            node_id         = excluded.node_id,
                            file_name       = excluded.file_name,
                            file_type       = excluded.file_type,
                            file_extension  = excluded.file_extension,
                            file_size_bytes = excluded.file_size_bytes,
                            is_bookmarked   = excluded.is_bookmarked,
                            is_completed    = MAX(materials.is_completed, excluded.is_completed),
                            updated_at      = datetime('now')",
                        rusqlite::params![
                            chapter_id,
                            m.file_path,
                            m.file_name,
                            m.file_type,
                            m.file_extension,
                            m.file_size_bytes,
                            i64::from(m.is_bookmarked),
                            i64::from(m.is_completed),
                        ],
                    )?;
                    let material_id: i64 = tx.query_row(
                        "SELECT id FROM materials WHERE file_path = ?1",
                        [&m.file_path],
                        |r| r.get(0),
                    )?;
                    counts.materials += 1;

                    // Restore watch progress (upsert; keep the larger position/duration).
                    if m.position_secs > 0.0 || m.duration_secs > 0.0 {
                        tx.execute(
                            "INSERT INTO watch_progress(material_id, position_secs, duration_secs, completed, last_watched_at, watch_count)
                             VALUES(?1, ?2, ?3, ?4, datetime('now'), 1)
                             ON CONFLICT(material_id) DO UPDATE SET
                                position_secs = MAX(watch_progress.position_secs, excluded.position_secs),
                                duration_secs = MAX(watch_progress.duration_secs, excluded.duration_secs)",
                            rusqlite::params![
                                material_id,
                                m.position_secs,
                                m.duration_secs,
                                i64::from(m.is_completed),
                            ],
                        )?;
                    }
                }
            }
        }
    }

    // Merge settings (skip the health-check key).
    for (k, v) in &payload.settings {
        if k == "__healthcheck" {
            continue;
        }
        tx.execute(
            "INSERT INTO settings(key, value) VALUES(?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [k, v],
        )?;
    }

    tx.commit()?;
    Ok(counts)
}
