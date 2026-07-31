/**
 * scheduleClock — ONE global wall-clock source for every time-aware planning surface.
 *
 * ## Why this exists
 *
 * Before this, the app ran two independent clocks and paid for both:
 *
 *   * `useTaskReminders` polled `listTasks()` every 60s forever — 1,440 IPC round-trips a
 *     day whether or not anything was due, and it could still fire up to 60s LATE.
 *   * `PlannerTab` held a 1 Hz `setInterval` that called `setNowTick(Date.now())`, which
 *     re-rendered the entire tab subtree (every task row, the heatmap, Next Up) once a
 *     second purely to keep "in 42m" labels fresh.
 *
 * On the 4 GB target that second one is the expensive half: a whole-subtree reconcile per
 * second competes with video decode. So:
 *
 *   * The clock ticks on the **minute boundary**, not every second. Relative labels are
 *     rendered in minutes ("in 42m"), so a per-second tick could not change a single
 *     pixel — it was pure waste.
 *   * It is a **store with selectors**, so a component subscribing to `minute` re-renders
 *     alone instead of dragging its parent's tree with it.
 *   * Reminders are **event-driven** (see `scheduleReminders.ts`): one `setTimeout` armed
 *     at the next interesting instant, ~30 wakeups a day instead of 1,440 polls, and it
 *     fires ON TIME rather than up to a poll late.
 *   * The now-line is **CSS-animated** (see `Today` view), so it moves smoothly without
 *     any JS in the frame path. This clock never drives animation.
 *
 * ## Timestamp discipline
 *
 * Everything here is LOCAL wall clock, matching the Rust planner (`db::plan`): `day` is a
 * local `YYYY-MM-DD` and `minutes` is minutes since LOCAL midnight. Never `toISOString()`
 * — that would silently shift the planner by the UTC offset.
 *
 * ## Sleep / throttling
 *
 * A `setInterval` is unsafe here: WebView2 throttles background timers, and a suspended
 * laptop can skip hours. So each tick re-arms a fresh `setTimeout` to the NEXT minute
 * boundary (self-correcting — drift can't accumulate), and `visibilitychange` / `focus`
 * force an immediate resync so returning to the app never shows a stale clock or misses a
 * midnight rollover.
 */

import { create } from "zustand";

/** Local `YYYY-MM-DD` for a date. */
export function localDay(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Minutes since LOCAL midnight (0..1439) — the `now_mins` the backend expects. */
export function localMinutes(d: Date = new Date()): number {
  return d.getHours() * 60 + d.getMinutes();
}

/** The local day `offset` days from `day` (handles month/year rollover and DST). */
export function dayOffset(day: string, offset: number): string {
  const [y, m, d] = day.split("-").map(Number);
  // Noon avoids the DST edge where midnight + 1 day can land back on the same date.
  const base = new Date(y, (m ?? 1) - 1, d ?? 1, 12, 0, 0);
  base.setDate(base.getDate() + offset);
  return localDay(base);
}

/** `'HH:MM'` → minutes since midnight, or `null` when malformed (never a silent 0). */
export function hhmmToMins(hhmm: string | null | undefined): number | null {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Minutes since midnight → `'HH:MM'`, clamped inside the day (never wraps to 00:xx). */
export function minsToHhmm(mins: number): string {
  const v = Math.max(0, Math.min(1439, Math.round(mins)));
  return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
}

/** Local wall-clock `YYYY-MM-DD HH:MM:SS` — the only datetime shape the ledger accepts. */
export function localDateTime(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${localDay(d)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Epoch ms for a `day` + minutes-since-midnight, in local time. */
export function dayMinsToMs(day: string, mins: number): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, 0, mins, 0, 0).getTime();
}

/** Compact relative label in the same vocabulary the planner uses ("in 42m", "12m ago"). */
export function relativeMins(deltaMins: number): string {
  const abs = Math.abs(Math.round(deltaMins));
  const unit = abs < 60 ? `${abs}m` : abs < 1440 ? `${Math.round(abs / 60)}h` : `${Math.round(abs / 1440)}d`;
  if (abs === 0) return "now";
  return deltaMins > 0 ? `in ${unit}` : `${unit} ago`;
}

interface ScheduleClockState {
  /** Epoch ms, refreshed on the minute boundary. */
  nowMs: number;
  /** Minutes since local midnight — pass straight to `nowMins` backend params. */
  minutes: number;
  /** Local `YYYY-MM-DD`. Changes exactly once per day, so day-scoped fetches can key on it. */
  day: string;
  /** Bumped on every tick; a component can subscribe to just this to re-render alone. */
  tick: number;
  /** Force a resync (returning from background, or after a mutation that moved the plan). */
  sync: () => void;
}

export const useScheduleClock = create<ScheduleClockState>((set) => ({
  nowMs: Date.now(),
  minutes: localMinutes(),
  day: localDay(),
  tick: 0,
  sync: () => {
    const d = new Date();
    set((s) => ({
      nowMs: d.getTime(),
      minutes: localMinutes(d),
      day: localDay(d),
      tick: s.tick + 1,
    }));
  },
}));

/** Read the clock outside React (stores, timeout callbacks). */
export function clockNow(): { nowMs: number; minutes: number; day: string } {
  const { nowMs, minutes, day } = useScheduleClock.getState();
  return { nowMs, minutes, day };
}

// ── The single timer ─────────────────────────────────────────────────────────
//
// Module scope, started once on import: there is exactly ONE of these for the whole app no
// matter how many components read the clock. Each tick re-arms from the real wall clock, so
// throttling or sleep delays a tick but never makes the clock drift.

let timer: number | undefined;

function armNextMinute() {
  if (typeof window === "undefined") return;
  const ms = 60_000 - (Date.now() % 60_000);
  window.clearTimeout(timer);
  // +50ms so we land just AFTER the boundary; firing at 11:59.999 would publish the old
  // minute and leave every label one minute stale until the following tick.
  timer = window.setTimeout(() => {
    useScheduleClock.getState().sync();
    armNextMinute();
  }, ms + 50);
}

if (typeof window !== "undefined") {
  armNextMinute();
  const resync = () => {
    useScheduleClock.getState().sync();
    armNextMinute();
  };
  // Returning from background may be hours later (a closed laptop lid); resync immediately
  // rather than waiting for a throttled timer that might be minutes out of date.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") resync();
  });
  window.addEventListener("focus", resync);
}
