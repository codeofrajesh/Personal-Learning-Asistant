/**
 * Header "Time Box" — the globally-visible Pomodoro control in the top nav header
 * (every non-player route). Always present so the user can start/see a focus session
 * from anywhere; this is the persistent cross-route timer surface (the Dashboard also
 * provides a larger control backed by the same store).
 *
 * Reads the global timer store via selectors (only the ticking digits re-render). Idle
 * → a compact "Start focus" pill. Running/paused → a live MM:SS pill with a thin ring,
 * phase label, and a play/pause affordance; the ring + accent are lime for focus, cyan
 * for breaks. Clicking the body routes to the Dashboard (full controls). Premium glass
 * to match the floating header.
 */

import { Link } from "react-router-dom";
import { Play, Pause, Timer } from "lucide-react";
import {
  useTimerStore,
  timerIsActive,
  phaseLabel,
  fmtClock,
} from "../../lib/timerStore";
import { cn } from "../../lib/utils";

const R = 15.5;
const CIRC = 2 * Math.PI * R;

export function HeaderTimeBox() {
  const active = useTimerStore(timerIsActive);
  const phase = useTimerStore((s) => s.phase);
  const running = useTimerStore((s) => s.running);
  const remaining = useTimerStore((s) => s.remaining);
  const phaseTotal = useTimerStore((s) => s.phaseTotal);
  const start = useTimerStore((s) => s.start);
  const pause = useTimerStore((s) => s.pause);
  const resume = useTimerStore((s) => s.resume);

  const isWork = phase === "work";
  const accent = isWork ? "text-lime" : "text-cyan-400";
  const stroke = isWork ? "#AAFF00" : "#22D3EE";
  const border = isWork ? "border-lime/25" : "border-cyan-400/25";

  // Idle: a single "Start focus" pill.
  if (!active) {
    return (
      <div className="flex items-center rounded-full border border-white/[0.05] bg-white/[0.02] p-1 shadow-2xl backdrop-blur-xl [box-shadow:0_16px_40px_-12px_rgba(0,0,0,0.55),inset_0_1px_1px_rgba(255,255,255,0.06)]">
        <button
          type="button"
          onClick={start}
          aria-label="Start a focus session"
          title="Start focus"
          className="flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content-primary"
        >
          <Timer size={17} strokeWidth={2} className="text-lime" aria-hidden />
          <span className="hidden sm:inline">Start focus</span>
        </button>
      </div>
    );
  }

  const frac = phaseTotal > 0 ? Math.max(0, Math.min(1, remaining / phaseTotal)) : 0;
  const dashOffset = CIRC * (1 - frac);

  const toggle = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (running) pause();
    else resume();
  };

  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded-full border bg-white/[0.02] p-1 pl-2 shadow-2xl backdrop-blur-xl [box-shadow:0_16px_40px_-12px_rgba(0,0,0,0.55),inset_0_1px_1px_rgba(255,255,255,0.06)]",
        border,
      )}
    >
      <Link
        to="/"
        aria-label={`Focus timer: ${phaseLabel(phase)}, ${fmtClock(remaining)} remaining. Open dashboard.`}
        className="flex items-center gap-2.5 rounded-full py-1 pl-1 pr-2.5 transition-colors hover:bg-white/[0.04]"
      >
        {/* Mini ring with the countdown inside */}
        <span className="relative grid h-10 w-10 shrink-0 place-items-center">
          <svg className="h-full w-full -rotate-90" viewBox="0 0 36 36" aria-hidden="true">
            <circle cx="18" cy="18" r={R} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="3" />
            <circle
              cx="18"
              cy="18"
              r={R}
              fill="none"
              stroke={stroke}
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={CIRC}
              strokeDashoffset={dashOffset}
              className="perf-glow transition-[stroke-dashoffset] duration-1000 ease-linear"
              style={{ filter: `drop-shadow(0 0 4px ${stroke}88)` }}
            />
          </svg>
          <span className={cn("absolute h-2 w-2 rounded-full", isWork ? "bg-lime" : "bg-cyan-400", running && "animate-pulse")} aria-hidden />
        </span>

        <div className="leading-none">
          <div className={cn("font-mono text-base font-bold tabular-nums", accent)}>{fmtClock(remaining)}</div>
          <div className="mt-0.5 text-[11px] text-content-muted">
            {phaseLabel(phase)}
            {!running && " · paused"}
          </div>
        </div>
      </Link>

      <button
        type="button"
        onClick={toggle}
        aria-label={running ? "Pause timer" : "Resume timer"}
        className={cn(
          "grid h-10 w-10 shrink-0 place-items-center rounded-full transition-colors",
          isWork ? "text-lime hover:bg-lime/15" : "text-cyan-400 hover:bg-cyan-400/15",
        )}
      >
        {running ? (
          <Pause size={17} strokeWidth={2.5} fill="currentColor" aria-hidden />
        ) : (
          <Play size={17} strokeWidth={2.5} fill="currentColor" aria-hidden />
        )}
      </button>
    </div>
  );
}

export default HeaderTimeBox;
