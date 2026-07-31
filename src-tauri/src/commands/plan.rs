//! IPC commands for the Planning / Scheduling / Intelligence system (v9).
//!
//! Follows the established pattern: `db: State<Db>`, work inside `db.with` / `db.with_mut`,
//! return `AppResult<T>`. Registered in `lib.rs`.
//!
//! ## Local time crosses the IPC boundary explicitly
//!
//! Every command that needs "today" or "now" takes it as a parameter from the frontend rather
//! than calling SQLite's UTC `date('now')`. The planner is local-wall-clock throughout (a
//! student who plans "6:00 AM" means their 6 AM), and a backend that guessed the local day
//! would mis-file late-evening study for anyone east or west of UTC. The frontend already knows
//! the real local date; it passes it.
//!
//! ## Reads never write
//!
//! [`recovery_plans`] is deliberately read-only so the UI can compute and preview options
//! freely. Nothing is committed until the student taps Apply, which calls [`apply_recovery`]
//! and gets an undo token back.

use tauri::State;

use crate::db::plan::{self, BlockInputDto, DayPlan, PlanBlock};
use crate::db::queries::{self, ScoreWindow};
use crate::db::Db;
use crate::planner::solver::RecoveryReport;
use crate::utils::errors::{AppError, AppResult};

/// Guard against a malformed `day` reaching the queries. `YYYY-MM-DD` only — a loose string
/// would silently create a phantom day row that never matches anything the UI reads back.
fn validate_day(day: &str) -> AppResult<()> {
    let b = day.as_bytes();
    let shaped = b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b
            .iter()
            .enumerate()
            .all(|(i, c)| matches!(i, 4 | 7) || c.is_ascii_digit());
    if shaped {
        Ok(())
    } else {
        Err(AppError::Invalid(format!(
            "invalid day '{day}' (want YYYY-MM-DD)"
        )))
    }
}

/// Minutes since local midnight must be a real time of day.
fn validate_now(now_mins: i64) -> AppResult<i32> {
    if (0..24 * 60).contains(&now_mins) {
        Ok(now_mins as i32)
    } else {
        Err(AppError::Invalid(format!(
            "now_mins {now_mins} out of range (0..1440)"
        )))
    }
}

/// The full Today payload: window, blocks, and the advisory pre-mortem verdict.
#[tauri::command]
pub fn plan_day(db: State<'_, Db>, day: String) -> AppResult<DayPlan> {
    validate_day(&day)?;
    db.with(|conn| plan::day_plan(conn, &day))
}

/// Create or update a time block. Returns its id.
#[tauri::command]
pub fn upsert_plan_block(db: State<'_, Db>, block: BlockInputDto) -> AppResult<i64> {
    validate_day(&block.day)?;
    db.with(|conn| plan::upsert_block(conn, &block))
}

/// Delete a block outright (distinct from skipping it, which preserves the record).
#[tauri::command]
pub fn delete_plan_block(db: State<'_, Db>, id: i64) -> AppResult<()> {
    db.with(|conn| plan::delete_block(conn, id))
}

/// Set a block's status. Re-snapshots the day so the score reflects the change immediately —
/// the same cheap single-upsert pattern `set_task_done` already uses.
#[tauri::command]
pub fn set_plan_block_status(
    db: State<'_, Db>,
    id: i64,
    status: String,
    executed_mins: Option<f64>,
    day: Option<String>,
) -> AppResult<()> {
    if let Some(d) = day.as_deref() {
        validate_day(d)?;
    }
    db.with(|conn| {
        plan::set_block_status(conn, id, &status, executed_mins)?;
        // Snapshot the block's OWN day, not "today": confirming yesterday's unfinished block
        // during the end-of-day review must update yesterday's score, not today's.
        let target = match day.as_deref() {
            Some(d) => d.to_string(),
            None => plan::get_block(conn, id)?.day,
        };
        let _ = queries::snapshot_day(conn, &target);
        Ok(())
    })
}

/// Mark a block as started (at most one is active at a time).
#[tauri::command]
pub fn start_plan_block(db: State<'_, Db>, id: i64) -> AppResult<()> {
    db.with(|conn| plan::start_block(conn, id))
}

/// The block currently in progress, if any. Lets the UI bind the Pomodoro ring and attribute
/// playback without re-deriving state on the frontend.
#[tauri::command]
pub fn active_plan_block(db: State<'_, Db>) -> AppResult<Option<PlanBlock>> {
    db.with(|conn| plan::active_block(conn))
}

/// Set (or clear) a day's wake / hard-stop overrides.
///
/// Per-day overrides matter: a student may legitimately study late on a Saturday, and forcing a
/// single global bedtime would either block that or push every weekday too late. `None` clears
/// the override and falls back to the global setting.
#[tauri::command]
pub fn set_plan_day_window(
    db: State<'_, Db>,
    day: String,
    wake_at: Option<String>,
    hard_stop_at: Option<String>,
) -> AppResult<()> {
    validate_day(&day)?;
    db.with(|conn| plan::set_day_window(conn, &day, wake_at.as_deref(), hard_stop_at.as_deref()))
}

/// Compute recovery options for a day. READ-ONLY — nothing is mutated, so the UI may call this
/// as often as it likes and preview freely.
#[tauri::command]
pub fn recovery_plans(db: State<'_, Db>, day: String, now_mins: i64) -> AppResult<RecoveryReport> {
    validate_day(&day)?;
    let now = validate_now(now_mins)?;
    db.with(|conn| plan::recovery_report(conn, &day, now))
}

/// Apply one recovery plan in a single transaction. Returns an undo token.
///
/// `next_day` is supplied by the caller (local calendar arithmetic, including month/year
/// rollover, belongs on the side that knows the user's timezone) and is where dropped blocks
/// spill to. Blocks are never deleted by an adjustment.
#[tauri::command]
pub fn apply_recovery(
    db: State<'_, Db>,
    day: String,
    plan_id: String,
    now_mins: i64,
    next_day: String,
) -> AppResult<String> {
    validate_day(&day)?;
    validate_day(&next_day)?;
    let now = validate_now(now_mins)?;
    db.with_mut(|conn| {
        let token = plan::apply_recovery(conn, &day, &plan_id, now, &next_day)?;
        let _ = queries::snapshot_day(conn, &day);
        Ok(token)
    })
}

/// Revert the most recently applied recovery for a day.
#[tauri::command]
pub fn undo_recovery(db: State<'_, Db>, token: String) -> AppResult<()> {
    db.with_mut(|conn| {
        plan::undo_recovery(conn, &token)?;
        if let Some(day) = token.split(':').next() {
            let _ = queries::snapshot_day(conn, day);
        }
        Ok(())
    })
}

/// Record that the student dismissed the recovery card for a day.
///
/// Persisted rather than held in memory: this is what enforces "one prompt per drift event".
/// Without it, navigating back to Today would re-open the card they just declined.
#[tauri::command]
pub fn dismiss_recovery(db: State<'_, Db>, day: String) -> AppResult<()> {
    validate_day(&day)?;
    db.with(|conn| plan::dismiss_recovery(conn, &day))
}

/// Generate a day's blocks from a routine template. Returns how many were created.
#[tauri::command]
pub fn apply_plan_template(db: State<'_, Db>, template_id: i64, day: String) -> AppResult<i64> {
    validate_day(&day)?;
    db.with(|conn| plan::apply_template(conn, template_id, &day))
}

/// Reconcile every past day from the caller's LOCAL date, then re-snapshot.
///
/// The boot pass in `lib.rs` uses SQLite's UTC date as a conservative approximation; the
/// frontend calls this once on load with the true local date to finish the job correctly.
#[tauri::command]
pub fn reconcile_plan(db: State<'_, Db>, today: String) -> AppResult<i64> {
    validate_day(&today)?;
    db.with(|conn| {
        let n = plan::reconcile_plan_days(conn, &today)?;
        let _ = queries::snapshot_day(conn, &today);
        Ok(n)
    })
}

/// The score drill-down: Today / Week / Month / Rolling-90.
///
/// There is intentionally no lifetime "Overall" figure — after a bad month it becomes
/// mathematically unrecoverable, turning feedback into a permanent indictment. Rolling-90 always
/// recovers.
#[tauri::command]
pub fn score_summary(db: State<'_, Db>) -> AppResult<Vec<ScoreWindow>> {
    db.with(|conn| queries::score_summary(conn))
}
