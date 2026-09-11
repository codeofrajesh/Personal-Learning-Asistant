/**
 * CumulativeVelocity — study hours accumulating THIS MONTH against an ideal-pace benchmark.
 *
 * Designed for maximum student comprehension:
 *   • Infographic badges: daily burn rate, projected month-end total, ambition goal progress bar, best week.
 *   • Interactive SVG curve with transparent hover columns, vertical crosshair guide, and detailed floating tooltip.
 *   • High-contrast X-axis baseline with aligned date milestone labels (1 Sep, 5 Sep, 10 Sep, etc.).
 *   • Student-friendly legend explaining actual accumulated hours vs ideal target benchmark.
 */

import { useState, useLayoutEffect, useRef } from "react";
import { gsap } from "gsap";
import { TrendingUp, Zap, Target, Trophy } from "lucide-react";
import type { DayStudy } from "../../lib/types";
import { useScheduleClock } from "../../lib/scheduleClock";
import { currentTier, motionAllowed } from "../../lib/perfStore";
import {
  cumulative,
  fmtHM,
  fmtDateShort,
  bestWeek,
  parseLocalDay,
  DEFAULT_TARGET_MINS,
} from "./analyticsUtils";
import { cn } from "../../lib/utils";

interface Props {
  daily: DayStudy[];
  targetMins: number | null;
  periodDays?: DayStudy[];
  periodMode?: "day" | "week" | "month";
  periodLabel?: string;
  totalDaysInPeriod?: number;
  periodGoalMins?: number;
}

const W = 100;
const H = 42;
const PANEL = "flex h-full flex-col rounded-[20px] border border-white/[0.06] bg-white/[0.02] p-5 backdrop-blur-xl";

function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = i > 0 ? pts[i - 1] : pts[0];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = i < pts.length - 2 ? pts[i + 2] : p2;
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
  periodGoalMins,
}: Props) {
  const lineRef = useRef<SVGPathElement>(null);
  const today = useScheduleClock((s) => s.day);
  const target = targetMins && targetMins > 0 ? targetMins : DEFAULT_TARGET_MINS;
  const glowOk = currentTier() !== "lite";

  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const base = parseLocalDay(today);
  const daysInMonth = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
  const firstOfMonth = `${today.slice(0, 7)}-01`;

  const spanDays =
    totalDaysInPeriod ??
    (periodMode === "week" ? 7 : periodMode === "month" ? (periodDays?.length ?? daysInMonth) : daysInMonth);

  const periodTarget = periodGoalMins && periodGoalMins > 0 ? periodGoalMins : target * spanDays;
  const idealDailyRate = periodTarget / Math.max(1, spanDays);

  // Use periodDays if provided, else fallback to current month up to today
  const activeDays = periodDays ?? daily.filter((d) => d.date >= firstOfMonth && d.date <= today);
  const points = cumulative(activeDays, idealDailyRate);
  const n = points.length;
  const daysElapsed = Math.max(1, n);

  const actualTotal = n ? points[n - 1].cum : 0;
  const expectedToday = idealDailyRate * daysElapsed;
  const maxY = Math.max(1, actualTotal, expectedToday, periodTarget) * 1.15;

  const x = (i: number) => (n > 1 ? (i / (n - 1)) * W : 50);
  const y = (v: number) => H - (v / maxY) * H;

  const linePts = points.map((p, i) => ({ x: x(i), y: y(p.cum) }));
  const linePath = smoothPath(linePts);
  const areaPath = n > 0 ? `${linePath} L ${W} ${H} L 0 ${H} Z` : "";
  const benchPath = n > 0 ? `M 0 ${y(points[0].benchmark)} L ${W} ${y(expectedToday)}` : "";

  const ahead = actualTotal >= expectedToday;
  const paceMins = actualTotal / daysElapsed;
  const projected = paceMins * spanDays;
  const progressPct = Math.max(0, Math.min(100, Math.round((actualTotal / Math.max(1, periodTarget)) * 100)));
  const catchUp = Math.max(0, idealDailyRate * (daysElapsed + 1) - actualTotal);
  const best = bestWeek(daily);
  const stroke = ahead ? "#34D399" : "#38BDF8";

  const titleText = periodLabel ? `Study Velocity · ${periodLabel}` : "Study Velocity · This Month";

  // Hovered item details
  const hoveredPoint = hoveredIdx !== null && hoveredIdx >= 0 && hoveredIdx < n ? points[hoveredIdx] : null;
  const hoveredDay = hoveredIdx !== null && hoveredIdx >= 0 && hoveredIdx < n ? activeDays[hoveredIdx] : null;

  const coach = hoveredPoint && hoveredDay
    ? `On ${fmtDateShort(hoveredDay.date)}: ${fmtHM(hoveredDay.work_mins)} studied · Cumulative: ${fmtHM(hoveredPoint.cum)} (${
        hoveredPoint.cum >= hoveredPoint.benchmark
          ? `${fmtHM(hoveredPoint.cum - hoveredPoint.benchmark)} ahead of target pace`
          : `${fmtHM(hoveredPoint.benchmark - hoveredPoint.cum)} behind target pace`
      })`
    : ahead
      ? `Pacing at ${fmtHM(paceMins)}/day · ${fmtHM(actualTotal - expectedToday)} ahead of your target pace.`
      : catchUp <= target * 2.5
        ? `Pacing at ${fmtHM(paceMins)}/day · aim for ${fmtHM(catchUp)} tomorrow to catch up.`
        : `Pacing at ${fmtHM(paceMins)}/day · every session moves you toward ${fmtHM(target)}/day.`;

  // Milestone X-axis tick indices
  const tickIndices: number[] = [];
  if (n > 0) {
    tickIndices.push(0); // Day 1
    const step = n > 20 ? 5 : n > 10 ? 3 : 2;
    for (let i = step - 1; i < n - 1; i += step) {
      if (n - 1 - i >= 2) tickIndices.push(i);
    }
    if (n > 1 && !tickIndices.includes(n - 1)) {
      tickIndices.push(n - 1); // Last day
    }
  }

  useLayoutEffect(() => {
    const path = lineRef.current;
    if (!path || !motionAllowed() || currentTier() !== "high") return;
    const len = path.getTotalLength();
    gsap.fromTo(
      path,
      { strokeDasharray: len, strokeDashoffset: len },
      { strokeDashoffset: 0, duration: 1, ease: "power2.out" },
    );
  }, [linePath]);

  return (
    <div className={PANEL} style={{ boxShadow: "inset 0 1px 1px rgba(255,255,255,0.05)" }}>
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-1.5 text-[0.68rem] font-semibold uppercase tracking-wider text-white/50">
            <TrendingUp size={14} strokeWidth={2.25} className="text-lime" aria-hidden />
            {titleText}
          </div>
          <div className="mt-0.5 text-2xl font-black tabular-nums text-content-primary">
            {fmtHM(actualTotal)}
          </div>
        </div>
        <span
          className={cn(
            "rounded-full border px-2.5 py-0.5 text-[0.66rem] font-semibold",
            ahead
              ? "border-[#34D399]/30 bg-[#10B981]/10 text-[#34D399]"
              : "border-[#38BDF8]/30 bg-[#38BDF8]/10 text-[#38BDF8]",
          )}
        >
          {ahead ? "Ahead of pace" : "Building Momentum"}
        </span>
      </div>

      {/* Infographic badges */}
      <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        <Badge icon={Zap} tint="text-[#FACC15]">
          <div className="text-sm font-bold tabular-nums text-content-primary">
            {fmtHM(paceMins)}/day
          </div>
          <div className="text-[0.66rem] text-white/45">Projected {fmtHM(projected)}</div>
        </Badge>

        <Badge icon={Target} tint="text-[#38BDF8]">
          <div className="text-[0.68rem] tabular-nums text-white/65 font-medium">
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
          <div className="text-sm font-bold tabular-nums text-content-primary">
            {best ? fmtHM(best.mins) : "—"}
          </div>
          <div className="text-[0.66rem] text-white/45 truncate">
            {best ? `Best week · ${fmtDateShort(best.start)}–${fmtDateShort(best.end)}` : "No week yet"}
          </div>
        </Badge>
      </div>

      {/* Chart Area */}
      <div
        className="relative mt-4 h-36 min-h-[140px] flex-1"
        onMouseLeave={() => setHoveredIdx(null)}
      >
        {/* Hover Tooltip */}
        {hoveredIdx !== null && hoveredPoint && hoveredDay && (
          <div
            className="absolute -top-12 z-30 pointer-events-none -translate-x-1/2 rounded-lg border border-white/20 bg-[#121218] px-3 py-1.5 text-[0.7rem] font-semibold text-white shadow-2xl transition-all duration-150"
            style={{ left: `${x(hoveredIdx)}%` }}
          >
            <div className="flex items-center gap-2">
              <span className="text-white font-bold">{fmtDateShort(hoveredDay.date)}</span>
              <span className="text-white/40">·</span>
              <span
                className={cn(
                  "font-semibold",
                  hoveredDay.work_mins >= target ? "text-emerald-400" : "text-white/80",
                )}
              >
                {fmtHM(hoveredDay.work_mins)} logged
              </span>
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[0.66rem] text-white/60">
              <span className="font-bold text-[#38BDF8]">{fmtHM(hoveredPoint.cum)} total</span>
              <span>vs</span>
              <span className="text-white/50">{fmtHM(hoveredPoint.benchmark)} goal</span>
              <span
                className={cn(
                  "font-bold",
                  hoveredPoint.cum >= hoveredPoint.benchmark ? "text-emerald-400" : "text-amber-400",
                )}
              >
                ({hoveredPoint.cum >= hoveredPoint.benchmark
                  ? `+${fmtHM(hoveredPoint.cum - hoveredPoint.benchmark)}`
                  : `-${fmtHM(hoveredPoint.benchmark - hoveredPoint.cum)}`})
              </span>
            </div>
          </div>
        )}

        {/* SVG Curve */}
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="absolute inset-0 h-full w-full overflow-visible"
          preserveAspectRatio="none"
          role="img"
          aria-label="Cumulative study hours vs target pace"
        >
          <defs>
            <linearGradient id="cumFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity={0.32} />
              <stop offset="100%" stopColor={stroke} stopOpacity={0} />
            </linearGradient>
          </defs>

          {areaPath && <path d={areaPath} fill="url(#cumFill)" stroke="none" />}

          {/* Target Pace Dashed Line */}
          {benchPath && (
            <path
              d={benchPath}
              fill="none"
              stroke="rgba(255,255,255,0.4)"
              strokeWidth={1.2}
              strokeDasharray="4 4"
              vectorEffect="non-scaling-stroke"
            />
          )}

          {/* Actual Cumulative Study Line */}
          {linePath && (
            <path
              ref={lineRef}
              d={linePath}
              fill="none"
              stroke={stroke}
              strokeWidth={2.4}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              pathLength={1}
              strokeDasharray={1}
              style={{ strokeDashoffset: 1 }}
            />
          )}
        </svg>

        {/* Vertical Guide Line on Hover */}
        {hoveredIdx !== null && (
          <div
            className="absolute top-0 bottom-0 w-px border-l border-dashed border-cyan-400/60 pointer-events-none"
            style={{ left: `${x(hoveredIdx)}%` }}
          />
        )}

        {/* Anchor Dots on Study Days */}
        {points.map((p, i) => {
          if (activeDays[i]?.work_mins <= 0 && i !== n - 1) return null;
          const isHovered = hoveredIdx === i;
          const leftPct = x(i);
          const topPct = (y(p.cum) / H) * 100;

          return (
            <span
              key={i}
              className={cn(
                "absolute -translate-x-1/2 -translate-y-1/2 rounded-full transition-transform duration-200 pointer-events-none",
                isHovered ? "h-3 w-3 scale-125 ring-4 ring-cyan-400/30" : "h-2 w-2",
              )}
              style={{
                left: `${leftPct}%`,
                top: `${topPct}%`,
                background: stroke,
                boxShadow: glowOk ? `0 0 8px ${stroke}` : undefined,
              }}
              aria-hidden
            />
          );
        })}

        {/* Invisible Vertical Column Hover Trigger Zones */}
        <div className="absolute inset-0 flex">
          {points.map((_, i) => (
            <div
              key={i}
              className="flex-1 cursor-crosshair"
              onMouseEnter={() => setHoveredIdx(i)}
            />
          ))}
        </div>
      </div>

      {/* Crisp Solid X-Axis Baseline */}
      <div className="mt-2 h-[2px] w-full rounded-full bg-white/[0.18]" />

      {/* Prominent High-Contrast Date Milestone Labels */}
      <div className="relative mt-1 h-5">
        {tickIndices.map((idx) => {
          const d = activeDays[idx];
          if (!d) return null;
          const isCurrent = d.date === today;
          const leftPct = x(idx);

          return (
            <div
              key={d.date}
              className="absolute -translate-x-1/2 flex flex-col items-center"
              style={{ left: `${leftPct}%` }}
            >
              {/* Tick line connecting to baseline */}
              <div
                className={cn(
                  "rounded-full",
                  isCurrent ? "h-1.5 w-[2px] bg-lime" : "h-1 w-[1.5px] bg-white/50",
                )}
              />
              <span
                className={cn(
                  "mt-0.5 whitespace-nowrap text-[0.68rem] font-semibold tabular-nums",
                  isCurrent ? "text-lime font-bold" : "text-white/80",
                )}
              >
                {fmtDateShort(d.date)}
              </span>
            </div>
          );
        })}
      </div>

      {/* Student-Friendly Legend */}
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-white/[0.06] pt-3 text-[0.72rem] font-medium text-white/60">
        <span className="flex items-center gap-2">
          <span className="h-0.5 w-4 rounded-full" style={{ background: stroke }} aria-hidden />
          <span className="text-white/80 font-semibold">Your Hours</span>
          <span className="text-white/40">(accumulated focus)</span>
        </span>
        <span className="flex items-center gap-2">
          <span className="h-0 w-4 border-t-2 border-dashed border-white/40" aria-hidden />
          <span className="text-white/80 font-semibold">Target Pace</span>
          <span className="text-white/40">({fmtHM(periodTarget)} goal line)</span>
        </span>
      </div>

      {/* Coaching readout */}
      <p
        className={cn(
          "mt-2 text-[0.76rem] font-medium leading-snug transition-colors",
          hoveredIdx !== null ? "text-white/90 font-semibold" : ahead ? "text-[#34D399]" : "text-[#7DD3FC]",
        )}
      >
        {coach}
      </p>
    </div>
  );
}

function Badge({
  icon: Icon,
  tint,
  children,
}: {
  icon: typeof Zap;
  tint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-[14px] border border-white/[0.06] bg-white/[0.025] p-3">
      <div className="mb-1 flex items-center gap-1.5 text-[0.62rem] font-semibold uppercase tracking-wider text-white/40">
        <Icon size={12} strokeWidth={2.25} className={cn("shrink-0", tint)} aria-hidden />
      </div>
      {children}
    </div>
  );
}
