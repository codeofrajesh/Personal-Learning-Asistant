/**
 * Pure helpers for the Analytics workspace — formatting, period math, and the derived signals
 * (deltas, peak day, chronotype, golden window, pace status, plan↔target reconciliation).
 *
 * Everything here is a pure function over data the hooks already fetched. Keeping it out of the
 * components makes the numbers testable and the components presentational, and it is the ONLY place
 * the plan↔target reconciliation rule lives — so "today's plan vs your ambition target" reads the
 * same wherever it is shown.
 */

import type { DayStudy, PeakHour, StudyMeter } from "../../lib/types";
import { dayOffset, localDay } from "../../lib/scheduleClock";

/** Settings keys shared with the Rust backend (see `db::plan`). */
export const SETTING_DAILY_GOAL = "study.daily_goal_mins";
export const SETTING_TRACKING_PAUSED = "study.tracking_paused";
export const SETTING_RETENTION_DAYS = "study.retention_days";

// ── Formatting ────────────────────────────────────────────────────────────────

/** `"1h 20m"` / `"45m"` / `"2h"` — matches the sidebar StudyMeter so every surface reads alike. */
export function fmtHM(mins: number): string {
  const m = Math.max(0, Math.round(mins));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${h}h` : `${h}h ${r}m`;
}

/** Parse a local `YYYY-MM-DD` into a local `Date` (never `toISOString` — that would shift days). */
export function parseLocalDay(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y || 1970, (m || 1) - 1, d || 1);
}

/** `"Sep 4"`. */
export function fmtDateShort(day: string): string {
  return parseLocalDay(day).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** `"Mon"`. */
export function weekdayShort(day: string): string {
  return parseLocalDay(day).toLocaleDateString(undefined, { weekday: "short" });
}

/** Saturday / Sunday (local). */
export function isWeekend(day: string): boolean {
  const wd = parseLocalDay(day).getDay();
  return wd === 0 || wd === 6;
}

/** Minutes-since-midnight → `"7:30 PM"` / `"9 AM"`. */
export function fmt12h(mins: number): string {
  const v = Math.max(0, Math.min(1439, Math.round(mins)));
  let h = Math.floor(v / 60);
  const m = v % 60;
  const ampm = h < 12 ? "AM" : "PM";
  h %= 12;
  if (h === 0) h = 12;
  return m === 0 ? `${h} ${ampm}` : `${h}:${String(m).padStart(2, "0")} ${ampm}`;
}

/** An hour bucket 0..23 → `"2 PM"` (for axis labels). */
export function fmtHour12(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  const ampm = h < 12 ? "AM" : "PM";
  let hh = h % 12;
  if (hh === 0) hh = 12;
  return `${hh} ${ampm}`;
}

// ── Period aggregates ───────────────────────────────────────────────────────

export function sumMins(days: DayStudy[]): number {
  return days.reduce((s, d) => s + d.work_mins, 0);
}
export function activeDays(days: DayStudy[]): number {
  return days.reduce((s, d) => s + (d.work_mins > 0 ? 1 : 0), 0);
}

/** The single highest-study day in the range (>0), or null. */
export function peakDay(days: DayStudy[]): DayStudy | null {
  let best: DayStudy | null = null;
  for (const d of days) {
    if (d.work_mins > 0 && (!best || d.work_mins > best.work_mins)) best = d;
  }
  return best;
}

export interface Delta {
  /** Rounded percentage change, or null when there's no prior signal to compare against. */
  pct: number | null;
  up: boolean;
  /** True when the previous period had nothing (so a percentage would be meaningless). */
  isNew: boolean;
}

/** Percentage change from `prev` → `cur`, guarding the divide-by-zero "no prior data" case. */
export function delta(cur: number, prev: number): Delta {
  if (prev <= 0) return { pct: null, up: cur >= 0, isNew: cur > 0 };
  const pct = Math.round(((cur - prev) / prev) * 100);
  return { pct, up: pct >= 0, isNew: false };
}

// ── Chronotype + golden window (from PeakHour[]) ──────────────────────────────

export interface ChronoBucket {
  key: string;
  label: string;
  /** e.g. "6a–12p" */
  range: string;
  mins: number;
  pct: number;
}

/** Split focus into Morning / Afternoon / Evening / Night, as minutes + share of total. */
export function chronotype(hours: PeakHour[]): { buckets: ChronoBucket[]; total: number } {
  const byHour = new Map(hours.map((h) => [h.hour, h.total_mins]));
  const get = (h: number) => byHour.get(h) ?? 0;
  const defs: { key: string; label: string; range: string; hrs: number[] }[] = [
    { key: "morning", label: "Morning", range: "6a–12p", hrs: [6, 7, 8, 9, 10, 11] },
    { key: "afternoon", label: "Afternoon", range: "12p–6p", hrs: [12, 13, 14, 15, 16, 17] },
    { key: "evening", label: "Evening", range: "6p–10p", hrs: [18, 19, 20, 21] },
    { key: "night", label: "Night", range: "10p–6a", hrs: [22, 23, 0, 1, 2, 3, 4, 5] },
  ];
  const buckets: ChronoBucket[] = defs.map((d) => ({
    key: d.key,
    label: d.label,
    range: d.range,
    mins: d.hrs.reduce((s, h) => s + get(h), 0),
    pct: 0,
  }));
  const total = buckets.reduce((s, b) => s + b.mins, 0);
  for (const b of buckets) b.pct = total > 0 ? Math.round((b.mins / total) * 100) : 0;
  return { buckets, total };
}

export interface GoldenWindow {
  startHour: number;
  /** Inclusive last hour bucket; the window covers up to `endHour + 1 :00`. */
  endHour: number;
  pct: number;
  mins: number;
}

/** The contiguous run of hours around the peak that holds the bulk of focus. */
export function goldenWindow(hours: PeakHour[]): GoldenWindow | null {
  if (!hours.length) return null;
  const byHour = new Map(hours.map((h) => [h.hour, h.total_mins]));
  const total = hours.reduce((s, h) => s + h.total_mins, 0);
  if (total <= 0) return null;

  let peakHour = 0;
  let peakMins = -1;
  for (let h = 0; h < 24; h++) {
    const m = byHour.get(h) ?? 0;
    if (m > peakMins) {
      peakMins = m;
      peakHour = h;
    }
  }
  // Grow out from the peak while neighbours are still a meaningful share of it.
  const thresh = peakMins * 0.4;
  let start = peakHour;
  let end = peakHour;
  while (start - 1 >= 0 && (byHour.get(start - 1) ?? 0) >= thresh) start--;
  while (end + 1 <= 23 && (byHour.get(end + 1) ?? 0) >= thresh) end++;

  let mins = 0;
  for (let h = start; h <= end; h++) mins += byHour.get(h) ?? 0;
  return { startHour: start, endHour: end, pct: Math.round((mins / total) * 100), mins };
}

// ── Pace + plan↔target reconciliation ─────────────────────────────────────────

export type PaceState = "crushed" | "ahead" | "warning" | "idle";

export interface Pace {
  state: PaceState;
  /** Honest, uncapped percentage of the goal. */
  pct: number;
  /** Geometry only — clamped to [0,1] so the gauge can't overrun. */
  fill: number;
  message: string;
}

/**
 * Live pacing status for TODAY, measured against the effective goal (`study_meter`'s `goal_mins`).
 * The gauge always tracks the effective goal — which is the plan when a day is planned — so it can
 * never contradict the sidebar meter or override a planned schedule. The plan↔target relationship
 * is surfaced separately by [`reconcileCaption`].
 */
export function computePace(args: {
  studiedMins: number;
  goalMins: number;
  nowMins: number;
  wakeMins: number;
  hardStopMins: number;
  goalSource: StudyMeter["goal_source"];
}): Pace {
  const { studiedMins, goalMins, nowMins, wakeMins, hardStopMins, goalSource } = args;
  const goal = Math.max(1, goalMins);
  const pct = Math.round((studiedMins / goal) * 100);
  const fill = Math.max(0, Math.min(1, studiedMins / goal));

  if (studiedMins >= goal) {
    return { state: "crushed", pct, fill: 1, message: `${fmtHM(studiedMins)} / ${fmtHM(goal)} — goal crushed! 🚀` };
  }
  if (goalSource === "default") {
    return { state: "idle", pct, fill, message: "Set a daily target to start tracking your pace." };
  }

  const remaining = goal - studiedMins;
  const window = Math.max(1, hardStopMins - wakeMins);
  const elapsed = Math.max(0, Math.min(window, nowMins - wakeMins));
  const expected = goal * (elapsed / window);

  if (studiedMins >= expected && elapsed > 0) {
    const rate = studiedMins / elapsed; // studied minutes per usable minute
    const eta = rate > 0 ? nowMins + remaining / rate : hardStopMins + 1;
    if (eta <= hardStopMins) {
      return { state: "ahead", pct, fill, message: `Ahead of pace — on track to hit ${fmtHM(goal)} by ${fmt12h(eta)}.` };
    }
  }

  const stop = hardStopMins > nowMins ? hardStopMins : 24 * 60;
  return { state: "warning", pct, fill, message: `${fmtHM(remaining)} to go — needed before ${fmt12h(stop)} to close today's target.` };
}

/**
 * One honest line describing how the effective goal relates to the student's ambition target — the
 * "handle wisely" rule. Never conflates the two: a planned day is measured by the plan, and the
 * target is surfaced as context (and a nudge) rather than silently overriding the plan.
 */
export function reconcileCaption(
  goalSource: StudyMeter["goal_source"],
  goalMins: number,
  targetMins: number | null,
): string {
  if (goalSource === "plan") {
    if (targetMins && targetMins !== goalMins) {
      return targetMins > goalMins
        ? `Today's plan is ${fmtHM(goalMins)} — lighter than your ${fmtHM(targetMins)} target. Finish it, then push on.`
        : `Today's plan is ${fmtHM(goalMins)} — above your ${fmtHM(targetMins)} target. Ambitious day.`;
    }
    if (targetMins && targetMins === goalMins) return `Today's plan matches your ${fmtHM(targetMins)} target.`;
    return `Measured against today's plan (${fmtHM(goalMins)}).`;
  }
  if (goalSource === "setting") return `Your ${fmtHM(goalMins)} daily target · nothing planned today.`;
  return `No target set — using a ${fmtHM(goalMins)} default.`;
}

// ── Dynamic performance color system ──────────────────────────────────────────
//
// Motivating, not punishing (design-taste §4.2 / §9.A — no oversaturated red flood). Each day is
// classified against the daily target and given a refined treatment:
//   under (< 100%)  → dark glass + a warm amber rim   progress, not an alarm
//   met   (100–109%)→ electric cyan glass + aura       target completed
//   over  (≥ 110%)  → emerald glass + a golden halo    supercharged / overtime
//   none  (0 study) → muted translucent tile           rests quietly in the background
//
// Two representations per tone: `bar` (chart bar gradient) and the `cell*` fields (calendar tile).

/** Benchmark used when no explicit target is set, so bars still read meaningfully (matches the
 *  study-meter's 2h default). */
export const DEFAULT_TARGET_MINS = 120;

export type PerfKey = "none" | "under" | "met" | "over";

export interface PerfTone {
  key: PerfKey;
  label: string;
  /** Primary color (hex) — for legends, dots, accents. */
  solid: string;
  /** CSS gradient (bottom→top) for a bar fill. */
  bar: string;
  /** Glow color for a bar box-shadow, or null when the state earns no glow. */
  glow: string | null;
  /** Tailwind text color class (labels). */
  text: string;
  /** Tailwind border/bg/text classes for a small chip. */
  chip: string;
  /** Calendar-cell background (inline color). */
  cellBg: string;
  /** Calendar-cell border (inline color). */
  cellBorder: string;
  /** Calendar-cell glow color, or null (gated off on lite). */
  cellGlow: string | null;
  /** Tailwind text color for the date number inside a cell. */
  cellText: string;
}

// Under target — TEXTURED VIBRANT CRIMSON RED BOX. Rich dimensional gradient with specular highlight.
const TONE_UNDER: PerfTone = {
  key: "under",
  label: "Below target",
  solid: "#EF4444",
  bar: "linear-gradient(to top, #B91C1C, #EF4444)",
  glow: null,
  text: "text-red-400",
  chip: "border-red-500/35 bg-red-500/15 text-red-300",
  cellBg: "linear-gradient(180deg, #F87171 0%, #EF4444 35%, #DC2626 70%, #B91C1C 100%)",
  cellBorder: "rgba(255,255,255,0.24)",
  cellGlow: null,
  cellText: "text-white font-bold",
};
// Target met — ROYAL AZURE / SAPPHIRE BLUE BOX. Satisfying, crisp, and deep.
const TONE_MET: PerfTone = {
  key: "met",
  label: "Target met",
  solid: "#2563EB",
  bar: "linear-gradient(to top, #1D4ED8, #2563EB)",
  glow: null,
  text: "text-blue-400",
  chip: "border-blue-500/35 bg-blue-500/15 text-blue-300",
  cellBg: "linear-gradient(180deg, #60A5FA 0%, #3B82F6 35%, #2563EB 70%, #1D4ED8 100%)",
  cellBorder: "rgba(255,255,255,0.24)",
  cellGlow: null,
  cellText: "text-white font-bold",
};
// Over target — RADIANT SUN GOLD / AMBER BOX. Supercharged trophy day, replacing green.
const TONE_OVER: PerfTone = {
  key: "over",
  label: "Over target",
  solid: "#F59E0B",
  bar: "linear-gradient(to top, #B45309, #F59E0B)",
  glow: null,
  text: "text-amber-300",
  chip: "border-amber-400/35 bg-amber-400/15 text-amber-300",
  cellBg: "linear-gradient(180deg, #FDE68A 0%, #FBBF24 35%, #F59E0B 70%, #D97706 100%)",
  cellBorder: "rgba(255,255,255,0.26)",
  cellGlow: null,
  cellText: "text-white font-bold",
};
const TONE_NONE: PerfTone = {
  key: "none",
  label: "Rest day",
  solid: "#27272A",
  bar: "linear-gradient(to top, #18181b, #27272a)",
  glow: null,
  text: "text-white/40",
  chip: "border-white/10 bg-white/[0.04] text-white/40",
  cellBg: "#171720",
  cellBorder: "rgba(255,255,255,0.08)",
  cellGlow: null,
  cellText: "text-white/45 font-medium",
};

/** Classify a day's study against the daily target and return its color treatment. */
export function performanceTone(workMins: number, targetMins: number): PerfTone {
  if (workMins <= 0) return TONE_NONE;
  const target = targetMins > 0 ? targetMins : DEFAULT_TARGET_MINS;
  const ratio = workMins / target;
  if (ratio >= 1.1) return TONE_OVER;
  if (ratio >= 1.0) return TONE_MET;
  return TONE_UNDER;
}

// ── Cumulative velocity + hourly golden window ────────────────────────────────

export interface CumulativePoint {
  date: string;
  /** Running total of study minutes up to and including this day. */
  cum: number;
  /** Ideal cumulative pace by this day = dailyTarget × (dayIndex + 1). */
  benchmark: number;
}

/** Running cumulative study minutes vs the ideal straight-line pace toward the period target. */
export function cumulative(days: DayStudy[], dailyTargetMins: number): CumulativePoint[] {
  const target = dailyTargetMins > 0 ? dailyTargetMins : DEFAULT_TARGET_MINS;
  let run = 0;
  return days.map((d, i) => {
    run += d.work_mins;
    return { date: d.date, cum: run, benchmark: target * (i + 1) };
  });
}

/** Golden window derived from a 24-slot hourly array (Compare periods expose `hourly`, not the
 *  `PeakHour[]` the peak-hours hook returns). */
export function goldenWindowFromHourly(hourly: number[]): GoldenWindow | null {
  const hours = hourly.map((total_mins, hour) => ({ hour, total_mins, days: 0 }));
  return goldenWindow(hours);
}

/** Seconds → `"2h 43m"` / `"54m"`. */
export function fmtHMFromSecs(secs: number): string {
  return fmtHM(secs / 60);
}

/** Count of days at or above the daily target (for the "target met ratio"). */
export function daysMetTarget(days: DayStudy[], targetMins: number): number {
  const target = targetMins > 0 ? targetMins : DEFAULT_TARGET_MINS;
  return days.reduce((n, d) => n + (d.work_mins >= target ? 1 : 0), 0);
}

// ── Compare-mode period math ──────────────────────────────────────────────────

export type Granularity = "day" | "week" | "month";

export interface ComparePeriod {
  /** Local `YYYY-MM-DD` (inclusive). */
  start: string;
  end: string;
  /** Short human label ("Today", "Last week", "August 2026"). */
  label: string;
  /** A date-range subtitle. */
  sub: string;
}

/**
 * Resolve a compare period from a granularity + a step `index` (0 = current, -1 = previous, …),
 * anchored on the caller's LOCAL `today`. Day/Week are rolling windows (DST-safe via `dayOffset`);
 * Month is a real calendar month, with the current month capped at today for a fair partial view.
 */
export function comparePeriod(gran: Granularity, index: number, today: string): ComparePeriod {
  if (gran === "day") {
    const d = dayOffset(today, index);
    const label = index === 0 ? "Today" : index === -1 ? "Yesterday" : fmtDateShort(d);
    return { start: d, end: d, label, sub: fmtDateShort(d) };
  }
  if (gran === "week") {
    const end = dayOffset(today, index * 7);
    const start = dayOffset(end, -6);
    const label = index === 0 ? "This week" : index === -1 ? "Last week" : `${-index} weeks ago`;
    return { start, end, label, sub: `${fmtDateShort(start)} – ${fmtDateShort(end)}` };
  }
  // Calendar month.
  const base = parseLocalDay(today);
  const first = new Date(base.getFullYear(), base.getMonth() + index, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  const firstLd = localDay(first);
  const lastLd = localDay(last);
  // Don't project the current (partial) month past today.
  const endLd = index === 0 && lastLd > today ? today : lastLd;
  const label = first.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  return { start: firstLd, end: endLd, label, sub: `${fmtDateShort(firstLd)} – ${fmtDateShort(endLd)}` };
}

// ── Multi-month calendar + picker helpers ─────────────────────────────────────

/** One calendar month laid out for a grid render. */
export interface MonthGrid {
  year: number;
  /** 0-11. */
  monthIndex: number;
  /** "August 2026". */
  label: string;
  /** Blank cells before day 1 = weekday (0=Sun) of the 1st. */
  leading: number;
  /** Every day of the month: its local date + day-of-month. */
  days: { date: string; dom: number }[];
}

/** Build the grid for a single calendar month. */
export function monthGridOf(year: number, monthIndex: number): MonthGrid {
  const first = new Date(year, monthIndex, 1);
  const dim = new Date(year, monthIndex + 1, 0).getDate();
  const days: { date: string; dom: number }[] = [];
  for (let dom = 1; dom <= dim; dom++) {
    days.push({ date: localDay(new Date(year, monthIndex, dom)), dom });
  }
  return {
    year: first.getFullYear(),
    monthIndex: first.getMonth(),
    label: first.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
    leading: first.getDay(),
    days,
  };
}

/** The last `count` calendar months ending with the month containing `today`, OLDEST first. */
export function lastCalendarMonths(today: string, count: number): MonthGrid[] {
  const base = parseLocalDay(today);
  const out: MonthGrid[] = [];
  for (let k = count - 1; k >= 0; k--) {
    const d = new Date(base.getFullYear(), base.getMonth() - k, 1);
    out.push(monthGridOf(d.getFullYear(), d.getMonth()));
  }
  return out;
}

export interface BestWeek {
  start: string;
  end: string;
  mins: number;
}

/** The best rolling 7-consecutive-day window in the series (by total minutes), or null if none. */
export function bestWeek(days: DayStudy[]): BestWeek | null {
  let best: BestWeek | null = null;
  for (let i = 0; i + 7 <= days.length; i++) {
    let sum = 0;
    for (let j = i; j < i + 7; j++) sum += days[j].work_mins;
    if (!best || sum > best.mins) best = { start: days[i].date, end: days[i + 6].date, mins: sum };
  }
  // Fewer than 7 days of history: sum whatever exists.
  if (!best && days.length) {
    best = { start: days[0].date, end: days[days.length - 1].date, mins: sumMins(days) };
  }
  return best && best.mins > 0 ? best : null;
}

/** Month-granularity compare index (0 = current month, negative = past) for a chosen year+month. */
export function monthOffset(year: number, monthIndex: number, today: string): number {
  const base = parseLocalDay(today);
  return (year - base.getFullYear()) * 12 + (monthIndex - base.getMonth());
}

/** Day-granularity compare index for a chosen local date (0 = today, negative = past). */
export function dayOffsetIndex(dateStr: string, today: string): number {
  return Math.round((parseLocalDay(dateStr).getTime() - parseLocalDay(today).getTime()) / 86_400_000);
}

// ── Navigable calendar windows ────────────────────────────────────────────────

export const CALENDAR_WINDOWS = ["Jan – Apr", "May – Aug", "Sep – Dec"] as const;

/**
 * Generate the 4 calendar months for a specific window index (0, 1, or 2) of a given year.
 *   window 0: Jan – Apr (months 0..3)
 *   window 1: May – Aug (months 4..7)
 *   window 2: Sep – Dec (months 8..11)
 * 3 windows × 4 months = 12 months in total.
 */
export function calendarMonthsOfWindow(year: number, windowIndex: number): MonthGrid[] {
  const startMonth = Math.max(0, Math.min(2, windowIndex)) * 4;
  const out: MonthGrid[] = [];
  for (let i = 0; i < 4; i++) {
    out.push(monthGridOf(year, startMonth + i));
  }
  return out;
}

/**
 * Generate 4 calendar months starting from a window offset relative to `today`.
 *   offset  0 → the current window (months ending with the current month)
 *   offset -1 → the previous 4 months
 *   offset  1 → FORBIDDEN (the UI disables the "next" button at offset 0)
 *
 * The offset maps to months: window 0 shows months [today-3..today], window -1 shows
 * [today-7..today-4], etc. Each window is exactly 4 months.
 */
export function calendarMonthsFromOffset(today: string, offset: number, count = 4): MonthGrid[] {
  const base = parseLocalDay(today);
  const endMonth = base.getMonth() + offset * count;
  const out: MonthGrid[] = [];
  for (let k = count - 1; k >= 0; k--) {
    const d = new Date(base.getFullYear(), endMonth - k, 1);
    out.push(monthGridOf(d.getFullYear(), d.getMonth()));
  }
  return out;
}

/** A short label for a 4-month window: "Jun – Sep 2026". */
export function calendarWindowLabel(months: MonthGrid[]): string {
  if (!months.length) return "";
  const first = months[0];
  const last = months[months.length - 1];
  const fm = new Date(first.year, first.monthIndex).toLocaleDateString(undefined, { month: "short" });
  const lm = new Date(last.year, last.monthIndex).toLocaleDateString(undefined, { month: "short" });
  const fy = first.year;
  const ly = last.year;
  if (fy === ly) return `${fm} – ${lm} ${ly}`;
  return `${fm} ${fy} – ${lm} ${ly}`;
}

// ── Study streaks ──────────────────────────────────────────────────────────────

export interface StudyStreaks {
  /** Current consecutive days (from today going back) where the student studied > 0 mins. */
  current: number;
  /** Longest-ever consecutive-day streak in the data. */
  longest: number;
  /** Whether today counts (the student has studied today). */
  activeToday: boolean;
}

/** Count current and longest streaks from the daily array (must be OLDEST-first, contiguous). */
export function studyStreaks(daily: DayStudy[], today: string): StudyStreaks {
  if (!daily.length) return { current: 0, longest: 0, activeToday: false };

  let longest = 0;
  let run = 0;
  for (const d of daily) {
    if (d.work_mins > 0) {
      run++;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }

  // Current streak: walk back from today (the last entry), counting consecutive studied days.
  let current = 0;
  for (let i = daily.length - 1; i >= 0; i--) {
    if (daily[i].work_mins > 0) current++;
    else break;
  }

  const activeToday = daily.length > 0 && daily[daily.length - 1].date === today && daily[daily.length - 1].work_mins > 0;
  return { current, longest, activeToday };
}

// ── Weekday rhythm (which days of the week are strongest?) ────────────────────

export interface WeekdayBucket {
  /** 0=Sun..6=Sat. */
  day: number;
  label: string;
  /** Average minutes on this weekday across the series. */
  avgMins: number;
  /** Share of total study done on this weekday (0–100). */
  pct: number;
}

/** Aggregate study per weekday, averaged over the series. */
export function weekdayRhythm(daily: DayStudy[]): WeekdayBucket[] {
  const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const sums = new Array(7).fill(0);
  const counts = new Array(7).fill(0);

  for (const d of daily) {
    const dow = parseLocalDay(d.date).getDay();
    sums[dow] += d.work_mins;
    counts[dow]++;
  }

  const total = sums.reduce((a, b) => a + b, 0);
  return DAY_LABELS.map((label, i) => ({
    day: i,
    label,
    avgMins: counts[i] > 0 ? sums[i] / counts[i] : 0,
    pct: total > 0 ? Math.round((sums[i] / total) * 100) : 0,
  }));
}
