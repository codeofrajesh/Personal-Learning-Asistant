/**
 * Pomodoro / Focus Timer widget (Dashboard). The full control surface: a circular
 * progress ring with the MM:SS countdown, the current phase label, cycle dots (●●●○),
 * phase switcher pills, and Start/Pause/Resume + Reset/Skip controls.
 *
 * Perf: subscribes to the global timer store with SELECTORS so only this widget
 * re-renders on a tick — the rest of the dashboard is untouched. The countdown digits
 * live in the ring, driven by `remaining` (1 Hz). No local interval; the store owns the
 * single app-wide ticker (survives navigation + restart).
 *
 * Aesthetic (ui-ux-pro-max dark glassmorphism): translucent card, a lime ring for Focus
 * and cyan for breaks (matching the app's lime↔cyan duotone), soft glow on the active
 * arc, tactile controls. lucide-react icons (ui-styling).
 */

import { memo } from "react";
import { Play, Pause, RotateCcw, SkipForward, Timer } from "lucide-react";
import {
  useTimerStore,
  phaseLabel,
  fmtClock,
  TIMER_DEFAULTS,
  type Phase,
} from "../../lib/timerStore";
import { cn } from "../../lib/utils";

const RADIUS = 52;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** Phase → ring color + glow (lime for focus, cyan for breaks). */
function phaseColor(phase: Phase): { stroke: string; text: string; glow: string } {
  if (phase === "work") {
    return { stroke: "#AAFF00", text: "text-lime", glow: "drop-shadow(0 0 6px rgba(170,255,0,0.5))" };
  }
  return { stroke: "#22D3EE", text: "text-cyan-400", glow: "drop-shadow(0 0 6px rgba(34,211,238,0.5))" };
}

const PHASES: Phase[] = ["work", "short_break", "long_break"];

function PomodoroWidgetView() {
  // Selector subscriptions — only the fields this widget shows.
  const phase = useTimerStore((s) => s.phase);
  const running = useTimerStore((s) => s.running);
  const remaining = useTimerStore((s) => s.remaining);
  const phaseTotal = useTimerStore((s) => s.phaseTotal);
  const pausedRemaining = useTimerStore((s) => s.pausedRemaining);
  const completedWork = useTimerStore((s) => s.completedWork);

  const start = useTimerStore((s) => s.start);
  const pause = useTimerStore((s) => s.pause);
  const resume = useTimerStore((s) => s.resume);
  const reset = useTimerStore((s) => s.reset);
  const skip = useTimerStore((s) => s.skip);
  const setPhase = useTimerStore((s) => s.setPhase);

  const paused = !running && pausedRemaining != null;
  const idle = !running && pausedRemaining == null;
  const color = phaseColor(phase);

  const frac = phaseTotal > 0 ? Math.max(0, Math.min(1, remaining / phaseTotal)) : 0;
  const dashOffset = CIRCUMFERENCE * (1 - frac);

  // Cycle dots: how many work blocks completed toward the next long break.
  const cyclePos = completedWork % TIMER_DEFAULTS.longBreakEvery;

  return (
    <section className="pomodoro relative flex h-full flex-col overflow-hidden rounded-[24px] border border-white/[0.06] bg-white/[0.02] p-6 shadow-2xl backdrop-blur-xl">
      <header className="mb-2 flex items-center gap-2">
        <Timer size={17} strokeWidth={2} className="text-content-secondary" aria-hidden />
        <h2 className="text-base font-semibold text-content-primary">Focus timer</h2>
      </header>

      {/* Phase switcher (only when idle — switching mid-run would be confusing) */}
      <div className="mb-4 flex gap-1.5">
        {PHASES.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPhase(p)}
            disabled={!idle}
            aria-pressed={phase === p}
            className={cn(
              "flex-1 rounded-full border px-2 py-1 text-[0.66rem] font-medium transition-colors disabled:cursor-not-allowed",
              phase === p
                ? p === "work"
                  ? "border-lime/40 bg-lime/10 text-lime"
                  : "border-cyan-400/40 bg-cyan-400/10 text-cyan-400"
                : "border-white/[0.06] text-white/45 hover:bg-white/[0.04] disabled:opacity-40",
            )}
          >
            {phaseLabel(p)}
          </button>
        ))}
      </div>

      {/* Ring + countdown */}
      <div className="flex flex-1 items-center justify-center py-1">
        <div className="relative flex h-40 w-40 items-center justify-center">
          <svg className="h-full w-full -rotate-90" viewBox="0 0 120 120" aria-hidden="true">
            <circle cx="60" cy="60" r={RADIUS} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="9" />
            <circle
              cx="60"
              cy="60"
              r={RADIUS}
              fill="none"
              stroke={color.stroke}
              strokeWidth="9"
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={dashOffset}
              className="transition-[stroke-dashoffset] duration-1000 ease-linear"
              style={{ filter: color.glow }}
            />
          </svg>
          <div className="absolute flex flex-col items-center">
            <span className="text-4xl font-bold tabular-nums text-content-primary">
              {fmtClock(remaining)}
            </span>
            <span className={cn("mt-1 text-xs font-medium", color.text)}>{phaseLabel(phase)}</span>
          </div>
        </div>
      </div>

      {/* Cycle dots (●●●○) — work blocks toward the next long break */}
      <div className="mt-3 flex items-center justify-center gap-2" aria-label={`${cyclePos} of ${TIMER_DEFAULTS.longBreakEvery} focus blocks done`}>
        {Array.from({ length: TIMER_DEFAULTS.longBreakEvery }).map((_, i) => (
          <span
            key={i}
            className={cn(
              "h-2 w-2 rounded-full transition-colors",
              i < cyclePos ? "bg-lime shadow-glow-lime" : "bg-white/15",
            )}
            aria-hidden
          />
        ))}
      </div>

      {/* Controls */}
      <div className="mt-4 flex items-center justify-center gap-2.5">
        {/* Reset */}
        <button
          type="button"
          onClick={reset}
          disabled={idle && remaining === phaseTotal}
          aria-label="Reset"
          title="Reset"
          className="grid h-10 w-10 place-items-center rounded-full border border-white/10 text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content-primary disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
        >
          <RotateCcw size={16} strokeWidth={2} aria-hidden />
        </button>

        {/* Primary: start / pause / resume */}
        {running ? (
          <button
            type="button"
            onClick={pause}
            aria-label="Pause"
            className="grid h-14 w-14 place-items-center rounded-full bg-lime text-ink-900 shadow-[0_0_24px_rgba(170,255,0,0.4)] transition-all hover:brightness-105 hover:shadow-[0_0_34px_rgba(170,255,0,0.6)] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/50"
          >
            <Pause size={22} strokeWidth={2.5} fill="currentColor" aria-hidden />
          </button>
        ) : (
          <button
            type="button"
            onClick={paused ? resume : start}
            aria-label={paused ? "Resume" : "Start"}
            className="grid h-14 w-14 place-items-center rounded-full bg-lime text-ink-900 shadow-[0_0_24px_rgba(170,255,0,0.4)] transition-all hover:brightness-105 hover:shadow-[0_0_34px_rgba(170,255,0,0.6)] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/50"
          >
            <Play size={22} strokeWidth={2.5} fill="currentColor" aria-hidden className="ml-0.5" />
          </button>
        )}

        {/* Skip to next phase */}
        <button
          type="button"
          onClick={skip}
          aria-label="Skip to next phase"
          title="Skip"
          className="grid h-10 w-10 place-items-center rounded-full border border-white/10 text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
        >
          <SkipForward size={16} strokeWidth={2} aria-hidden />
        </button>
      </div>
    </section>
  );
}

export default memo(PomodoroWidgetView);
