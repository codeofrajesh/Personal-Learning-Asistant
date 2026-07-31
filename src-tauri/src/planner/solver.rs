//! The Intelligent Adjustment solver — a **pure function** over a day's plan.
//!
//! Given a snapshot of today's blocks and the current wall-clock minute, this produces two
//! or three *named, previewable* recovery plans. It never mutates anything, never touches the
//! database, and never reads the clock. `db::plan` reads the snapshot under the connection
//! mutex, releases it, then calls in here; for a realistic day (n ≈ 10–25 blocks) the whole
//! thing runs in single-digit microseconds, so it never needs to be async, spawned, or cached.
//!
//! ## Why propose instead of auto-reschedule
//!
//! Tools that silently rewrite the day (Motion et al.) lose user trust fast: the plan mutates
//! while you aren't looking, and you stop believing the calendar. For a student who just woke
//! up late, a silently-rewritten day is indistinguishable from the app having lost their plan.
//! So this module's contract is: **emit options, explain the consequence of each, change
//! nothing.** The caller applies exactly one, in one transaction, with an undo token.
//!
//! ## The three strategies
//!
//! * [`PlanKind::Cascade`]  — push everything back in order; drop from the tail what no longer
//!   fits. Preserves the student's intended sequence, sacrifices the evening.
//! * [`PlanKind::Triage`]   — greedy 0/1 knapsack on value density. Protects what matters,
//!   drops the rest. Usually recommended.
//! * [`PlanKind::Compress`] — scale every block toward its viable floor. Preserves breadth,
//!   sacrifices depth. Right for revision, wrong for first-pass lectures.
//!
//! When everything still fits in the remaining time, only Cascade is produced: nothing needs
//! to be cut, and offering the student a "choose what to sacrifice" dialog for a 20-minute
//! sleep-in would be its own kind of bad UX.

use serde::Serialize;

use super::{fmt_duration, fmt_hhmm, MINUTES_PER_DAY};

// ── Inputs ───────────────────────────────────────────────────────────────────

/// Lifecycle state of a block, as far as the solver cares.
///
/// Only `Pending` and `Active` participate in adjustment: a block that is already done,
/// skipped or spilled is history, and history is not rescheduled.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BlockState {
    Pending,
    Active,
    Done,
    Partial,
    Skipped,
    Spilled,
}

impl BlockState {
    /// Parse the DB's `plan_blocks.status` text. Unknown values are treated as `Pending`
    /// (the safe default: an unrecognized block is still offered to the student rather than
    /// silently vanishing from their day).
    pub fn from_db(s: &str) -> Self {
        match s {
            "active" => Self::Active,
            "done" => Self::Done,
            "partial" => Self::Partial,
            "skipped" => Self::Skipped,
            "spilled" => Self::Spilled,
            _ => Self::Pending,
        }
    }

    /// Whether this block is still open work that adjustment should consider.
    pub fn is_open(self) -> bool {
        matches!(self, Self::Pending | Self::Active)
    }
}

/// One block as the solver sees it. All times are local minutes-since-midnight.
#[derive(Debug, Clone)]
pub struct BlockInput {
    pub id: i64,
    pub title: String,
    /// Current scheduled start (the adjusted `actual_start` if one exists, else `planned_start`).
    pub start_mins: i32,
    /// Current scheduled duration (`actual_mins` if adjusted, else `planned_mins`).
    pub planned_mins: i32,
    /// 0 none / 1 low / 2 medium / 3 high.
    pub weight: i32,
    /// An anchored block cannot move (a live class, a coaching slot). Without this flag,
    /// cascade produces nonsense — it would happily shove a 9 AM lecture to 3 PM.
    pub is_anchored: bool,
    /// Explicit floor below which doing this block is pointless. `None` → derived (see
    /// [`BlockInput::min_viable`]).
    pub min_viable_mins: Option<i32>,
    pub state: BlockState,
    /// Minutes already executed against this block (from `study_sessions` attribution).
    pub executed_mins: f64,
    /// How many times this block has already been pushed to a later day. Promotes chronically
    /// avoided work in triage so the one subject the student dislikes can't be dodged forever.
    pub spill_count: i32,
    /// Learned pace for this block's target course (EWMA of wall-minutes / content-minutes).
    /// 1.0 = real-time; 1.6 = needs 96 min of clock for 60 min of lecture.
    pub pace_ratio: f64,
    /// Whether this block feeds a dated exam goal (bumps its triage value).
    pub exam_linked: bool,
}

impl BlockInput {
    /// The honest duration: the plan multiplied by this student's observed pace. This is what
    /// turns the planner from aspirational into realistic — a 60-minute lecture for someone
    /// who pauses and takes notes genuinely costs ~90 minutes.
    pub fn effective_mins(&self) -> i32 {
        let raw = (self.planned_mins as f64 * self.pace_ratio.clamp(0.25, 4.0)).round() as i32;
        raw.clamp(1, MINUTES_PER_DAY)
    }

    /// Minutes still outstanding, accounting for work already logged against the block.
    /// A block that is 40 minutes into a 60-minute plan only needs 20 more.
    pub fn remaining_mins(&self) -> i32 {
        let done = self.executed_mins.max(0.0).round() as i32;
        (self.effective_mins() - done).max(1)
    }

    /// The floor below which doing this block is worthless. Explicit value wins; otherwise
    /// half the effective duration, never under 10 minutes (below that, setup cost dominates).
    pub fn min_viable(&self) -> i32 {
        let derived = ((self.effective_mins() as f64) * 0.5).round() as i32;
        self.min_viable_mins
            .unwrap_or_else(|| derived.max(10))
            .clamp(1, self.remaining_mins().max(1))
    }

    /// Triage value. Priority must *dominate* rather than act as a tiebreak, so weight enters
    /// squared: None→1, Low→4, Medium→9, High→16.
    ///
    /// Deviation from the original design note (`weight²`) is deliberate: a literal `weight²`
    /// makes a priority-0 block worth exactly 0, which means it can never be admitted and
    /// contributes nothing to coverage — it would silently disappear from every plan and from
    /// the "% of today" figure. `(weight + 1)²` keeps the same ~16× spread while giving
    /// unprioritized work a real, if small, voice.
    pub fn value(&self) -> f64 {
        let base = ((self.weight.clamp(0, 3) + 1) as f64).powi(2);
        let exam = if self.exam_linked { 1.5 } else { 1.0 };
        let spill = 1.0 + 0.5 * (self.spill_count.clamp(0, 6) as f64);
        base * exam * spill
    }

    /// Value per minute — the greedy admission key.
    pub fn density(&self) -> f64 {
        self.value() / (self.min_viable().max(1) as f64)
    }

    /// Scheduled end of the block at its current position.
    pub fn end_mins(&self) -> i32 {
        self.start_mins + self.planned_mins
    }
}

/// Tunables for the capacity model. Defaults encode "what actually happens" rather than
/// "what a spreadsheet says fits".
#[derive(Debug, Clone, Copy)]
pub struct AdjustPrefs {
    /// Context-switch cost charged per kept block. Switching subjects is never free.
    pub transition_mins: i32,
    /// Nobody executes 100% of a raw window. Discounting is the difference between a planner
    /// that is usually right and one the student learns to ignore.
    pub fatigue_factor: f64,
}

impl Default for AdjustPrefs {
    fn default() -> Self {
        Self {
            transition_mins: 5,
            fatigue_factor: 0.85,
        }
    }
}

/// Everything the solver needs about one day. Assembled by `db::plan` under the mutex, then
/// handed over as plain data.
#[derive(Debug, Clone)]
pub struct DaySnapshot {
    pub day: String,
    /// Start of the usable window (local minutes since midnight).
    pub wake_mins: i32,
    /// Never schedule past this. Per-day value, falling back to the global setting.
    pub hard_stop_mins: i32,
    pub blocks: Vec<BlockInput>,
    pub prefs: AdjustPrefs,
}

// ── Outputs ──────────────────────────────────────────────────────────────────

/// What a plan does to one block.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MoveAction {
    /// Unchanged — same start, same duration.
    Keep,
    /// Same duration, later start.
    Shift,
    /// Shortened (possibly also moved).
    Compress,
    /// Cut from today. Never deleted — the caller spills it to the next day.
    Drop,
}

/// One block's fate under a plan. `from_*` / `to_*` are both included so the UI can render a
/// literal diff ("Physics 6:00 → 7:00") without recomputing anything.
#[derive(Debug, Clone, Serialize)]
pub struct BlockMove {
    pub block_id: i64,
    pub title: String,
    pub action: MoveAction,
    pub from_start: String,
    pub to_start: String,
    pub from_mins: i32,
    pub to_mins: i32,
}

/// Which strategy produced a plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PlanKind {
    Cascade,
    Triage,
    Compress,
}

impl PlanKind {
    /// Stable identifier used by `apply_recovery` to re-derive the plan server-side rather
    /// than trusting a client-sent diff.
    pub fn id(self) -> &'static str {
        match self {
            Self::Cascade => "cascade",
            Self::Triage => "triage",
            Self::Compress => "compress",
        }
    }

    pub fn from_id(s: &str) -> Option<Self> {
        match s {
            "cascade" => Some(Self::Cascade),
            "triage" => Some(Self::Triage),
            "compress" => Some(Self::Compress),
            _ => None,
        }
    }

    /// Short human label for the Recovery Card.
    pub fn label(self) -> &'static str {
        match self {
            Self::Cascade => "Push everything back",
            Self::Triage => "Protect priorities",
            Self::Compress => "Compress all evenly",
        }
    }
}

/// One previewable recovery option.
#[derive(Debug, Clone, Serialize)]
pub struct RecoveryPlan {
    pub id: String,
    pub kind: PlanKind,
    pub label: String,
    /// One-line consequence in *content* terms ("Chemistry won't fit"), never "3 changes".
    pub summary: String,
    /// Fraction of today's weighted value retained — rendered as "reaches 91% of today".
    pub coverage: f64,
    /// 1.0 unless an anchored commitment had to be abandoned (its window already passed).
    pub integrity: f64,
    /// Penalizes leaving large idle gaps between kept blocks.
    pub continuity: f64,
    /// Ranking score: `0.6·coverage + 0.25·integrity + 0.15·continuity`.
    pub score: f64,
    /// True on the single best-scoring plan. A default, never an imposition.
    pub recommended: bool,
    pub moves: Vec<BlockMove>,
    /// Titles cut from today (surfaced verbatim so the consequence is concrete).
    pub dropped_titles: Vec<String>,
    pub kept_count: usize,
    pub dropped_count: usize,
    /// Total minutes of work the plan schedules.
    pub scheduled_mins: i32,
}

/// The full adjustment verdict for a day.
#[derive(Debug, Clone, Serialize)]
pub struct RecoveryReport {
    pub day: String,
    /// How far behind the student is, in minutes (0 when on track).
    pub drift_mins: i32,
    /// Usable minutes left after the fatigue discount.
    pub usable_mins: i32,
    /// Minutes required to complete every open block at its viable floor.
    pub required_mins: i32,
    /// True when everything still fits — the caller should present this gently (a shift), not
    /// as a crisis requiring triage.
    pub fits: bool,
    /// True when there is genuinely nothing to adjust (no open blocks, or day already over).
    pub nothing_to_do: bool,
    pub plans: Vec<RecoveryPlan>,
}

// ── Free-window model ────────────────────────────────────────────────────────

/// A contiguous stretch of schedulable time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Gap {
    start: i32,
    end: i32,
}

impl Gap {
    fn len(&self) -> i32 {
        (self.end - self.start).max(0)
    }
}

/// Compute the schedulable gaps in `[now, hard_stop]`, with anchored blocks carved out.
///
/// Anchors are immovable by definition, so rather than "scheduling around" them heuristically
/// we subtract their intervals from the window and place flexible work in what's left. This is
/// what keeps a 5 PM coaching class intact while the morning gets rearranged.
fn free_gaps(snapshot: &DaySnapshot, now: i32) -> Vec<Gap> {
    let window_start = now.max(0);
    let window_end = snapshot.hard_stop_mins.min(MINUTES_PER_DAY);
    if window_end <= window_start {
        return Vec::new();
    }

    // Anchored, still-open blocks whose time hasn't fully passed occupy fixed intervals.
    let mut busy: Vec<Gap> = snapshot
        .blocks
        .iter()
        .filter(|b| b.is_anchored && b.state.is_open() && b.end_mins() > window_start)
        .map(|b| Gap {
            start: b.start_mins.max(window_start),
            end: b.end_mins().min(window_end),
        })
        .filter(|g| g.len() > 0)
        .collect();
    busy.sort_by_key(|g| g.start);

    // Merge overlapping anchors (a double-booked calendar shouldn't produce negative gaps).
    let mut merged: Vec<Gap> = Vec::with_capacity(busy.len());
    for g in busy {
        match merged.last_mut() {
            Some(last) if g.start <= last.end => last.end = last.end.max(g.end),
            _ => merged.push(g),
        }
    }

    // Invert: the complement of the busy intervals within the window.
    let mut gaps = Vec::new();
    let mut cursor = window_start;
    for g in &merged {
        if g.start > cursor {
            gaps.push(Gap {
                start: cursor,
                end: g.start,
            });
        }
        cursor = cursor.max(g.end);
    }
    if cursor < window_end {
        gaps.push(Gap {
            start: cursor,
            end: window_end,
        });
    }
    gaps
}

/// Total schedulable minutes across all gaps, after the fatigue discount.
fn usable_minutes(gaps: &[Gap], prefs: &AdjustPrefs) -> i32 {
    let raw: i32 = gaps.iter().map(|g| g.len()).sum();
    ((raw as f64) * prefs.fatigue_factor.clamp(0.1, 1.0)).round() as i32
}

/// Greedily lay a sequence of (block, duration) pairs into the gaps, in the given order.
///
/// Returns the placements plus anything that didn't fit. A block is only placed if its *full*
/// requested duration fits in some gap — half a block placed is worse than none, because the
/// student arrives, sets up, and gets interrupted.
fn place_in_gaps(
    items: &[(usize, i32)],
    gaps: &[Gap],
    transition_mins: i32,
) -> (Vec<(usize, i32, i32)>, Vec<usize>) {
    // Mutable cursors, one per gap.
    let mut cursors: Vec<i32> = gaps.iter().map(|g| g.start).collect();
    let mut placed: Vec<(usize, i32, i32)> = Vec::with_capacity(items.len());
    let mut unplaced: Vec<usize> = Vec::new();

    for &(idx, mins) in items {
        let mut done = false;
        for (gi, gap) in gaps.iter().enumerate() {
            // Charge the context switch only when something already occupies this gap.
            let lead = if cursors[gi] > gap.start {
                transition_mins
            } else {
                0
            };
            let start = cursors[gi] + lead;
            if start + mins <= gap.end {
                placed.push((idx, start, mins));
                cursors[gi] = start + mins;
                done = true;
                break;
            }
        }
        if !done {
            unplaced.push(idx);
        }
    }
    (placed, unplaced)
}

// ── Plan construction ────────────────────────────────────────────────────────

/// Build the move list + quality metrics for a set of placements.
#[allow(clippy::too_many_arguments)]
fn assemble_plan(
    kind: PlanKind,
    open: &[usize],
    blocks: &[BlockInput],
    placed: &[(usize, i32, i32)],
    gaps: &[Gap],
    anchors_lost: usize,
    anchors_total: usize,
) -> RecoveryPlan {
    let mut moves: Vec<BlockMove> = Vec::with_capacity(open.len());
    let mut kept_value = 0.0f64;
    let mut total_value = 0.0f64;
    let mut scheduled_mins = 0i32;
    let mut dropped_titles: Vec<String> = Vec::new();
    let mut kept_count = 0usize;
    let mut dropped_count = 0usize;

    for &i in open {
        total_value += blocks[i].value();
    }

    // Anchored blocks are reported as Keep — they were never candidates for movement.
    for &i in open {
        let b = &blocks[i];
        if b.is_anchored {
            moves.push(BlockMove {
                block_id: b.id,
                title: b.title.clone(),
                action: MoveAction::Keep,
                from_start: fmt_hhmm(b.start_mins),
                to_start: fmt_hhmm(b.start_mins),
                from_mins: b.planned_mins,
                to_mins: b.planned_mins,
            });
            kept_value += b.value();
            kept_count += 1;
            scheduled_mins += b.planned_mins;
        }
    }

    for &(i, start, mins) in placed {
        let b = &blocks[i];
        let action = if start == b.start_mins && mins == b.planned_mins {
            MoveAction::Keep
        } else if mins < b.planned_mins {
            MoveAction::Compress
        } else {
            MoveAction::Shift
        };
        moves.push(BlockMove {
            block_id: b.id,
            title: b.title.clone(),
            action,
            from_start: fmt_hhmm(b.start_mins),
            to_start: fmt_hhmm(start),
            from_mins: b.planned_mins,
            to_mins: mins,
        });
        // Partial credit for a compressed block: it retains value in proportion to the
        // fraction of its honest duration that survives, so "trim Math to 40m" is scored as a
        // real (if reduced) win rather than a full one.
        let frac = (mins as f64 / b.effective_mins().max(1) as f64).clamp(0.0, 1.0);
        kept_value += b.value() * frac;
        kept_count += 1;
        scheduled_mins += mins;
    }

    let placed_ids: Vec<usize> = placed.iter().map(|(i, _, _)| *i).collect();
    for &i in open {
        let b = &blocks[i];
        if b.is_anchored || placed_ids.contains(&i) {
            continue;
        }
        dropped_titles.push(b.title.clone());
        dropped_count += 1;
        moves.push(BlockMove {
            block_id: b.id,
            title: b.title.clone(),
            action: MoveAction::Drop,
            from_start: fmt_hhmm(b.start_mins),
            to_start: fmt_hhmm(b.start_mins),
            from_mins: b.planned_mins,
            to_mins: 0,
        });
    }

    let coverage = if total_value > 0.0 {
        (kept_value / total_value).clamp(0.0, 1.0)
    } else {
        1.0
    };
    let integrity = if anchors_total > 0 {
        1.0 - (anchors_lost as f64 / anchors_total as f64)
    } else {
        1.0
    };

    // Continuity: what fraction of the spanned time is actually working time. Rewards plans
    // that keep the day contiguous instead of scattering blocks across dead air.
    let continuity = {
        let span_start = placed.iter().map(|(_, s, _)| *s).min();
        let span_end = placed.iter().map(|(_, s, m)| s + m).max();
        match (span_start, span_end) {
            (Some(s), Some(e)) if e > s => {
                let worked: i32 = placed.iter().map(|(_, _, m)| *m).sum();
                (worked as f64 / (e - s) as f64).clamp(0.0, 1.0)
            }
            _ => 1.0,
        }
    };

    let score = 0.6 * coverage + 0.25 * integrity + 0.15 * continuity;
    let summary = build_summary(kind, &dropped_titles, placed, blocks, gaps);

    // Chronological order so the UI can render the plan as a day, not as a change log.
    moves.sort_by(|a, b| a.to_start.cmp(&b.to_start));

    RecoveryPlan {
        id: kind.id().to_string(),
        kind,
        label: kind.label().to_string(),
        summary,
        coverage,
        integrity,
        continuity,
        score,
        recommended: false,
        moves,
        dropped_titles,
        kept_count,
        dropped_count,
        scheduled_mins,
    }
}

/// One line describing the *consequence*, in content terms. "Chemistry won't fit" is
/// actionable; "3 changes" is noise.
fn build_summary(
    kind: PlanKind,
    dropped: &[String],
    placed: &[(usize, i32, i32)],
    blocks: &[BlockInput],
    _gaps: &[Gap],
) -> String {
    let trimmed: Vec<&str> = placed
        .iter()
        .filter(|(i, _, m)| *m < blocks[*i].planned_mins)
        .map(|(i, _, _)| blocks[*i].title.as_str())
        .collect();

    let mut parts: Vec<String> = Vec::new();
    match kind {
        PlanKind::Cascade => {
            if let Some((i, start, _)) = placed.first() {
                parts.push(format!(
                    "Everything moves back — {} starts {}",
                    blocks[*i].title,
                    fmt_hhmm(*start)
                ));
            } else {
                parts.push("Nothing fits in the time left".to_string());
            }
        }
        PlanKind::Triage => {
            if let Some((i, _, m)) = placed
                .iter()
                .max_by(|a, b| blocks[a.0].value().total_cmp(&blocks[b.0].value()))
            {
                parts.push(format!(
                    "Keeps {} at {}",
                    blocks[*i].title,
                    fmt_duration(*m)
                ));
            }
            if !trimmed.is_empty() {
                parts.push(format!("trims {}", trimmed.join(", ")));
            }
        }
        PlanKind::Compress => {
            let total: i32 = placed.iter().map(|(_, _, m)| *m).sum();
            parts.push(format!(
                "Every block shortened — {} of study kept",
                fmt_duration(total)
            ));
        }
    }

    match dropped.len() {
        0 => {}
        1 => parts.push(format!("{} won't fit", dropped[0])),
        n => parts.push(format!("{} and {} more won't fit", dropped[0], n - 1)),
    }

    if parts.is_empty() {
        "No changes needed".to_string()
    } else {
        parts.join(" · ")
    }
}

// ── Entry point ──────────────────────────────────────────────────────────────

/// Produce the recovery options for a day.
///
/// `now_mins` is local minutes since midnight, injected rather than read from the clock so
/// every scenario is unit-testable.
pub fn build_recovery_plans(snapshot: &DaySnapshot, now_mins: i32) -> RecoveryReport {
    let blocks = &snapshot.blocks;
    let prefs = &snapshot.prefs;

    // Open work only. Done / skipped / spilled blocks are history.
    let open: Vec<usize> = blocks
        .iter()
        .enumerate()
        .filter(|(_, b)| b.state.is_open())
        .map(|(i, _)| i)
        .collect();

    // Drift: how far past their scheduled end the still-open blocks have slipped. Measured
    // against the *latest* overrun so a single stale block doesn't understate the problem.
    let drift_mins = open
        .iter()
        .map(|&i| now_mins - blocks[i].end_mins())
        .max()
        .unwrap_or(0)
        .max(0);

    let gaps = free_gaps(snapshot, now_mins);
    let usable = usable_minutes(&gaps, prefs);

    // Anchors whose window has already passed are unrecoverable — they cost integrity.
    let anchors: Vec<usize> = open.iter().copied().filter(|&i| blocks[i].is_anchored).collect();
    let anchors_lost = anchors
        .iter()
        .filter(|&&i| blocks[i].end_mins() <= now_mins)
        .count();

    // Flexible open work, in chronological order (the student's intended sequence).
    let mut flex: Vec<usize> = open
        .iter()
        .copied()
        .filter(|&i| !blocks[i].is_anchored)
        .collect();
    flex.sort_by_key(|&i| (blocks[i].start_mins, blocks[i].id));

    let required_mins: i32 = flex.iter().map(|&i| blocks[i].min_viable()).sum();
    let demand_full: i32 = flex.iter().map(|&i| blocks[i].remaining_mins()).sum();
    let fits = demand_full <= usable;

    if open.is_empty() {
        // Everything is settled. There is no adjustment to offer; the caller shows an
        // end-of-day review instead of a recovery card.
        return RecoveryReport {
            day: snapshot.day.clone(),
            drift_mins,
            usable_mins: usable,
            required_mins,
            fits: true,
            nothing_to_do: true,
            plans: Vec::new(),
        };
    }

    let mut plans: Vec<RecoveryPlan> = Vec::new();

    // ── No time left, but work still open: the day is over and the debt is real. ──
    //
    // This used to return `nothing_to_do`, which is where the "Recovery Card never appears"
    // bug came from: at 23:25 with a 22:00 hard stop, `free_gaps` is empty, so the ONE moment
    // the student most needs an escape hatch was the one moment the card refused to appear.
    //
    // "No adjustment is possible today" is true, and it is not the same as "nothing to do":
    // the honest offer is to carry the unfinished work to tomorrow, which is exactly what
    // `apply_recovery` does with a `Drop` (spill forward with provenance, never a delete).
    // One plan only — Triage and Compress would both reduce to the same "everything moves"
    // outcome, and three identical options dressed as a choice is worse than one clear one.
    if gaps.is_empty() {
        let (placed, _) = place_in_gaps(&[], &gaps, prefs.transition_mins);
        plans.push(assemble_plan(
            PlanKind::Cascade,
            &open,
            blocks,
            &placed,
            &gaps,
            anchors_lost,
            anchors.len(),
        ));
        if let Some(p) = plans.first_mut() {
            p.recommended = true;
        }
        return RecoveryReport {
            day: snapshot.day.clone(),
            drift_mins,
            usable_mins: usable,
            required_mins,
            fits: false,
            nothing_to_do: false,
            plans,
        };
    }

    // ── A. Cascade — preserve order, full durations, drop from the tail. ──
    {
        let items: Vec<(usize, i32)> = flex
            .iter()
            .map(|&i| (i, blocks[i].remaining_mins()))
            .collect();
        let (placed, _) = place_in_gaps(&items, &gaps, prefs.transition_mins);
        plans.push(assemble_plan(
            PlanKind::Cascade,
            &open,
            blocks,
            &placed,
            &gaps,
            anchors_lost,
            anchors.len(),
        ));
    }

    // When everything fits, a single gentle shift is the whole answer. Offering "choose what
    // to sacrifice" for a 20-minute sleep-in manufactures a crisis out of a non-event.
    if fits {
        let mut report = RecoveryReport {
            day: snapshot.day.clone(),
            drift_mins,
            usable_mins: usable,
            required_mins,
            fits: true,
            nothing_to_do: false,
            plans,
        };
        if let Some(p) = report.plans.first_mut() {
            p.recommended = true;
        }
        return report;
    }

    // ── B. Triage — greedy knapsack on value density, then redistribute slack. ──
    {
        let mut by_density: Vec<usize> = flex.clone();
        by_density.sort_by(|&a, &b| {
            blocks[b]
                .density()
                .total_cmp(&blocks[a].density())
                .then_with(|| blocks[b].value().total_cmp(&blocks[a].value()))
                .then_with(|| blocks[a].start_mins.cmp(&blocks[b].start_mins))
        });

        // Admit at the viable floor while capacity remains.
        let mut budget = usable;
        let mut admitted: Vec<usize> = Vec::new();
        for &i in &by_density {
            let need = blocks[i].min_viable() + prefs.transition_mins;
            if need <= budget {
                admitted.push(i);
                budget -= need;
            }
        }

        // Give leftover minutes back to the most valuable admitted blocks, up to their full
        // honest duration — triage should not leave the student with a needlessly thin day.
        let mut alloc: Vec<(usize, i32)> = admitted
            .iter()
            .map(|&i| (i, blocks[i].min_viable()))
            .collect();
        let mut by_value: Vec<usize> = (0..alloc.len()).collect();
        by_value.sort_by(|&a, &b| {
            blocks[alloc[b].0]
                .value()
                .total_cmp(&blocks[alloc[a].0].value())
        });
        for ai in by_value {
            if budget <= 0 {
                break;
            }
            let (bi, cur) = alloc[ai];
            let want = blocks[bi].remaining_mins() - cur;
            if want > 0 {
                let give = want.min(budget);
                alloc[ai].1 = cur + give;
                budget -= give;
            }
        }

        // Place in chronological order so the resulting day still reads naturally.
        alloc.sort_by_key(|&(i, _)| (blocks[i].start_mins, blocks[i].id));
        let (placed, _) = place_in_gaps(&alloc, &gaps, prefs.transition_mins);
        plans.push(assemble_plan(
            PlanKind::Triage,
            &open,
            blocks,
            &placed,
            &gaps,
            anchors_lost,
            anchors.len(),
        ));
    }

    // ── C. Compress — scale everything, drop only what falls under its floor. ──
    {
        let ratio = if demand_full > 0 {
            (usable as f64 / demand_full as f64).clamp(0.0, 1.0)
        } else {
            1.0
        };
        let items: Vec<(usize, i32)> = flex
            .iter()
            .filter_map(|&i| {
                let scaled = ((blocks[i].remaining_mins() as f64) * ratio).round() as i32;
                // Below the floor, shrinking produces a block not worth attending. Drop it
                // instead of pretending 6 minutes of Physics is useful.
                if scaled >= blocks[i].min_viable() {
                    Some((i, scaled))
                } else {
                    None
                }
            })
            .collect();
        let (placed, _) = place_in_gaps(&items, &gaps, prefs.transition_mins);
        plans.push(assemble_plan(
            PlanKind::Compress,
            &open,
            blocks,
            &placed,
            &gaps,
            anchors_lost,
            anchors.len(),
        ));
    }

    // Rank, then mark exactly one recommendation.
    let best = plans
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.score.total_cmp(&b.1.score))
        .map(|(i, _)| i);
    if let Some(i) = best {
        plans[i].recommended = true;
    }

    RecoveryReport {
        day: snapshot.day.clone(),
        drift_mins,
        usable_mins: usable,
        required_mins,
        fits: false,
        nothing_to_do: false,
        plans,
    }
}

// ── Pre-mortem (Plan Integrity) ──────────────────────────────────────────────

/// The verdict on whether a day's plan is physically achievable *before* it starts.
#[derive(Debug, Clone, Serialize)]
pub struct IntegrityVerdict {
    /// 0-100. 100 = comfortably achievable.
    pub integrity: f64,
    /// Honest minutes the plan demands (pace-adjusted).
    pub demand_mins: i32,
    /// Realistic minutes available in the window.
    pub capacity_mins: i32,
    /// Minutes to trim to make the plan achievable (0 when it already is).
    pub overcommit_mins: i32,
    /// Advisory message. Advisory *only* — an ambitious student is never blocked from saving.
    pub message: Option<String>,
}

/// Score a whole day's plan for achievability, from the wake time rather than "now".
///
/// This is the cheapest high-value feature in the system: warning at 10 PM the night before
/// that an 11-hour plan doesn't fit in a 9-hour day prevents the three recovery prompts that
/// would otherwise follow at lunch. Purely advisory by product decision.
pub fn plan_integrity(snapshot: &DaySnapshot) -> IntegrityVerdict {
    let start = snapshot.wake_mins.min(snapshot.hard_stop_mins);
    let gaps = free_gaps(snapshot, start);
    let capacity = usable_minutes(&gaps, &snapshot.prefs);

    let flex_demand: i32 = snapshot
        .blocks
        .iter()
        .filter(|b| b.state.is_open() && !b.is_anchored)
        .map(|b| b.effective_mins() + snapshot.prefs.transition_mins)
        .sum();

    let overcommit = (flex_demand - capacity).max(0);
    let integrity = if flex_demand <= 0 {
        100.0
    } else if capacity <= 0 {
        0.0
    } else {
        ((capacity as f64 / flex_demand as f64) * 100.0).clamp(0.0, 100.0)
    };

    let message = if overcommit > 0 {
        Some(format!(
            "This plan needs {} but you have about {}. Trim ~{} or it will break by midday.",
            fmt_duration(flex_demand),
            fmt_duration(capacity),
            fmt_duration(overcommit)
        ))
    } else {
        None
    };

    IntegrityVerdict {
        integrity,
        demand_mins: flex_demand,
        capacity_mins: capacity,
        overcommit_mins: overcommit,
        message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(id: i64, title: &str, start: i32, mins: i32, weight: i32) -> BlockInput {
        BlockInput {
            id,
            title: title.to_string(),
            start_mins: start,
            planned_mins: mins,
            weight,
            is_anchored: false,
            min_viable_mins: None,
            state: BlockState::Pending,
            executed_mins: 0.0,
            spill_count: 0,
            pace_ratio: 1.0,
            exam_linked: false,
        }
    }

    fn snapshot(blocks: Vec<BlockInput>) -> DaySnapshot {
        DaySnapshot {
            day: "2026-07-31".to_string(),
            wake_mins: 360,      // 06:00
            hard_stop_mins: 1320, // 22:00
            blocks,
            prefs: AdjustPrefs::default(),
        }
    }

    /// The headline scenario from the brief: plans 6:00 Physics + 7:00 Math, wakes at 7:00.
    /// Everything still fits before the hard stop, so we offer ONE gentle shift — not a
    /// "choose what to sacrifice" dialog.
    #[test]
    fn late_start_that_still_fits_offers_only_a_shift() {
        let s = snapshot(vec![
            block(1, "Physics", 360, 60, 3),
            block(2, "Math", 420, 60, 2),
        ]);
        let r = build_recovery_plans(&s, 420); // 07:00

        assert!(r.fits, "2h of work with 15h left must fit");
        assert!(!r.nothing_to_do);
        assert_eq!(r.plans.len(), 1, "no triage needed when nothing must be cut");
        assert_eq!(r.plans[0].kind, PlanKind::Cascade);
        assert!(r.plans[0].recommended);
        assert_eq!(r.plans[0].dropped_count, 0, "nothing dropped");
        assert_eq!(r.drift_mins, 0, "Physics ends 07:00, so no overrun yet");
    }

    /// Real drift: it's 08:00 and a 06:00 block never happened.
    #[test]
    fn reports_drift_from_the_worst_overrun() {
        let s = snapshot(vec![block(1, "Physics", 360, 60, 3)]);
        let r = build_recovery_plans(&s, 480); // 08:00, block ended 07:00
        assert_eq!(r.drift_mins, 60);
    }

    /// Over-committed day: three plans, each with a distinct trade-off, and exactly one
    /// recommendation.
    #[test]
    fn overcommitted_day_offers_three_distinct_plans() {
        // 06:00 hard stop 12:00 → 6h raw ≈ 306 usable after fatigue. Demand 8h.
        let mut s = snapshot(vec![
            block(1, "Physics", 360, 120, 3),
            block(2, "Math", 480, 120, 2),
            block(3, "Chemistry", 600, 120, 1),
            block(4, "Revision", 720, 120, 0),
        ]);
        s.hard_stop_mins = 720; // 12:00
        let r = build_recovery_plans(&s, 360);

        assert!(!r.fits, "8h of work cannot fit in 6h");
        assert_eq!(r.plans.len(), 3);
        let kinds: Vec<PlanKind> = r.plans.iter().map(|p| p.kind).collect();
        assert!(kinds.contains(&PlanKind::Cascade));
        assert!(kinds.contains(&PlanKind::Triage));
        assert!(kinds.contains(&PlanKind::Compress));
        assert_eq!(
            r.plans.iter().filter(|p| p.recommended).count(),
            1,
            "exactly one recommendation — a default, not an imposition"
        );
    }

    /// Priority must dominate: triage keeps the High block and sheds the priority-0 one.
    #[test]
    fn triage_protects_high_priority_and_drops_lowest() {
        let mut s = snapshot(vec![
            block(1, "Physics", 360, 120, 3),
            block(2, "Doomscroll review", 480, 120, 0),
        ]);
        s.hard_stop_mins = 540; // 09:00 → 3h raw, ~153 usable; can't hold both at 120.
        let r = build_recovery_plans(&s, 360);

        let triage = r.plans.iter().find(|p| p.kind == PlanKind::Triage).unwrap();
        assert!(
            !triage.dropped_titles.contains(&"Physics".to_string()),
            "the High-priority block must survive triage"
        );
    }

    /// Anchored blocks are immovable: a 10:00 class stays at 10:00 and flexible work is
    /// placed around it.
    #[test]
    fn anchored_blocks_never_move() {
        let mut s = snapshot(vec![
            block(1, "Flexible study", 360, 60, 2),
            block(2, "Live class", 600, 60, 3),
        ]);
        s.blocks[1].is_anchored = true;
        let r = build_recovery_plans(&s, 420);

        let plan = &r.plans[0];
        let class = plan.moves.iter().find(|m| m.block_id == 2).unwrap();
        assert_eq!(class.action, MoveAction::Keep);
        assert_eq!(class.to_start, "10:00", "an anchored class cannot be shifted");
    }

    /// Flexible work must not be scheduled on top of an anchor.
    #[test]
    fn flexible_work_is_placed_around_anchors_not_over_them() {
        let mut s = snapshot(vec![
            block(1, "Study A", 360, 120, 2),
            block(2, "Live class", 420, 60, 3), // 07:00-08:00 immovable
        ]);
        s.blocks[1].is_anchored = true;
        let r = build_recovery_plans(&s, 360);

        let plan = &r.plans[0];
        let a = plan.moves.iter().find(|m| m.block_id == 1).unwrap();
        // A 120-min block can't fit in the 60-min pre-class gap, so it lands after the class.
        assert!(
            a.to_start >= "08:00".to_string(),
            "Study A must not overlap the 07:00 class, got {}",
            a.to_start
        );
    }

    /// An anchored commitment whose window has already passed is unrecoverable and must cost
    /// integrity — the plan should not silently pretend it's fine.
    #[test]
    fn missed_anchor_reduces_integrity() {
        let mut s = snapshot(vec![block(1, "Missed class", 360, 60, 3)]);
        s.blocks[0].is_anchored = true;
        let r = build_recovery_plans(&s, 600); // 10:00, class ended 07:00

        assert!(!r.plans.is_empty());
        assert!(
            r.plans[0].integrity < 1.0,
            "a missed anchor must dent integrity, got {}",
            r.plans[0].integrity
        );
    }

    /// Past the hard stop with work still open, the day cannot be rescued — but the student
    /// still needs the way out. Offer exactly one plan: carry it to tomorrow.
    ///
    /// This is the regression test for "the Recovery Card never appears": the old code returned
    /// `nothing_to_do` here, so the card stayed hidden at 23:25 with a ruined day on screen.
    #[test]
    fn past_hard_stop_still_offers_a_carry_over() {
        let s = snapshot(vec![block(1, "Physics", 360, 60, 3)]);
        let r = build_recovery_plans(&s, 1380); // 23:00, hard stop 22:00

        assert!(!r.nothing_to_do, "open work past the hard stop is not 'nothing to do'");
        assert!(!r.fits);
        assert_eq!(r.plans.len(), 1, "one honest option, not three identical ones");

        let p = &r.plans[0];
        assert_eq!(p.kind, PlanKind::Cascade);
        assert!(p.recommended);
        assert_eq!(p.dropped_count, 1, "the block moves to tomorrow");
        assert_eq!(p.scheduled_mins, 0, "nothing can be scheduled in zero time");
        assert_eq!(p.dropped_titles, vec!["Physics".to_string()]);
    }

    /// A block that ran past the hard stop but is anchored still counts as a lost commitment
    /// rather than something to carry forward.
    #[test]
    fn past_hard_stop_reports_anchors_as_kept_not_dropped() {
        let mut s = snapshot(vec![block(1, "Coaching", 1140, 60, 3)]);
        s.blocks[0].is_anchored = true;
        let r = build_recovery_plans(&s, 1380); // 23:00

        assert!(!r.nothing_to_do);
        let p = &r.plans[0];
        assert_eq!(p.dropped_count, 0, "an anchor is never spilled by the solver");
        assert!(p.integrity < 1.0, "but its missed window dents integrity");
    }

    /// A day with no open blocks is "nothing to do", not "everything dropped".
    #[test]
    fn fully_completed_day_yields_nothing_to_do() {
        let mut s = snapshot(vec![block(1, "Physics", 360, 60, 3)]);
        s.blocks[0].state = BlockState::Done;
        let r = build_recovery_plans(&s, 480);
        assert!(r.nothing_to_do);
        assert!(r.fits);
    }

    /// Compress shortens rather than drops when the ratio stays above the viable floor.
    #[test]
    fn compress_shortens_every_block() {
        let mut s = snapshot(vec![
            block(1, "A", 360, 120, 2),
            block(2, "B", 480, 120, 2),
        ]);
        s.hard_stop_mins = 600; // 10:00 → 4h raw, ~204 usable vs 240 demand.
        let r = build_recovery_plans(&s, 360);

        let c = r.plans.iter().find(|p| p.kind == PlanKind::Compress).unwrap();
        assert_eq!(c.dropped_count, 0, "both survive, just shorter");
        assert!(
            c.moves
                .iter()
                .filter(|m| m.action != MoveAction::Drop)
                .all(|m| m.to_mins < m.from_mins),
            "every kept block must actually shrink"
        );
    }

    /// Compress must DROP rather than shrink a block into uselessness.
    #[test]
    fn compress_drops_below_viable_floor_instead_of_shrinking_to_nothing() {
        let mut s = snapshot(vec![
            block(1, "A", 360, 120, 2),
            block(2, "B", 480, 120, 2),
            block(3, "C", 600, 120, 2),
        ]);
        s.hard_stop_mins = 480; // 06:00-08:00 → 2h raw, ~102 usable vs 360 demand.
        let r = build_recovery_plans(&s, 360);

        let c = r.plans.iter().find(|p| p.kind == PlanKind::Compress).unwrap();
        assert!(
            c.dropped_count > 0,
            "at a 0.28 ratio, blocks fall under their floor and must be dropped"
        );
    }

    /// Spillover promotion: a block pushed twice already outranks an equal-priority peer, so
    /// the disliked subject can't be dodged forever.
    #[test]
    fn spillover_promotes_chronically_deferred_work() {
        let fresh = block(1, "Fresh", 360, 60, 2);
        let mut deferred = block(2, "Deferred twice", 360, 60, 2);
        deferred.spill_count = 2;
        assert!(
            deferred.value() > fresh.value(),
            "spill count must raise triage value"
        );
    }

    /// Pace ratio makes estimates honest: a slow-paced course costs more clock time.
    #[test]
    fn pace_ratio_inflates_effective_duration() {
        let mut b = block(1, "Lecture", 360, 60, 2);
        assert_eq!(b.effective_mins(), 60);
        b.pace_ratio = 1.5;
        assert_eq!(b.effective_mins(), 90, "60 min of content, 90 min of clock");
    }

    /// Work already logged reduces what remains — a half-done block isn't rescheduled whole.
    #[test]
    fn executed_minutes_reduce_remaining_work() {
        let mut b = block(1, "Half done", 360, 60, 2);
        b.executed_mins = 40.0;
        assert_eq!(b.remaining_mins(), 20);
    }

    /// The derived floor is half the honest duration, never below 10 minutes.
    #[test]
    fn min_viable_floor_derivation() {
        let b = block(1, "Long", 360, 120, 2);
        assert_eq!(b.min_viable(), 60);
        let short = block(2, "Short", 360, 10, 2);
        assert_eq!(short.min_viable(), 10, "never below the 10-minute setup floor");
        let mut explicit = block(3, "Explicit", 360, 120, 2);
        explicit.min_viable_mins = Some(45);
        assert_eq!(explicit.min_viable(), 45, "explicit floor wins");
    }

    /// Priority-0 work must still carry non-zero value, or it would vanish from every plan
    /// AND from the coverage figure. This is the reason for `(weight+1)²` over `weight²`.
    #[test]
    fn zero_priority_still_has_value() {
        let b = block(1, "Unprioritized", 360, 60, 0);
        assert!(b.value() > 0.0);
        let high = block(2, "High", 360, 60, 3);
        assert!(
            high.value() >= b.value() * 8.0,
            "priority must dominate, not merely tiebreak"
        );
    }

    /// Coverage is a real fraction and drops when work is cut.
    #[test]
    fn coverage_reflects_value_retained() {
        let mut s = snapshot(vec![
            block(1, "Keep", 360, 60, 3),
            block(2, "Cut", 480, 240, 1),
        ]);
        s.hard_stop_mins = 480; // only ~102 usable
        let r = build_recovery_plans(&s, 360);
        for p in &r.plans {
            assert!(
                p.coverage >= 0.0 && p.coverage <= 1.0,
                "coverage must be a fraction, got {}",
                p.coverage
            );
        }
        assert!(
            r.plans.iter().any(|p| p.coverage < 1.0),
            "cutting work must reduce coverage"
        );
    }

    /// Every plan explains its consequence in content terms, never as a change count.
    #[test]
    fn plans_carry_a_human_summary() {
        let mut s = snapshot(vec![
            block(1, "Physics", 360, 120, 3),
            block(2, "Chemistry", 480, 120, 1),
        ]);
        s.hard_stop_mins = 540;
        let r = build_recovery_plans(&s, 360);
        for p in &r.plans {
            assert!(!p.summary.is_empty(), "{:?} needs a summary", p.kind);
            assert!(
                !p.summary.contains("changes"),
                "summaries name consequences, not change counts: {}",
                p.summary
            );
        }
    }

    /// A single block that doesn't fit at all is dropped, not scheduled past the hard stop.
    #[test]
    fn never_schedules_past_the_hard_stop() {
        let mut s = snapshot(vec![block(1, "Marathon", 360, 600, 3)]);
        s.hard_stop_mins = 480; // 2h window vs a 10h block
        let r = build_recovery_plans(&s, 360);
        for p in &r.plans {
            for m in p.moves.iter().filter(|m| m.action != MoveAction::Drop) {
                let end = super::super::parse_hhmm(&m.to_start).unwrap() + m.to_mins;
                assert!(end <= s.hard_stop_mins, "{} ends past the hard stop", m.title);
            }
        }
    }

    /// Pre-mortem: an over-ambitious plan is flagged with a concrete trim amount, advisory only.
    #[test]
    fn plan_integrity_flags_overcommitment() {
        let mut s = snapshot(vec![
            block(1, "A", 360, 240, 2),
            block(2, "B", 600, 240, 2),
            block(3, "C", 840, 240, 2),
        ]);
        s.wake_mins = 360;
        s.hard_stop_mins = 1080; // 06:00-18:00 = 12h raw, ~612 usable vs 720 demand
        let v = plan_integrity(&s);

        assert!(v.overcommit_mins > 0);
        assert!(v.integrity < 100.0);
        assert!(v.message.is_some(), "the student must be told, before the day starts");
    }

    /// A comfortable plan gets a clean bill of health and no nagging message.
    #[test]
    fn plan_integrity_passes_a_realistic_plan() {
        let s = snapshot(vec![
            block(1, "A", 360, 60, 2),
            block(2, "B", 480, 60, 2),
        ]);
        let v = plan_integrity(&s);
        assert_eq!(v.overcommit_mins, 0);
        assert_eq!(v.integrity, 100.0);
        assert!(v.message.is_none(), "don't nag when the plan is fine");
    }

    /// Pace ratio feeds the pre-mortem too: the same plan becomes unachievable for a slower
    /// student. This is what makes the warning personal rather than generic.
    #[test]
    fn plan_integrity_accounts_for_learned_pace() {
        let mut s = snapshot(vec![
            block(1, "A", 360, 180, 2),
            block(2, "B", 540, 180, 2),
        ]);
        s.hard_stop_mins = 780; // 06:00-13:00, 7h raw ≈ 357 usable vs 360 + transitions
        let fast = plan_integrity(&s);

        for b in &mut s.blocks {
            b.pace_ratio = 1.6;
        }
        let slow = plan_integrity(&s);
        assert!(
            slow.demand_mins > fast.demand_mins,
            "a slower pace must raise demand"
        );
        assert!(slow.integrity < fast.integrity);
    }

    /// Gap inversion sanity: anchors carve the window into the expected free stretches.
    #[test]
    fn free_gaps_carve_around_anchors() {
        let mut s = snapshot(vec![block(1, "Class", 600, 60, 3)]);
        s.blocks[0].is_anchored = true;
        s.hard_stop_mins = 780; // 13:00
        let gaps = free_gaps(&s, 480); // now 08:00

        assert_eq!(gaps.len(), 2, "before and after the class");
        assert_eq!((gaps[0].start, gaps[0].end), (480, 600));
        assert_eq!((gaps[1].start, gaps[1].end), (660, 780));
    }

    /// Overlapping anchors (a double-booked calendar) must not produce negative gaps.
    #[test]
    fn overlapping_anchors_are_merged() {
        let mut s = snapshot(vec![
            block(1, "Class A", 600, 60, 3),
            block(2, "Class B", 630, 60, 3),
        ]);
        s.blocks[0].is_anchored = true;
        s.blocks[1].is_anchored = true;
        s.hard_stop_mins = 780;
        let gaps = free_gaps(&s, 480);

        assert!(gaps.iter().all(|g| g.len() > 0), "no zero/negative gaps");
        assert_eq!(gaps.len(), 2);
        assert_eq!((gaps[1].start, gaps[1].end), (690, 780), "merged 10:00-11:30");
    }

    /// The solver is deterministic — same input, same output. Non-negotiable for a feature
    /// whose whole value proposition is that the student can trust it.
    #[test]
    fn solver_is_deterministic() {
        let s = snapshot(vec![
            block(1, "A", 360, 120, 3),
            block(2, "B", 480, 120, 2),
            block(3, "C", 600, 120, 1),
        ]);
        let a = build_recovery_plans(&s, 400);
        let b = build_recovery_plans(&s, 400);
        assert_eq!(a.plans.len(), b.plans.len());
        for (p, q) in a.plans.iter().zip(b.plans.iter()) {
            assert_eq!(p.id, q.id);
            assert_eq!(p.score, q.score);
            assert_eq!(p.moves.len(), q.moves.len());
        }
    }
}
