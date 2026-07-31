//! Planner persistence (v9) — the bridge between SQLite and the pure [`solver`].
//!
//! ## Division of labour
//!
//! Everything in here does I/O; nothing in here does scheduling *math*. The pattern for any
//! adjustment is always:
//!
//!   1. [`build_day_snapshot`] reads the day into plain Rust structs (mutex held, microseconds).
//!   2. The caller drops the guard.
//!   3. [`solver::build_recovery_plans`] computes options (no lock, no I/O).
//!   4. [`apply_recovery`] writes ONE small transaction if the student picks a plan.
//!
//! That ordering is what keeps the scheduler off the video-playback critical path: the app has
//! a single `Mutex<Connection>`, and holding it during computation would stall `save_progress`
//! / `log_session` and surface as playback stutter.
//!
//! ## Local time is the caller's responsibility
//!
//! SQLite's `date('now')` / `datetime('now')` are **UTC**. A planner keyed on UTC days would
//! roll over at the wrong moment for most of the world and would mis-file late-evening study.
//! So every function here that needs "today" or "now" takes it as a parameter — the frontend
//! passes its local `day` (YYYY-MM-DD) and `now_mins` (minutes since local midnight). The only
//! places we let SQLite generate a timestamp are `created_at`/`updated_at`-style bookkeeping
//! columns and `plan_events.at`, where an absolute instant is exactly what we want.

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::planner::solver::{
    self, AdjustPrefs, BlockInput, BlockState, DaySnapshot, IntegrityVerdict, MoveAction, PlanKind,
    RecoveryReport,
};
use crate::planner::{fmt_hhmm, parse_hhmm, DEFAULT_HARD_STOP, DEFAULT_WAKE};
use crate::utils::errors::{AppError, AppResult};

/// Settings key holding the global fallback hard stop ('HH:MM').
pub const SETTING_HARD_STOP: &str = "plan.hard_stop";
/// Settings key holding the global fallback wake time ('HH:MM').
pub const SETTING_WAKE: &str = "plan.wake";
/// Prefix for the single-slot undo payload persisted per day.
const UNDO_KEY_PREFIX: &str = "plan.undo.";

// ── DTOs ─────────────────────────────────────────────────────────────────────

/// One planner block, as sent to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct PlanBlock {
    pub id: i64,
    pub day: String,
    pub planned_start: String,
    pub planned_mins: i64,
    pub actual_start: Option<String>,
    pub actual_mins: Option<i64>,
    /// The position actually in force (`actual_*` when adjusted, else `planned_*`). Provided so
    /// the UI never has to re-implement the fallback rule.
    pub effective_start: String,
    pub effective_mins: i64,
    pub title: String,
    pub target_kind: String,
    pub target_node_id: Option<i64>,
    pub target_material_id: Option<i64>,
    pub target_task_id: Option<i64>,
    pub target_count: Option<i64>,
    /// Resolved display name of the target (course / file / task), when it still exists.
    pub target_name: Option<String>,
    pub weight: i64,
    pub is_anchored: bool,
    pub min_viable_mins: Option<i64>,
    pub status: String,
    pub executed_mins: f64,
    pub progress_count: i64,
    pub completed_at: Option<String>,
    pub spilled_from_id: Option<i64>,
    /// How many times this work has already been pushed to a later day.
    pub spill_count: i64,
    pub notes: Option<String>,
    /// True when completion cannot be detected automatically and the student must confirm.
    pub needs_manual_confirm: bool,
}

/// Everything the Today surface needs in one round-trip.
#[derive(Debug, Clone, Serialize)]
pub struct DayPlan {
    pub day: String,
    pub wake_at: String,
    pub hard_stop_at: String,
    pub planned_mins: i64,
    pub executed_mins: f64,
    pub blocks: Vec<PlanBlock>,
    /// Pre-mortem verdict (advisory only — never blocks saving an ambitious plan).
    pub integrity: IntegrityVerdict,
}

/// Create/update payload for a block.
#[derive(Debug, Clone, Deserialize)]
pub struct BlockInputDto {
    pub id: Option<i64>,
    pub day: String,
    pub planned_start: String,
    pub planned_mins: i64,
    pub title: String,
    #[serde(default = "default_target_kind")]
    pub target_kind: String,
    pub target_node_id: Option<i64>,
    pub target_material_id: Option<i64>,
    pub target_task_id: Option<i64>,
    pub target_count: Option<i64>,
    #[serde(default = "default_weight")]
    pub weight: i64,
    #[serde(default)]
    pub is_anchored: bool,
    pub min_viable_mins: Option<i64>,
    pub notes: Option<String>,
}

fn default_target_kind() -> String {
    "freeform".to_string()
}
fn default_weight() -> i64 {
    2
}

/// Valid `target_kind` values. Anything else is rejected rather than silently stored, so a
/// typo can't create a block the solver quietly mis-handles forever.
const TARGET_KINDS: [&str; 5] = ["material", "node_count", "node_minutes", "task", "freeform"];

/// Valid `status` values.
const STATUSES: [&str; 6] = ["pending", "active", "done", "partial", "skipped", "spilled"];

/// Whether a block's completion can be observed from playback, or needs the student to say so.
///
/// `material` / `node_count` / `node_minutes` blocks are auto-tracked through the existing
/// `watch_progress` + `log_session` path. `task` follows its to-do row. `freeform`
/// ("read textbook page 10") has no digital footprint at all, so it — and only it — requires
/// manual confirmation.
fn needs_manual_confirm(target_kind: &str) -> bool {
    target_kind == "freeform"
}

// ── Day window resolution ────────────────────────────────────────────────────

/// Resolve the usable window for a day as `(wake_mins, hard_stop_mins)`.
///
/// Precedence is per-day → global setting → built-in default. The per-day override matters:
/// a student may legitimately want to study late on a Saturday, and a single global bedtime
/// would either block that or push every weekday too late.
pub fn resolve_day_window(conn: &Connection, day: &str) -> AppResult<(i32, i32)> {
    let row: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT wake_at, hard_stop_at FROM plan_days WHERE day = ?1",
            [day],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (day_wake, day_stop) = row.unwrap_or((None, None));

    let wake = day_wake
        .as_deref()
        .and_then(parse_hhmm)
        .or_else(|| {
            crate::db::queries::get_setting(conn, SETTING_WAKE)
                .ok()
                .flatten()
                .as_deref()
                .and_then(parse_hhmm)
        })
        .unwrap_or_else(|| parse_hhmm(DEFAULT_WAKE).unwrap_or(360));

    let stop = day_stop
        .as_deref()
        .and_then(parse_hhmm)
        .or_else(|| {
            crate::db::queries::get_setting(conn, SETTING_HARD_STOP)
                .ok()
                .flatten()
                .as_deref()
                .and_then(parse_hhmm)
        })
        .unwrap_or_else(|| parse_hhmm(DEFAULT_HARD_STOP).unwrap_or(1320));

    // A hard stop at or before the wake time would yield a zero-length day and make every
    // plan look impossible. Treat it as misconfiguration and fall back to the default.
    let stop = if stop <= wake {
        parse_hhmm(DEFAULT_HARD_STOP).unwrap_or(1320).max(wake + 60)
    } else {
        stop
    };
    Ok((wake, stop))
}

/// Persist a day's window. `None` clears the override (falling back to the global setting).
pub fn set_day_window(
    conn: &Connection,
    day: &str,
    wake_at: Option<&str>,
    hard_stop_at: Option<&str>,
) -> AppResult<()> {
    // Validate before writing: an unparseable time silently ignored at read time would be a
    // confusing "my bedtime didn't save" bug.
    for v in [wake_at, hard_stop_at].into_iter().flatten() {
        if parse_hhmm(v).is_none() {
            return Err(AppError::Invalid(format!("invalid time '{v}' (want HH:MM)")));
        }
    }
    conn.execute(
        "INSERT INTO plan_days(day, wake_at, hard_stop_at) VALUES(?1, ?2, ?3)
         ON CONFLICT(day) DO UPDATE SET wake_at = excluded.wake_at,
                                       hard_stop_at = excluded.hard_stop_at",
        rusqlite::params![day, wake_at, hard_stop_at],
    )?;
    Ok(())
}

// ── Reads ────────────────────────────────────────────────────────────────────

/// Shared SELECT for a block row, resolving the target's display name and the spill depth.
///
/// `spill_count` walks the `spilled_from_id` chain with a recursive CTE: a block carried over
/// three days running reports 3, which is what promotes chronically-deferred work in triage.
const BLOCK_SELECT: &str = "
WITH RECURSIVE spill(id, root, n) AS (
    SELECT id, spilled_from_id, 0 FROM plan_blocks
    UNION ALL
    SELECT s.id, p.spilled_from_id, s.n + 1
    FROM spill s JOIN plan_blocks p ON p.id = s.root
    WHERE s.root IS NOT NULL
),
spill_depth AS (SELECT id, MAX(n) AS depth FROM spill GROUP BY id)
SELECT
    b.id, b.day, b.planned_start, b.planned_mins, b.actual_start, b.actual_mins,
    b.title, b.target_kind, b.target_node_id, b.target_material_id, b.target_task_id,
    b.target_count,
    COALESCE(n.name, m.file_name, t.title) AS target_name,
    b.weight, b.is_anchored, b.min_viable_mins, b.status, b.executed_mins,
    b.progress_count, b.completed_at, b.spilled_from_id,
    COALESCE(sd.depth, 0) AS spill_count, b.notes
FROM plan_blocks b
LEFT JOIN nodes     n ON n.id = b.target_node_id
LEFT JOIN materials m ON m.id = b.target_material_id
LEFT JOIN tasks     t ON t.id = b.target_task_id
LEFT JOIN spill_depth sd ON sd.id = b.id";

fn map_block(r: &rusqlite::Row) -> rusqlite::Result<PlanBlock> {
    let planned_start: String = r.get(2)?;
    let planned_mins: i64 = r.get(3)?;
    let actual_start: Option<String> = r.get(4)?;
    let actual_mins: Option<i64> = r.get(5)?;
    let target_kind: String = r.get(7)?;
    Ok(PlanBlock {
        id: r.get(0)?,
        day: r.get(1)?,
        effective_start: actual_start.clone().unwrap_or_else(|| planned_start.clone()),
        effective_mins: actual_mins.unwrap_or(planned_mins),
        planned_start,
        planned_mins,
        actual_start,
        actual_mins,
        title: r.get(6)?,
        needs_manual_confirm: needs_manual_confirm(&target_kind),
        target_kind,
        target_node_id: r.get(8)?,
        target_material_id: r.get(9)?,
        target_task_id: r.get(10)?,
        target_count: r.get(11)?,
        target_name: r.get(12)?,
        weight: r.get(13)?,
        is_anchored: r.get::<_, i64>(14)? != 0,
        min_viable_mins: r.get(15)?,
        status: r.get(16)?,
        executed_mins: r.get(17)?,
        progress_count: r.get(18)?,
        completed_at: r.get(19)?,
        spilled_from_id: r.get(20)?,
        spill_count: r.get(21)?,
        notes: r.get(22)?,
    })
}

/// All blocks for a day, in schedule order.
pub fn list_day_blocks(conn: &Connection, day: &str) -> AppResult<Vec<PlanBlock>> {
    let sql = format!(
        "{BLOCK_SELECT}
         WHERE b.day = ?1
         ORDER BY COALESCE(b.actual_start, b.planned_start), b.id"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([day], map_block)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Fetch one block by id.
pub fn get_block(conn: &Connection, id: i64) -> AppResult<PlanBlock> {
    let sql = format!("{BLOCK_SELECT} WHERE b.id = ?1");
    conn.query_row(&sql, [id], map_block)
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("plan block {id}")))
}

/// Learned pace for a course node, defaulting to 1.0 (real-time) when unseen.
fn pace_for_node(conn: &Connection, node_id: Option<i64>) -> f64 {
    let Some(node_id) = node_id else { return 1.0 };
    conn.query_row(
        "SELECT pace_ratio FROM node_velocity WHERE node_id = ?1",
        [node_id],
        |r| r.get::<_, f64>(0),
    )
    .optional()
    .ok()
    .flatten()
    .unwrap_or(1.0)
    .clamp(0.25, 4.0)
}

/// Read a day into the pure solver's input shape.
pub fn build_day_snapshot(conn: &Connection, day: &str) -> AppResult<DaySnapshot> {
    let (wake, stop) = resolve_day_window(conn, day)?;
    let rows = list_day_blocks(conn, day)?;

    let mut blocks = Vec::with_capacity(rows.len());
    for b in &rows {
        // A malformed stored time would otherwise be silently treated as midnight; fall back
        // to the wake time so the block stays visible and obviously misplaced instead.
        let start = parse_hhmm(&b.effective_start).unwrap_or(wake);
        blocks.push(BlockInput {
            id: b.id,
            title: b.title.clone(),
            start_mins: start,
            planned_mins: b.effective_mins.clamp(1, 24 * 60) as i32,
            weight: b.weight.clamp(0, 3) as i32,
            is_anchored: b.is_anchored,
            min_viable_mins: b.min_viable_mins.map(|v| v.clamp(1, 24 * 60) as i32),
            state: BlockState::from_db(&b.status),
            executed_mins: b.executed_mins,
            spill_count: b.spill_count.clamp(0, 100) as i32,
            pace_ratio: pace_for_node(conn, b.target_node_id),
            // Exam linkage arrives with backward-planning (a later phase); until then no block
            // claims exam urgency rather than every block pretending to have it.
            exam_linked: false,
        });
    }

    Ok(DaySnapshot {
        day: day.to_string(),
        wake_mins: wake,
        hard_stop_mins: stop,
        blocks,
        prefs: AdjustPrefs::default(),
    })
}

/// Assemble the full Today payload, including the advisory pre-mortem.
pub fn day_plan(conn: &Connection, day: &str) -> AppResult<DayPlan> {
    let (wake, stop) = resolve_day_window(conn, day)?;
    let blocks = list_day_blocks(conn, day)?;
    let snapshot = build_day_snapshot(conn, day)?;
    let integrity = solver::plan_integrity(&snapshot);

    let planned_mins: i64 = blocks
        .iter()
        .filter(|b| BlockState::from_db(&b.status).is_open())
        .map(|b| b.effective_mins)
        .sum();
    let executed_mins: f64 = blocks.iter().map(|b| b.executed_mins).sum();

    Ok(DayPlan {
        day: day.to_string(),
        wake_at: fmt_hhmm(wake),
        hard_stop_at: fmt_hhmm(stop),
        planned_mins,
        executed_mins,
        blocks,
        integrity,
    })
}

/// Compute the recovery options for a day. Read-only by design: the UI can preview freely and
/// nothing is committed until [`apply_recovery`].
pub fn recovery_report(conn: &Connection, day: &str, now_mins: i32) -> AppResult<RecoveryReport> {
    let snapshot = build_day_snapshot(conn, day)?;
    Ok(solver::build_recovery_plans(&snapshot, now_mins))
}

// ── Writes ───────────────────────────────────────────────────────────────────

/// Append a lifecycle event. Best-effort by contract: the ledger is for learning and audit, so
/// a failure here must never abort the user-visible action that triggered it.
pub fn log_event(
    conn: &Connection,
    block_id: Option<i64>,
    day: &str,
    kind: &str,
    delta_mins: Option<i64>,
    meta: Option<&str>,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO plan_events(block_id, day, kind, delta_mins, meta)
         VALUES(?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![block_id, day, kind, delta_mins, meta],
    )?;
    Ok(())
}

/// Create or update a block. Returns its id.
pub fn upsert_block(conn: &Connection, input: &BlockInputDto) -> AppResult<i64> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err(AppError::Invalid("block title is required".into()));
    }
    if parse_hhmm(&input.planned_start).is_none() {
        return Err(AppError::Invalid(format!(
            "invalid start '{}' (want HH:MM)",
            input.planned_start
        )));
    }
    if !TARGET_KINDS.contains(&input.target_kind.as_str()) {
        return Err(AppError::Invalid(format!(
            "unknown target_kind '{}'",
            input.target_kind
        )));
    }
    if input.planned_mins < 1 || input.planned_mins > 24 * 60 {
        return Err(AppError::Invalid(
            "planned_mins must be between 1 and 1440".into(),
        ));
    }
    let weight = input.weight.clamp(0, 3);

    // Ensure the day row exists so the window/adjust state have somewhere to live.
    conn.execute(
        "INSERT INTO plan_days(day) VALUES(?1) ON CONFLICT(day) DO NOTHING",
        [&input.day],
    )?;

    match input.id {
        Some(id) => {
            let n = conn.execute(
                "UPDATE plan_blocks SET
                    day = ?2, planned_start = ?3, planned_mins = ?4, title = ?5,
                    target_kind = ?6, target_node_id = ?7, target_material_id = ?8,
                    target_task_id = ?9, target_count = ?10, weight = ?11,
                    is_anchored = ?12, min_viable_mins = ?13, notes = ?14,
                    updated_at = datetime('now')
                 WHERE id = ?1",
                rusqlite::params![
                    id,
                    input.day,
                    input.planned_start,
                    input.planned_mins,
                    title,
                    input.target_kind,
                    input.target_node_id,
                    input.target_material_id,
                    input.target_task_id,
                    input.target_count,
                    weight,
                    i64::from(input.is_anchored),
                    input.min_viable_mins,
                    input.notes,
                ],
            )?;
            if n == 0 {
                return Err(AppError::NotFound(format!("plan block {id}")));
            }
            Ok(id)
        }
        None => {
            conn.execute(
                "INSERT INTO plan_blocks(
                    day, planned_start, planned_mins, title, target_kind, target_node_id,
                    target_material_id, target_task_id, target_count, weight, is_anchored,
                    min_viable_mins, notes)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
                rusqlite::params![
                    input.day,
                    input.planned_start,
                    input.planned_mins,
                    title,
                    input.target_kind,
                    input.target_node_id,
                    input.target_material_id,
                    input.target_task_id,
                    input.target_count,
                    weight,
                    i64::from(input.is_anchored),
                    input.min_viable_mins,
                    input.notes,
                ],
            )?;
            Ok(conn.last_insert_rowid())
        }
    }
}

/// Delete a block outright (a genuine "I never meant to plan this", distinct from skipping).
pub fn delete_block(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM plan_blocks WHERE id = ?1", [id])?;
    Ok(())
}

/// Set a block's status, optionally recording executed minutes.
///
/// Terminal statuses stamp `completed_at`; re-opening a block clears it. Also appends the
/// matching lifecycle event so adherence and velocity have a trail to learn from.
pub fn set_block_status(
    conn: &Connection,
    id: i64,
    status: &str,
    executed_mins: Option<f64>,
) -> AppResult<()> {
    if !STATUSES.contains(&status) {
        return Err(AppError::Invalid(format!("unknown status '{status}'")));
    }
    let block = get_block(conn, id)?;
    let terminal = matches!(status, "done" | "partial" | "skipped" | "spilled");

    conn.execute(
        "UPDATE plan_blocks SET
            status = ?2,
            executed_mins = COALESCE(?3, executed_mins),
            completed_at = CASE WHEN ?4 = 1 THEN datetime('now') ELSE NULL END,
            updated_at = datetime('now')
         WHERE id = ?1",
        rusqlite::params![id, status, executed_mins, i64::from(terminal)],
    )?;

    let kind = match status {
        "active" => "started",
        "done" => "completed",
        "partial" => "partial",
        "skipped" => "skipped",
        "spilled" => "spilled",
        _ => "confirmed",
    };
    let _ = log_event(conn, Some(id), &block.day, kind, None, None);
    Ok(())
}

/// Mark a block active (the student started it). At most one block is active at a time — an
/// earlier active block is demoted to `partial` if it saw work, else back to `pending`, so the
/// "what am I doing now" signal stays unambiguous.
pub fn start_block(conn: &Connection, id: i64) -> AppResult<()> {
    let block = get_block(conn, id)?;
    conn.execute(
        "UPDATE plan_blocks
            SET status = CASE WHEN executed_mins > 0 THEN 'partial' ELSE 'pending' END,
                updated_at = datetime('now')
          WHERE status = 'active' AND id <> ?1",
        [id],
    )?;
    conn.execute(
        "UPDATE plan_blocks SET status = 'active', updated_at = datetime('now') WHERE id = ?1",
        [id],
    )?;
    let _ = log_event(conn, Some(id), &block.day, "started", None, None);
    Ok(())
}

/// Add executed minutes to a block (called from the existing `log_session` write path).
pub fn add_executed_mins(conn: &Connection, id: i64, mins: f64) -> AppResult<()> {
    if mins <= 0.0 {
        return Ok(());
    }
    conn.execute(
        "UPDATE plan_blocks SET executed_mins = executed_mins + ?2,
                                updated_at = datetime('now')
         WHERE id = ?1",
        rusqlite::params![id, mins],
    )?;
    Ok(())
}

/// The currently active block, if any.
pub fn active_block(conn: &Connection) -> AppResult<Option<PlanBlock>> {
    let sql = format!("{BLOCK_SELECT} WHERE b.status = 'active' ORDER BY b.id DESC LIMIT 1");
    Ok(conn.query_row(&sql, [], map_block).optional()?)
}

/// Update the learned pace for a course from one observation.
///
/// EWMA with α = 0.2: responsive enough to adapt within a week, damped enough that one
/// distracted session doesn't rewrite the estimate. `content_mins` is the material time
/// actually consumed; `wall_mins` is the clock time it took.
pub fn record_velocity(
    conn: &Connection,
    node_id: i64,
    wall_mins: f64,
    content_mins: f64,
) -> AppResult<()> {
    if content_mins <= 0.5 || wall_mins <= 0.0 {
        // Too small a sample to mean anything; recording it would only add noise.
        return Ok(());
    }
    let observed = (wall_mins / content_mins).clamp(0.25, 4.0);
    let existing: Option<(i64, f64)> = conn
        .query_row(
            "SELECT samples, pace_ratio FROM node_velocity WHERE node_id = ?1",
            [node_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;

    let (samples, ratio) = match existing {
        Some((n, prev)) => (n + 1, 0.8 * prev + 0.2 * observed),
        // First observation: trust it outright rather than dragging it toward a fictional 1.0.
        None => (1, observed),
    };
    conn.execute(
        "INSERT INTO node_velocity(node_id, samples, pace_ratio, updated_at)
         VALUES(?1, ?2, ?3, datetime('now'))
         ON CONFLICT(node_id) DO UPDATE SET
            samples = excluded.samples,
            pace_ratio = excluded.pace_ratio,
            updated_at = excluded.updated_at",
        rusqlite::params![node_id, samples, ratio.clamp(0.25, 4.0)],
    )?;
    Ok(())
}

// ── Recovery application + undo ──────────────────────────────────────────────

/// One block's pre-adjustment state, kept so a mistaken Apply is fully reversible.
#[derive(Debug, Serialize, Deserialize)]
struct UndoBlock {
    id: i64,
    actual_start: Option<String>,
    actual_mins: Option<i64>,
    status: String,
}

/// The undo payload for one applied recovery.
#[derive(Debug, Serialize, Deserialize)]
struct UndoPayload {
    day: String,
    plan: String,
    blocks: Vec<UndoBlock>,
    /// Blocks created as spill carry-overs, removed on undo.
    created: Vec<i64>,
}

/// Apply a recovery plan in ONE transaction, returning an undo token.
///
/// The plan is re-derived server-side from `plan_id` rather than trusting a client-sent diff:
/// the snapshot may have changed between preview and tap (a block completed, the clock moved),
/// and applying a stale diff would silently corrupt the day.
///
/// Dropped blocks are never deleted. Each is marked `spilled` and re-created on the following
/// day with `spilled_from_id` set, producing a visible debt ledger — and a spill count that
/// promotes the work next time it's triaged.
pub fn apply_recovery(
    conn: &mut Connection,
    day: &str,
    plan_id: &str,
    now_mins: i32,
    next_day: &str,
) -> AppResult<String> {
    let kind = PlanKind::from_id(plan_id)
        .ok_or_else(|| AppError::Invalid(format!("unknown recovery plan '{plan_id}'")))?;

    // Compute BEFORE opening the transaction: the solver is pure, so there's no reason to hold
    // a write lock while it runs.
    let snapshot = build_day_snapshot(conn, day)?;
    let report = solver::build_recovery_plans(&snapshot, now_mins);
    let plan = report
        .plans
        .iter()
        .find(|p| p.kind == kind)
        .ok_or_else(|| AppError::Invalid(format!("plan '{plan_id}' not available for {day}")))?;

    // Capture prior state for undo.
    let mut undo = UndoPayload {
        day: day.to_string(),
        plan: plan_id.to_string(),
        blocks: Vec::new(),
        created: Vec::new(),
    };
    for m in &plan.moves {
        let prev: Option<(Option<String>, Option<i64>, String)> = conn
            .query_row(
                "SELECT actual_start, actual_mins, status FROM plan_blocks WHERE id = ?1",
                [m.block_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        if let Some((s, mi, st)) = prev {
            undo.blocks.push(UndoBlock {
                id: m.block_id,
                actual_start: s,
                actual_mins: mi,
                status: st,
            });
        }
    }

    let tx = conn.transaction()?;
    for m in &plan.moves {
        match m.action {
            MoveAction::Keep => {}
            MoveAction::Shift | MoveAction::Compress => {
                tx.execute(
                    "UPDATE plan_blocks SET actual_start = ?2, actual_mins = ?3,
                                            updated_at = datetime('now')
                     WHERE id = ?1",
                    rusqlite::params![m.block_id, m.to_start, m.to_mins],
                )?;
                let kind_str = if m.action == MoveAction::Compress {
                    "compressed"
                } else {
                    "shifted"
                };
                let delta = i64::from(m.to_mins - m.from_mins);
                tx.execute(
                    "INSERT INTO plan_events(block_id, day, kind, delta_mins, meta)
                     VALUES(?1, ?2, ?3, ?4, ?5)",
                    rusqlite::params![
                        m.block_id,
                        day,
                        kind_str,
                        delta,
                        format!(r#"{{"plan":"{plan_id}"}}"#)
                    ],
                )?;
            }
            MoveAction::Drop => {
                tx.execute(
                    "UPDATE plan_blocks SET status = 'spilled', updated_at = datetime('now')
                     WHERE id = ?1",
                    [m.block_id],
                )?;
                // Carry the work forward instead of destroying it.
                tx.execute(
                    "INSERT INTO plan_blocks(
                        day, planned_start, planned_mins, title, target_kind, target_node_id,
                        target_material_id, target_task_id, target_count, weight, is_anchored,
                        min_viable_mins, notes, spilled_from_id)
                     SELECT ?2, planned_start, planned_mins, title, target_kind, target_node_id,
                            target_material_id, target_task_id, target_count, weight, is_anchored,
                            min_viable_mins, notes, id
                       FROM plan_blocks WHERE id = ?1",
                    rusqlite::params![m.block_id, next_day],
                )?;
                undo.created.push(tx.last_insert_rowid());
                tx.execute(
                    "INSERT INTO plan_events(block_id, day, kind, meta)
                     VALUES(?1, ?2, 'spilled', ?3)",
                    rusqlite::params![
                        m.block_id,
                        day,
                        format!(r#"{{"plan":"{plan_id}","to":"{next_day}"}}"#)
                    ],
                )?;
            }
        }
    }

    let token = format!("{day}:{plan_id}:{now_mins}");
    let payload = serde_json::to_string(&undo)?;
    tx.execute(
        "INSERT INTO settings(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![format!("{UNDO_KEY_PREFIX}{day}"), payload],
    )?;
    tx.execute(
        "INSERT INTO plan_days(day, adjust_state, last_adjust_at)
         VALUES(?1, 'applied', datetime('now'))
         ON CONFLICT(day) DO UPDATE SET adjust_state = 'applied',
                                        last_adjust_at = datetime('now')",
        [day],
    )?;
    tx.commit()?;
    Ok(token)
}

/// Revert the most recent recovery applied to a day.
pub fn undo_recovery(conn: &mut Connection, token: &str) -> AppResult<()> {
    let day = token
        .split(':')
        .next()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::Invalid("malformed undo token".into()))?;
    let key = format!("{UNDO_KEY_PREFIX}{day}");
    let raw: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [&key], |r| {
            r.get(0)
        })
        .optional()?;
    let Some(raw) = raw else {
        return Err(AppError::NotFound(format!("no undo state for {day}")));
    };
    let payload: UndoPayload = serde_json::from_str(&raw)?;

    let tx = conn.transaction()?;
    for b in &payload.blocks {
        tx.execute(
            "UPDATE plan_blocks SET actual_start = ?2, actual_mins = ?3, status = ?4,
                                    updated_at = datetime('now')
             WHERE id = ?1",
            rusqlite::params![b.id, b.actual_start, b.actual_mins, b.status],
        )?;
    }
    for id in &payload.created {
        tx.execute("DELETE FROM plan_blocks WHERE id = ?1", [id])?;
    }
    tx.execute("DELETE FROM settings WHERE key = ?1", [&key])?;
    tx.execute(
        "UPDATE plan_days SET adjust_state = NULL WHERE day = ?1",
        [day],
    )?;
    tx.execute(
        "INSERT INTO plan_events(block_id, day, kind, meta)
         VALUES(NULL, ?1, 'confirmed', '{\"undo\":true}')",
        [day],
    )?;
    tx.commit()?;
    Ok(())
}

/// Record that the student dismissed the recovery prompt for a day.
///
/// Persisting this is what enforces "one prompt per drift event": without it, every navigation
/// back to Today would re-open the card the student just declined.
pub fn dismiss_recovery(conn: &Connection, day: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO plan_days(day, adjust_state, last_adjust_at)
         VALUES(?1, 'dismissed', datetime('now'))
         ON CONFLICT(day) DO UPDATE SET adjust_state = 'dismissed',
                                        last_adjust_at = datetime('now')",
        [day],
    )?;
    Ok(())
}

// ── Durable reminder ledger ──────────────────────────────────────────────────

/// One row of the reminder ledger.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReminderState {
    pub key: String,
    pub fired_at: String,
    pub ack_at: Option<String>,
    pub snooze_to: Option<String>,
}

/// Normalize a caller-supplied wall-clock datetime to `'YYYY-MM-DD HH:MM:SS'`.
///
/// Every timestamp in this ledger is compared **lexicographically** against another timestamp
/// from the same source, so they must all share one format: `'2026-07-31T21:05'` and
/// `'2026-07-31 21:05:00'` describe the same instant but sort differently as strings, and a
/// snooze stored in one shape would be compared wrongly against a claim in the other.
///
/// A trailing `Z` is **rejected** rather than stripped. The planner is local-wall-clock
/// throughout (see the module header); silently reading a UTC instant as local would shift
/// every reminder by the caller's offset — a reminder that fires at the wrong hour is worse
/// than a loud error at the call site.
fn norm_dt(raw: &str) -> AppResult<String> {
    let s = raw.trim();
    let invalid = || {
        AppError::Invalid(format!(
            "invalid datetime '{raw}' (want local 'YYYY-MM-DD HH:MM[:SS]', no timezone suffix)"
        ))
    };
    if s.ends_with('Z') || s.ends_with('z') {
        return Err(AppError::Invalid(format!(
            "datetime '{raw}' is UTC; the planner needs LOCAL wall-clock time"
        )));
    }
    let b = s.as_bytes();
    let date_shaped = b.len() >= 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b[..10]
            .iter()
            .enumerate()
            .all(|(i, c)| matches!(i, 4 | 7) || c.is_ascii_digit());
    if !date_shaped {
        return Err(invalid());
    }
    let date = &s[..10];

    let rest = s[10..].trim_start_matches(['T', 't', ' ']);
    if rest.is_empty() {
        // A date-only value means "start of that day", which is what a bare day implies.
        return Ok(format!("{date} 00:00:00"));
    }
    let mut parts = rest.split(':');
    let mut next = |default: u32| -> AppResult<u32> {
        match parts.next() {
            None => Ok(default),
            Some(p) => p.trim().parse::<u32>().map_err(|_| invalid()),
        }
    };
    let (h, m, sec) = (next(0)?, next(0)?, next(0)?);
    if parts.next().is_some() || h > 23 || m > 59 || sec > 59 {
        return Err(invalid());
    }
    Ok(format!("{date} {h:02}:{m:02}:{sec:02}"))
}

fn clean_key(key: &str) -> AppResult<&str> {
    let k = key.trim();
    if k.is_empty() {
        Err(AppError::Invalid("reminder key is required".into()))
    } else {
        Ok(k)
    }
}

/// Atomically CLAIM a reminder: `true` only for the caller that gets to fire it.
///
/// This exists because the frontend's dedupe (`toastStore`'s in-memory cooldown map) forgets
/// everything on restart, so every reminder re-fired on the next launch. The claim is a single
/// upsert — not read-then-write — so two clocks racing the same key can't both win.
///
/// Re-granted only when an active snooze has expired. An acknowledged reminder is never
/// re-granted: the student already acted on it.
pub fn claim_reminder(conn: &Connection, key: &str, now: &str) -> AppResult<bool> {
    let key = clean_key(key)?;
    let now = norm_dt(now)?;
    let n = conn.execute(
        "INSERT INTO reminder_state(key, fired_at) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET fired_at = excluded.fired_at,
                                        snooze_to = NULL
          WHERE reminder_state.ack_at IS NULL
            AND reminder_state.snooze_to IS NOT NULL
            AND reminder_state.snooze_to <= excluded.fired_at",
        rusqlite::params![key, now],
    )?;
    Ok(n == 1)
}

/// Ledger rows whose key starts with `prefix` (e.g. `block-42-`), newest first.
///
/// Matched with `substr` rather than `LIKE`: a key fragment containing `%` or `_` would
/// otherwise act as a wildcard and quietly return unrelated reminders. The table is bounded by
/// [`prune_reminders`], so the scan is cheap.
pub fn list_reminders(conn: &Connection, prefix: &str) -> AppResult<Vec<ReminderState>> {
    let mut stmt = conn.prepare(
        "SELECT key, fired_at, ack_at, snooze_to FROM reminder_state
          WHERE substr(key, 1, length(?1)) = ?1
          ORDER BY fired_at DESC, key",
    )?;
    let rows = stmt.query_map([prefix], |r| {
        Ok(ReminderState {
            key: r.get(0)?,
            fired_at: r.get(1)?,
            ack_at: r.get(2)?,
            snooze_to: r.get(3)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Mark a reminder acknowledged (the student acted on it) and clear any snooze.
///
/// Upserts so an ack can't fail on a row that was pruned between firing and acking — losing the
/// ack would let the reminder fire again, which is the exact bug this ledger exists to prevent.
/// `ack_at` is bookkeeping (an absolute observation, never compared against wall-clock plan
/// times), so SQLite's own timestamp is the right source here.
pub fn ack_reminder(conn: &Connection, key: &str) -> AppResult<()> {
    let key = clean_key(key)?;
    conn.execute(
        "INSERT INTO reminder_state(key, fired_at, ack_at)
         VALUES(?1, datetime('now'), datetime('now'))
         ON CONFLICT(key) DO UPDATE SET ack_at = datetime('now'), snooze_to = NULL",
        [key],
    )?;
    Ok(())
}

/// Snooze a reminder until `snooze_to` (local wall clock); it may be claimed again after that.
pub fn snooze_reminder(conn: &Connection, key: &str, snooze_to: &str) -> AppResult<()> {
    let key = clean_key(key)?;
    let until = norm_dt(snooze_to)?;
    conn.execute(
        "INSERT INTO reminder_state(key, fired_at, snooze_to)
         VALUES(?1, datetime('now'), ?2)
         ON CONFLICT(key) DO UPDATE SET snooze_to = excluded.snooze_to, ack_at = NULL",
        rusqlite::params![key, until],
    )?;
    Ok(())
}

/// Drop ledger rows older than `keep_days`, returning how many were removed.
///
/// Rows with a snooze still in the future are kept regardless of age: deleting one would let
/// the reminder be re-claimed immediately, resurfacing something the student deliberately
/// pushed away. `keep_days` is clamped to 1..=3650 so a stray 0 can't wipe today's ledger.
pub fn prune_reminders(conn: &Connection, keep_days: i64) -> AppResult<i64> {
    let keep = keep_days.clamp(1, 3650);
    let n = conn.execute(
        "DELETE FROM reminder_state
          WHERE fired_at < datetime('now', ?1)
            AND (snooze_to IS NULL OR snooze_to <= datetime('now'))",
        [format!("-{keep} days")],
    )?;
    Ok(n as i64)
}

// ── Templates ────────────────────────────────────────────────────────────────

/// Generate a day's blocks from a routine template. Skips blocks that already exist for that
/// day at the same time+title, so applying twice doesn't duplicate the routine.
pub fn apply_template(conn: &Connection, template_id: i64, day: &str) -> AppResult<i64> {
    conn.execute(
        "INSERT INTO plan_days(day, template_id) VALUES(?1, ?2)
         ON CONFLICT(day) DO UPDATE SET template_id = excluded.template_id",
        rusqlite::params![day, template_id],
    )?;
    let n = conn.execute(
        "INSERT INTO plan_blocks(
            day, planned_start, planned_mins, title, target_kind, target_node_id,
            target_count, weight, is_anchored, template_id)
         SELECT ?2, t.planned_start, t.planned_mins, t.title, t.target_kind, t.target_node_id,
                t.target_count, t.weight, t.is_anchored, t.template_id
           FROM plan_template_blocks t
          WHERE t.template_id = ?1
            AND NOT EXISTS (
                SELECT 1 FROM plan_blocks b
                 WHERE b.day = ?2 AND b.planned_start = t.planned_start AND b.title = t.title
            )
          ORDER BY t.sort_order, t.id",
        rusqlite::params![template_id, day],
    )?;
    Ok(n as i64)
}

// ── Boot reconciliation ──────────────────────────────────────────────────────

/// Close out every day before `today`: any block still `pending`/`active` on a past day is
/// marked `skipped`, and the day is stamped `reconciled_at`.
///
/// Deliberately a ONE-SHOT boot pass, not a background loop — the same shape as the existing
/// `backfill_consistency`. Idle CPU cost is zero, which is the whole point on the 4 GB target.
/// Cost is O(days since last open), capped to a 365-day window so a long-dormant install can't
/// grind through years of history on launch.
///
/// `today` is the caller's LOCAL date; see the module note on why we don't ask SQLite.
pub fn reconcile_plan_days(conn: &Connection, today: &str) -> AppResult<i64> {
    // Nothing planned, ever → cheapest possible exit.
    let earliest: Option<String> = conn
        .query_row(
            "SELECT MIN(day) FROM plan_blocks WHERE day < ?1",
            [today],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    let Some(_earliest) = earliest else {
        return Ok(0);
    };

    // Mark abandoned work on past days. One UPDATE for the whole backlog.
    let skipped = conn.execute(
        "UPDATE plan_blocks
            SET status = CASE WHEN executed_mins > 0 THEN 'partial' ELSE 'skipped' END,
                updated_at = datetime('now')
          WHERE day < ?1
            AND day >= date(?1, '-365 days')
            AND status IN ('pending','active')",
        [today],
    )?;

    // Stamp the days we just closed so a later boot doesn't redo the work.
    conn.execute(
        "INSERT INTO plan_days(day, reconciled_at)
         SELECT DISTINCT day, datetime('now') FROM plan_blocks
          WHERE day < ?1 AND day >= date(?1, '-365 days')
         ON CONFLICT(day) DO UPDATE SET reconciled_at = datetime('now')",
        [today],
    )?;

    Ok(skipped as i64)
}

/// Per-day schedule facts, feeding the adherence half of the consistency score.
#[derive(Debug, Default, Clone, Serialize)]
pub struct PlanDayFacts {
    pub blocks_planned: i64,
    pub blocks_completed: i64,
    pub blocks_partial: i64,
    pub blocks_skipped: i64,
    pub planned_minutes: f64,
    pub executed_minutes: f64,
    /// Blocks that started within 15 minutes of plan (punctuality numerator).
    pub on_time_starts: i64,
}

/// Gather a day's schedule facts.
pub fn plan_day_facts(conn: &Connection, day: &str) -> AppResult<PlanDayFacts> {
    let f = conn
        .query_row(
            "SELECT
                COUNT(*),
                COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN status IN ('skipped','spilled') THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(COALESCE(actual_mins, planned_mins)), 0),
                COALESCE(SUM(executed_mins), 0)
             FROM plan_blocks WHERE day = ?1",
            [day],
            |r| {
                Ok(PlanDayFacts {
                    blocks_planned: r.get(0)?,
                    blocks_completed: r.get(1)?,
                    blocks_partial: r.get(2)?,
                    blocks_skipped: r.get(3)?,
                    planned_minutes: r.get::<_, f64>(4)?,
                    executed_minutes: r.get::<_, f64>(5)?,
                    on_time_starts: 0,
                })
            },
        )
        .optional()?
        .unwrap_or_default();

    // Punctuality: the first 'started' event within 15 minutes of the planned start. Read from
    // the append-only ledger rather than a mutable column, so later edits can't rewrite history.
    let on_time: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM plan_blocks b
              WHERE b.day = ?1
                AND EXISTS (
                    SELECT 1 FROM plan_events e
                     WHERE e.block_id = b.id AND e.kind = 'started'
                       AND ABS(
                            (CAST(strftime('%H', e.at) AS INTEGER) * 60
                             + CAST(strftime('%M', e.at) AS INTEGER))
                            - (CAST(substr(COALESCE(b.actual_start, b.planned_start), 1, 2) AS INTEGER) * 60
                               + CAST(substr(COALESCE(b.actual_start, b.planned_start), 4, 2) AS INTEGER))
                          ) <= 15
                )",
            [day],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(0);

    Ok(PlanDayFacts {
        on_time_starts: on_time,
        ..f
    })
}

/// Schedule adherence for a day, 0-100. `None` when nothing was planned — a day with no plan
/// is neutral, not a failure, which preserves the existing "don't punish unplanned days" rule.
///
/// Weighting: 50% block completion (partial counts half), 30% time-on-task, 20% punctuality.
pub fn adherence_for_day(f: &PlanDayFacts) -> Option<f64> {
    if f.blocks_planned <= 0 {
        return None;
    }
    let planned = f.blocks_planned as f64;
    let completion =
        (f.blocks_completed as f64 + 0.5 * f.blocks_partial as f64) / planned;
    let time_ratio = if f.planned_minutes > 0.0 {
        (f.executed_minutes / f.planned_minutes).min(1.0)
    } else {
        0.0
    };
    let punctuality = f.on_time_starts as f64 / planned;
    Some(((0.5 * completion + 0.3 * time_ratio + 0.2 * punctuality) * 100.0).clamp(0.0, 100.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::connection::test_conn;

    const DAY: &str = "2026-07-31";
    const NEXT: &str = "2026-08-01";

    fn dto(day: &str, start: &str, mins: i64, title: &str, weight: i64) -> BlockInputDto {
        BlockInputDto {
            id: None,
            day: day.to_string(),
            planned_start: start.to_string(),
            planned_mins: mins,
            title: title.to_string(),
            target_kind: "freeform".to_string(),
            target_node_id: None,
            target_material_id: None,
            target_task_id: None,
            target_count: None,
            weight,
            is_anchored: false,
            min_viable_mins: None,
            notes: None,
        }
    }

    /// Round-trip: a created block reads back with its effective position defaulting to the
    /// planned one, and the day row is auto-created so the window has somewhere to live.
    #[test]
    fn upsert_and_read_block_round_trip() {
        let conn = test_conn();
        let id = upsert_block(&conn, &dto(DAY, "06:00", 60, "Physics", 3)).unwrap();

        let b = get_block(&conn, id).unwrap();
        assert_eq!(b.title, "Physics");
        assert_eq!(b.planned_start, "06:00");
        assert_eq!(b.effective_start, "06:00", "no adjustment yet → planned wins");
        assert_eq!(b.effective_mins, 60);
        assert_eq!(b.status, "pending");
        assert!(b.needs_manual_confirm, "freeform has no digital footprint");

        let day_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM plan_days WHERE day = ?1", [DAY], |r| r.get(0))
            .unwrap();
        assert_eq!(day_rows, 1, "the day row is created alongside the block");
    }

    /// Bad input is rejected rather than silently stored — a block at "midnight" the student
    /// never asked for is worse than an error.
    #[test]
    fn rejects_invalid_block_input() {
        let conn = test_conn();

        let mut bad_time = dto(DAY, "25:00", 60, "X", 2);
        assert!(upsert_block(&conn, &bad_time).is_err(), "hour out of range");
        bad_time.planned_start = "abc".into();
        assert!(upsert_block(&conn, &bad_time).is_err(), "unparseable time");

        let mut bad_kind = dto(DAY, "06:00", 60, "X", 2);
        bad_kind.target_kind = "nonsense".into();
        assert!(upsert_block(&conn, &bad_kind).is_err(), "unknown target_kind");

        let mut bad_mins = dto(DAY, "06:00", 0, "X", 2);
        assert!(upsert_block(&conn, &bad_mins).is_err(), "zero-length block");
        bad_mins.planned_mins = 5000;
        assert!(upsert_block(&conn, &bad_mins).is_err(), "longer than a day");

        let blank = dto(DAY, "06:00", 60, "   ", 2);
        assert!(upsert_block(&conn, &blank).is_err(), "blank title");
    }

    /// Window precedence: per-day override → global setting → built-in default.
    #[test]
    fn day_window_precedence() {
        let conn = test_conn();

        // Nothing set → defaults.
        let (wake, stop) = resolve_day_window(&conn, DAY).unwrap();
        assert_eq!((wake, stop), (360, 1320), "06:00 / 22:00 defaults");

        // Global setting applies.
        crate::db::queries::set_setting(&conn, SETTING_HARD_STOP, "23:00").unwrap();
        let (_, stop) = resolve_day_window(&conn, DAY).unwrap();
        assert_eq!(stop, 1380, "global setting overrides the default");

        // Per-day override wins over the global (study late on a Saturday).
        set_day_window(&conn, DAY, Some("05:30"), Some("23:30")).unwrap();
        let (wake, stop) = resolve_day_window(&conn, DAY).unwrap();
        assert_eq!((wake, stop), (330, 1410), "per-day override wins");

        // Clearing the override falls back to the global setting again.
        set_day_window(&conn, DAY, None, None).unwrap();
        let (_, stop) = resolve_day_window(&conn, DAY).unwrap();
        assert_eq!(stop, 1380, "cleared override → global");
    }

    /// A hard stop at/before wake would make every plan look impossible; treat it as
    /// misconfiguration rather than propagating a zero-length day.
    #[test]
    fn inverted_window_falls_back_instead_of_zero_length_day() {
        let conn = test_conn();
        set_day_window(&conn, DAY, Some("08:00"), Some("07:00")).unwrap();
        let (wake, stop) = resolve_day_window(&conn, DAY).unwrap();
        assert!(stop > wake, "must not yield a non-positive window");
    }

    #[test]
    fn set_day_window_validates_times() {
        let conn = test_conn();
        assert!(set_day_window(&conn, DAY, Some("nope"), None).is_err());
        assert!(set_day_window(&conn, DAY, None, Some("24:61")).is_err());
    }

    /// Only ONE block is active at a time: starting a second demotes the first, and a first
    /// that saw real work is preserved as `partial` rather than reset to `pending`.
    #[test]
    fn starting_a_block_demotes_the_previous_active_one() {
        let conn = test_conn();
        let a = upsert_block(&conn, &dto(DAY, "06:00", 60, "A", 2)).unwrap();
        let b = upsert_block(&conn, &dto(DAY, "07:00", 60, "B", 2)).unwrap();

        start_block(&conn, a).unwrap();
        add_executed_mins(&conn, a, 25.0).unwrap();
        start_block(&conn, b).unwrap();

        assert_eq!(get_block(&conn, a).unwrap().status, "partial", "work is not lost");
        assert_eq!(get_block(&conn, b).unwrap().status, "active");
        assert_eq!(active_block(&conn).unwrap().unwrap().id, b);

        // A block with no logged work reverts cleanly to pending.
        let c = upsert_block(&conn, &dto(DAY, "08:00", 60, "C", 2)).unwrap();
        start_block(&conn, c).unwrap();
        assert_eq!(get_block(&conn, b).unwrap().status, "pending");
    }

    /// Terminal statuses stamp `completed_at`; re-opening clears it. Each transition appends
    /// to the append-only ledger.
    #[test]
    fn status_transitions_stamp_and_log() {
        let conn = test_conn();
        let id = upsert_block(&conn, &dto(DAY, "06:00", 60, "A", 2)).unwrap();

        set_block_status(&conn, id, "done", Some(58.0)).unwrap();
        let b = get_block(&conn, id).unwrap();
        assert_eq!(b.status, "done");
        assert!(b.completed_at.is_some());
        assert_eq!(b.executed_mins, 58.0);

        set_block_status(&conn, id, "pending", None).unwrap();
        let b = get_block(&conn, id).unwrap();
        assert!(b.completed_at.is_none(), "re-opening clears the stamp");
        assert_eq!(b.executed_mins, 58.0, "executed minutes are NOT wiped");

        let events: i64 = conn
            .query_row("SELECT COUNT(*) FROM plan_events WHERE block_id = ?1", [id], |r| r.get(0))
            .unwrap();
        assert!(events >= 2, "every transition is logged");

        assert!(set_block_status(&conn, id, "bogus", None).is_err());
    }

    /// Applying a recovery plan must SPILL dropped work forward, never delete it, and must be
    /// fully reversible.
    #[test]
    fn apply_recovery_spills_dropped_work_and_undo_restores_it() {
        let mut conn = test_conn();
        set_day_window(&conn, DAY, Some("06:00"), Some("09:00")).unwrap();
        let a = upsert_block(&conn, &dto(DAY, "06:00", 120, "Physics", 3)).unwrap();
        let b = upsert_block(&conn, &dto(DAY, "08:00", 120, "Chemistry", 1)).unwrap();

        // 06:00, ~153 usable minutes vs 240 demanded → something must give.
        let report = recovery_report(&conn, DAY, 360).unwrap();
        assert!(!report.fits);
        assert_eq!(report.plans.len(), 3);

        let token = apply_recovery(&mut conn, DAY, "triage", 360, NEXT).unwrap();

        // Nothing was destroyed: every original block still exists.
        for id in [a, b] {
            assert!(get_block(&conn, id).is_ok(), "block {id} must survive");
        }
        // Any dropped block spilled to the next day with provenance recorded.
        let spilled = list_day_blocks(&conn, NEXT).unwrap();
        let dropped_now: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM plan_blocks WHERE day = ?1 AND status = 'spilled'",
                [DAY],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            spilled.len() as i64, dropped_now,
            "each spilled block gets exactly one carry-over"
        );
        assert!(spilled.iter().all(|s| s.spilled_from_id.is_some()));

        let state: Option<String> = conn
            .query_row("SELECT adjust_state FROM plan_days WHERE day = ?1", [DAY], |r| r.get(0))
            .unwrap();
        assert_eq!(state.as_deref(), Some("applied"));

        // Undo removes the carry-overs and restores the original positions/statuses.
        undo_recovery(&mut conn, &token).unwrap();
        assert!(list_day_blocks(&conn, NEXT).unwrap().is_empty(), "carry-overs removed");
        for blk in list_day_blocks(&conn, DAY).unwrap() {
            assert_ne!(blk.status, "spilled", "statuses restored");
            assert!(blk.actual_start.is_none(), "adjusted position reverted");
        }
        let state: Option<String> = conn
            .query_row("SELECT adjust_state FROM plan_days WHERE day = ?1", [DAY], |r| r.get(0))
            .unwrap();
        assert_eq!(state, None, "the day is adjustable again");
    }

    /// An unknown plan id is rejected rather than applied as a no-op the user believes worked.
    #[test]
    fn apply_recovery_rejects_unknown_plan() {
        let mut conn = test_conn();
        upsert_block(&conn, &dto(DAY, "06:00", 60, "A", 2)).unwrap();
        assert!(apply_recovery(&mut conn, DAY, "wishful", 360, NEXT).is_err());
    }

    #[test]
    fn undo_without_prior_apply_errors() {
        let mut conn = test_conn();
        assert!(undo_recovery(&mut conn, &format!("{DAY}:triage:360")).is_err());
    }

    /// Dismissal must PERSIST — that is what enforces "one prompt per drift event" across
    /// navigation.
    #[test]
    fn dismissal_persists() {
        let conn = test_conn();
        dismiss_recovery(&conn, DAY).unwrap();
        let state: String = conn
            .query_row("SELECT adjust_state FROM plan_days WHERE day = ?1", [DAY], |r| r.get(0))
            .unwrap();
        assert_eq!(state, "dismissed");
    }

    /// Boot reconciliation closes out abandoned PAST days and leaves today alone.
    #[test]
    fn reconcile_closes_past_days_only() {
        let conn = test_conn();
        let past = "2026-07-29";
        let untouched = upsert_block(&conn, &dto(past, "06:00", 60, "Missed", 2)).unwrap();
        let worked = upsert_block(&conn, &dto(past, "08:00", 60, "Half done", 2)).unwrap();
        add_executed_mins(&conn, worked, 30.0).unwrap();
        let today_block = upsert_block(&conn, &dto(DAY, "06:00", 60, "Today", 2)).unwrap();

        let n = reconcile_plan_days(&conn, DAY).unwrap();
        assert_eq!(n, 2, "both past blocks resolved");

        assert_eq!(get_block(&conn, untouched).unwrap().status, "skipped");
        assert_eq!(
            get_block(&conn, worked).unwrap().status, "partial",
            "a block with real work logged is partial, not skipped"
        );
        assert_eq!(
            get_block(&conn, today_block).unwrap().status, "pending",
            "today is still in play and must NOT be closed out"
        );

        // Idempotent: a second boot finds nothing left to do.
        assert_eq!(reconcile_plan_days(&conn, DAY).unwrap(), 0);
    }

    /// With nothing ever planned, reconciliation takes the cheapest possible exit.
    #[test]
    fn reconcile_is_a_noop_on_an_empty_planner() {
        let conn = test_conn();
        assert_eq!(reconcile_plan_days(&conn, DAY).unwrap(), 0);
    }

    /// Adherence is `None` for an unplanned day (neutral, not a failure) and rises with
    /// completion.
    #[test]
    fn adherence_scoring() {
        let conn = test_conn();
        assert!(
            adherence_for_day(&plan_day_facts(&conn, DAY).unwrap()).is_none(),
            "no plan → neutral day, never a zero"
        );

        let a = upsert_block(&conn, &dto(DAY, "06:00", 60, "A", 2)).unwrap();
        let b = upsert_block(&conn, &dto(DAY, "07:00", 60, "B", 2)).unwrap();
        let low = adherence_for_day(&plan_day_facts(&conn, DAY).unwrap()).unwrap();

        set_block_status(&conn, a, "done", Some(60.0)).unwrap();
        set_block_status(&conn, b, "done", Some(60.0)).unwrap();
        let high = adherence_for_day(&plan_day_facts(&conn, DAY).unwrap()).unwrap();

        assert!(high > low, "completing work must raise adherence");
        assert!(high <= 100.0 && low >= 0.0);

        let facts = plan_day_facts(&conn, DAY).unwrap();
        assert_eq!(facts.blocks_planned, 2);
        assert_eq!(facts.blocks_completed, 2);
        assert_eq!(facts.executed_minutes, 120.0);
    }

    /// Partial completion counts for half — real progress deserves partial credit.
    #[test]
    fn partial_blocks_earn_half_credit() {
        let conn = test_conn();
        let a = upsert_block(&conn, &dto(DAY, "06:00", 60, "A", 2)).unwrap();
        set_block_status(&conn, a, "skipped", None).unwrap();
        let skipped = adherence_for_day(&plan_day_facts(&conn, DAY).unwrap()).unwrap();

        set_block_status(&conn, a, "partial", Some(30.0)).unwrap();
        let partial = adherence_for_day(&plan_day_facts(&conn, DAY).unwrap()).unwrap();
        assert!(partial > skipped, "partial beats skipped");
    }

    /// Velocity learning: the first observation is trusted outright, later ones are damped.
    #[test]
    fn velocity_ewma_learns_pace() {
        let conn = test_conn();
        let node = crate::db::queries::upsert_root_node(&conn, "Physics").unwrap();

        // First sample: 90 minutes of clock for 60 of content → 1.5.
        record_velocity(&conn, node, 90.0, 60.0).unwrap();
        let p1 = pace_for_node(&conn, Some(node));
        assert!((p1 - 1.5).abs() < 1e-6, "first sample trusted, got {p1}");

        // A single fast session must not erase the learned pace.
        record_velocity(&conn, node, 60.0, 60.0).unwrap();
        let p2 = pace_for_node(&conn, Some(node));
        assert!(p2 < p1 && p2 > 1.0, "damped toward the new sample, got {p2}");

        let samples: i64 = conn
            .query_row("SELECT samples FROM node_velocity WHERE node_id = ?1", [node], |r| r.get(0))
            .unwrap();
        assert_eq!(samples, 2);
    }

    /// Degenerate samples are ignored rather than poisoning the estimate.
    #[test]
    fn velocity_ignores_meaningless_samples() {
        let conn = test_conn();
        let node = crate::db::queries::upsert_root_node(&conn, "Physics").unwrap();
        record_velocity(&conn, node, 10.0, 0.0).unwrap();
        record_velocity(&conn, node, 0.0, 10.0).unwrap();
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM node_velocity", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0, "no sample recorded");
        assert_eq!(pace_for_node(&conn, Some(node)), 1.0, "defaults to real-time");
    }

    /// The learned pace must actually reach the solver, otherwise velocity learning is
    /// decorative. This guards the snapshot wiring end-to-end.
    #[test]
    fn snapshot_carries_learned_pace_into_the_solver() {
        let conn = test_conn();
        let node = crate::db::queries::upsert_root_node(&conn, "Physics").unwrap();
        let mut d = dto(DAY, "06:00", 60, "Lecture", 2);
        d.target_kind = "node_minutes".into();
        d.target_node_id = Some(node);
        upsert_block(&conn, &d).unwrap();

        let before = build_day_snapshot(&conn, DAY).unwrap();
        assert_eq!(before.blocks[0].effective_mins(), 60);

        record_velocity(&conn, node, 90.0, 60.0).unwrap();
        let after = build_day_snapshot(&conn, DAY).unwrap();
        assert_eq!(
            after.blocks[0].effective_mins(), 90,
            "a slower observed pace must inflate the honest duration"
        );
    }

    /// Templates generate a day in one tap and are idempotent — applying twice must not
    /// duplicate the routine.
    #[test]
    fn template_application_is_idempotent() {
        let conn = test_conn();
        conn.execute("INSERT INTO plan_templates(name) VALUES('Weekday')", [])
            .unwrap();
        let tid = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO plan_template_blocks(template_id, planned_start, planned_mins, title, weight)
             VALUES(?1, '06:00', 60, 'Physics', 3), (?1, '07:00', 60, 'Math', 2)",
            [tid],
        )
        .unwrap();

        assert_eq!(apply_template(&conn, tid, DAY).unwrap(), 2);
        assert_eq!(list_day_blocks(&conn, DAY).unwrap().len(), 2);

        assert_eq!(apply_template(&conn, tid, DAY).unwrap(), 0, "no duplicates");
        assert_eq!(list_day_blocks(&conn, DAY).unwrap().len(), 2);
    }

    /// The Today payload exposes the window, totals, and the advisory pre-mortem together.
    #[test]
    fn day_plan_payload_includes_integrity_verdict() {
        let conn = test_conn();
        set_day_window(&conn, DAY, Some("06:00"), Some("09:00")).unwrap();
        upsert_block(&conn, &dto(DAY, "06:00", 240, "Overcommitted", 2)).unwrap();

        let plan = day_plan(&conn, DAY).unwrap();
        assert_eq!(plan.day, DAY);
        assert_eq!(plan.wake_at, "06:00");
        assert_eq!(plan.hard_stop_at, "09:00");
        assert_eq!(plan.planned_mins, 240);
        assert_eq!(plan.blocks.len(), 1);
        assert!(
            plan.integrity.overcommit_mins > 0,
            "4h of work in a 3h window must be flagged"
        );
        assert!(plan.integrity.message.is_some());
    }

    /// Blocks are ordered by their EFFECTIVE start, so an adjusted day still reads
    /// chronologically.
    #[test]
    fn blocks_are_ordered_by_effective_start() {
        let conn = test_conn();
        let a = upsert_block(&conn, &dto(DAY, "06:00", 60, "A", 2)).unwrap();
        upsert_block(&conn, &dto(DAY, "07:00", 60, "B", 2)).unwrap();
        // Push A past B.
        conn.execute(
            "UPDATE plan_blocks SET actual_start = '09:00' WHERE id = ?1",
            [a],
        )
        .unwrap();

        let blocks = list_day_blocks(&conn, DAY).unwrap();
        assert_eq!(blocks[0].title, "B", "B is now first");
        assert_eq!(blocks[1].title, "A");
        assert_eq!(blocks[1].effective_start, "09:00");
        assert_eq!(blocks[1].planned_start, "06:00", "the original intent is retained");
    }

    /// Auto-tracked targets must not demand manual confirmation; only freeform does.
    #[test]
    fn only_freeform_blocks_need_manual_confirmation() {
        assert!(needs_manual_confirm("freeform"));
        for kind in ["material", "node_count", "node_minutes", "task"] {
            assert!(!needs_manual_confirm(kind), "{kind} is auto-tracked");
        }
    }

    /// The spill chain depth is what promotes chronically-deferred work in triage, so the
    /// recursive count must be right.
    #[test]
    fn spill_count_tracks_the_carry_over_chain() {
        let conn = test_conn();
        let first = upsert_block(&conn, &dto("2026-07-29", "06:00", 60, "Dodged", 2)).unwrap();
        conn.execute(
            "INSERT INTO plan_blocks(day, planned_start, planned_mins, title, spilled_from_id)
             VALUES('2026-07-30', '06:00', 60, 'Dodged', ?1)",
            [first],
        )
        .unwrap();
        let second = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO plan_blocks(day, planned_start, planned_mins, title, spilled_from_id)
             VALUES(?2, '06:00', 60, 'Dodged', ?1)",
            rusqlite::params![second, DAY],
        )
        .unwrap();
        let third = conn.last_insert_rowid();

        assert_eq!(get_block(&conn, first).unwrap().spill_count, 0);
        assert_eq!(get_block(&conn, second).unwrap().spill_count, 1);
        assert_eq!(
            get_block(&conn, third).unwrap().spill_count, 2,
            "twice-deferred work reports depth 2"
        );
    }

    /// Deleting a target course must not delete the block (ON DELETE SET NULL): the student's
    /// intention survives, it just loses its link.
    #[test]
    fn deleting_a_target_node_keeps_the_block() {
        let conn = test_conn();
        let node = crate::db::queries::upsert_root_node(&conn, "Physics").unwrap();
        let mut d = dto(DAY, "06:00", 60, "Lecture", 2);
        d.target_kind = "node_count".into();
        d.target_node_id = Some(node);
        d.target_count = Some(2);
        let id = upsert_block(&conn, &d).unwrap();
        assert_eq!(get_block(&conn, id).unwrap().target_name.as_deref(), Some("Physics"));

        conn.execute("DELETE FROM nodes WHERE id = ?1", [node]).unwrap();

        let b = get_block(&conn, id).unwrap();
        assert_eq!(b.target_node_id, None, "link cleared");
        assert_eq!(b.title, "Lecture", "the block itself survives");
    }

    #[test]
    fn missing_block_is_a_not_found_error() {
        let conn = test_conn();
        assert!(get_block(&conn, 424242).is_err());
        assert!(set_block_status(&conn, 424242, "done", None).is_err());
    }

    // ── Reminder ledger ──────────────────────────────────────────────────────

    /// The whole point of the ledger: a reminder is granted exactly ONCE, and the second
    /// attempt is refused even though the in-memory dedupe of a restarted app would have
    /// forgotten it.
    #[test]
    fn a_reminder_is_claimable_exactly_once() {
        let conn = test_conn();
        let key = "block-42-start";

        assert!(claim_reminder(&conn, key, "2026-07-31 06:00").unwrap(), "first claim fires");
        assert!(
            !claim_reminder(&conn, key, "2026-07-31 06:01").unwrap(),
            "a restart must NOT re-fire it"
        );
        // Much later, still refused: absence of a snooze means the reminder is spent.
        assert!(!claim_reminder(&conn, key, "2026-08-05 09:00").unwrap());

        let rows = list_reminders(&conn, "block-42-").unwrap();
        assert_eq!(rows.len(), 1, "one ledger row, not one per attempt");
        assert_eq!(rows[0].fired_at, "2026-07-31 06:00:00", "fired_at is the FIRST fire");
        assert!(rows[0].ack_at.is_none() && rows[0].snooze_to.is_none());
    }

    /// Snooze is the one path back: refused while pending, re-granted once elapsed. Acking
    /// afterwards closes it for good.
    #[test]
    fn snooze_regrants_a_claim_only_after_it_elapses() {
        let conn = test_conn();
        let key = "block-7-t10";
        assert!(claim_reminder(&conn, key, "2026-07-31 08:00").unwrap());

        snooze_reminder(&conn, key, "2026-07-31 08:30").unwrap();
        assert!(
            !claim_reminder(&conn, key, "2026-07-31 08:29").unwrap(),
            "still snoozed — must stay quiet"
        );
        assert!(
            claim_reminder(&conn, key, "2026-07-31 08:30").unwrap(),
            "the snooze has elapsed → fire again"
        );
        // Claiming clears the snooze, so it does not re-grant a third time.
        assert!(!claim_reminder(&conn, key, "2026-07-31 09:00").unwrap());
        let row = &list_reminders(&conn, key).unwrap()[0];
        assert!(row.snooze_to.is_none(), "the consumed snooze is cleared");

        // An acknowledged reminder is never re-granted, even with a stale snooze on the row.
        ack_reminder(&conn, key).unwrap();
        snooze_reminder(&conn, key, "2026-07-31 09:05").unwrap();
        assert!(
            claim_reminder(&conn, key, "2026-07-31 09:10").unwrap(),
            "snoozing explicitly re-opens a reminder the student pushed away"
        );
    }

    /// Ack survives a pruned row: losing it would let a handled reminder fire again, which is
    /// exactly the bug this table exists to prevent.
    #[test]
    fn ack_marks_the_row_and_blocks_further_claims() {
        let conn = test_conn();
        let key = "block-9-end";

        // Ack with no prior row at all (it was pruned between firing and acking).
        ack_reminder(&conn, key).unwrap();
        let rows = list_reminders(&conn, key).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].ack_at.is_some());

        assert!(
            !claim_reminder(&conn, key, "2026-07-31 10:00").unwrap(),
            "the student already acted on it"
        );
    }

    /// Prefix listing must be a literal prefix match. A key fragment containing SQL wildcards
    /// would otherwise pull in unrelated reminders.
    #[test]
    fn listing_matches_a_literal_prefix_not_a_like_pattern() {
        let conn = test_conn();
        for key in ["block-4-start", "block-4-end", "block-42-start", "exam-1-start"] {
            claim_reminder(&conn, key, "2026-07-31 06:00").unwrap();
        }

        let mut keys: Vec<String> = list_reminders(&conn, "block-4-")
            .unwrap()
            .into_iter()
            .map(|r| r.key)
            .collect();
        keys.sort();
        assert_eq!(keys, ["block-4-end", "block-4-start"], "block-42 is NOT a block-4- reminder");

        // `_` and `%` are literal characters here, not wildcards.
        assert!(list_reminders(&conn, "block-4_").unwrap().is_empty());
        assert!(list_reminders(&conn, "%").unwrap().is_empty());
        assert_eq!(list_reminders(&conn, "").unwrap().len(), 4, "empty prefix = everything");
    }

    /// Pruning bounds the table but must never resurface a pending snooze.
    #[test]
    fn pruning_drops_old_rows_but_keeps_pending_snoozes() {
        let conn = test_conn();
        claim_reminder(&conn, "old-1", "2026-01-01 06:00").unwrap();
        claim_reminder(&conn, "old-2", "2026-01-01 07:00").unwrap();
        conn.execute(
            "UPDATE reminder_state SET fired_at = datetime('now', '-90 days')",
            [],
        )
        .unwrap();
        // An ancient row the student deliberately pushed into the future.
        conn.execute(
            "INSERT INTO reminder_state(key, fired_at, snooze_to)
             VALUES('old-3', datetime('now', '-90 days'), datetime('now', '+2 days'))",
            [],
        )
        .unwrap();
        claim_reminder(&conn, "fresh", "2026-07-31 06:00").unwrap();

        let removed = prune_reminders(&conn, 30).unwrap();
        assert_eq!(removed, 2, "only the two spent old rows go");

        let mut keys: Vec<String> = list_reminders(&conn, "")
            .unwrap()
            .into_iter()
            .map(|r| r.key)
            .collect();
        keys.sort();
        assert_eq!(keys, ["fresh", "old-3"], "a pending snooze survives pruning");

        // A stray 0 (or negative) retention must not wipe the ledger.
        assert_eq!(prune_reminders(&conn, 0).unwrap(), 0);
        assert_eq!(list_reminders(&conn, "").unwrap().len(), 2);
    }

    /// Timestamps are compared lexicographically, so mixed formats would compare wrongly.
    /// Everything is normalized on the way in, and UTC is refused outright — the planner is
    /// local wall-clock, and reading a `Z` instant as local would shift every reminder.
    #[test]
    fn datetimes_are_normalized_and_utc_is_refused() {
        assert_eq!(norm_dt("2026-07-31T21:05").unwrap(), "2026-07-31 21:05:00");
        assert_eq!(norm_dt(" 2026-07-31 21:05:09 ").unwrap(), "2026-07-31 21:05:09");
        assert_eq!(norm_dt("2026-07-31").unwrap(), "2026-07-31 00:00:00", "date → start of day");
        assert!(norm_dt("2026-07-31T21:05:00Z").is_err(), "UTC must be rejected, not stripped");
        for bad in ["", "31-07-2026 21:05", "2026-07-31 24:00", "2026-07-31 21:60", "nonsense"] {
            assert!(norm_dt(bad).is_err(), "{bad:?} must not parse");
        }

        // Cross-format ordering actually works after normalization.
        let conn = test_conn();
        claim_reminder(&conn, "k", "2026-07-31T08:00").unwrap();
        snooze_reminder(&conn, "k", "2026-07-31 08:30:00").unwrap();
        assert!(!claim_reminder(&conn, "k", "2026-07-31T08:15").unwrap());
        assert!(claim_reminder(&conn, "k", "2026-07-31T08:45").unwrap());
    }

    #[test]
    fn reminder_keys_and_times_are_validated() {
        let conn = test_conn();
        assert!(claim_reminder(&conn, "   ", "2026-07-31 06:00").is_err(), "blank key");
        assert!(claim_reminder(&conn, "k", "whenever").is_err(), "unparseable time");
        assert!(ack_reminder(&conn, "").is_err());
        assert!(snooze_reminder(&conn, "k", "2026-13-99 99:99").is_err());
    }
}
