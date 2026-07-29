/**
 * Consistency score card — the headline of the Consistency engine. A big score ring
 * (0-100, lime), a status label (Building/Steady/Strong/Elite), a current streak, and
 * a small SVG trend sparkline of the daily score over the window.
 *
 * All hand-rolled SVG (no chart library — bundle/memory target), matching the app's
 * existing ProgressRing/ActivityChart approach. The ring arc draws on mount via a CSS
 * stroke-dashoffset transition (instant under reduced-motion via the global CSS rule).
 */

import { memo } from "react";
import { Flame } from "lucide-react";
import type { ConsistencyDay } from "../../lib/types";

const RADIUS = 46;
const CIRC = 2 * Math.PI * RADIUS;

/** Score → status label + accent. */
function status(score: number): { label: string; color: string } {
  if (score >= 85) return { label: "Elite", color: "text-lime" };
  if (score >= 60) return { label: "Strong", color: "text-lime" };
  if (score >= 35) return { label: "Steady", color: "text-cyan-400" };
  return { label: "Building", color: "text-orange" };
}

/** Build an SVG polyline path for the score trend (days with signal only). */
function trendPath(days: ConsistencyDay[], w: number, h: number): string {
  const pts = days.filter((d) => d.tasks_due > 0 || d.study_minutes > 0);
  if (pts.length < 2) return "";
  const stepX = w / (pts.length - 1);
  return pts
    .map((d, i) => {
      const x = i * stepX;
      const y = h - (Math.max(0, Math.min(100, d.score)) / 100) * h;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function ConsistencyScoreView({
  score,
  streak,
  days,
}: {
  score: number | null;
  streak: number;
  days: ConsistencyDay[];
}) {
  const pct = score == null ? 0 : Math.round(Math.max(0, Math.min(100, score)));
  const st = status(pct);
  const dashOffset = CIRC * (1 - pct / 100);
  const path = trendPath(days, 100, 32);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-5">
        {/* Score ring */}
        <div className="relative grid h-28 w-28 shrink-0 place-items-center">
          <svg className="h-full w-full -rotate-90" viewBox="0 0 110 110" aria-hidden="true">
            <circle cx="55" cy="55" r={RADIUS} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="8" />
            {score != null && (
              <circle
                cx="55"
                cy="55"
                r={RADIUS}
                fill="none"
                stroke="#AAFF00"
                strokeWidth="8"
                strokeLinecap="round"
                strokeDasharray={CIRC}
                strokeDashoffset={dashOffset}
                className="transition-[stroke-dashoffset] duration-700 ease-smooth"
                style={{ filter: pct > 0 ? "drop-shadow(0 0 6px rgba(170,255,0,0.5))" : "none" }}
              />
            )}
          </svg>
          <div className="absolute flex flex-col items-center">
            {score == null ? (
              <span className="text-sm text-white/40">No data</span>
            ) : (
              <>
                <span className="text-3xl font-bold tabular-nums text-content-primary">{pct}</span>
                <span className={"text-[0.66rem] font-medium " + st.color}>{st.label}</span>
              </>
            )}
          </div>
        </div>

        {/* Meta: label + streak + trend */}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-content-primary">Consistency score</p>
          <p className="mt-0.5 text-xs text-white/40">
            Trailing 13-week average, recent days weighted heavier.
          </p>
          <div className="mt-3 flex items-center gap-2 text-sm font-semibold text-orange">
            <Flame size={15} strokeWidth={2} aria-hidden />
            {streak} {streak === 1 ? "day" : "days"} streak
          </div>
        </div>
      </div>

      {/* Trend sparkline */}
      {path && (
        <div>
          <p className="mb-1.5 text-[0.66rem] text-white/40">Score trend</p>
          <svg viewBox="0 0 100 32" preserveAspectRatio="none" className="h-10 w-full" aria-hidden="true">
            <path d={`${path} L100,32 L0,32 Z`} fill="url(#trendFill)" opacity="0.25" />
            <path d={path} fill="none" stroke="#AAFF00" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            <defs>
              <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#AAFF00" />
                <stop offset="100%" stopColor="#AAFF00" stopOpacity="0" />
              </linearGradient>
            </defs>
          </svg>
        </div>
      )}
    </div>
  );
}

export default memo(ConsistencyScoreView);
