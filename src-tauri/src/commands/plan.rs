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

use crate::db::plan::{
    self, BlockInputDto, DayPlan, Exam, ExamInputDto, ExamPlan, FocusContract, FocusRecord,
    PeakHour, PlanBlock, PlanTemplate,
    PlanTemplateBlock, ReminderState, StreakStatus, TemplateBlockInputDto, TemplateInputDto,
};
use crate::db::queries::{self, ScoreWindow};
use crate::db::Db;
use crate::planner::solver::RecoveryReport;
use crate::utils::errors::{AppError, AppResult};

/// Guard against a malformed `day` reaching the queries. `YYYY-MM-DD` only — a loose string
/// would silently create a phantom day row that never matches anything the UI reads back.
pub(crate) fn validate_day(day: &str) -> AppResult<()> {
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

// ── Routine templates ────────────────────────────────────────────────────────

/// All routines, with block counts.
#[tauri::command]
pub fn list_plan_templates(db: State<'_, Db>) -> AppResult<Vec<PlanTemplate>> {
    db.with(|conn| plan::list_templates(conn))
}

/// One routine's blocks, in routine order.
#[tauri::command]
pub fn plan_template_blocks(
    db: State<'_, Db>,
    template_id: i64,
) -> AppResult<Vec<PlanTemplateBlock>> {
    db.with(|conn| plan::template_blocks(conn, template_id))
}

/// Create or update a routine. Returns its id.
#[tauri::command]
pub fn upsert_plan_template(db: State<'_, Db>, template: TemplateInputDto) -> AppResult<i64> {
    db.with(|conn| plan::upsert_template(conn, &template))
}

/// Delete a routine. Days already generated from it keep their blocks.
#[tauri::command]
pub fn delete_plan_template(db: State<'_, Db>, id: i64) -> AppResult<()> {
    db.with(|conn| plan::delete_template(conn, id))
}

/// Create or update one block inside a routine.
#[tauri::command]
pub fn upsert_plan_template_block(
    db: State<'_, Db>,
    block: TemplateBlockInputDto,
) -> AppResult<i64> {
    db.with(|conn| plan::upsert_template_block(conn, &block))
}

/// Delete one block from a routine.
#[tauri::command]
pub fn delete_plan_template_block(db: State<'_, Db>, id: i64) -> AppResult<()> {
    db.with(|conn| plan::delete_template_block(conn, id))
}

/// Capture a day's blocks as a reusable routine. Returns the new template id.
#[tauri::command]
pub fn save_day_as_template(
    db: State<'_, Db>,
    day: String,
    name: String,
    dow_mask: i64,
) -> AppResult<i64> {
    validate_day(&day)?;
    db.with(|conn| plan::save_day_as_template(conn, &day, &name, dow_mask))
}

/// The routine matching `weekday` (0 = Sunday), if any.
///
/// `weekday` comes from the frontend rather than SQLite's `strftime('%w')`, which is UTC and
/// would suggest tomorrow's routine late in the evening.
#[tauri::command]
pub fn suggested_plan_template(
    db: State<'_, Db>,
    weekday: i64,
) -> AppResult<Option<PlanTemplate>> {
    db.with(|conn| plan::suggested_template(conn, weekday))
}

// ── Focus contract ───────────────────────────────────────────────────────────

/// Record what "done" means for a block, before starting it. Supersedes any unresolved
/// commitment on the same block.
#[tauri::command]
pub fn commit_focus(db: State<'_, Db>, block_id: i64, intention: String) -> AppResult<()> {
    db.with(|conn| plan::commit_focus(conn, block_id, &intention))
}

/// Record whether the commitment was kept. SELF-REPORTED by design — "did I do what I said?"
/// isn't observable from playback, and inferring it from minutes would score the wrong thing.
#[tauri::command]
pub fn resolve_focus(db: State<'_, Db>, block_id: i64, kept: bool) -> AppResult<()> {
    db.with(|conn| plan::resolve_focus(conn, block_id, kept))
}

/// The commitment for one block, if any.
#[tauri::command]
pub fn focus_contract(db: State<'_, Db>, block_id: i64) -> AppResult<Option<FocusContract>> {
    db.with(|conn| plan::focus_contract(conn, block_id))
}

/// Keep-rate over the trailing `days`. `today` is the caller's LOCAL date.
#[tauri::command]
pub fn focus_record(db: State<'_, Db>, today: String, days: Option<i64>) -> AppResult<FocusRecord> {
    validate_day(&today)?;
    let window = days.unwrap_or(30);
    db.with(|conn| plan::focus_record(conn, &today, window))
}

/// The current streak, with earned bad days bridged.
///
/// Purely derived from `consistency_log`, so the same history always yields the same number —
/// there is no spendable token to persist and no way to farm one by opening the app on the right
/// day. `today` is the caller's LOCAL date.
#[tauri::command]
pub fn streak_status(db: State<'_, Db>, today: String) -> AppResult<StreakStatus> {
    validate_day(&today)?;
    db.with(|conn| plan::streak_status(conn, &today))
}

/// Focus-by-hour over the trailing `days`, in the caller's LOCAL time.
///
/// `utc_offset_mins` is required, not optional: `study_sessions.started_at` is stored in UTC, so
/// bucketing by `strftime('%H')` alone would tell a student in UTC+5:30 that they peak five and a
/// half hours from when they actually study.
#[tauri::command]
pub fn peak_hours(
    db: State<'_, Db>,
    utc_offset_mins: i64,
    days: Option<i64>,
) -> AppResult<Vec<PeakHour>> {
    let window = days.unwrap_or(60);
    db.with(|conn| plan::peak_hours(conn, utc_offset_mins, window))
}

// ── Exams & backward planning (v10) ──────────────────────────────────────────

/// All exams, soonest first. Archived ones are excluded unless asked for.
#[tauri::command]
pub fn list_exams(db: State<'_, Db>, include_archived: Option<bool>) -> AppResult<Vec<Exam>> {
    let all = include_archived.unwrap_or(false);
    db.with(|conn| plan::list_exams(conn, all))
}

/// Create or update an exam. Returns its id.
#[tauri::command]
pub fn upsert_exam(db: State<'_, Db>, exam: ExamInputDto) -> AppResult<i64> {
    db.with(|conn| plan::upsert_exam(conn, &exam))
}

/// Delete an exam. Blocks already scheduled for it are kept — the work still happened.
#[tauri::command]
pub fn delete_exam(db: State<'_, Db>, id: i64) -> AppResult<()> {
    db.with(|conn| plan::delete_exam(conn, id))
}

/// Backward plans for every active exam, as of the caller's LOCAL `today`.
///
/// Derived on read, never stored: materials are added, watched and completed constantly, so a
/// cached projection would be wrong within a day.
#[tauri::command]
pub fn exam_plans(db: State<'_, Db>, today: String) -> AppResult<Vec<ExamPlan>> {
    validate_day(&today)?;
    db.with(|conn| plan::exam_plans(conn, &today))
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
/// `today` is the caller's LOCAL date — see `queries::score_window` for why it isn't `date('now')`.
#[tauri::command]
pub fn score_summary(db: State<'_, Db>, today: String) -> AppResult<Vec<ScoreWindow>> {
    validate_day(&today)?;
    db.with(|conn| queries::score_summary(conn, &today))
}

// ── Durable reminder ledger ──────────────────────────────────────────────────
//
// The reminder engine's dedupe used to live only in `toastStore`'s in-memory cooldown map, so
// every reminder re-fired after a restart. These five commands move that state into SQLite.
// `now_iso` / `snooze_to` are LOCAL wall-clock strings from the frontend for the same reason
// every other planner command takes `day`: SQLite's `datetime('now')` is UTC and would arm
// reminders at the wrong hour.

/// Atomically claim a reminder. `true` only for the caller that gets to fire it.
///
/// The claim is one upsert rather than a read-then-write, so two clock ticks racing the same key
/// cannot both fire it. A claim is re-granted only once an active snooze has elapsed.
#[tauri::command]
pub fn claim_reminder(db: State<'_, Db>, key: String, now_iso: String) -> AppResult<bool> {
    db.with(|conn| plan::claim_reminder(conn, &key, &now_iso))
}

/// Ledger rows whose key starts with `prefix` (e.g. `block-42-`), newest first.
#[tauri::command]
pub fn list_reminders(db: State<'_, Db>, prefix: String) -> AppResult<Vec<ReminderState>> {
    db.with(|conn| plan::list_reminders(conn, &prefix))
}

/// Mark a reminder acknowledged — the student acted on it, so it must never fire again.
#[tauri::command]
pub fn ack_reminder(db: State<'_, Db>, key: String) -> AppResult<()> {
    db.with(|conn| plan::ack_reminder(conn, &key))
}

/// Snooze a reminder until `snooze_to` (local wall clock). It becomes claimable again after.
#[tauri::command]
pub fn snooze_reminder(db: State<'_, Db>, key: String, snooze_to: String) -> AppResult<()> {
    db.with(|conn| plan::snooze_reminder(conn, &key, &snooze_to))
}

/// Drop ledger rows older than `keep_days`, returning how many were removed. Rows with a snooze
/// still pending survive regardless of age — pruning one would resurface it immediately.
#[tauri::command]
pub fn prune_reminders(db: State<'_, Db>, keep_days: i64) -> AppResult<i64> {
    db.with(|conn| plan::prune_reminders(conn, keep_days))
}
