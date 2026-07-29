/**
 * Pomodoro / focus timer — a single global Zustand store (module-scoped) that survives
 * route changes and Chromium background throttling, and rehydrates after an app restart.
 *
 * ── Why timestamp-based (the core rule) ──────────────────────────────────────────────
 * WebView2 (Chromium) throttles background `setInterval` to ~1/sec, then ~1/min after the
 * window is hidden a while. A naïve `secondsLeft--` loop LOSES time when the user
 * navigates to the player or backgrounds the app. So we never store a countdown — we
 * store the absolute `phaseEndsAt` (epoch ms) and derive `remaining = phaseEndsAt - now`
 * on every tick. The 1 Hz interval exists ONLY to trigger a re-render of the digits;
 * there is no drift to correct because time is read from the wall clock, not accumulated.
 *
 * ── Surviving restart ────────────────────────────────────────────────────────────────
 * The whole persistable state is written to `localStorage` on every transition (not every
 * tick). On load we rehydrate; if a running phase's end already passed while the app was
 * closed, we resolve it forward (advance phases / mark done) so the UI is correct on boot.
 *
 * ── Feeding the Dashboard ────────────────────────────────────────────────────────────
 * When a WORK phase completes (or is stopped after real focus time), we log the elapsed
 * focus seconds via `ipc.logSession(null, secs, "work")` so the activity chart + streak
 * reflect Pomodoro focus. Breaks are logged as `short_break`/`long_break` (excluded from
 * study-time aggregates by the backend).
 *
 * Components subscribe with SELECTORS (e.g. `useTimerStore(s => s.remaining)`) so only the
 * ticking parts re-render; the rest of the dashboard never re-renders on a tick.
 */

import { create } from "zustand";
import { ipc, isTauri } from "./ipc";
import { toast } from "./toastStore";

export type Phase = "work" | "short_break" | "long_break";

/** Default phase durations (seconds) + the long-break cadence. */
export const TIMER_DEFAULTS = {
  work: 25 * 60,
  short_break: 5 * 60,
  long_break: 15 * 60,
  /** Long break after this many completed work phases. */
  longBreakEvery: 4,
} as const;

const STORAGE_KEY = "ple.timer.v1";

/** Session-type label for `ipc.logSession`. */
type SessionType = "work" | "short_break" | "long_break";

interface PersistedState {
  phase: Phase;
  /** Running: true while counting down (not paused, not idle). */
  running: boolean;
  /** Epoch ms when the current phase ends (only meaningful while running). */
  phaseEndsAt: number | null;
  /** Seconds left when paused (frozen); null while running. */
  pausedRemaining: number | null;
  /** Completed WORK phases this cycle set (drives the ●●●○ dots + long-break cadence). */
  completedWork: number;
  /** Immutable total for the active/paused session; configuration edits must not change it. */
  currentTotal: number | null;
  /** Configurable durations (seconds). */
  durations: { work: number; short_break: number; long_break: number };
}

interface TimerState extends PersistedState {
  /** Seconds remaining in the current phase (derived; updated at 1 Hz). */
  remaining: number;
  /** Total seconds of the current phase (for the ring fraction). */
  phaseTotal: number;

  // actions
  start: () => void;
  pause: () => void;
  resume: () => void;
  reset: () => void;
  skip: () => void; // finish the current phase now, advance to the next
  setPhase: (phase: Phase) => void;
  /** Update one or more phase durations (seconds). Idle → the visible clock re-syncs
   *  to the new length immediately; a running/paused session keeps its live countdown
   *  and only picks up the new length on its next phase. */
  setDurations: (partial: Partial<PersistedState["durations"]>) => void;
  _tick: () => void;
}

/** Clamp a duration (seconds) to a sane range: 5s … 8h. */
export function clampDuration(secs: number): number {
  if (!Number.isFinite(secs)) return TIMER_DEFAULTS.work;
  return Math.max(5, Math.min(8 * 60 * 60, Math.round(secs)));
}

const now = () => Date.now();

/** Duration (s) of a phase given the current config. */
function durationFor(phase: Phase, durations: PersistedState["durations"]): number {
  return durations[phase];
}

/** Which phase follows `phase`, given how many work blocks are done. */
function nextPhase(phase: Phase, completedWork: number): Phase {
  if (phase === "work") {
    const done = completedWork + 1;
    return done % TIMER_DEFAULTS.longBreakEvery === 0 ? "long_break" : "short_break";
  }
  return "work";
}

/** Human label for a phase. */
export function phaseLabel(phase: Phase): string {
  switch (phase) {
    case "work":
      return "Focus";
    case "short_break":
      return "Short break";
    case "long_break":
      return "Long break";
  }
}

/** Log elapsed seconds of a phase to the backend (best-effort). */
function logPhase(phase: Phase, seconds: number) {
  if (!isTauri() || seconds < 1) return;
  void ipc.logSession(null, Math.round(seconds), phase as SessionType).catch(() => {});
}

/** Read + sanity-resolve persisted state from localStorage. */
function loadPersisted(): PersistedState {
  const fallback: PersistedState = {
    phase: "work",
    running: false,
    phaseEndsAt: null,
    pausedRemaining: null,
    completedWork: 0,
    currentTotal: null,
    durations: {
      work: TIMER_DEFAULTS.work,
      short_break: TIMER_DEFAULTS.short_break,
      long_break: TIMER_DEFAULTS.long_break,
    },
  };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Partial<PersistedState>;
    const phase: Phase = p.phase === "short_break" || p.phase === "long_break" ? p.phase : "work";
    const durations = {
      work: clampDuration(Number(p.durations?.work ?? fallback.durations.work)),
      short_break: clampDuration(Number(p.durations?.short_break ?? fallback.durations.short_break)),
      long_break: clampDuration(Number(p.durations?.long_break ?? fallback.durations.long_break)),
    };
    const phaseEndsAt = Number.isFinite(p.phaseEndsAt) ? Number(p.phaseEndsAt) : null;
    const pausedRemaining = Number.isFinite(p.pausedRemaining) ? Math.max(0, Number(p.pausedRemaining)) : null;
    const running = p.running === true && phaseEndsAt != null;
    return {
      phase,
      running,
      phaseEndsAt: running ? phaseEndsAt : null,
      pausedRemaining: running ? null : pausedRemaining,
      completedWork: Number.isFinite(p.completedWork) ? Math.max(0, Math.floor(Number(p.completedWork))) : 0,
      currentTotal: Number.isFinite(p.currentTotal) ? clampDuration(Number(p.currentTotal)) : null,
      durations,
    };
  } catch {
    return fallback;
  }
}

function persist(s: PersistedState) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        phase: s.phase,
        running: s.running,
        phaseEndsAt: s.phaseEndsAt,
        pausedRemaining: s.pausedRemaining,
        completedWork: s.completedWork,
        currentTotal: s.currentTotal,
        durations: s.durations,
      } satisfies PersistedState),
    );
  } catch {
    /* storage full / unavailable — non-critical */
  }
}

/** Compute the initial derived remaining/total for the store from persisted state. */
function deriveInitial(p: PersistedState): { remaining: number; phaseTotal: number } {
  const phaseTotal = p.currentTotal ?? durationFor(p.phase, p.durations);
  if (p.running && p.phaseEndsAt != null) {
    return { remaining: Math.max(0, Math.round((p.phaseEndsAt - now()) / 1000)), phaseTotal };
  }
  if (p.pausedRemaining != null) {
    return { remaining: Math.max(0, p.pausedRemaining), phaseTotal };
  }
  return { remaining: phaseTotal, phaseTotal };
}

// One app-wide 1 Hz ticker; started on first `start()`, cleared when idle/paused.
let intervalId: number | undefined;
function ensureTicking(tick: () => void) {
  if (intervalId != null) return;
  intervalId = window.setInterval(tick, 1000);
}
function stopTicking() {
  if (intervalId != null) {
    window.clearInterval(intervalId);
    intervalId = undefined;
  }
}

const initial = loadPersisted();
const { remaining: initialRemaining, phaseTotal: initialTotal } = deriveInitial(initial);

export const useTimerStore = create<TimerState>((set, get) => ({
  ...initial,
  remaining: initialRemaining,
  phaseTotal: initialTotal,

  start: () => {
    const s = get();
    const total = durationFor(s.phase, s.durations);
    const endsAt = now() + total * 1000;
    set({ running: true, phaseEndsAt: endsAt, pausedRemaining: null, currentTotal: total, remaining: total, phaseTotal: total });
    persist(get());
    ensureTicking(() => get()._tick());
  },

  pause: () => {
    const s = get();
    if (!s.running || s.phaseEndsAt == null) return;
    const remaining = Math.max(0, Math.round((s.phaseEndsAt - now()) / 1000));
    set({ running: false, pausedRemaining: remaining, phaseEndsAt: null, remaining });
    persist(get());
    stopTicking();
  },

  resume: () => {
    const s = get();
    const remaining = s.pausedRemaining ?? durationFor(s.phase, s.durations);
    const total = s.currentTotal ?? durationFor(s.phase, s.durations);
    const endsAt = now() + remaining * 1000;
    set({ running: true, phaseEndsAt: endsAt, pausedRemaining: null, currentTotal: total, remaining, phaseTotal: total });
    persist(get());
    ensureTicking(() => get()._tick());
  },

  reset: () => {
    // Reset the current phase to full, stop running. Does not log (nothing completed).
    const s = get();
    const total = durationFor(s.phase, s.durations);
    stopTicking();
    set({ running: false, phaseEndsAt: null, pausedRemaining: null, currentTotal: null, remaining: total, phaseTotal: total });
    persist(get());
  },

  skip: () => {
    // Log the elapsed portion of the current phase, then advance to the next phase (idle).
    const s = get();
    const total = s.currentTotal ?? durationFor(s.phase, s.durations);
    const remaining = s.running && s.phaseEndsAt != null
      ? Math.max(0, Math.round((s.phaseEndsAt - now()) / 1000))
      : s.pausedRemaining ?? total;
    const elapsed = total - remaining;
    logPhase(s.phase, elapsed);

    const completedWork = s.phase === "work" ? s.completedWork + 1 : s.completedWork;
    const np = nextPhase(s.phase, s.completedWork);
    const npTotal = durationFor(np, s.durations);
    stopTicking();
    set({
      phase: np,
      completedWork,
      running: false,
      phaseEndsAt: null,
      pausedRemaining: null,
      currentTotal: null,
      remaining: npTotal,
      phaseTotal: npTotal,
    });
    persist(get());
  },

  setPhase: (phase: Phase) => {
    // Manual phase switch (idle only) — reset to that phase's full duration.
    const s = get();
    stopTicking();
    const total = durationFor(phase, s.durations);
    set({ phase, running: false, phaseEndsAt: null, pausedRemaining: null, currentTotal: null, remaining: total, phaseTotal: total });
    persist(get());
  },

  setDurations: (partial) => {
    const s = get();
    const durations = {
      work: clampDuration(partial.work ?? s.durations.work),
      short_break: clampDuration(partial.short_break ?? s.durations.short_break),
      long_break: clampDuration(partial.long_break ?? s.durations.long_break),
    };
    // While idle, re-sync the visible clock to the current phase's new length. A
    // running/paused session keeps its countdown and immutable baseline untouched.
    const idle = !s.running && s.pausedRemaining == null;
    const total = durationFor(s.phase, durations);
    set({
      durations,
      phaseTotal: idle ? total : s.phaseTotal,
      remaining: idle ? total : s.remaining,
    });
    persist(get());
  },

  _tick: () => {
    const s = get();
    if (!s.running || s.phaseEndsAt == null) return;
    const remaining = Math.max(0, Math.round((s.phaseEndsAt - now()) / 1000));
    if (remaining > 0) {
      // Only update if the visible second changed (avoids redundant renders).
      if (remaining !== s.remaining) set({ remaining });
      return;
    }
    // Phase complete — log the full phase, advance.
    const total = s.currentTotal ?? s.phaseTotal;
    logPhase(s.phase, total);
    const completedWork = s.phase === "work" ? s.completedWork + 1 : s.completedWork;
    const np = nextPhase(s.phase, s.completedWork);
    const npTotal = durationFor(np, s.durations);
    stopTicking();
    set({
      phase: np,
      completedWork,
      running: false,
      phaseEndsAt: null,
      pausedRemaining: null,
      currentTotal: null,
      remaining: npTotal,
      phaseTotal: npTotal,
    });
    persist(get());
    // Gentle completion cue (best-effort; ignored if audio is blocked) + a toast.
    playChime();
    notifyPhaseComplete(s.phase, np);
  },
}));

/** Raise a completion toast when a phase ends, nudging the user into the next phase. */
function notifyPhaseComplete(finished: Phase, next: Phase) {
  if (finished === "work") {
    toast({
      tone: "focus",
      title: "Focus session complete",
      body: `Nice work. Time for a ${next === "long_break" ? "long break" : "short break"}.`,
      key: "timer-phase",
      cooldownMs: 2000,
      action: { label: "Start break", run: () => useTimerStore.getState().start() },
    });
  } else {
    toast({
      tone: "break",
      title: "Break's over",
      body: "Ready to get back to it? Start your next focus session.",
      key: "timer-phase",
      cooldownMs: 2000,
      action: { label: "Start focus", run: () => useTimerStore.getState().start() },
    });
  }
}

// ── Boot resolution ────────────────────────────────────────────────────────────────
// If the app was closed mid-phase and the end time already passed, resolve it forward
// once on load so the UI opens in a correct state (and completed focus is logged).
(function resolveOnBoot() {
  const s = useTimerStore.getState();
  if (s.running && s.phaseEndsAt != null) {
    if (s.phaseEndsAt <= now()) {
      // Phase finished while closed — log it and advance to the next (idle) phase.
      logPhase(s.phase, s.currentTotal ?? s.phaseTotal);
      const np = nextPhase(s.phase, s.completedWork);
      const npTotal = durationFor(np, s.durations);
      useTimerStore.setState({
        phase: np,
        completedWork: s.phase === "work" ? s.completedWork + 1 : s.completedWork,
        running: false,
        phaseEndsAt: null,
        pausedRemaining: null,
        currentTotal: null,
        remaining: npTotal,
        phaseTotal: npTotal,
      });
      persist(useTimerStore.getState());
      notifyPhaseComplete(s.phase, np);
    } else {
      // Still running — resume the ticker.
      ensureTicking(() => useTimerStore.getState()._tick());
    }
  }
  // Recompute the correct value the moment the window regains focus (throttling snap).
  if (typeof window !== "undefined") {
    const snap = () => {
      const st = useTimerStore.getState();
      if (st.running && st.phaseEndsAt != null) st._tick();
    };
    window.addEventListener("visibilitychange", snap);
    window.addEventListener("focus", snap);
  }
})();

/** Whether the timer is showing (running or paused mid-phase) — for the mini-indicator. */
export function timerIsActive(s: TimerState): boolean {
  return s.running || s.pausedRemaining != null;
}

/** MM:SS from seconds. */
export function fmtClock(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** A short, self-contained completion chime via the Web Audio API (no asset). */
function playChime() {
  if (typeof window === "undefined") return;
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(660, ctx.currentTime);
    o.frequency.setValueAtTime(880, ctx.currentTime + 0.15);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.55);
    o.onended = () => void ctx.close();
  } catch {
    /* audio unavailable — non-critical */
  }
}
