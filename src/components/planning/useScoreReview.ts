/**
 * useScoreReview — the data behind the score drill-down and the weekly review.
 *
 * Both surfaces read the SAME `consistency_log` rows the score windows are computed from, so the
 * review can never disagree with the number above it. That's the point: a review that says "great
 * week" under a score of 41 destroys trust in both.
 *
 * The weekly review is derived on the client rather than added as a backend command, because
 * every input is already in the `ConsistencySummary` payload the Planner tab fetches. A new IPC
 * round-trip would buy nothing but a second definition of "this week".
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ipc, isTauri } from "../../lib/ipc";
import { localDay, useScheduleClock } from "../../lib/scheduleClock";
import type { ConsistencyDay, ConsistencySummary, ScoreWindow } from "../../lib/types";

/** A day carries signal if the student had a deadline, studied, or planned. Mirrors the
 *  backend's `day_has_signal` exactly — two definitions here would desync the review from
 *  the score it sits under. */
export function dayHasSignal(d: ConsistencyDay): boolean {
  return d.tasks_due > 0 || d.study_minutes > 0 || d.blocks_planned > 0;
}

export interface WeekdayPattern {
  /** 0 = Sunday, matching `Date.getDay()`. */
  weekday: number;
  label: string;
  score: number | null;
  days: number;
}

export interface WeeklyReview {
  /** The 7 days ending today, oldest first (including neutral ones, so gaps are visible). */
  days: ConsistencyDay[];
  /** Signal-bearing days only. */
  countedDays: number;
  score: number | null;
  /** Same 7 days, one week earlier — the honest comparison. */
  priorScore: number | null;
  studyMinutes: number;
  blocksPlanned: number;
  blocksCompleted: number;
  /** Weighted schedule adherence across the week, `null` when nothing was planned. */
  adherence: number | null;
  /** The strongest and weakest weekdays over the whole 90-day window, not just this week —
   *  one bad Tuesday is noise, eight of them is a pattern. */
  bestWeekday: WeekdayPattern | null;
  worstWeekday: WeekdayPattern | null;
  /** Longest run of consecutive signal-bearing days at or above 60 within the window. */
  bestStreak: number;
}

export interface ScoreReviewState {
  windows: ScoreWindow[];
  summary: ConsistencySummary | null;
  review: WeeklyReview | null;
  loaded: boolean;
  reload: () => Promise<void>;
}

const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Below this many observations a weekday average is noise, not a pattern. */
const MIN_WEEKDAY_SAMPLES = 3;

export function useScoreReview(): ScoreReviewState {
  // Re-derive when the local day rolls over, so a review left open overnight isn't stale.
  const clockDay = useScheduleClock((s) => s.day);
  const [windows, setWindows] = useState<ScoreWindow[]>([]);
  const [summary, setSummary] = useState<ConsistencySummary | null>(null);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    if (!isTauri()) {
      setLoaded(true);
      return;
    }
    const today = localDay();
    try {
      const [w, s] = await Promise.all([
        ipc.scoreSummary(today),
        // 91 days = a full heatmap AND enough history for the weekday pattern to mean something.
        ipc.consistencySummary(today, 91),
      ]);
      setWindows(w);
      setSummary(s);
    } catch {
      /* keep prior state — a failed read must not blank a page the student is reading */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, clockDay]);

  const review = useMemo(
    () => (summary ? buildWeeklyReview(summary.days) : null),
    [summary],
  );

  return useMemo(
    () => ({ windows, summary, review, loaded, reload }),
    [windows, summary, review, loaded, reload],
  );
}

/** Plain average over signal-bearing days. `null` when the slice holds no signal at all. */
function avgScore(days: ConsistencyDay[]): number | null {
  const withSignal = days.filter(dayHasSignal);
  if (withSignal.length === 0) return null;
  return withSignal.reduce((sum, d) => sum + d.score, 0) / withSignal.length;
}

/**
 * Build the review from the trailing series. `days` is oldest-first and may have gaps (a day with
 * no row at all simply isn't there), so slicing by POSITION would silently compare mismatched
 * spans. Everything below keys off the actual date strings instead.
 */
export function buildWeeklyReview(all: ConsistencyDay[]): WeeklyReview | null {
  if (all.length === 0) return null;

  const last = all[all.length - 1]!.day;
  const cutoff = shiftDay(last, -6); // 7 days inclusive
  const priorCutoff = shiftDay(last, -13);

  const days = all.filter((d) => d.day >= cutoff);
  const prior = all.filter((d) => d.day >= priorCutoff && d.day < cutoff);

  const planned = days.reduce((s, d) => s + d.planned_minutes, 0);
  const executed = days.reduce((s, d) => s + d.executed_minutes, 0);

  return {
    days,
    countedDays: days.filter(dayHasSignal).length,
    score: avgScore(days),
    priorScore: avgScore(prior),
    studyMinutes: days.reduce((s, d) => s + d.study_minutes, 0),
    blocksPlanned: days.reduce((s, d) => s + d.blocks_planned, 0),
    blocksCompleted: days.reduce((s, d) => s + d.blocks_completed, 0),
    // Minute-weighted, not a mean of daily percentages: a day with one 15-minute block must not
    // swing the week as hard as a day with six hours planned.
    adherence: planned > 0 ? Math.min(100, (executed / planned) * 100) : null,
    ...weekdayPattern(all),
    bestStreak: longestStreak(all),
  };
}

/** Best/worst weekday across the whole window, ignoring weekdays with too few observations. */
function weekdayPattern(all: ConsistencyDay[]): {
  bestWeekday: WeekdayPattern | null;
  worstWeekday: WeekdayPattern | null;
} {
  const buckets: { sum: number; n: number }[] = Array.from({ length: 7 }, () => ({ sum: 0, n: 0 }));
  for (const d of all) {
    if (!dayHasSignal(d)) continue;
    const wd = weekdayOf(d.day);
    if (wd == null) continue;
    buckets[wd]!.sum += d.score;
    buckets[wd]!.n += 1;
  }

  const ranked = buckets
    .map((b, weekday) => ({
      weekday,
      label: WEEKDAY_LABELS[weekday]!,
      score: b.n > 0 ? b.sum / b.n : null,
      days: b.n,
    }))
    .filter((b): b is WeekdayPattern & { score: number } =>
      b.score != null && b.days >= MIN_WEEKDAY_SAMPLES,
    )
    .sort((a, b) => b.score - a.score);

  // With fewer than two comparable weekdays there is no "pattern" to report, only a single
  // data point dressed up as an insight.
  if (ranked.length < 2) return { bestWeekday: null, worstWeekday: null };
  return { bestWeekday: ranked[0]!, worstWeekday: ranked[ranked.length - 1]! };
}

/**
 * Longest run of signal-bearing days scoring >= 60.
 *
 * Neutral days (nothing due, nothing planned, no study) are SKIPPED rather than treated as
 * breaks, matching the backend's trailing-streak loop exactly. That is deliberate on both sides:
 * this codebase treats an empty day as no evidence rather than as failure, so a rest day should
 * not erase a fortnight of consistency. A missing row means the same thing as an empty one.
 *
 * A calendar-contiguity requirement was tried here first and dropped — it would have made this
 * number mean something different from the streak shown on the Planner tab, and two "streak"
 * figures that disagree are worse than either rule on its own.
 */
function longestStreak(all: ConsistencyDay[]): number {
  let best = 0;
  let run = 0;

  for (const d of all) {
    if (!dayHasSignal(d)) continue;
    run = d.score >= 60 ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

/** `YYYY-MM-DD` → weekday index, or `null` if unparseable. Local-time construction. */
function weekdayOf(day: string): number | null {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d).getDay();
}

/** Shift a `YYYY-MM-DD` string by whole days, handling month/year rollover. */
function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + delta);
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${dt.getFullYear()}-${mm}-${dd}`;
}
