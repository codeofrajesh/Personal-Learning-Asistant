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
use crate::planner::{fmt_hhmm, parse_hhmm, DEFAULT_HARD_STOP, DEFAULT_WAKE, MINUTES_PER_DAY};
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
    /// `plan_days.adjust_state`: `None` (never prompted) | `"dismissed"` | `"applied"`.
    /// Surfaced so the Recovery Card can honour "one prompt per drift event" across a
    /// remount or restart; without it the client cannot tell a declined day from a fresh one.
    pub adjust_state: Option<String>,
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

    // Which nodes feed an exam that is still ahead of the day being planned. One query for the
    // whole day rather than a lookup per block. `day` is the reference date, not `'now'`: when
    // planning a future day, an exam between now and then is no longer urgent *for that day*.
    let exam_nodes = exam_linked_nodes(conn, day).unwrap_or_default();

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
            // v10: real exam linkage. A block feeding a dated exam that hasn't happened yet
            // earns the solver's 1.5x urgency, so triage sacrifices non-exam work first.
            // Until v10 this was hardcoded `false` and the multiplier was dead code.
            exam_linked: b
                .target_node_id
                .is_some_and(|n| exam_nodes.contains(&n)),
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

    // Missing row = never prompted. A day only gets a `plan_days` row once its window is set
    // or an adjustment touches it, so absence must read as "fresh", not as an error.
    let adjust_state: Option<String> = conn
        .query_row(
            "SELECT adjust_state FROM plan_days WHERE day = ?1",
            [day],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();

    Ok(DayPlan {
        day: day.to_string(),
        wake_at: fmt_hhmm(wake),
        hard_stop_at: fmt_hhmm(stop),
        planned_mins,
        executed_mins,
        blocks,
        integrity,
        adjust_state,
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

/// A block whose time collides with a proposed one.
#[derive(Debug, Clone, Serialize)]
pub struct BlockConflict {
    pub id: i64,
    pub title: String,
    /// Effective position of the existing block, `HH:MM`.
    pub start: String,
    pub mins: i64,
    /// First `HH:MM` at or after the proposed start where the block would fit, when one exists
    /// before midnight. The UI offers this as a one-tap fix.
    pub next_free: Option<String>,
}

/// Find an OPEN block on `day` whose effective time overlaps `[start, start+mins)`.
///
/// Only `pending` / `active` blocks conflict. A `done` block records time that has already been
/// spent and a `skipped` / `spilled` one records time deliberately given up — refusing to let a
/// student plan over either would make the schedule un-editable after the fact, which is a
/// worse bug than the one being fixed.
///
/// Comparison uses the EFFECTIVE position (`actual_*` when a recovery moved the block, else
/// `planned_*`), because that is where the block actually sits on the timeline and therefore what
/// "you can't be in two places at once" refers to.
pub fn find_conflict(
    conn: &Connection,
    day: &str,
    start_mins: i32,
    mins: i64,
    exclude_id: Option<i64>,
) -> AppResult<Option<BlockConflict>> {
    // Every open block on the day, as (id, title, effective start, effective mins).
    let mut stmt = conn.prepare(
        "SELECT id, title,
                COALESCE(actual_start, planned_start) AS eff_start,
                COALESCE(actual_mins, planned_mins)   AS eff_mins
           FROM plan_blocks
          WHERE day = ?1
            AND status IN ('pending', 'active')
            AND (?2 IS NULL OR id <> ?2)
          ORDER BY eff_start",
    )?;
    let rows: Vec<(i64, String, i32, i64)> = stmt
        .query_map(rusqlite::params![day, exclude_id], |r| {
            let start: String = r.get(2)?;
            Ok((r.get(0)?, r.get(1)?, start, r.get(3)?))
        })?
        .filter_map(|r| r.ok())
        .filter_map(|(id, title, s, m): (i64, String, String, i64)| {
            parse_hhmm(&s).map(|sm| (id, title, sm, m))
        })
        .collect();

    // Half-open intervals: a block ending exactly when the next begins is back-to-back, not a
    // clash. Getting this wrong would reject every tidily-packed day.
    let start = i64::from(start_mins);
    let overlaps = |at: i64, s: i32, m: i64| {
        let bs = i64::from(s);
        bs < at + mins && at < bs + m
    };
    let hit = rows.iter().find(|(_, _, s, m)| overlaps(start, *s, *m));

    let Some((id, title, s, m)) = hit else {
        return Ok(None);
    };

    // Walk the occupied intervals forward from the proposed start to find the first slot the
    // block fits in whole. Suggesting a time it still won't fit would be a worse offer than none.
    let day_end = i64::from(MINUTES_PER_DAY);
    let mut cursor = start;
    let mut next_free = None;
    while cursor + mins <= day_end {
        match rows.iter().find(|(_, _, s, m)| overlaps(cursor, *s, *m)) {
            Some((_, _, s, m)) => cursor = i64::from(*s) + *m,
            None => {
                next_free = Some(fmt_hhmm(cursor as i32));
                break;
            }
        }
    }

    Ok(Some(BlockConflict {
        id: *id,
        title: title.clone(),
        start: fmt_hhmm(*s),
        mins: *m,
        next_free,
    }))
}

/// Create or update a block. Returns its id.
///
/// Rejects a block that would overlap an open one (see [`find_conflict`]): the solver's whole
/// model is that a block is time the student will actually be sitting down, so two of them at
/// once is not an ambitious plan, it is an impossible one. Note this differs from
/// over-commitment, which IS allowed and merely advised against by the pre-mortem — an
/// overcommitted day is a judgement call, a double-booked hour is arithmetic.
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

    // Refuse a double-booking. Checked here rather than in the command layer so every writer
    // (modal, quick-add, a future importer) inherits it — this is an invariant of the table, not
    // a property of one screen.
    let start_mins = parse_hhmm(&input.planned_start)
        .ok_or_else(|| AppError::Invalid("invalid start".to_string()))?;
    if let Some(c) = find_conflict(conn, &input.day, start_mins, input.planned_mins, input.id)? {
        let suggestion = match &c.next_free {
            Some(t) => format!(" The next free slot that fits is {t}."),
            None => String::new(),
        };
        return Err(AppError::Invalid(format!(
            "That overlaps “{}” ({}–{}).{}",
            c.title,
            fmt_hhmm(parse_hhmm(&c.start).unwrap_or(0)),
            fmt_hhmm(parse_hhmm(&c.start).unwrap_or(0) + c.mins as i32),
            suggestion
        )));
    }

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

/// Add executed minutes to a block. Called from `queries::log_study_session` for every `work`
/// session, which is what makes `executed_mins` reflect reality; see that function's note.
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

/// A routine day ("my normal weekday"), with its block count for display.
#[derive(Debug, Clone, Serialize)]
pub struct PlanTemplate {
    pub id: i64,
    pub name: String,
    /// Bitmask of weekdays this routine suits: bit 0 = Sunday … bit 6 = Saturday.
    pub dow_mask: i64,
    pub is_active: bool,
    pub block_count: i64,
    pub planned_mins: i64,
}

/// One block inside a template. No `day` and no lifecycle state — a template is a *shape*,
/// not a schedule, so it has no status, no executed minutes, and nothing to reconcile.
#[derive(Debug, Clone, Serialize)]
pub struct PlanTemplateBlock {
    pub id: i64,
    pub template_id: i64,
    pub planned_start: String,
    pub planned_mins: i64,
    pub title: String,
    pub target_kind: String,
    pub target_node_id: Option<i64>,
    pub target_count: Option<i64>,
    pub weight: i64,
    pub is_anchored: bool,
    pub sort_order: i64,
    /// Resolved course name when `target_node_id` still exists.
    pub target_name: Option<String>,
}

/// Create/update payload for a template.
#[derive(Debug, Clone, Deserialize)]
pub struct TemplateInputDto {
    pub id: Option<i64>,
    pub name: String,
    #[serde(default = "default_dow_mask")]
    pub dow_mask: i64,
    #[serde(default = "default_true")]
    pub is_active: bool,
}

/// Create/update payload for a template block.
#[derive(Debug, Clone, Deserialize)]
pub struct TemplateBlockInputDto {
    pub id: Option<i64>,
    pub template_id: i64,
    pub planned_start: String,
    pub planned_mins: i64,
    pub title: String,
    #[serde(default = "default_target_kind")]
    pub target_kind: String,
    pub target_node_id: Option<i64>,
    pub target_count: Option<i64>,
    #[serde(default = "default_weight")]
    pub weight: i64,
    #[serde(default)]
    pub is_anchored: bool,
    #[serde(default)]
    pub sort_order: i64,
}

fn default_dow_mask() -> i64 {
    127 // every day
}
fn default_true() -> bool {
    true
}

/// All templates, newest first, with rolled-up block counts.
pub fn list_templates(conn: &Connection) -> AppResult<Vec<PlanTemplate>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name, t.dow_mask, t.is_active,
                COUNT(b.id), COALESCE(SUM(b.planned_mins), 0)
           FROM plan_templates t
           LEFT JOIN plan_template_blocks b ON b.template_id = t.id
          GROUP BY t.id
          ORDER BY t.id DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(PlanTemplate {
            id: r.get(0)?,
            name: r.get(1)?,
            dow_mask: r.get(2)?,
            is_active: r.get::<_, i64>(3)? != 0,
            block_count: r.get(4)?,
            planned_mins: r.get(5)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// One template's blocks, in routine order.
pub fn template_blocks(conn: &Connection, template_id: i64) -> AppResult<Vec<PlanTemplateBlock>> {
    let mut stmt = conn.prepare(
        "SELECT b.id, b.template_id, b.planned_start, b.planned_mins, b.title, b.target_kind,
                b.target_node_id, b.target_count, b.weight, b.is_anchored, b.sort_order,
                n.name
           FROM plan_template_blocks b
           LEFT JOIN nodes n ON n.id = b.target_node_id
          WHERE b.template_id = ?1
          ORDER BY b.sort_order, b.planned_start, b.id",
    )?;
    let rows = stmt.query_map([template_id], |r| {
        Ok(PlanTemplateBlock {
            id: r.get(0)?,
            template_id: r.get(1)?,
            planned_start: r.get(2)?,
            planned_mins: r.get(3)?,
            title: r.get(4)?,
            target_kind: r.get(5)?,
            target_node_id: r.get(6)?,
            target_count: r.get(7)?,
            weight: r.get(8)?,
            is_anchored: r.get::<_, i64>(9)? != 0,
            sort_order: r.get(10)?,
            target_name: r.get(11)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Create or update a template. Returns its id.
pub fn upsert_template(conn: &Connection, input: &TemplateInputDto) -> AppResult<i64> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err(AppError::Invalid("template name is required".into()));
    }
    // Only the low 7 bits are meaningful; a wider value would silently never match a weekday.
    let mask = input.dow_mask & 0x7F;
    match input.id {
        Some(id) => {
            let n = conn.execute(
                "UPDATE plan_templates SET name = ?2, dow_mask = ?3, is_active = ?4 WHERE id = ?1",
                rusqlite::params![id, name, mask, input.is_active as i64],
            )?;
            if n == 0 {
                return Err(AppError::NotFound(format!("template {id} not found")));
            }
            Ok(id)
        }
        None => {
            conn.execute(
                "INSERT INTO plan_templates(name, dow_mask, is_active) VALUES(?1, ?2, ?3)",
                rusqlite::params![name, mask, input.is_active as i64],
            )?;
            Ok(conn.last_insert_rowid())
        }
    }
}

/// Delete a template. Its blocks go with it via `ON DELETE CASCADE`; days that were generated
/// from it keep their blocks (`plan_days.template_id` is `ON DELETE SET NULL`) — deleting a
/// routine must never retroactively empty the days it produced.
pub fn delete_template(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM plan_templates WHERE id = ?1", [id])?;
    Ok(())
}

/// Create or update one block inside a template. Same validation as a real block, minus the
/// day/lifecycle fields — a template with an invalid time would generate broken days forever.
pub fn upsert_template_block(
    conn: &Connection,
    input: &TemplateBlockInputDto,
) -> AppResult<i64> {
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

    match input.id {
        Some(id) => {
            let n = conn.execute(
                "UPDATE plan_template_blocks SET
                    template_id = ?2, planned_start = ?3, planned_mins = ?4, title = ?5,
                    target_kind = ?6, target_node_id = ?7, target_count = ?8, weight = ?9,
                    is_anchored = ?10, sort_order = ?11
                 WHERE id = ?1",
                rusqlite::params![
                    id,
                    input.template_id,
                    input.planned_start,
                    input.planned_mins,
                    title,
                    input.target_kind,
                    input.target_node_id,
                    input.target_count,
                    weight,
                    input.is_anchored as i64,
                    input.sort_order,
                ],
            )?;
            if n == 0 {
                return Err(AppError::NotFound(format!("template block {id} not found")));
            }
            Ok(id)
        }
        None => {
            conn.execute(
                "INSERT INTO plan_template_blocks(
                    template_id, planned_start, planned_mins, title, target_kind,
                    target_node_id, target_count, weight, is_anchored, sort_order)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                rusqlite::params![
                    input.template_id,
                    input.planned_start,
                    input.planned_mins,
                    title,
                    input.target_kind,
                    input.target_node_id,
                    input.target_count,
                    weight,
                    input.is_anchored as i64,
                    input.sort_order,
                ],
            )?;
            Ok(conn.last_insert_rowid())
        }
    }
}

/// Delete one block from a template.
pub fn delete_template_block(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM plan_template_blocks WHERE id = ?1", [id])?;
    Ok(())
}

/// Capture an existing day's blocks as a reusable routine. Returns the new template id.
///
/// This is the only ergonomic way to author a template: nobody builds a routine from an empty
/// form, they build a good day and then want it back. `planned_*` is captured rather than
/// `effective_*` — the routine should be the intention, not one morning's adjustments baked in
/// permanently. Spilled carry-overs are excluded for the same reason: they belong to the day
/// that went wrong, not to the routine.
pub fn save_day_as_template(
    conn: &Connection,
    day: &str,
    name: &str,
    dow_mask: i64,
) -> AppResult<i64> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Invalid("template name is required".into()));
    }
    conn.execute(
        "INSERT INTO plan_templates(name, dow_mask) VALUES(?1, ?2)",
        rusqlite::params![name, dow_mask & 0x7F],
    )?;
    let template_id = conn.last_insert_rowid();

    let n = conn.execute(
        "INSERT INTO plan_template_blocks(
            template_id, planned_start, planned_mins, title, target_kind,
            target_node_id, target_count, weight, is_anchored, sort_order)
         SELECT ?1, b.planned_start, b.planned_mins, b.title, b.target_kind,
                b.target_node_id, b.target_count, b.weight, b.is_anchored,
                ROW_NUMBER() OVER (ORDER BY b.planned_start, b.id)
           FROM plan_blocks b
          WHERE b.day = ?2 AND b.status <> 'spilled' AND b.spilled_from_id IS NULL",
        rusqlite::params![template_id, day],
    )?;
    if n == 0 {
        // Refuse to leave an empty routine behind — applying it later would look like a bug.
        conn.execute("DELETE FROM plan_templates WHERE id = ?1", [template_id])?;
        return Err(AppError::Invalid(
            "that day has no blocks to save as a routine".into(),
        ));
    }
    Ok(template_id)
}

/// The active template whose `dow_mask` covers `weekday` (0 = Sunday), if any.
///
/// `weekday` is passed in rather than derived with SQLite's `strftime('%w')` for the same
/// reason every other planner call takes `day`: SQLite works in UTC, so late-evening local
/// time resolves to tomorrow's weekday and would suggest the wrong routine.
pub fn suggested_template(conn: &Connection, weekday: i64) -> AppResult<Option<PlanTemplate>> {
    if !(0..=6).contains(&weekday) {
        return Err(AppError::Invalid("weekday must be 0..=6".into()));
    }
    Ok(list_templates(conn)?
        .into_iter()
        .find(|t| t.is_active && t.block_count > 0 && (t.dow_mask & (1 << weekday)) != 0))
}

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

// ── Exams & backward planning (v10) ──────────────────────────────────────────
//
// Backward planning answers ONE question honestly: "given what's left of this syllabus, my
// learned pace, and the days remaining, how much per day does this actually take?" The answer
// is frequently unwelcome, and that is the feature — a student who finds out in week one that
// the exam needs 3h/day can still act on it. Finding out the night before is not a plan.
//
// Everything here is derived on read. There is no stored "plan" to go stale: materials get
// added, watched, and completed constantly, and a cached projection would be wrong within a day.

/// A dated exam attached to a course subtree.
#[derive(Debug, Clone, Serialize)]
pub struct Exam {
    pub id: i64,
    pub name: String,
    pub node_id: Option<i64>,
    /// Resolved course name, when the node still exists.
    pub node_name: Option<String>,
    pub exam_date: String,
    pub daily_target_mins: i64,
    pub revision_days: i64,
    pub is_archived: bool,
}

/// Create/update payload for an exam.
#[derive(Debug, Clone, Deserialize)]
pub struct ExamInputDto {
    pub id: Option<i64>,
    pub name: String,
    pub node_id: Option<i64>,
    pub exam_date: String,
    #[serde(default = "default_daily_target")]
    pub daily_target_mins: i64,
    #[serde(default = "default_revision_days")]
    pub revision_days: i64,
    #[serde(default)]
    pub is_archived: bool,
}

fn default_daily_target() -> i64 {
    60
}
fn default_revision_days() -> i64 {
    3
}

/// The backward plan for one exam: what's left, how long there is, and what that costs per day.
#[derive(Debug, Clone, Serialize)]
pub struct ExamPlan {
    pub exam: Exam,
    /// Calendar days from `today` to the exam (0 = today, negative = past).
    pub days_until: i64,
    /// Days actually usable for NEW material (`days_until` minus the revision tail).
    pub study_days: i64,
    /// Items in the subtree not yet finished.
    pub remaining_items: i64,
    /// Honest minutes of content left, already multiplied by the learned pace for this course.
    pub remaining_mins: i64,
    /// Minutes/day the syllabus actually demands.
    pub required_daily_mins: i64,
    /// Minutes/day the student said they'd give it.
    pub target_daily_mins: i64,
    /// True when `required <= target` — the stated intention is enough.
    pub on_track: bool,
    /// True once there are no study days left (exam imminent or passed).
    pub out_of_time: bool,
    /// One plain-language verdict. Content terms, never a ratio.
    pub message: String,
}

const EXAM_SELECT: &str = "SELECT e.id, e.name, e.node_id, n.name, e.exam_date,
        e.daily_target_mins, e.revision_days, e.is_archived
   FROM exams e
   LEFT JOIN nodes n ON n.id = e.node_id";

fn map_exam(r: &rusqlite::Row<'_>) -> rusqlite::Result<Exam> {
    Ok(Exam {
        id: r.get(0)?,
        name: r.get(1)?,
        node_id: r.get(2)?,
        node_name: r.get(3)?,
        exam_date: r.get(4)?,
        daily_target_mins: r.get(5)?,
        revision_days: r.get(6)?,
        is_archived: r.get::<_, i64>(7)? != 0,
    })
}

/// All exams, soonest first. Archived ones are included only when asked for — a past exam
/// should stop competing for attention on its own, without the student tidying up.
pub fn list_exams(conn: &Connection, include_archived: bool) -> AppResult<Vec<Exam>> {
    let sql = if include_archived {
        format!("{EXAM_SELECT} ORDER BY e.exam_date ASC, e.id ASC")
    } else {
        format!("{EXAM_SELECT} WHERE e.is_archived = 0 ORDER BY e.exam_date ASC, e.id ASC")
    };
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], map_exam)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Create or update an exam. Returns its id.
pub fn upsert_exam(conn: &Connection, input: &ExamInputDto) -> AppResult<i64> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err(AppError::Invalid("exam name is required".into()));
    }
    // A malformed date would silently produce a nonsense countdown forever.
    if !is_iso_day(&input.exam_date) {
        return Err(AppError::Invalid(format!(
            "invalid exam_date '{}' (want YYYY-MM-DD)",
            input.exam_date
        )));
    }
    let target = input.daily_target_mins.clamp(5, 16 * 60);
    let revision = input.revision_days.clamp(0, 60);

    match input.id {
        Some(id) => {
            let n = conn.execute(
                "UPDATE exams SET name = ?2, node_id = ?3, exam_date = ?4,
                                  daily_target_mins = ?5, revision_days = ?6, is_archived = ?7
                 WHERE id = ?1",
                rusqlite::params![
                    id,
                    name,
                    input.node_id,
                    input.exam_date,
                    target,
                    revision,
                    input.is_archived as i64
                ],
            )?;
            if n == 0 {
                return Err(AppError::NotFound(format!("exam {id} not found")));
            }
            Ok(id)
        }
        None => {
            conn.execute(
                "INSERT INTO exams(name, node_id, exam_date, daily_target_mins, revision_days,
                                   is_archived)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![
                    name,
                    input.node_id,
                    input.exam_date,
                    target,
                    revision,
                    input.is_archived as i64
                ],
            )?;
            Ok(conn.last_insert_rowid())
        }
    }
}

/// Delete an exam. Blocks that were scheduled for it keep existing — the work was still done,
/// and retroactively deleting a week of study because an exam was removed would be data loss.
pub fn delete_exam(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM exams WHERE id = ?1", [id])?;
    Ok(())
}

/// Shape check for `YYYY-MM-DD`. Deliberately not a full calendar validation: the frontend
/// sends real dates, and this only has to reject the shapes that would corrupt date maths.
fn is_iso_day(day: &str) -> bool {
    let b = day.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| matches!(i, 4 | 7) || c.is_ascii_digit())
}

/// Remaining, unwatched content in a node's subtree as `(items, content_minutes)`.
///
/// "Remaining" credits partial progress: a 60-minute lecture watched to 40 minutes leaves 20,
/// not 60. Counting it whole would inflate every projection and make the feature cry wolf.
/// Items with no known duration contribute a conservative 10-minute placeholder rather than
/// zero — a PDF with no page count is not free work.
fn remaining_syllabus(conn: &Connection, node_id: i64) -> AppResult<(i64, f64)> {
    conn.query_row(
        "WITH RECURSIVE subtree(id) AS (
            SELECT ?1
            UNION ALL
            SELECT n.id FROM nodes n JOIN subtree s ON n.parent_id = s.id
         )
         SELECT
            COUNT(*),
            COALESCE(SUM(
                MAX(0.0,
                    CASE
                        WHEN COALESCE(m.duration_secs, 0) > 0
                            THEN m.duration_secs - COALESCE(w.position_secs, 0)
                        ELSE 600.0
                    END
                )
            ), 0.0) / 60.0
         FROM materials m
         JOIN subtree s ON s.id = m.node_id
         LEFT JOIN watch_progress w ON w.material_id = m.id
         WHERE m.status = 'active'
           AND m.is_completed = 0
           AND COALESCE(w.completed, 0) = 0",
        [node_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .map_err(Into::into)
}

/// Whole days from `from` to `to` (both `YYYY-MM-DD`), via SQLite's julian day.
///
/// Uses the DB purely as a calendar calculator on two explicit dates — no `'now'`, so this is
/// still local-time-correct. Rust date arithmetic would mean a new dependency for one subtraction.
fn days_between(conn: &Connection, from: &str, to: &str) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT CAST(julianday(?2) - julianday(?1) AS INTEGER)",
        rusqlite::params![from, to],
        |r| r.get::<_, Option<i64>>(0),
    )?
    .unwrap_or(0))
}

/// Build the backward plan for one exam, as of the caller's LOCAL `today`.
pub fn exam_plan(conn: &Connection, exam: Exam, today: &str) -> AppResult<ExamPlan> {
    let days_until = days_between(conn, today, &exam.exam_date)?;
    // The revision tail is reserved for review, so new material stops before it.
    let study_days = (days_until - exam.revision_days).max(0);

    let (remaining_items, content_mins) = match exam.node_id {
        Some(node) => remaining_syllabus(conn, node)?,
        // An exam with no course attached still counts down; it just can't project a workload.
        None => (0, 0.0),
    };
    // The learned pace is the whole point of using it here: 90 minutes of lecture is not 90
    // minutes of this student's evening.
    let pace = pace_for_node(conn, exam.node_id);
    let remaining_mins = (content_mins * pace).round() as i64;

    let out_of_time = study_days <= 0;
    let required_daily_mins = if out_of_time {
        remaining_mins
    } else {
        (remaining_mins as f64 / study_days as f64).ceil() as i64
    };
    let target_daily_mins = exam.daily_target_mins;
    let on_track = !out_of_time && required_daily_mins <= target_daily_mins;

    let message = if days_until < 0 {
        "This exam has passed.".to_string()
    } else if remaining_items == 0 {
        match exam.node_id {
            Some(_) => "Everything for this exam is covered. The rest is revision.".to_string(),
            None => "No course linked yet, so there's nothing to project.".to_string(),
        }
    } else if out_of_time {
        format!(
            "{remaining_items} items still uncovered with no study days left — this is triage now, \
             not coverage. Pick what matters most."
        )
    } else if on_track {
        format!(
            "{} a day covers the {remaining_items} items left, with {} to spare.",
            fmt_mins_short(required_daily_mins),
            fmt_mins_short(target_daily_mins - required_daily_mins),
        )
    } else {
        format!(
            "The {remaining_items} items left need {} a day, not {}. Either give it more time or \
             decide now what you're not going to cover.",
            fmt_mins_short(required_daily_mins),
            fmt_mins_short(target_daily_mins),
        )
    };

    Ok(ExamPlan {
        exam,
        days_until,
        study_days,
        remaining_items,
        remaining_mins,
        required_daily_mins,
        target_daily_mins,
        on_track,
        out_of_time,
        message,
    })
}

/// Backward plans for every active exam, soonest first.
pub fn exam_plans(conn: &Connection, today: &str) -> AppResult<Vec<ExamPlan>> {
    let mut out = Vec::new();
    for exam in list_exams(conn, false)? {
        out.push(exam_plan(conn, exam, today)?);
    }
    Ok(out)
}

// ── Focus contract ───────────────────────────────────────────────────────────
//
// A focus contract is a pre-commitment: before starting a block the student writes, in one line,
// what "done" means for it. At the end they say whether they kept it. That's the whole mechanism.
//
// Two deliberate limits:
//   * It is NOT enforcement. Nothing is locked, blocked, or punished. A planner that fights the
//     student loses, and the point of a contract is that keeping it is the student's choice —
//     otherwise there is nothing to learn about themselves from having kept it.
//   * The verdict is SELF-REPORTED. "Did I do what I said?" is not observable from playback, and
//     inferring it from executed minutes would score the wrong thing: sitting there for 45
//     minutes is not the same as finishing what you promised.
//
// Stored as `plan_events` rows rather than new columns: it is a sequence of observations about a
// block, which is exactly what that append-only ledger is for. No migration, and the history is
// preserved even if the block is later edited.

/// What a student committed to for one block, and how it ended.
#[derive(Debug, Clone, Serialize)]
pub struct FocusContract {
    pub block_id: i64,
    /// The one-line definition of done, as written.
    pub intention: String,
    pub committed_at: String,
    /// `None` while the block is still in flight.
    pub kept: Option<bool>,
    pub resolved_at: Option<String>,
}

/// How reliably this student keeps what they commit to. The honest mirror the feature exists for.
#[derive(Debug, Clone, Serialize)]
pub struct FocusRecord {
    pub committed: i64,
    pub kept: i64,
    pub broken: i64,
    /// 0-100 over RESOLVED contracts only, `None` until at least three have been answered.
    pub keep_rate: Option<f64>,
}

/// Below this many resolved contracts a keep-rate is a coin toss, not a fact about the student.
const FOCUS_MIN_SAMPLES: i64 = 3;

/// Record a commitment for a block. Replaces any previous one for the same block.
pub fn commit_focus(conn: &Connection, block_id: i64, intention: &str) -> AppResult<()> {
    let intention = intention.trim();
    if intention.is_empty() {
        return Err(AppError::Invalid(
            "write what 'done' means before committing".into(),
        ));
    }
    if intention.chars().count() > 200 {
        return Err(AppError::Invalid(
            "keep the commitment to one line (200 characters)".into(),
        ));
    }
    let block = get_block(conn, block_id)?;

    // Re-committing supersedes rather than appends: two live contracts on one block would leave
    // no answer to "what did you promise?". Resolved ones are never touched — that's the record.
    conn.execute(
        "DELETE FROM plan_events
          WHERE block_id = ?1 AND kind = 'committed'
            AND NOT EXISTS (
                SELECT 1 FROM plan_events r
                 WHERE r.block_id = ?1 AND r.kind IN ('contract_kept', 'contract_broken')
            )",
        [block_id],
    )?;

    // `meta` is the existing small-JSON column. Escaped rather than string-formatted: an
    // intention containing a quote would otherwise produce invalid JSON that reads back empty.
    let meta = format!(
        "{{\"intention\":{}}}",
        serde_json::to_string(intention).unwrap_or_else(|_| "\"\"".into())
    );
    log_event(conn, Some(block_id), &block.day, "committed", None, Some(&meta))
}

/// Record whether the student kept their commitment. Self-reported by design.
pub fn resolve_focus(conn: &Connection, block_id: i64, kept: bool) -> AppResult<()> {
    let block = get_block(conn, block_id)?;
    let kind = if kept { "contract_kept" } else { "contract_broken" };
    log_event(conn, Some(block_id), &block.day, kind, None, None)
}

/// The live contract for a block, if one was ever made.
pub fn focus_contract(conn: &Connection, block_id: i64) -> AppResult<Option<FocusContract>> {
    let committed: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT at, meta FROM plan_events
              WHERE block_id = ?1 AND kind = 'committed'
              ORDER BY id DESC LIMIT 1",
            [block_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((committed_at, meta)) = committed else {
        return Ok(None);
    };

    // A malformed or missing meta yields an empty intention rather than an error: the contract
    // still happened, and losing the whole row over unreadable text would be worse.
    let intention = meta
        .as_deref()
        .and_then(|m| serde_json::from_str::<serde_json::Value>(m).ok())
        .and_then(|v| v.get("intention").and_then(|i| i.as_str()).map(str::to_owned))
        .unwrap_or_default();

    let resolution: Option<(String, String)> = conn
        .query_row(
            "SELECT kind, at FROM plan_events
              WHERE block_id = ?1 AND kind IN ('contract_kept', 'contract_broken')
              ORDER BY id DESC LIMIT 1",
            [block_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;

    let (kept, resolved_at) = match resolution {
        Some((kind, at)) => (Some(kind == "contract_kept"), Some(at)),
        None => (None, None),
    };

    Ok(Some(FocusContract {
        block_id,
        intention,
        committed_at,
        kept,
        resolved_at,
    }))
}

/// The student's keep-rate over the trailing `days`.
pub fn focus_record(conn: &Connection, today: &str, days: i64) -> AppResult<FocusRecord> {
    let window = format!("-{} days", days.clamp(1, 365));
    let (committed, kept, broken): (i64, i64, i64) = conn.query_row(
        "SELECT
            SUM(CASE WHEN kind = 'committed' THEN 1 ELSE 0 END),
            SUM(CASE WHEN kind = 'contract_kept' THEN 1 ELSE 0 END),
            SUM(CASE WHEN kind = 'contract_broken' THEN 1 ELSE 0 END)
           FROM plan_events
          WHERE kind IN ('committed', 'contract_kept', 'contract_broken')
            AND day <= ?1 AND day >= date(?1, ?2)",
        rusqlite::params![today, window],
        |r| {
            Ok((
                r.get::<_, Option<i64>>(0)?.unwrap_or(0),
                r.get::<_, Option<i64>>(1)?.unwrap_or(0),
                r.get::<_, Option<i64>>(2)?.unwrap_or(0),
            ))
        },
    )?;

    // Rate over RESOLVED contracts only. Counting unanswered ones as broken would punish the
    // student for blocks still in flight, and counting them as kept would flatter.
    let resolved = kept + broken;
    let keep_rate = if resolved >= FOCUS_MIN_SAMPLES {
        Some((kept as f64 / resolved as f64) * 100.0)
    } else {
        None
    };

    Ok(FocusRecord {
        committed,
        kept,
        broken,
        keep_rate,
    })
}

// ── Streak insurance ─────────────────────────────────────────────────────────

/// A streak that tolerates the occasional bad day, plus the arithmetic behind it.
#[derive(Debug, Clone, Serialize)]
pub struct StreakStatus {
    /// The streak the student is shown, with insured days bridged.
    pub streak: i64,
    /// What the streak would be under the strict "any bad day ends it" rule.
    pub raw_streak: i64,
    /// Days inside the current streak that insurance is covering, most recent first.
    pub insured_days: Vec<String>,
    /// Further bad days that could still be absorbed right now.
    pub insurance_left: i64,
    /// Good days needed to earn the next insured day.
    pub next_earned_in: i64,
}

/// Good days required to earn each insured day. The second one costs twice as much, and so on.
const INSURANCE_EARN_EVERY: i64 = 7;
/// Hard ceiling. Without it a long history would make the streak nearly unbreakable, and a
/// number that cannot be lost is not a streak.
const INSURANCE_MAX: i64 = 2;
/// Score at or above which a day counts as kept — the same bar the summary's streak uses.
const STREAK_BAR: f64 = 60.0;

/// The current streak, allowing a limited number of earned bad days to be bridged.
///
/// ## Why this is a tolerance, not a spendable token
///
/// The obvious design is a wallet: earn insurance, spend it to save a streak. It was rejected.
/// Spending requires PERSISTING which days were paid for, which means a write during what should
/// be a read, and it makes the displayed streak depend on the order the student happened to open
/// the app in. This rule is instead purely derived from `consistency_log`, so the same history
/// always produces the same number — nothing to migrate, nothing to reconcile, and no way to
/// farm tokens by opening the app on the right day.
///
/// Earning is progressive (7 good days for the first bridge, 14 for the second) and capped at
/// [`INSURANCE_MAX`], so consistency buys forgiveness but never invulnerability. A student who
/// studies hard for a month and gets ill for a day keeps their streak; one who works two days a
/// week does not get a free pass.
///
/// Neutral days (nothing due, nothing planned, nothing studied) are skipped rather than bridged —
/// they cost no insurance, matching the rest of the scoring layer's treatment of an empty day as
/// no evidence rather than as failure.
pub fn streak_status(conn: &Connection, today: &str) -> AppResult<StreakStatus> {
    // CHRONOLOGICAL order matters: insurance is earned by the good days BEFORE a bad one, so a
    // reverse walk would test the wrong days' worth of consistency against the cost.
    //
    // 120 days is a deliberate cap. A streak that started earlier is truncated to this window;
    // the alternative is scanning unbounded history on every read for a number that is already
    // in the "long time" bucket by then.
    let mut stmt = conn.prepare(
        "SELECT day, score, tasks_due, study_minutes, blocks_planned
           FROM consistency_log
          WHERE day <= ?1 AND day >= date(?1, '-120 days')
          ORDER BY day ASC",
    )?;
    let rows = stmt.query_map([today], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, f64>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, f64>(3)?,
            r.get::<_, i64>(4)?,
        ))
    })?;

    // Signal-bearing days only, chronological. Neutral days are dropped here so they can neither
    // extend a streak nor consume insurance.
    let mut days: Vec<(String, bool)> = Vec::new();
    for row in rows {
        let (day, score, tasks_due, study_minutes, blocks_planned) = row?;
        if tasks_due == 0 && study_minutes <= 0.0 && blocks_planned == 0 {
            continue;
        }
        days.push((day, score >= STREAK_BAR));
    }

    let mut good = 0i64;
    let mut insured: Vec<String> = Vec::new();

    for (day, is_good) in &days {
        if *is_good {
            good += 1;
            continue;
        }
        // A day below the bar. The n-th bridge costs n × INSURANCE_EARN_EVERY good days, all of
        // which must already be banked in the CURRENT run.
        let cost = INSURANCE_EARN_EVERY * (insured.len() as i64 + 1);
        if (insured.len() as i64) < INSURANCE_MAX && good >= cost {
            insured.push(day.clone());
            continue;
        }
        // Unaffordable: the streak ends and the next one starts from scratch, insurance included.
        good = 0;
        insured.clear();
    }

    // The strict streak: trailing good days with nothing bridged.
    let raw_streak = days
        .iter()
        .rev()
        .take_while(|(_, is_good)| *is_good)
        .count() as i64;

    // Most recent first, matching how the UI lists them.
    insured.reverse();

    let used = insured.len() as i64;
    let insurance_left = (INSURANCE_MAX - used).max(0);
    let next_cost = INSURANCE_EARN_EVERY * (used + 1);
    let next_earned_in = if insurance_left == 0 {
        0
    } else {
        (next_cost - good).max(0)
    };

    Ok(StreakStatus {
        streak: good,
        raw_streak,
        insured_days: insured,
        insurance_left,
        next_earned_in,
    })
}

// ── Learned peak hours ───────────────────────────────────────────────────────

/// One hour of the day, with how much focus the student has actually logged in it.
#[derive(Debug, Clone, Serialize)]
pub struct PeakHour {
    /// Local hour, 0..=23.
    pub hour: i64,
    pub total_mins: f64,
    /// Distinct days on which any focus landed in this hour — the confidence behind the number.
    pub days: i64,
}

/// Focus-by-hour over the trailing `days`, in the caller's LOCAL time.
///
/// `utc_offset_mins` is REQUIRED and comes from the frontend, because `study_sessions.started_at`
/// is written with SQLite's `datetime('now')` — UTC. Reading `strftime('%H', started_at)` directly
/// would report a student in UTC+5:30 as peaking five and a half hours away from when they
/// actually study, which is worse than not offering the feature: they'd be advised to schedule
/// their hardest work while asleep.
///
/// Breaks are excluded: this measures focus, and a long break at 21:00 is not a peak hour.
pub fn peak_hours(
    conn: &Connection,
    utc_offset_mins: i64,
    days: i64,
) -> AppResult<Vec<PeakHour>> {
    // Guard the offset: real zones span UTC-12..UTC+14, and a wild value would silently rotate
    // the whole histogram.
    if !(-12 * 60..=14 * 60).contains(&utc_offset_mins) {
        return Err(AppError::Invalid(format!(
            "utc_offset_mins {utc_offset_mins} out of range"
        )));
    }
    let window = format!("-{} days", days.clamp(1, 365));
    let shift = format!("{utc_offset_mins} minutes");

    let mut stmt = conn.prepare(
        "SELECT CAST(strftime('%H', datetime(started_at, ?1)) AS INTEGER) AS h,
                COALESCE(SUM(duration_secs), 0) / 60.0,
                COUNT(DISTINCT date(datetime(started_at, ?1)))
           FROM study_sessions
          WHERE COALESCE(session_type, 'work') = 'work'
            AND started_at >= datetime('now', ?2)
          GROUP BY h
          ORDER BY h",
    )?;
    let rows = stmt.query_map(rusqlite::params![shift, window], |r| {
        Ok(PeakHour {
            hour: r.get(0)?,
            total_mins: r.get(1)?,
            days: r.get(2)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Node ids with an active exam still ahead of `today`, including every ancestor of the exam's
/// node.
///
/// Ancestors matter: an exam is set on "Physics", but a block targets the specific chapter
/// underneath it. Matching only the exact node would leave almost every real block unlinked,
/// which is how the 1.5x urgency multiplier would stay dead code in practice.
fn exam_linked_nodes(conn: &Connection, today: &str) -> AppResult<std::collections::HashSet<i64>> {
    let mut stmt = conn.prepare(
        "WITH RECURSIVE subtree(id) AS (
            SELECT node_id FROM exams
             WHERE is_archived = 0 AND node_id IS NOT NULL AND exam_date >= ?1
            UNION
            SELECT n.id FROM nodes n JOIN subtree s ON n.parent_id = s.id
         )
         SELECT id FROM subtree",
    )?;
    let rows = stmt.query_map([today], |r| r.get::<_, i64>(0))?;
    let mut set = std::collections::HashSet::new();
    for row in rows {
        set.insert(row?);
    }
    Ok(set)
}

/// Short duration label for the verdict copy ("1h 20m", "45m").
fn fmt_mins_short(mins: i64) -> String {
    let m = mins.max(0);
    if m < 60 {
        format!("{m}m")
    } else if m % 60 == 0 {
        format!("{}h", m / 60)
    } else {
        format!("{}h {}m", m / 60, m % 60)
    }
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

    /// A template block payload with sane defaults, mirroring `dto` for real blocks.
    fn tblock(template_id: i64, start: &str, mins: i64, title: &str) -> TemplateBlockInputDto {
        TemplateBlockInputDto {
            id: None,
            template_id,
            planned_start: start.to_string(),
            planned_mins: mins,
            title: title.to_string(),
            target_kind: "freeform".to_string(),
            target_node_id: None,
            target_count: None,
            weight: 2,
            is_anchored: false,
            sort_order: 0,
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

    /// A student cannot be in two places at once, so an overlapping block is rejected outright
    /// — unlike over-commitment, which is allowed and merely advised against.
    #[test]
    fn rejects_a_block_that_overlaps_an_open_one() {
        let conn = test_conn();
        upsert_block(&conn, &dto(DAY, "11:10", 45, "Physics", 3)).unwrap(); // 11:10–11:55

        // The exact case from QA: a shorter block nested inside the first.
        let err = upsert_block(&conn, &dto(DAY, "11:20", 20, "Chemistry", 2)).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("Physics"), "names the block it collides with: {msg}");

        // NOTE: `BlockModal` parses this exact phrase to offer a one-tap "Move it to 11:55".
        // Reword it and the button silently stops appearing, so the wording is pinned here.
        assert!(
            msg.contains("The next free slot that fits is 11:55."),
            "must carry the machine-readable suggestion: {msg}"
        );

        // Straddling either edge is equally impossible.
        assert!(upsert_block(&conn, &dto(DAY, "10:50", 30, "Early", 2)).is_err());
        assert!(upsert_block(&conn, &dto(DAY, "11:50", 30, "Late", 2)).is_err());

        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM plan_blocks WHERE day = ?1", [DAY], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "no rejected block was written");
    }

    /// Back-to-back blocks are the normal case and must not be mistaken for a clash: the
    /// intervals are half-open, so one ending at 12:00 and the next starting at 12:00 is fine.
    #[test]
    fn allows_back_to_back_blocks() {
        let conn = test_conn();
        upsert_block(&conn, &dto(DAY, "11:00", 60, "Physics", 3)).unwrap();
        assert!(upsert_block(&conn, &dto(DAY, "12:00", 60, "Math", 2)).is_ok());
        assert!(upsert_block(&conn, &dto(DAY, "10:00", 60, "Chem", 2)).is_ok());
    }

    /// Editing a block must not collide with ITSELF, and a finished block never blocks new
    /// planning — otherwise the day becomes un-editable the moment anything is completed.
    #[test]
    fn conflict_check_ignores_self_and_settled_blocks() {
        let conn = test_conn();
        let id = upsert_block(&conn, &dto(DAY, "11:00", 60, "Physics", 3)).unwrap();

        // Same block, same slot, new title: an edit, not a conflict.
        let mut edit = dto(DAY, "11:00", 60, "Physics revised", 3);
        edit.id = Some(id);
        assert!(upsert_block(&conn, &edit).is_ok(), "a block cannot conflict with itself");

        // Once it's done, its time is history and can be planned over.
        set_block_status(&conn, id, "done", None).unwrap();
        assert!(
            upsert_block(&conn, &dto(DAY, "11:15", 30, "Recap", 2)).is_ok(),
            "a completed block must not lock its slot forever"
        );
    }

    /// The suggested slot has to be one the block actually FITS in, not merely the end of the
    /// thing it hit — otherwise the one-tap fix lands on another conflict.
    #[test]
    fn conflict_suggests_a_slot_the_block_actually_fits() {
        let conn = test_conn();
        upsert_block(&conn, &dto(DAY, "11:00", 60, "A", 2)).unwrap(); // 11:00–12:00
        upsert_block(&conn, &dto(DAY, "12:00", 30, "B", 2)).unwrap(); // 12:00–12:30

        // A 60-minute block at 11:30 hits A; 12:00 is free of A but B is there, so the answer
        // must skip past B to 12:30.
        let c = find_conflict(&conn, DAY, 11 * 60 + 30, 60, None).unwrap().unwrap();
        assert_eq!(c.title, "A", "reports the first thing it hits");
        assert_eq!(c.next_free.as_deref(), Some("12:30"));
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

    /// The Today payload must carry `adjust_state`, or the client cannot honour "one prompt per
    /// drift event" across a remount: a dismissed day would look identical to a fresh one.
    #[test]
    fn day_plan_exposes_adjust_state() {
        let conn = test_conn();
        upsert_block(&conn, &dto(DAY, "06:00", 60, "A", 2)).unwrap();

        // No `plan_days` row yet — absence must read as "never prompted", not error.
        assert_eq!(day_plan(&conn, DAY).unwrap().adjust_state, None);

        dismiss_recovery(&conn, DAY).unwrap();
        assert_eq!(
            day_plan(&conn, DAY).unwrap().adjust_state.as_deref(),
            Some("dismissed")
        );
    }

    /// Setting a day window creates a `plan_days` row with a NULL `adjust_state`. That must
    /// still read as "never prompted" rather than suppressing the card forever.
    #[test]
    fn day_window_row_leaves_adjust_state_unset() {
        let conn = test_conn();
        set_day_window(&conn, DAY, Some("06:00"), Some("22:00")).unwrap();
        assert_eq!(day_plan(&conn, DAY).unwrap().adjust_state, None);
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

    /// Template CRUD round-trip, including the rolled-up counts the list view renders.
    #[test]
    fn template_crud_round_trip() {
        let conn = test_conn();
        let tid = upsert_template(
            &conn,
            &TemplateInputDto {
                id: None,
                name: "  Weekday  ".into(),
                dow_mask: 0b0111110, // Mon–Fri
                is_active: true,
            },
        )
        .unwrap();

        upsert_template_block(&conn, &tblock(tid, "06:00", 60, "Physics")).unwrap();
        let second = upsert_template_block(&conn, &tblock(tid, "07:00", 45, "Math")).unwrap();

        let list = list_templates(&conn).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "Weekday", "the name is trimmed");
        assert_eq!(list[0].block_count, 2);
        assert_eq!(list[0].planned_mins, 105, "durations roll up for display");

        // Rename + narrow the weekday mask.
        upsert_template(
            &conn,
            &TemplateInputDto {
                id: Some(tid),
                name: "Term time".into(),
                dow_mask: 0b0000010, // Monday only
                is_active: false,
            },
        )
        .unwrap();
        let list = list_templates(&conn).unwrap();
        assert_eq!(list[0].name, "Term time");
        assert!(!list[0].is_active);

        delete_template_block(&conn, second).unwrap();
        assert_eq!(template_blocks(&conn, tid).unwrap().len(), 1);

        // Deleting the template cascades to its blocks.
        delete_template(&conn, tid).unwrap();
        assert!(list_templates(&conn).unwrap().is_empty());
        assert!(template_blocks(&conn, tid).unwrap().is_empty());
    }

    /// A blank name is rejected, not stored as an unnameable routine.
    #[test]
    fn template_rejects_blank_name() {
        let conn = test_conn();
        assert!(upsert_template(
            &conn,
            &TemplateInputDto {
                id: None,
                name: "   ".into(),
                dow_mask: 127,
                is_active: true,
            },
        )
        .is_err());
    }

    /// Template blocks get the SAME validation as real blocks — a bad time in a routine would
    /// generate broken days every time it was applied.
    #[test]
    fn template_blocks_validate_like_real_blocks() {
        let conn = test_conn();
        let tid = upsert_template(
            &conn,
            &TemplateInputDto { id: None, name: "T".into(), dow_mask: 127, is_active: true },
        )
        .unwrap();

        let mut bad = tblock(tid, "25:00", 60, "Nope");
        assert!(upsert_template_block(&conn, &bad).is_err(), "invalid HH:MM");

        bad = tblock(tid, "06:00", 0, "Nope");
        assert!(upsert_template_block(&conn, &bad).is_err(), "zero duration");

        bad = tblock(tid, "06:00", 60, "   ");
        assert!(upsert_template_block(&conn, &bad).is_err(), "blank title");

        bad = tblock(tid, "06:00", 60, "Nope");
        bad.target_kind = "wishful".into();
        assert!(upsert_template_block(&conn, &bad).is_err(), "unknown target_kind");

        // Weight is clamped rather than rejected — an out-of-range priority has an obvious
        // intent, unlike an invalid time.
        let mut ok = tblock(tid, "06:00", 60, "Physics");
        ok.weight = 99;
        let id = upsert_template_block(&conn, &ok).unwrap();
        let stored = template_blocks(&conn, tid).unwrap();
        assert_eq!(stored.iter().find(|b| b.id == id).unwrap().weight, 3);
    }

    /// Saving a day as a routine captures the INTENTION (`planned_*`), not one morning's
    /// adjustments, and excludes spill carry-overs that belong to the day that went wrong.
    #[test]
    fn save_day_as_template_captures_intent_only() {
        let conn = test_conn();
        let a = upsert_block(&conn, &dto(DAY, "06:00", 60, "Physics", 3)).unwrap();
        upsert_block(&conn, &dto(DAY, "07:00", 45, "Math", 2)).unwrap();
        // A carry-over from yesterday, and an adjusted position on a real block.
        // `spilled_from_id` is a real FK, so the source block has to exist.
        let source = upsert_block(&conn, &dto("2026-07-30", "09:00", 30, "Yesterday", 2)).unwrap();
        conn.execute(
            "INSERT INTO plan_blocks(day, planned_start, planned_mins, title, spilled_from_id)
             VALUES(?1, '09:00', 30, 'Yesterday leftovers', ?2)",
            rusqlite::params![DAY, source],
        )
        .unwrap();
        conn.execute("UPDATE plan_blocks SET actual_start = '11:00' WHERE id = ?1", [a])
            .unwrap();

        let tid = save_day_as_template(&conn, DAY, "My weekday", 0b0111110).unwrap();
        let blocks = template_blocks(&conn, tid).unwrap();

        assert_eq!(blocks.len(), 2, "the carry-over is not part of the routine");
        assert_eq!(
            blocks[0].planned_start, "06:00",
            "captures the intention, not the adjusted 11:00"
        );
        assert_eq!(blocks[1].planned_start, "07:00");
        assert_eq!(blocks[0].sort_order, 1, "routine order is materialised");
    }

    /// Saving an empty day must fail rather than leave behind a routine that silently does
    /// nothing when applied.
    #[test]
    fn save_day_as_template_refuses_an_empty_day() {
        let conn = test_conn();
        assert!(save_day_as_template(&conn, DAY, "Nothing", 127).is_err());
        assert!(
            list_templates(&conn).unwrap().is_empty(),
            "no orphan template row is left behind"
        );
    }

    /// The suggestion respects the weekday bitmask, the active flag, and skips empty routines.
    #[test]
    fn suggested_template_matches_the_weekday() {
        let conn = test_conn();
        // Weekend-only routine (bit 0 = Sunday, bit 6 = Saturday).
        let weekend = upsert_template(
            &conn,
            &TemplateInputDto {
                id: None,
                name: "Weekend".into(),
                dow_mask: 0b1000001,
                is_active: true,
            },
        )
        .unwrap();
        upsert_template_block(&conn, &tblock(weekend, "10:00", 90, "Long read")).unwrap();

        assert_eq!(
            suggested_template(&conn, 0).unwrap().map(|t| t.id),
            Some(weekend),
            "Sunday matches bit 0"
        );
        assert!(suggested_template(&conn, 3).unwrap().is_none(), "Wednesday does not");

        // An inactive routine is never suggested.
        upsert_template(
            &conn,
            &TemplateInputDto {
                id: Some(weekend),
                name: "Weekend".into(),
                dow_mask: 0b1000001,
                is_active: false,
            },
        )
        .unwrap();
        assert!(suggested_template(&conn, 0).unwrap().is_none(), "inactive is skipped");

        // An EMPTY routine is never suggested either — applying it would look like a bug.
        let empty = upsert_template(
            &conn,
            &TemplateInputDto {
                id: None,
                name: "Empty".into(),
                dow_mask: 127,
                is_active: true,
            },
        )
        .unwrap();
        assert!(
            suggested_template(&conn, 0).unwrap().is_none(),
            "a routine with no blocks is not a suggestion"
        );
        let _ = empty;

        assert!(suggested_template(&conn, 7).is_err(), "weekday must be 0..=6");
    }

    /// Helper: a course node with `n` video materials of `mins` each.
    fn course_with_videos(conn: &Connection, name: &str, n: i64, mins: f64) -> i64 {
        let node = crate::db::queries::upsert_root_node(conn, name).unwrap();
        for i in 0..n {
            conn.execute(
                "INSERT INTO materials(node_id, file_path, file_name, file_type, file_extension,
                                       duration_secs)
                 VALUES(?1, ?2, ?3, 'video', 'mp4', ?4)",
                rusqlite::params![
                    node,
                    format!("/{name}/{i}.mp4"),
                    format!("{name} {i}"),
                    mins * 60.0
                ],
            )
            .unwrap();
        }
        node
    }

    fn exam_dto(name: &str, node: Option<i64>, date: &str, target: i64, revision: i64) -> ExamInputDto {
        ExamInputDto {
            id: None,
            name: name.to_string(),
            node_id: node,
            exam_date: date.to_string(),
            daily_target_mins: target,
            revision_days: revision,
            is_archived: false,
        }
    }

    /// A contract round-trip: commit, read back, resolve, read the verdict.
    #[test]
    fn focus_contract_round_trip() {
        let conn = test_conn();
        let id = upsert_block(&conn, &dto(DAY, "06:00", 60, "Physics", 2)).unwrap();

        assert!(focus_contract(&conn, id).unwrap().is_none(), "none by default");

        commit_focus(&conn, id, "  Finish chapter 4 problems  ").unwrap();
        let c = focus_contract(&conn, id).unwrap().unwrap();
        assert_eq!(c.intention, "Finish chapter 4 problems", "trimmed");
        assert_eq!(c.kept, None, "unresolved while the block is in flight");

        resolve_focus(&conn, id, true).unwrap();
        let c = focus_contract(&conn, id).unwrap().unwrap();
        assert_eq!(c.kept, Some(true));
        assert!(c.resolved_at.is_some());
    }

    /// An intention containing quotes must survive the round-trip. Formatting the JSON by hand
    /// would produce an invalid `meta` that reads back as an empty commitment.
    #[test]
    fn focus_contract_escapes_the_intention() {
        let conn = test_conn();
        let id = upsert_block(&conn, &dto(DAY, "06:00", 60, "Physics", 2)).unwrap();
        let tricky = r#"Read "Waves" ch.2 \ notes"#;
        commit_focus(&conn, id, tricky).unwrap();
        assert_eq!(focus_contract(&conn, id).unwrap().unwrap().intention, tricky);
    }

    /// An empty or overlong commitment is rejected — "done" has to actually be defined.
    #[test]
    fn focus_contract_requires_a_real_intention() {
        let conn = test_conn();
        let id = upsert_block(&conn, &dto(DAY, "06:00", 60, "Physics", 2)).unwrap();
        assert!(commit_focus(&conn, id, "   ").is_err());
        assert!(commit_focus(&conn, id, &"x".repeat(201)).is_err());
        assert!(commit_focus(&conn, id, &"x".repeat(200)).is_ok());
    }

    /// Re-committing SUPERSEDES an unresolved contract rather than appending: two live promises
    /// on one block would leave no answer to "what did you commit to?".
    #[test]
    fn recommitting_supersedes_an_unresolved_contract() {
        let conn = test_conn();
        let id = upsert_block(&conn, &dto(DAY, "06:00", 60, "Physics", 2)).unwrap();
        commit_focus(&conn, id, "First idea").unwrap();
        commit_focus(&conn, id, "Actually: ch.4 problems").unwrap();

        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM plan_events WHERE block_id = ?1 AND kind = 'committed'",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "only one live commitment");
        assert_eq!(
            focus_contract(&conn, id).unwrap().unwrap().intention,
            "Actually: ch.4 problems"
        );

        // Once RESOLVED, the record is history and must not be rewritten.
        resolve_focus(&conn, id, false).unwrap();
        commit_focus(&conn, id, "Try again tomorrow").unwrap();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM plan_events WHERE block_id = ?1 AND kind = 'committed'",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 2, "the resolved contract is preserved alongside the new one");
    }

    /// The keep-rate counts RESOLVED contracts only, and stays null until there's real signal.
    #[test]
    fn focus_record_needs_resolved_samples() {
        let conn = test_conn();
        let mut ids = Vec::new();
        for i in 0..4 {
            let id = upsert_block(
                &conn,
                &dto(DAY, &format!("{:02}:00", 6 + i), 60, &format!("B{i}"), 2),
            )
            .unwrap();
            commit_focus(&conn, id, "Do the thing").unwrap();
            ids.push(id);
        }

        // Committed but unanswered: no rate yet. Counting these as broken would punish blocks
        // still in flight; counting them as kept would flatter.
        let r = focus_record(&conn, DAY, 30).unwrap();
        assert_eq!(r.committed, 4);
        assert_eq!(r.keep_rate, None, "nothing resolved yet");

        resolve_focus(&conn, ids[0], true).unwrap();
        resolve_focus(&conn, ids[1], true).unwrap();
        assert_eq!(
            focus_record(&conn, DAY, 30).unwrap().keep_rate,
            None,
            "two answers is still a coin toss"
        );

        resolve_focus(&conn, ids[2], false).unwrap();
        let r = focus_record(&conn, DAY, 30).unwrap();
        assert_eq!(r.kept, 2);
        assert_eq!(r.broken, 1);
        assert_eq!(
            r.keep_rate.map(|v| v.round()),
            Some(67.0),
            "2 of 3 resolved, the unanswered one is excluded"
        );
    }

    /// Insert a run of consistency_log days ending on `last`, newest score last.
    /// `scores[i]` is the day `last - (len-1-i)`, so the slice reads chronologically.
    fn log_run(conn: &Connection, last: &str, scores: &[f64]) {
        let n = scores.len() as i64;
        for (i, score) in scores.iter().enumerate() {
            let offset = format!("-{} days", n - 1 - i as i64);
            conn.execute(
                "INSERT INTO consistency_log(day, tasks_due, score) VALUES(date(?1, ?2), 1, ?3)",
                rusqlite::params![last, offset, score],
            )
            .unwrap();
        }
    }

    /// Consistency earns forgiveness: 7 good days buys ONE bridged bad day, so a student who
    /// worked hard for a week and then got ill keeps their streak.
    #[test]
    fn streak_insurance_bridges_one_earned_bad_day() {
        let conn = test_conn();
        // 7 good, one bad, then 2 good — the bad day sits inside the streak.
        let mut scores = vec![80.0; 7];
        scores.push(10.0);
        scores.extend([80.0, 80.0]);
        log_run(&conn, DAY, &scores);

        let s = streak_status(&conn, DAY).unwrap();
        assert_eq!(s.raw_streak, 2, "the strict rule stops at the bad day");
        assert_eq!(s.streak, 9, "insurance bridges it: all 9 good days count");
        assert_eq!(s.insured_days.len(), 1);
        assert_eq!(s.insurance_left, 1, "one bridge still available");
    }

    /// Without enough good days behind it, a bad day ends the streak. Insurance is EARNED —
    /// otherwise it's just a weaker streak rule pretending to be a reward.
    #[test]
    fn streak_insurance_must_be_earned() {
        let conn = test_conn();
        // Only 3 good days before the bad one — short of the 7 needed.
        log_run(&conn, DAY, &[80.0, 80.0, 80.0, 10.0, 80.0, 80.0]);

        let s = streak_status(&conn, DAY).unwrap();
        assert_eq!(s.streak, 2, "the bad day is not bridged");
        assert_eq!(s.raw_streak, 2);
        assert!(s.insured_days.is_empty());
        assert_eq!(s.next_earned_in, 5, "2 good days so far, 7 needed");
    }

    /// Earning is progressive and capped: the second bridge costs 14 good days, and there is no
    /// third at any price. A streak that cannot be lost is not a streak.
    #[test]
    fn streak_insurance_is_progressive_and_capped() {
        let conn = test_conn();
        // 14 good, bad, 7 good, bad, 1 good. Walking back from today: 7 good then a bad day
        // (first bridge, needs 7 — affordable), then 14 more good and a second bad day (second
        // bridge, needs 14 — also affordable).
        let mut scores = vec![80.0; 14];
        scores.push(10.0);
        scores.extend(vec![80.0; 7]);
        scores.push(10.0);
        scores.push(80.0);
        log_run(&conn, DAY, &scores);

        let s = streak_status(&conn, DAY).unwrap();
        assert_eq!(s.insured_days.len(), 2, "both bad days bridged");
        assert_eq!(s.streak, 22, "14 + 7 + 1 good days");
        assert_eq!(s.insurance_left, 0, "the cap is reached");
        assert_eq!(s.next_earned_in, 0, "nothing more to earn");

        // A THIRD bad day breaks the streak no matter how much history precedes it, and the new
        // streak starts from scratch — insurance included. Consistency buys forgiveness twice,
        // never a permanently unbreakable number.
        let conn = test_conn();
        let mut scores = vec![80.0; 40];
        for _ in 0..3 {
            scores.push(10.0);
            scores.extend(vec![80.0; 8]);
        }
        log_run(&conn, DAY, &scores);
        let s = streak_status(&conn, DAY).unwrap();
        assert_eq!(
            s.streak, 8,
            "the third bad day ends it; only the 8 days since then count"
        );
        assert!(
            s.insured_days.is_empty(),
            "a fresh streak carries no bridged days from the broken one"
        );
        assert_eq!(s.insurance_left, INSURANCE_MAX, "and insurance resets with it");
    }

    /// A neutral day costs nothing: nothing was due, planned, or studied, so there is no evidence
    /// either way and no insurance is consumed.
    #[test]
    fn streak_skips_neutral_days_without_spending_insurance() {
        let conn = test_conn();
        // Two good days (today and -2), with a genuinely EMPTY day between them at -1.
        conn.execute(
            "INSERT INTO consistency_log(day, tasks_due, score) VALUES(?1, 1, 80.0)",
            [DAY],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO consistency_log(day, tasks_due, study_minutes, score, blocks_planned)
             VALUES(date(?1, '-1 days'), 0, 0, 0.0, 0)",
            [DAY],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO consistency_log(day, tasks_due, score) VALUES(date(?1, '-2 days'), 1, 80.0)",
            [DAY],
        )
        .unwrap();

        let s = streak_status(&conn, DAY).unwrap();
        assert_eq!(s.streak, 2, "the empty day is skipped, not bridged");
        assert_eq!(s.insured_days.len(), 0, "and costs no insurance");
        assert_eq!(s.raw_streak, 2, "nor does it break the strict streak");
    }

    /// No history at all is a zero streak, not an error.
    #[test]
    fn streak_handles_no_history() {
        let conn = test_conn();
        let s = streak_status(&conn, DAY).unwrap();
        assert_eq!(s.streak, 0);
        assert_eq!(s.raw_streak, 0);
        assert_eq!(s.insurance_left, INSURANCE_MAX);
        assert_eq!(s.next_earned_in, INSURANCE_EARN_EVERY);
    }

    /// Peak hours must be bucketed in LOCAL time. `started_at` is stored in UTC, so an offset
    /// has to rotate the histogram — otherwise a student in UTC+5:30 is told they peak five and a
    /// half hours from when they actually study, and would schedule their hardest work asleep.
    #[test]
    fn peak_hours_bucket_in_local_time() {
        let conn = test_conn();
        // 18:00 UTC.
        conn.execute(
            "INSERT INTO study_sessions(started_at, duration_secs, session_type)
             VALUES(datetime('now', '-1 days', 'start of day', '+18 hours'), 3600, 'work')",
            [],
        )
        .unwrap();

        let utc = peak_hours(&conn, 0, 30).unwrap();
        assert_eq!(utc.len(), 1);
        assert_eq!(utc[0].hour, 18, "UTC reads it at 18:00");
        assert!((utc[0].total_mins - 60.0).abs() < 0.01);

        // UTC+5:30 → 23:30 local, so the same session belongs to hour 23.
        let ist = peak_hours(&conn, 330, 30).unwrap();
        assert_eq!(ist[0].hour, 23, "the same instant is 23:30 in UTC+5:30");

        // UTC-8 → 10:00 local.
        let pst = peak_hours(&conn, -480, 30).unwrap();
        assert_eq!(pst[0].hour, 10);

        // A nonsense offset is rejected rather than silently rotating the histogram.
        assert!(peak_hours(&conn, 99_999, 30).is_err());
    }

    /// Breaks are not peaks: this measures focus, and a long break at 21:00 is not a good hour
    /// to schedule hard work in.
    #[test]
    fn peak_hours_ignore_breaks() {
        let conn = test_conn();
        conn.execute(
            "INSERT INTO study_sessions(started_at, duration_secs, session_type)
             VALUES(datetime('now', '-1 days'), 1800, 'short_break'),
                   (datetime('now', '-1 days'), 1800, 'long_break')",
            [],
        )
        .unwrap();
        assert!(peak_hours(&conn, 0, 30).unwrap().is_empty());
    }

    /// Exam CRUD round-trip, including the archived filter and input clamping.
    #[test]
    fn exam_crud_round_trip() {
        let conn = test_conn();
        let node = crate::db::queries::upsert_root_node(&conn, "Physics").unwrap();

        let id = upsert_exam(&conn, &exam_dto("  Finals  ", Some(node), "2026-09-01", 90, 3))
            .unwrap();
        let list = list_exams(&conn, false).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "Finals", "the name is trimmed");
        assert_eq!(list[0].node_name.as_deref(), Some("Physics"));

        // Archiving hides it from the default list without deleting anything.
        let mut edit = exam_dto("Finals", Some(node), "2026-09-01", 90, 3);
        edit.id = Some(id);
        edit.is_archived = true;
        upsert_exam(&conn, &edit).unwrap();
        assert!(list_exams(&conn, false).unwrap().is_empty(), "archived is hidden");
        assert_eq!(list_exams(&conn, true).unwrap().len(), 1, "but still there");

        delete_exam(&conn, id).unwrap();
        assert!(list_exams(&conn, true).unwrap().is_empty());
    }

    /// A malformed date is rejected rather than stored to produce a nonsense countdown forever.
    #[test]
    fn exam_rejects_bad_input() {
        let conn = test_conn();
        assert!(upsert_exam(&conn, &exam_dto("X", None, "01-09-2026", 60, 3)).is_err());
        assert!(upsert_exam(&conn, &exam_dto("   ", None, "2026-09-01", 60, 3)).is_err());

        // Out-of-range intentions are clamped, not rejected: the intent is obvious.
        let id = upsert_exam(&conn, &exam_dto("X", None, "2026-09-01", 99_999, 9_999)).unwrap();
        let e = list_exams(&conn, false).unwrap().into_iter().find(|e| e.id == id).unwrap();
        assert_eq!(e.daily_target_mins, 16 * 60);
        assert_eq!(e.revision_days, 60);
    }

    /// The core backward-planning maths: remaining content ÷ usable days, at the learned pace,
    /// with the revision tail withheld.
    #[test]
    fn exam_plan_projects_required_daily_minutes() {
        let conn = test_conn();
        // 10 lectures × 60 min = 600 minutes of content.
        let node = course_with_videos(&conn, "Physics", 10, 60.0);
        upsert_exam(&conn, &exam_dto("Finals", Some(node), "2026-08-14", 60, 3)).unwrap();

        // From 2026-07-31 that's 14 days out, minus 3 revision days = 11 study days.
        let plan = &exam_plans(&conn, DAY).unwrap()[0];
        assert_eq!(plan.days_until, 14);
        assert_eq!(plan.study_days, 11);
        assert_eq!(plan.remaining_items, 10);
        assert_eq!(plan.remaining_mins, 600, "pace 1.0 until anything is learned");
        assert_eq!(plan.required_daily_mins, 55, "600 / 11, rounded up");
        assert!(plan.on_track, "55 <= the 60/day the student intends");

        // A slower learned pace inflates the honest workload — this is the whole point of
        // feeding velocity into the projection rather than trusting raw content length.
        record_velocity(&conn, node, 90.0, 60.0).unwrap();
        let plan = &exam_plans(&conn, DAY).unwrap()[0];
        assert_eq!(plan.remaining_mins, 900, "600 content minutes at 1.5x");
        assert_eq!(plan.required_daily_mins, 82, "900 / 11, rounded up");
        assert!(!plan.on_track, "82 > 60 — the student needs to know now");
        assert!(plan.message.contains("82m") || plan.message.contains("1h 22m"));
    }

    /// Partial progress must COUNT. A 60-minute lecture watched to 40 leaves 20 minutes, not 60 —
    /// otherwise every projection over-states the work and the feature cries wolf.
    #[test]
    fn exam_plan_credits_partial_progress() {
        let conn = test_conn();
        let node = course_with_videos(&conn, "Physics", 2, 60.0);
        upsert_exam(&conn, &exam_dto("Finals", Some(node), "2026-08-11", 60, 0)).unwrap();

        let before = exam_plans(&conn, DAY).unwrap()[0].remaining_mins;
        assert_eq!(before, 120);

        // Watch 40 of the first lecture's 60 minutes.
        let mid: i64 = conn
            .query_row("SELECT MIN(id) FROM materials", [], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO watch_progress(material_id, position_secs, duration_secs)
             VALUES(?1, 2400, 3600)",
            [mid],
        )
        .unwrap();

        let plan = &exam_plans(&conn, DAY).unwrap()[0];
        assert_eq!(plan.remaining_mins, 80, "only the unwatched 20 + the untouched 60");
        assert_eq!(plan.remaining_items, 2, "still two items in flight");

        // Completing it removes it from the syllabus entirely.
        conn.execute("UPDATE materials SET is_completed = 1 WHERE id = ?1", [mid])
            .unwrap();
        let plan = &exam_plans(&conn, DAY).unwrap()[0];
        assert_eq!(plan.remaining_items, 1);
        assert_eq!(plan.remaining_mins, 60);
    }

    /// Items with no known duration are not free work — they get a conservative placeholder.
    #[test]
    fn exam_plan_estimates_unknown_durations() {
        let conn = test_conn();
        let node = crate::db::queries::upsert_root_node(&conn, "Notes").unwrap();
        conn.execute(
            "INSERT INTO materials(node_id, file_path, file_name, file_type, file_extension)
             VALUES(?1, '/n/a.pdf', 'a.pdf', 'pdf', 'pdf')",
            [node],
        )
        .unwrap();
        upsert_exam(&conn, &exam_dto("Finals", Some(node), "2026-08-11", 60, 0)).unwrap();

        let plan = &exam_plans(&conn, DAY).unwrap()[0];
        assert_eq!(plan.remaining_mins, 10, "a PDF with no page count is not zero work");
    }

    /// Out of study days, the verdict switches from coverage to triage rather than dividing by
    /// zero or quietly reporting "0 a day".
    #[test]
    fn exam_plan_handles_running_out_of_time() {
        let conn = test_conn();
        let node = course_with_videos(&conn, "Physics", 5, 60.0);
        // Exam in 2 days with a 3-day revision tail → zero usable study days.
        upsert_exam(&conn, &exam_dto("Finals", Some(node), "2026-08-02", 60, 3)).unwrap();

        let plan = &exam_plans(&conn, DAY).unwrap()[0];
        assert!(plan.out_of_time);
        assert_eq!(plan.study_days, 0);
        assert!(!plan.on_track);
        assert_eq!(plan.required_daily_mins, 300, "all of it, with no days to spread it");
        assert!(plan.message.contains("triage"));
    }

    /// A finished syllabus says so, and a past exam says that instead of projecting work.
    #[test]
    fn exam_plan_reports_covered_and_past() {
        let conn = test_conn();
        let node = course_with_videos(&conn, "Physics", 1, 60.0);
        conn.execute("UPDATE materials SET is_completed = 1", []).unwrap();
        upsert_exam(&conn, &exam_dto("Finals", Some(node), "2026-08-14", 60, 3)).unwrap();

        let plan = &exam_plans(&conn, DAY).unwrap()[0];
        assert_eq!(plan.remaining_items, 0);
        assert!(plan.message.contains("revision"));

        // A past exam is reported as past, not as a workload.
        let past = upsert_exam(&conn, &exam_dto("Mock", Some(node), "2026-07-01", 60, 0)).unwrap();
        let plans = exam_plans(&conn, DAY).unwrap();
        let p = plans.iter().find(|p| p.exam.id == past).unwrap();
        assert!(p.days_until < 0);
        assert!(p.message.contains("passed"));
    }

    /// An exam with no course attached still counts down, but must not pretend to project work.
    #[test]
    fn exam_plan_without_a_course_projects_nothing() {
        let conn = test_conn();
        upsert_exam(&conn, &exam_dto("Unknown", None, "2026-08-14", 60, 3)).unwrap();
        let plan = &exam_plans(&conn, DAY).unwrap()[0];
        assert_eq!(plan.days_until, 14);
        assert_eq!(plan.remaining_mins, 0);
        assert!(plan.message.contains("No course linked"));
    }

    /// v10's real payoff: a block feeding a dated exam earns the solver's urgency multiplier.
    /// Ancestors count, because an exam is set on "Physics" while blocks target a chapter under
    /// it — matching only the exact node would leave real blocks unlinked and the 1.5x dead.
    #[test]
    fn exam_linkage_reaches_the_solver_through_descendants() {
        let conn = test_conn();
        let physics = crate::db::queries::upsert_root_node(&conn, "Physics").unwrap();
        let chapter =
            crate::db::queries::upsert_child_node(&conn, physics, "Waves").unwrap();
        let unrelated = crate::db::queries::upsert_root_node(&conn, "History").unwrap();

        let mut linked = dto(DAY, "06:00", 60, "Waves revision", 2);
        linked.target_kind = "node_minutes".into();
        linked.target_node_id = Some(chapter);
        upsert_block(&conn, &linked).unwrap();

        let mut other = dto(DAY, "08:00", 60, "History reading", 2);
        other.target_kind = "node_minutes".into();
        other.target_node_id = Some(unrelated);
        upsert_block(&conn, &other).unwrap();

        // No exam yet → nothing is urgent.
        let snap = build_day_snapshot(&conn, DAY).unwrap();
        assert!(snap.blocks.iter().all(|b| !b.exam_linked));

        upsert_exam(&conn, &exam_dto("Finals", Some(physics), "2026-08-14", 60, 3)).unwrap();
        let snap = build_day_snapshot(&conn, DAY).unwrap();
        let waves = snap.blocks.iter().find(|b| b.title == "Waves revision").unwrap();
        let history = snap.blocks.iter().find(|b| b.title == "History reading").unwrap();
        assert!(waves.exam_linked, "a chapter under the exam's course is exam work");
        assert!(!history.exam_linked, "an unrelated course is not");
        assert!(
            waves.value() > history.value(),
            "exam work must outrank equal-weight non-exam work in triage"
        );

        // A PAST exam stops conferring urgency on its own.
        let conn2 = test_conn();
        let n = crate::db::queries::upsert_root_node(&conn2, "Physics").unwrap();
        let mut b = dto(DAY, "06:00", 60, "Revision", 2);
        b.target_kind = "node_minutes".into();
        b.target_node_id = Some(n);
        upsert_block(&conn2, &b).unwrap();
        upsert_exam(&conn2, &exam_dto("Old", Some(n), "2026-07-01", 60, 0)).unwrap();
        let snap = build_day_snapshot(&conn2, DAY).unwrap();
        assert!(!snap.blocks[0].exam_linked, "a finished exam is not urgent");
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
