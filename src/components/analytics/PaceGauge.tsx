/**
 * PaceGauge — a 270° SVG arc "speedometer" for today's pace toward the effective daily goal.
 *
 * ## What it measures (the reconciliation rule)
 *
 * The arc fills `studied / goal` where `goal` is the EFFECTIVE goal from `study_meter` — i.e. the
 * sum of today's plan blocks when the day is planned, else the ambition target, else the 2h
 * default. It therefore never contradicts the sidebar meter and never overrides a planned schedule.
 * When the ambition target differs from the effective goal, a tick marks where the target sits on
 * the arc and the caption spells the relationship out ("today's plan is lighter than your target").
 *
 * ## Performance
 *
 * Pure inline SVG — no canvas, no chart library, no animation loop. The fill eases via a CSS
 * `stroke-dasharray` transition on the compositor; the only "glow" is a static drop-shadow on the
 * crushed state (never an animated filter), so it stays cheap behind the 60fps player.
 */

import { useMemo } from "react";
import { Target, Zap, Clock, TrendingUp } from "lucide-react";
import type { StudyMeter } from "../../lib/types";
import { computePace, reconcileCaption, fmtHM, type PaceState } from "./analyticsUtils";
import { cn } from "../../lib/utils";

interface Props {
  meter: StudyMeter | null;
  nowMins: number;
  wakeMins: number;
  hardStopMins: number;
  targetMins: number | null;
}

/** Gradient stops + accent per pace state using the unified color system:
 *  - behind pace: Pure Red (#EF4444 -> #DC2626)
 *  - on pace / ahead: Royal Azure Blue (#2563EB -> #1D4ED8)
 *  - goal crushed / over target: Vibrant Orange (#F97316 -> #EA580C)
 */
const TONES: Record<PaceState, { from: string; to: string; text: string; glow: boolean; chip: string; label: string; Icon: typeof Target }> = {
  crushed: { from: "#F97316", to: "#EA580C", text: "text-orange-300", glow: false, chip: "border-orange-500/35 bg-orange-500/15 text-orange-300", label: "Crushed", Icon: Zap },
  ahead: { from: "#2563EB", to: "#1D4ED8", text: "text-blue-300", glow: false, chip: "border-blue-500/35 bg-blue-500/15 text-blue-300", label: "Ahead", Icon: TrendingUp },
  warning: { from: "#EF4444", to: "#DC2626", text: "text-red-300", glow: false, chip: "border-red-500/35 bg-red-500/12 text-red-300", label: "Behind pace", Icon: Clock },
  idle: { from: "#2563EB", to: "#1D4ED8", text: "text-blue-300", glow: false, chip: "border-blue-500/25 bg-blue-500/10 text-blue-300", label: "No target", Icon: Target },
};

// Geometry: a 270° arc (gap at the bottom). pathLength=100 makes the dash units read as percent.
const R = 78;
const CENTER = 100;
const ARC_UNITS = 75; // 270° of the 100-unit pathLength

export default function PaceGauge({ meter, nowMins, wakeMins, hardStopMins, targetMins }: Props) {
  const pace = useMemo(() => {
    if (!meter) return null;
    return computePace({
      studiedMins: meter.studied_mins,
      goalMins: meter.goal_mins,
      nowMins,
      wakeMins,
      hardStopMins,
      goalSource: meter.goal_source,
    });
  }, [meter, nowMins, wakeMins, hardStopMins]);

  // Where the ambition target sits on the (plan-scaled) arc, when it differs from the goal.
  const tick = useMemo(() => {
    if (!meter || !targetMins || targetMins === meter.goal_mins) return null;
    const frac = Math.max(0, Math.min(1, targetMins / Math.max(1, meter.goal_mins)));
    // Arc starts at 135° (after the rotate) and sweeps 270° clockwise.
    const deg = 135 + frac * 270;
    const rad = (deg * Math.PI) / 180;
    const inner = R - 9;
    const outer = R + 9;
    return {
      x1: CENTER + inner * Math.cos(rad),
      y1: CENTER + inner * Math.sin(rad),
      x2: CENTER + outer * Math.cos(rad),
      y2: CENTER + outer * Math.sin(rad),
    };
  }, [meter, targetMins]);

  if (!meter || !pace) {
    return (
      <div className="grid min-h-[220px] place-items-center rounded-[20px] border border-white/[0.06] bg-white/[0.02] p-5 backdrop-blur-xl">
        <span className="text-sm text-white/30">Loading pace…</span>
      </div>
    );
  }

  const tone = TONES[pace.state];
  const progress = (pace.fill * ARC_UNITS).toFixed(3);
  const caption = reconcileCaption(meter.goal_source, meter.goal_mins, targetMins);

  return (
    <div
      className="relative flex h-full flex-col rounded-[20px] border border-white/[0.06] bg-white/[0.02] p-5 backdrop-blur-xl"
      style={{ boxShadow: "inset 0 1px 1px rgba(255,255,255,0.05)" }}
    >
      <div className="mb-1 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[0.62rem] font-medium uppercase tracking-wide text-white/40">
          <Target size={13} strokeWidth={2.25} className="shrink-0 text-lime" aria-hidden />
          Target pace · today
        </span>
        <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.62rem] font-semibold", tone.chip)}>
          <tone.Icon size={11} strokeWidth={2.5} aria-hidden />
          {tone.label}
        </span>
      </div>

      <div className="relative mx-auto w-full max-w-[240px]">
        <svg viewBox="0 0 200 200" className="w-full" role="img" aria-label={`${pace.pct}% of today's goal`}>
          <defs>
            <linearGradient id="paceArc" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor={tone.from} />
              <stop offset="100%" stopColor={tone.to} />
            </linearGradient>
          </defs>
          <g transform={`rotate(135 ${CENTER} ${CENTER})`}>
            {/* Track (270°) */}
            <circle
              cx={CENTER}
              cy={CENTER}
              r={R}
              fill="none"
              stroke="rgba(255,255,255,0.07)"
              strokeWidth={14}
              strokeLinecap="round"
              pathLength={100}
              strokeDasharray={`${ARC_UNITS} 100`}
            />
            {/* Progress */}
            <circle
              cx={CENTER}
              cy={CENTER}
              r={R}
              fill="none"
              stroke="url(#paceArc)"
              strokeWidth={14}
              strokeLinecap="round"
              pathLength={100}
              strokeDasharray={`${progress} 100`}
              style={{
                transition: "stroke-dasharray 700ms cubic-bezier(0.16,1,0.3,1)",
                filter: tone.glow ? `drop-shadow(0 0 6px ${tone.from})` : undefined,
              }}
            />
          </g>
          {/* Ambition-target tick (only when it differs from the effective goal). */}
          {tick && (
            <line
              x1={tick.x1}
              y1={tick.y1}
              x2={tick.x2}
              y2={tick.y2}
              stroke="rgba(244,244,245,0.7)"
              strokeWidth={2}
              strokeLinecap="round"
            />
          )}
        </svg>

        {/* Center readout */}
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="text-center">
            <div className={cn("text-3xl font-bold leading-none tabular-nums", tone.text)}>
              {pace.pct}%
            </div>
            <div className="mt-1 text-[0.72rem] tabular-nums text-white/45">
              {fmtHM(meter.studied_mins)} / {fmtHM(meter.goal_mins)}
            </div>
          </div>
        </div>
      </div>

      <p className={cn("mt-2 text-center text-[0.78rem] font-medium leading-snug", tone.text)}>
        {pace.message}
      </p>
      <p className="mt-1 text-center text-[0.66rem] leading-snug text-white/35">{caption}</p>
    </div>
  );
}
