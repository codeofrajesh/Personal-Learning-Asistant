/**
 * CumulativeVelocity — study hours accumulating THIS MONTH against an ideal-pace benchmark, wrapped
 * in infographic context so the curve reads clearly:
 *
 *   • Badges: current daily pace + projected month total, a monthly-target progress bar, best week.
 *   • Chart: smooth area curve with glowing anchor dots on study days, a dashed target-pace line,
 *            X-axis date ticks (1/5/10/15/20/25/today), and a solid-vs-dashed legend.
 *
 * Smart date-relative Y-scaling keeps the curve visible (never squashed against an end-of-month
 * cliff). Encouraging copy, never "behind" indictments. Pure composited SVG + CSS; the line's
 * draw-in is `high`-tier only.
 */

import { useLayoutEffect, useRef } from "react";
import { gsap } from "gsap";
import { TrendingUp, Zap, Target, Trophy } from "lucide-react";
import type { DayStudy } from "../../lib/types";
import { useScheduleClock } from "../../lib/scheduleClock";
import { currentTier, motionAllowed } from "../../lib/perfStore";
import { cumulative, fmtHM, fmtDateShort, bestWeek, parseLocalDay, DEFAULT_TARGET_MINS } from "./analyticsUtils";
import { cn } from "../../lib/utils";

interface Props {
  daily: DayStudy[];
  targetMins: number | null;
  periodDays?: DayStudy[];
  periodMode?: "day" | "week" | "month";
  periodLabel?: string;
  totalDaysInPeriod?: number;
}

const W = 100;
const H = 42;
const PANEL = "flex h-full flex-col rounded-[20px] border border-white/[0.06] bg-white/[0.02] p-5 backdrop-blur-xl";

function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}

export default function CumulativeVelocity({
  daily,
  targetMins,
  periodDays,
  periodMode = "month",
  periodLabel,
  totalDaysInPeriod,
}: Props) {
  const lineRef = useRef<SVGPathElement>(null);
  const today = useScheduleClock((s) => s.day);
  const target = targetMins && targetMins > 0 ? targetMins : DEFAULT_TARGET_MINS;
  const glowOk = currentTier() !== "lite";

  const base = parseLocalDay(today);
  const daysInMonth = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
  const firstOfMonth = `${today.slice(0, 7)}-01`;

  // Use periodDays if provided, else fallback to current month up to today
  const activeDays = periodDays ?? daily.filter((d) => d.date >= firstOfMonth && d.date <= today);
  const points = cumulative(activeDays, target);
  const n = points.length;
  const daysElapsed = Math.max(1, n);

  const spanDays = totalDaysInPeriod ?? (periodMode === "week" ? 7 : (periodMode === "month" ? (periodDays?.length ?? daysInMonth) : daysInMonth));

  const actualTotal = n ? points[n - 1].cum : 0;
  const expectedToday = target * daysElapsed;
  const maxY = Math.max(1, actualTotal, expectedToday) * 1.15;

  const x = (i: number) => (n > 1 ? (i / (n - 1)) * W : 0);
  const y = (v: number) => H - (v / maxY) * H;

  const linePts = points.map((p, i) => ({ x: x(i), y: y(p.cum) }));
  const linePath = smoothPath(linePts);
  const areaPath = n > 0 ? `${linePath} L ${W} ${H} L 0 ${H} Z` : "";
  const benchPath = n > 0 ? `M 0 ${y(points[0].benchmark)} L ${W} ${y(expectedToday)}` : "";

  const ahead = actualTotal >= expectedToday;
  const paceMins = actualTotal / daysElapsed;
  const projected = paceMins * spanDays;
  const periodTarget = target * spanDays;
  const progressPct = Math.max(0, Math.min(100, Math.round((actualTotal / Math.max(1, periodTarget)) * 100)));
  const catchUp = Math.max(0, target * (daysElapsed + 1) - actualTotal);
  const best = bestWeek(daily);
  const stroke = ahead ? "#34D399" : "#38BDF8";

  const titleText = periodLabel
    ? `Study velocity · ${periodLabel}`
    : "Study velocity · this month";

  const coach = ahead
    ? `Pacing at ${fmtHM(paceMins)}/day · ${fmtHM(actualTotal - expectedToday)} ahead of your target pace.`
    : catchUp <= target * 2.5
      ? `Pacing at ${fmtHM(paceMins)}/day · aim for ${fmtHM(catchUp)} tomorrow to catch up.`
      : `Pacing at ${fmtHM(paceMins)}/day · every session moves you toward ${fmtHM(target)}/day.`;

  // Glowing anchor dots on days with study, positioned as HTML % overlay so they stay round
  // (an SVG <circle> would distort under preserveAspectRatio="none").
  const dots = points
    .map((p, i) => (activeDays[i]?.work_mins > 0 ? { xPct: x(i), yPct: (y(p.cum) / H) * 100 } : null))
    .filter((d): d is { xPct: number; yPct: number } => d !== null);

  const ticks = [1, 5, 10, 15, 20, 25, daysElapsed].filter((d, i, a) => d <= daysElapsed && a.indexOf(d) === i);

  useLayoutEffect(() => {
    const path = lineRef.current;
    if (!path || !motionAllowed() || currentTier() !== "high") return;
    const len = path.getTotalLength();
    gsap.fromTo(path, { strokeDasharray: len, strokeDashoffset: len }, { strokeDashoffset: 0, duration: 1, ease: "power2.out" });
  }, [linePath]);

  return (
    <div className={PANEL} style={{ boxShadow: "inset 0 1px 1px rgba(255,255,255,0.05)" }}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-1.5 text-[0.62rem] font-medium uppercase tracking-wide text-white/40">
            <TrendingUp size={13} strokeWidth={2.25} className="text-lime" aria-hidden />
            {titleText}
          </div>
          <div className="mt-0.5 text-2xl font-bold tabular-nums text-content-primary">{fmtHM(actualTotal)}</div>
        </div>
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 text-[0.62rem] font-semibold",
            ahead ? "border-[#34D399]/30 bg-[#10B981]/10 text-[#34D399]" : "border-[#38BDF8]/30 bg-[#38BDF8]/10 text-[#38BDF8]",
          )}
        >
          {ahead ? "Ahead of pace" : "Building"}
        </span>
      </div>

      {/* Infographic badges */}
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Badge icon={Zap} tint="text-[#FACC15]">
          <div className="text-sm font-bold tabular-nums text-content-primary">{fmtHM(paceMins)}/day</div>
          <div className="text-[0.62rem] text-white/40">Projected {fmtHM(projected)}</div>
        </Badge>
        <Badge icon={Target} tint="text-[#38BDF8]">
          <div className="text-[0.62rem] tabular-nums text-white/50">
            {fmtHM(actualTotal)} / {fmtHM(periodTarget)} · {progressPct}%
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className="h-full rounded-full"
              style={{
                width: `${progressPct}%`,
                background: "linear-gradient(90deg, #0e7490, #00D2FF)",
                boxShadow: glowOk ? "0 0 8px rgba(0,210,255,0.5)" : undefined,
              }}
            />
          </div>
        </Badge>
        <Badge icon={Trophy} tint="text-lime">
          <div className="text-sm font-bold tabular-nums text-content-primary">{best ? fmtHM(best.mins) : "—"}</div>
          <div className="text-[0.62rem] text-white/40">{best ? `Best week · ${fmtDateShort(best.start)}–${fmtDateShort(best.end)}` : "No week yet"}</div>
        </Badge>
      </div>

      {/* Chart */}
      <div className="relative mt-4 h-28 flex-1">
        <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 h-full w-full" preserveAspectRatio="none" role="img" aria-label="Cumulative study hours this month vs target pace">
          <defs>
            <linearGradient id="cumFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity={0.32} />
              <stop offset="100%" stopColor={stroke} stopOpacity={0} />
            </linearGradient>
          </defs>
          {areaPath && <path d={areaPath} fill="url(#cumFill)" stroke="none" />}
          {benchPath && (
            <path d={benchPath} fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
          )}
          {linePath && (
            <path
              ref={lineRef}
              d={linePath}
              fill="none"
              stroke={stroke}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              pathLength={1}
              strokeDasharray={1}
              style={{ strokeDashoffset: 1 }}
            />
          )}
        </svg>
        {/* Round glowing anchor dots (HTML overlay so they don't distort). */}
        {dots.map((dot, i) => (
          <span
            key={i}
            className="absolute h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{
              left: `${dot.xPct}%`,
              top: `${dot.yPct}%`,
              background: stroke,
              boxShadow: glowOk ? `0 0 6px ${stroke}` : undefined,
            }}
            aria-hidden
          />
        ))}
      </div>

      {/* X-axis date ticks */}
      <div className="relative mt-1 h-3">
        {ticks.map((d) => (
          <span
            key={d}
            className="absolute -translate-x-1/2 text-[0.5rem] tabular-nums text-white/25"
            style={{ left: `${n > 1 ? ((d - 1) / (n - 1)) * 100 : 0}%` }}
          >
            {d}
          </span>
        ))}
      </div>

      {/* Legend + coaching */}
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-white/[0.05] pt-3">
        <span className="flex items-center gap-1.5 text-[0.62rem] text-white/40">
          <span className="h-0.5 w-4 rounded-full" style={{ background: stroke }} aria-hidden />
          Your hours
        </span>
        <span className="flex items-center gap-1.5 text-[0.62rem] text-white/40">
          <span className="h-0 w-4 border-t border-dashed border-white/40" aria-hidden />
          Target pace
        </span>
      </div>
      <p className={cn("mt-2 text-[0.76rem] font-medium leading-snug", ahead ? "text-[#34D399]" : "text-[#7DD3FC]")}>{coach}</p>
    </div>
  );
}

function Badge({ icon: Icon, tint, children }: { icon: typeof Zap; tint: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[12px] border border-white/[0.05] bg-white/[0.02] p-2.5">
      <div className="mb-1 flex items-center gap-1.5 text-[0.55rem] font-medium uppercase tracking-wide text-white/35">
        <Icon size={11} strokeWidth={2.25} className={cn("shrink-0", tint)} aria-hidden />
      </div>
      {children}
    </div>
  );
}
