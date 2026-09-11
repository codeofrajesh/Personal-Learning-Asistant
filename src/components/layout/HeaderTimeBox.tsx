/**
 * Header "Time Box" — the globally-visible Pomodoro control in the top nav header
 * (every non-player route). Always present so the user can start/see a focus session
 * from anywhere; this is the persistent cross-route timer surface.
 *
 * Reads the global timer store via selectors (only the ticking digits re-render).
 * Clicking the pill toggles an attached arrow dropdown menu that allows switching between
 * Focus Session, Short Break, and Long Break, skipping breaks/phases, and customizing durations
 * without leaving the current page.
 */

import { useState } from "react";
import { Play, Pause, Timer, ChevronDown } from "lucide-react";
import {
  useTimerStore,
  timerIsActive,
  phaseLabel,
  fmtClock,
} from "../../lib/timerStore";
import { useActiveBlock } from "../dashboard/useActiveBlock";
import { HeaderTimerDropdown } from "./HeaderTimerDropdown";
import { cn } from "../../lib/utils";

const R = 15.5;
const CIRC = 2 * Math.PI * R;

export function HeaderTimeBox() {
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const active = useTimerStore(timerIsActive);
  const phase = useTimerStore((s) => s.phase);
  const running = useTimerStore((s) => s.running);
  const remaining = useTimerStore((s) => s.remaining);
  const phaseTotal = useTimerStore((s) => s.phaseTotal);
  const start = useTimerStore((s) => s.start);
  const pause = useTimerStore((s) => s.pause);
  const resume = useTimerStore((s) => s.resume);

  // What this focus time is being credited to
  const block = useActiveBlock();

  const isWork = phase === "work";
  const isLongBreak = phase === "long_break";

  const accent = isWork ? "text-lime" : isLongBreak ? "text-purple-400" : "text-cyan-400";
  const stroke = isWork ? "#AAFF00" : isLongBreak ? "#A78BFA" : "#22D3EE";
  const border = isWork
    ? "border-lime/25"
    : isLongBreak
    ? "border-purple-400/25"
    : "border-cyan-400/25";

  // Idle: interactive pill that can start directly or open the configuration dropdown
  if (!active) {
    return (
      <div className="relative">
        <div className="flex items-center gap-1 rounded-full border border-white/[0.06] bg-white/[0.02] p-1 shadow-2xl backdrop-blur-xl [box-shadow:0_16px_40px_-12px_rgba(0,0,0,0.55),inset_0_1px_1px_rgba(255,255,255,0.06)]">
          <button
            type="button"
            onClick={() => setDropdownOpen((v) => !v)}
            aria-expanded={dropdownOpen}
            aria-haspopup="dialog"
            aria-label="Open Pomodoro timer menu"
            title="Focus timer options"
            className="flex items-center gap-2 rounded-full py-1.5 pl-3 pr-2 text-sm font-semibold text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content-primary"
          >
            <Timer size={16} strokeWidth={2} className="text-lime" aria-hidden />
            <span className="hidden sm:inline">Focus timer</span>
            <ChevronDown
              size={14}
              className={cn(
                "text-content-muted transition-transform duration-200",
                dropdownOpen && "rotate-180"
              )}
            />
          </button>

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              start();
            }}
            title="Start focus session immediately"
            aria-label="Start focus session"
            className="grid h-8 w-8 place-items-center rounded-full bg-lime/10 text-lime transition-all hover:bg-lime/20 hover:scale-105 active:scale-95"
          >
            <Play size={14} strokeWidth={2.5} fill="currentColor" className="ml-0.5" />
          </button>
        </div>

        <HeaderTimerDropdown open={dropdownOpen} onClose={() => setDropdownOpen(false)} />
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
    <div className="relative">
      <div
        className={cn(
          "flex items-center gap-1 rounded-full border bg-white/[0.02] p-1 pl-2 shadow-2xl backdrop-blur-xl [box-shadow:0_16px_40px_-12px_rgba(0,0,0,0.55),inset_0_1px_1px_rgba(255,255,255,0.06)]",
          border
        )}
      >
        {/* Clicking the body opens the attached arrow dropdown */}
        <button
          type="button"
          onClick={() => setDropdownOpen((v) => !v)}
          aria-expanded={dropdownOpen}
          aria-haspopup="dialog"
          aria-label={
            `Focus timer: ${phaseLabel(phase)}, ${fmtClock(remaining)} remaining` +
            (block ? `, counting toward ${block.title}` : "") +
            ". Click to open quick controls."
          }
          className="flex items-center gap-2 rounded-full py-1 pl-1 pr-2 text-left transition-colors hover:bg-white/[0.04]"
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
            <span
              className={cn(
                "absolute h-2 w-2 rounded-full",
                isWork ? "bg-lime" : isLongBreak ? "bg-purple-400" : "bg-cyan-400",
                running && "animate-pulse"
              )}
              aria-hidden
            />
          </span>

          <div className="min-w-0 leading-none">
            <div className={cn("font-mono text-base font-bold tabular-nums", accent)}>
              {fmtClock(remaining)}
            </div>
            <div className="mt-0.5 max-w-[8.5rem] truncate text-[11px] text-content-muted">
              {block ? block.title : phaseLabel(phase)}
              {!running && " · paused"}
            </div>
          </div>

          <ChevronDown
            size={14}
            className={cn(
              "ml-0.5 shrink-0 text-content-muted transition-transform duration-200",
              dropdownOpen && "rotate-180"
            )}
          />
        </button>

        {/* Play / Pause affordance */}
        <button
          type="button"
          onClick={toggle}
          aria-label={running ? "Pause timer" : "Resume timer"}
          className={cn(
            "grid h-10 w-10 shrink-0 place-items-center rounded-full transition-colors",
            isWork
              ? "text-lime hover:bg-lime/15"
              : isLongBreak
              ? "text-purple-400 hover:bg-purple-400/15"
              : "text-cyan-400 hover:bg-cyan-400/15"
          )}
        >
          {running ? (
            <Pause size={17} strokeWidth={2.5} fill="currentColor" aria-hidden />
          ) : (
            <Play size={17} strokeWidth={2.5} fill="currentColor" aria-hidden />
          )}
        </button>
      </div>

      <HeaderTimerDropdown open={dropdownOpen} onClose={() => setDropdownOpen(false)} />
    </div>
  );
}

export default HeaderTimeBox;
