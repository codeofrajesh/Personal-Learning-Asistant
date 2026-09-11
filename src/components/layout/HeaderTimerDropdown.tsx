/**
 * HeaderTimerDropdown — the attached popover dropdown for the top-right Pomodoro pill.
 *
 * Provides immediate in-place control without navigating away from the active route:
 *   1. Upward-pointing arrow notch attached seamlessly to the pill.
 *   2. Phase switching: Focus Session, Short Break, Long Break.
 *   3. Quick actions: Play/Pause/Resume, Skip Break/Phase, Reset.
 *   4. Inline duration editor: Adjust minutes for all 3 phases with steppers or direct input.
 *   5. GSAP entrance/exit animations with spring overshoot.
 *   6. Multi-tier performance optimization (High: spring+stagger+blur-2xl, Balanced: smooth
 *      fade+blur-md, Lite: instant snap, solid background, zero blur).
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import gsap from "gsap";
import {
  Play,
  Pause,
  RotateCcw,
  SkipForward,
  Flame,
  Coffee,
  Sparkles,
  ExternalLink,
  Plus,
  Minus,
  RotateCcw as ResetIcon,
} from "lucide-react";
import {
  useTimerStore,
  type Phase,
  phaseLabel,
  fmtClock,
  TIMER_DEFAULTS,
} from "../../lib/timerStore";
import { currentTier, motionAllowed } from "../../lib/perfStore";
import { cn } from "../../lib/utils";

interface HeaderTimerDropdownProps {
  open: boolean;
  onClose: () => void;
}

const PHASE_CONFIG: {
  key: Phase;
  label: string;
  icon: typeof Flame;
  accent: string;
  bgActive: string;
  borderActive: string;
  glow: string;
  minMins: number;
  maxMins: number;
  step: number;
}[] = [
  {
    key: "work",
    label: "Focus",
    icon: Flame,
    accent: "text-lime",
    bgActive: "bg-lime/15",
    borderActive: "border-lime/40",
    glow: "0 0 16px rgba(170,255,0,0.18)",
    minMins: 1,
    maxMins: 180,
    step: 5,
  },
  {
    key: "short_break",
    label: "Short Break",
    icon: Coffee,
    accent: "text-cyan-400",
    bgActive: "bg-cyan-400/15",
    borderActive: "border-cyan-400/40",
    glow: "0 0 16px rgba(34,211,238,0.18)",
    minMins: 1,
    maxMins: 45,
    step: 1,
  },
  {
    key: "long_break",
    label: "Long Break",
    icon: Sparkles,
    accent: "text-purple-400",
    bgActive: "bg-purple-400/15",
    borderActive: "border-purple-400/40",
    glow: "0 0 16px rgba(167,139,250,0.18)",
    minMins: 1,
    maxMins: 90,
    step: 5,
  },
];

export function HeaderTimerDropdown({ open, onClose }: HeaderTimerDropdownProps) {
  // Store subscriptions
  const phase = useTimerStore((s) => s.phase);
  const running = useTimerStore((s) => s.running);
  const remaining = useTimerStore((s) => s.remaining);
  const phaseTotal = useTimerStore((s) => s.phaseTotal);
  const pausedRemaining = useTimerStore((s) => s.pausedRemaining);
  const durations = useTimerStore((s) => s.durations);
  const completedWork = useTimerStore((s) => s.completedWork);

  const start = useTimerStore((s) => s.start);
  const pause = useTimerStore((s) => s.pause);
  const resume = useTimerStore((s) => s.resume);
  const reset = useTimerStore((s) => s.reset);
  const skip = useTimerStore((s) => s.skip);
  const setPhase = useTimerStore((s) => s.setPhase);
  const setDurations = useTimerStore((s) => s.setDurations);

  const panelRef = useRef<HTMLDivElement>(null);
  const [isRendered, setIsRendered] = useState(open);

  const tier = currentTier();
  const allowMotion = motionAllowed();

  const isPaused = !running && pausedRemaining != null;
  const isIdle = !running && pausedRemaining == null;

  // Sync mount/unmount with GSAP entrance/exit
  useEffect(() => {
    if (open) {
      setIsRendered(true);
    }
  }, [open]);

  // Entrance & Exit animation
  useLayoutEffect(() => {
    if (!isRendered || !panelRef.current) return;

    const panel = panelRef.current;

    if (open) {
      if (!allowMotion || tier === "lite") {
        gsap.set(panel, { opacity: 1, y: 0, scale: 1 });
      } else if (tier === "balanced") {
        gsap.fromTo(
          panel,
          { opacity: 0, y: -8, scale: 0.97, transformOrigin: "top right" },
          { opacity: 1, y: 0, scale: 1, duration: 0.18, ease: "power2.out" }
        );
      } else {
        // High tier: spring pop with stagger on inner sections
        gsap.fromTo(
          panel,
          { opacity: 0, y: -12, scale: 0.94, transformOrigin: "top right" },
          { opacity: 1, y: 0, scale: 1, duration: 0.26, ease: "back.out(1.2)" }
        );
        const items = panel.querySelectorAll(".hdr-stagger");
        if (items.length > 0) {
          gsap.fromTo(
            items,
            { opacity: 0, y: 6 },
            { opacity: 1, y: 0, stagger: 0.03, duration: 0.2, ease: "power2.out", delay: 0.04 }
          );
        }
      }
    } else {
      // Closing
      if (!allowMotion || tier === "lite") {
        setIsRendered(false);
      } else {
        gsap.to(panel, {
          opacity: 0,
          y: -8,
          scale: 0.97,
          duration: 0.14,
          ease: "power2.in",
          onComplete: () => setIsRendered(false),
        });
      }
    }
  }, [open, isRendered, allowMotion, tier]);

  // Keyboard (Escape) & click-outside dismissal
  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (e: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  if (!isRendered) return null;

  // Time formatting
  const frac = phaseTotal > 0 ? Math.max(0, Math.min(1, remaining / phaseTotal)) : 0;
  const cyclePos = completedWork % TIMER_DEFAULTS.longBreakEvery;

  // Minutes for each phase
  const workMins = Math.max(1, Math.round(durations.work / 60));
  const shortBreakMins = Math.max(1, Math.round(durations.short_break / 60));
  const longBreakMins = Math.max(1, Math.round(durations.long_break / 60));

  const changeDuration = (p: Phase, deltaMins: number) => {
    const current =
      p === "work" ? workMins : p === "short_break" ? shortBreakMins : longBreakMins;
    const cfg = PHASE_CONFIG.find((c) => c.key === p)!;
    const next = Math.max(cfg.minMins, Math.min(cfg.maxMins, current + deltaMins));
    setDurations({ [p]: next * 60 });
  };

  const setDurationDirect = (p: Phase, raw: string) => {
    const num = parseInt(raw, 10);
    if (isNaN(num)) return;
    const cfg = PHASE_CONFIG.find((c) => c.key === p)!;
    const clamped = Math.max(cfg.minMins, Math.min(cfg.maxMins, num));
    setDurations({ [p]: clamped * 60 });
  };

  const resetAllDefaults = () => {
    setDurations({
      work: TIMER_DEFAULTS.work,
      short_break: TIMER_DEFAULTS.short_break,
      long_break: TIMER_DEFAULTS.long_break,
    });
  };

  const currentTheme =
    phase === "work"
      ? {
          stroke: "#AAFF00",
          text: "text-lime",
          border: "border-lime/30",
          bgActive: "bg-lime/10",
          glow: "rgba(170,255,0,0.3)",
        }
      : phase === "short_break"
      ? {
          stroke: "#22D3EE",
          text: "text-cyan-400",
          border: "border-cyan-400/30",
          bgActive: "bg-cyan-400/10",
          glow: "rgba(34,211,238,0.3)",
        }
      : {
          stroke: "#A78BFA",
          text: "text-purple-400",
          border: "border-purple-400/30",
          bgActive: "bg-purple-400/10",
          glow: "rgba(167,139,250,0.3)",
        };

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Pomodoro timer controls"
      className={cn(
        "absolute right-0 top-[calc(100%+10px)] z-50 w-[336px] rounded-2xl border border-white/10 p-4 shadow-[0_24px_50px_-12px_rgba(0,0,0,0.85)]",
        tier === "lite"
          ? "bg-[#14171f]"
          : tier === "balanced"
          ? "bg-[#0d1017]/95 backdrop-blur-md"
          : "bg-[#0c0f16]/90 backdrop-blur-2xl [box-shadow:0_28px_60px_-14px_rgba(0,0,0,0.9),inset_0_1px_1px_rgba(255,255,255,0.08)]"
      )}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Attached upward-pointing arrow notch */}
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute -top-[7px] right-14 h-3.5 w-3.5 rotate-45 border-l border-t border-white/10",
          tier === "lite" ? "bg-[#14171f]" : "bg-[#0c0f16]"
        )}
      />

      {/* ── 1. Header Row ── */}
      <div className="hdr-stagger mb-3 flex items-center justify-between border-b border-white/[0.06] pb-2.5">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              running
                ? phase === "work"
                  ? "animate-pulse bg-lime shadow-[0_0_8px_#AAFF00]"
                  : phase === "short_break"
                  ? "animate-pulse bg-cyan-400 shadow-[0_0_8px_#22D3EE]"
                  : "animate-pulse bg-purple-400 shadow-[0_0_8px_#A78BFA]"
                : isPaused
                ? "bg-orange-400"
                : "bg-white/30"
            )}
            aria-hidden
          />
          <span className="text-xs font-semibold uppercase tracking-wider text-content-secondary">
            {running
              ? `${phaseLabel(phase)} in progress`
              : isPaused
              ? `${phaseLabel(phase)} paused`
              : "Timer Ready"}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Cycle dots: 4 focus sessions toward a long break */}
          <div
            className="flex items-center gap-1"
            title={`${cyclePos} of ${TIMER_DEFAULTS.longBreakEvery} focus blocks before long break`}
            aria-label={`${cyclePos} of ${TIMER_DEFAULTS.longBreakEvery} focus blocks done`}
          >
            {Array.from({ length: TIMER_DEFAULTS.longBreakEvery }).map((_, i) => (
              <span
                key={i}
                className={cn(
                  "h-1.5 w-1.5 rounded-full transition-colors",
                  i < cyclePos ? "bg-lime shadow-[0_0_6px_rgba(170,255,0,0.5)]" : "bg-white/15"
                )}
                aria-hidden
              />
            ))}
          </div>

          {/* Quick link to Dashboard */}
          <Link
            to="/"
            onClick={onClose}
            title="Open in Dashboard"
            className="rounded p-1 text-content-muted transition-colors hover:bg-white/[0.08] hover:text-content-primary"
          >
            <ExternalLink size={13} strokeWidth={2} />
          </Link>
        </div>
      </div>

      {/* ── 2. Phase Switcher (Focus / Short Break / Long Break) ── */}
      <div className="hdr-stagger mb-3.5 grid grid-cols-3 gap-1.5 rounded-xl border border-white/[0.05] bg-white/[0.02] p-1">
        {PHASE_CONFIG.map((cfg) => {
          const Icon = cfg.icon;
          const isCurrent = phase === cfg.key;
          const mins =
            cfg.key === "work"
              ? workMins
              : cfg.key === "short_break"
              ? shortBreakMins
              : longBreakMins;

          return (
            <button
              key={cfg.key}
              type="button"
              onClick={() => setPhase(cfg.key)}
              aria-pressed={isCurrent}
              style={isCurrent && tier !== "lite" ? { boxShadow: cfg.glow } : undefined}
              className={cn(
                "flex flex-col items-center justify-center rounded-lg border py-2 px-1 text-center transition-all",
                isCurrent
                  ? cn(cfg.bgActive, cfg.borderActive, cfg.accent, "font-semibold")
                  : "border-transparent text-content-secondary hover:bg-white/[0.04] hover:text-content-primary"
              )}
            >
              <Icon size={15} strokeWidth={2.2} className="mb-0.5 shrink-0" aria-hidden />
              <span className="text-[11px] leading-tight">{cfg.label}</span>
              <span className="text-[10px] opacity-70 font-mono">{mins}m</span>
            </button>
          );
        })}
      </div>

      {/* ── 3. Central Countdown & Progress ── */}
      <div className="hdr-stagger mb-3.5 flex flex-col items-center rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 text-center">
        <div className={cn("font-mono text-3xl font-bold tracking-tight tabular-nums", currentTheme.text)}>
          {fmtClock(remaining)}
        </div>

        {/* Progress track */}
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.07]">
          <div
            className={cn("h-full transition-all duration-300", currentTheme.bgActive.replace("/10", ""))}
            style={{
              width: `${(1 - frac) * 100}%`,
              backgroundColor: currentTheme.stroke,
            }}
          />
        </div>

        {/* Action Controls */}
        <div className="mt-3 flex items-center justify-center gap-3">
          {/* Reset */}
          <button
            type="button"
            onClick={reset}
            disabled={isIdle && remaining === phaseTotal}
            title="Reset current phase"
            aria-label="Reset timer"
            className="grid h-8 w-8 place-items-center rounded-full border border-white/10 text-content-secondary transition-colors hover:bg-white/[0.08] hover:text-content-primary disabled:opacity-30"
          >
            <RotateCcw size={14} strokeWidth={2} />
          </button>

          {/* Play / Pause Primary Button */}
          {running ? (
            <button
              type="button"
              onClick={pause}
              aria-label="Pause timer"
              className={cn(
                "flex h-10 items-center gap-1.5 rounded-full px-5 text-xs font-semibold text-ink-950 shadow-lg transition-all hover:brightness-105 active:scale-95",
                phase === "work"
                  ? "bg-lime shadow-[0_0_18px_rgba(170,255,0,0.35)]"
                  : phase === "short_break"
                  ? "bg-cyan-400 shadow-[0_0_18px_rgba(34,211,238,0.35)]"
                  : "bg-purple-400 shadow-[0_0_18px_rgba(167,139,250,0.35)]"
              )}
            >
              <Pause size={14} strokeWidth={2.5} fill="currentColor" />
              <span>Pause</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={isPaused ? resume : start}
              aria-label={isPaused ? "Resume timer" : "Start timer"}
              className={cn(
                "flex h-10 items-center gap-1.5 rounded-full px-5 text-xs font-semibold text-ink-950 shadow-lg transition-all hover:brightness-105 active:scale-95",
                phase === "work"
                  ? "bg-lime shadow-[0_0_18px_rgba(170,255,0,0.35)]"
                  : phase === "short_break"
                  ? "bg-cyan-400 shadow-[0_0_18px_rgba(34,211,238,0.35)]"
                  : "bg-purple-400 shadow-[0_0_18px_rgba(167,139,250,0.35)]"
              )}
            >
              <Play size={14} strokeWidth={2.5} fill="currentColor" className="ml-0.5" />
              <span>{isPaused ? "Resume" : "Start"}</span>
            </button>
          )}

          {/* Skip Break / Skip Phase */}
          <button
            type="button"
            onClick={skip}
            title={phase === "work" ? "Skip to break" : "Skip break & resume focus"}
            aria-label={phase === "work" ? "Skip focus session" : "Skip break"}
            className="flex items-center gap-1 rounded-full border border-white/10 px-2.5 py-1.5 text-xs font-medium text-content-secondary transition-colors hover:bg-white/[0.08] hover:text-content-primary"
          >
            <SkipForward size={13} strokeWidth={2} />
            <span>{phase === "work" ? "Skip" : "Skip break"}</span>
          </button>
        </div>
      </div>

      {/* ── 4. Inline Timing Customizer ── */}
      <div className="hdr-stagger rounded-xl border border-white/[0.06] bg-white/[0.02] p-2.5">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] font-semibold text-content-secondary">
            Phase Durations
          </span>
          <button
            type="button"
            onClick={resetAllDefaults}
            title="Reset to 25 / 5 / 15 defaults"
            className="flex items-center gap-1 text-[10px] text-content-muted transition-colors hover:text-content-primary"
          >
            <ResetIcon size={10} strokeWidth={2} />
            <span>Defaults (25/5/15)</span>
          </button>
        </div>

        <div className="space-y-1.5">
          {PHASE_CONFIG.map((cfg) => {
            const Icon = cfg.icon;
            const currentMins =
              cfg.key === "work"
                ? workMins
                : cfg.key === "short_break"
                ? shortBreakMins
                : longBreakMins;

            return (
              <div
                key={cfg.key}
                className="flex items-center justify-between rounded-lg bg-white/[0.02] px-2 py-1.5 text-xs"
              >
                <div className="flex items-center gap-1.5">
                  <Icon size={13} strokeWidth={2.2} className={cfg.accent} aria-hidden />
                  <span className="font-medium text-content-primary">{cfg.label}</span>
                </div>

                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => changeDuration(cfg.key, -cfg.step)}
                    aria-label={`Decrease ${cfg.label} time`}
                    className="grid h-6 w-6 place-items-center rounded bg-white/[0.05] text-content-secondary transition-colors hover:bg-white/[0.1] hover:text-content-primary active:scale-95"
                  >
                    <Minus size={11} strokeWidth={2.5} />
                  </button>

                  <div className="flex items-center gap-0.5">
                    <input
                      type="number"
                      min={cfg.minMins}
                      max={cfg.maxMins}
                      value={currentMins}
                      onChange={(e) => setDurationDirect(cfg.key, e.target.value)}
                      aria-label={`${cfg.label} minutes`}
                      className="w-8 bg-transparent text-center font-mono text-xs font-bold tabular-nums text-content-primary outline-none focus:text-white [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                    <span className="text-[10px] text-content-muted">m</span>
                  </div>

                  <button
                    type="button"
                    onClick={() => changeDuration(cfg.key, cfg.step)}
                    aria-label={`Increase ${cfg.label} time`}
                    className="grid h-6 w-6 place-items-center rounded bg-white/[0.05] text-content-secondary transition-colors hover:bg-white/[0.1] hover:text-content-primary active:scale-95"
                  >
                    <Plus size={11} strokeWidth={2.5} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Notice if running session */}
        {!isIdle && (
          <p className="mt-2 text-center text-[10px] text-content-muted">
            Active countdown preserved · changes apply to next session
          </p>
        )}
      </div>
    </div>
  );
}

export default HeaderTimerDropdown;
