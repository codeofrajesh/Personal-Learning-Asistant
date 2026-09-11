/**
 * StudyInsights — executive intelligence cards positioned beneath the main period chart.
 *
 * Three cards with substantial height, rich insights, and clean vector icons:
 *   1. **Study Streak** — current streak with exact date range + all-time longest streak with exact dates.
 *   2. **Weekly Rhythm** — peak productive day, study share, lowest/rest day, and 7-day visual distribution.
 *   3. **Consistency & Goals** — 30-day active rate gauge, active vs rest days, and target goal crushed days.
 */

import { useLayoutEffect, useRef, useMemo } from "react";
import { gsap } from "gsap";
import {
  Flame,
  Trophy,
  CalendarRange,
  BarChart3,
  Zap,
  Sparkles,
  Target,
  CheckCircle2,
  Award,
  CircleDot,
} from "lucide-react";
import type { DayStudy } from "../../lib/types";
import { useScheduleClock } from "../../lib/scheduleClock";
import { currentTier, motionAllowed } from "../../lib/perfStore";
import {
  studyStreaks,
  weekdayRhythm,
  fmtHM,
  activeDays,
  fmtDateRange,
} from "./analyticsUtils";
import { cn } from "../../lib/utils";

interface Props {
  daily: DayStudy[];
  targetMins: number | null;
  className?: string;
}

export default function StudyInsights({ daily, targetMins, className }: Props) {
  const today = useScheduleClock((s) => s.day);
  const tier = currentTier();
  const rootRef = useRef<HTMLDivElement>(null);
  const flameRef = useRef<HTMLDivElement>(null);

  const last30 = useMemo(() => daily.slice(Math.max(0, daily.length - 30)), [daily]);
  const streaks = useMemo(() => studyStreaks(daily, today), [daily, today]);
  const rhythm = useMemo(() => weekdayRhythm(last30), [last30]);
  const active = useMemo(() => activeDays(last30), [last30]);
  const consistencyPct = last30.length > 0 ? Math.round((active / last30.length) * 100) : 0;

  // Days in last 30 that met or exceeded the daily target
  const metTargetCount = useMemo(() => {
    if (!targetMins || targetMins <= 0) return null;
    return last30.filter((d) => d.work_mins >= targetMins).length;
  }, [last30, targetMins]);

  // Best and lowest weekday
  const bestDay = useMemo(() => {
    const sorted = [...rhythm].sort((a, b) => b.avgMins - a.avgMins);
    return sorted[0] ?? null;
  }, [rhythm]);

  const lowestDay = useMemo(() => {
    const sorted = [...rhythm].sort((a, b) => a.avgMins - b.avgMins);
    return sorted[0] ?? null;
  }, [rhythm]);

  const maxAvg = Math.max(1, ...rhythm.map((r) => r.avgMins));

  // GSAP entrance for the insights strip
  useLayoutEffect(() => {
    if (!motionAllowed()) return;
    const el = rootRef.current;
    if (!el) return;
    const ctx = gsap.context(() => {
      gsap.from(el.children, {
        y: 10,
        opacity: 0,
        duration: 0.45,
        ease: "power2.out",
        stagger: 0.08,
      });
    }, el);
    return () => ctx.revert();
  }, []);

  // GSAP subtle breathing flame on active days (high tier only)
  useLayoutEffect(() => {
    if (!motionAllowed() || tier !== "high" || !streaks.activeToday) return;
    const el = flameRef.current;
    if (!el) return;
    const ctx = gsap.context(() => {
      gsap.to(el, {
        scale: 1.12,
        duration: 1.1,
        repeat: -1,
        yoyo: true,
        ease: "sine.inOut",
      });
    }, el);
    return () => ctx.revert();
  }, [tier, streaks.activeToday]);

  // Donut SVG parameters
  const donutR = 15;
  const donutC = Math.PI * 2 * donutR;
  const donutFill = (consistencyPct / 100) * donutC;

  return (
    <div
      ref={rootRef}
      className={cn("grid gap-4 sm:grid-cols-3", className)}
    >
      {/* ── CARD 1: STREAKS ────────────────────────────────────────── */}
      <div className="flex min-h-[148px] flex-col justify-between rounded-[16px] border border-white/[0.08] bg-white/[0.025] p-4 transition-all duration-200 hover:border-white/[0.14] hover:bg-white/[0.04]">
        <div>
          {/* Top Bar: Icon + Title + Status Pill */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div
                ref={flameRef}
                className={cn(
                  "grid h-7 w-7 place-items-center rounded-lg transition-transform",
                  streaks.activeToday
                    ? "bg-[#F59E0B]/15 text-[#F59E0B]"
                    : "bg-white/[0.05] text-white/40",
                )}
                style={{
                  boxShadow:
                    streaks.activeToday && tier !== "lite"
                      ? "0 0 14px -2px rgba(245,158,11,0.45)"
                      : undefined,
                }}
              >
                <Flame size={15} strokeWidth={2.2} aria-hidden />
              </div>
              <span className="text-[0.72rem] font-semibold uppercase tracking-wider text-white/50">
                Study Streak
              </span>
            </div>

            {streaks.activeToday ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[0.62rem] font-semibold text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                Active Today
              </span>
            ) : streaks.current > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[0.62rem] font-semibold text-amber-400">
                Extend Today!
              </span>
            ) : (
              <span className="rounded-full bg-white/[0.05] px-2 py-0.5 text-[0.62rem] font-medium text-white/40">
                Start Streak
              </span>
            )}
          </div>

          {/* Main Hero: Current Streak */}
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-2xl font-black tabular-nums text-content-primary">
              {streaks.current}
            </span>
            <span className="text-xs font-semibold text-white/60">
              {streaks.current === 1 ? "day streak" : "days active streak"}
            </span>
          </div>

          {/* Current streak timeline info */}
          <div className="mt-1 flex items-center gap-1.5 text-[0.7rem] text-white/50">
            <CalendarRange size={12} className="shrink-0 text-white/40" aria-hidden />
            <span className="truncate">
              {streaks.current > 0
                ? `Run: ${fmtDateRange(streaks.currentStartDate, streaks.currentEndDate)}`
                : "No active consecutive streak"}
            </span>
          </div>
        </div>

        {/* Bottom Details: Longest Streak Ever */}
        <div className="mt-3 flex items-center justify-between border-t border-white/[0.06] pt-2.5">
          <div className="flex items-center gap-1.5">
            <Trophy size={13} className="text-amber-400 shrink-0" aria-hidden />
            <span className="text-[0.68rem] font-medium text-white/50">All-Time Best:</span>
            <span className="text-[0.72rem] font-bold tabular-nums text-white">
              {streaks.longest} {streaks.longest === 1 ? "day" : "days"}
            </span>
          </div>
          {streaks.longestStartDate && (
            <span className="text-[0.66rem] font-medium tabular-nums text-amber-400/90">
              {fmtDateRange(streaks.longestStartDate, streaks.longestEndDate)}
            </span>
          )}
        </div>
      </div>

      {/* ── CARD 2: WEEKLY RHYTHM ───────────────────────────────────── */}
      <div className="flex min-h-[148px] flex-col justify-between rounded-[16px] border border-white/[0.08] bg-white/[0.025] p-4 transition-all duration-200 hover:border-white/[0.14] hover:bg-white/[0.04]">
        <div>
          {/* Top Bar */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="grid h-7 w-7 place-items-center rounded-lg bg-[#38BDF8]/15 text-[#38BDF8]">
                <BarChart3 size={15} strokeWidth={2.2} aria-hidden />
              </div>
              <span className="text-[0.72rem] font-semibold uppercase tracking-wider text-white/50">
                Weekly Rhythm
              </span>
            </div>

            {bestDay && bestDay.avgMins > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full border border-[#38BDF8]/25 bg-[#38BDF8]/10 px-2 py-0.5 text-[0.62rem] font-semibold text-[#38BDF8]">
                <Zap size={10} strokeWidth={2.2} />
                {bestDay.label} Peak
              </span>
            )}
          </div>

          {/* Main Hero: Best Day Average */}
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-2xl font-black tabular-nums text-content-primary">
              {bestDay && bestDay.avgMins > 0 ? fmtHM(bestDay.avgMins) : "0m"}
            </span>
            <span className="text-xs font-semibold text-white/60">
              {bestDay && bestDay.avgMins > 0
                ? `avg on ${
                    {
                      Sun: "Sundays",
                      Mon: "Mondays",
                      Tue: "Tuesdays",
                      Wed: "Wednesdays",
                      Thu: "Thursdays",
                      Fri: "Fridays",
                      Sat: "Saturdays",
                    }[bestDay.label] ?? `${bestDay.label}s`
                  }`
                : "no weekly signal"}
            </span>
          </div>

          {/* Subtitle breakdown */}
          <div className="mt-1 flex items-center gap-1.5 text-[0.7rem] text-white/50">
            <Sparkles size={12} className="shrink-0 text-[#38BDF8]/70" aria-hidden />
            <span className="truncate">
              {bestDay && bestDay.avgMins > 0
                ? `${bestDay.pct}% of study volume · Min: ${lowestDay?.label ?? "—"} (${lowestDay ? fmtHM(lowestDay.avgMins) : "0m"})`
                : "Log study sessions to view rhythm"}
            </span>
          </div>
        </div>

        {/* Visual Mini 7-Day Chart with Baseline */}
        <div className="mt-3 border-t border-white/[0.06] pt-2">
          <div className="flex h-7 items-end gap-1">
            {rhythm.map((r) => {
              const h = maxAvg > 0 ? Math.max(r.avgMins > 0 ? 12 : 0, (r.avgMins / maxAvg) * 100) : 0;
              const isBest = bestDay && r.day === bestDay.day && r.avgMins > 0;
              return (
                <div
                  key={r.day}
                  className="flex flex-1 flex-col items-center justify-end"
                  title={`${r.label} · avg ${fmtHM(r.avgMins)} · ${r.pct}% of total`}
                >
                  <div
                    className={cn(
                      "w-full rounded-t-[3px] transition-[height] duration-500",
                      isBest ? "bg-[#38BDF8]" : r.avgMins > 0 ? "bg-white/30 hover:bg-white/45" : "bg-white/[0.06]",
                    )}
                    style={{
                      height: `${h}%`,
                      minHeight: r.avgMins > 0 ? "4px" : "2px",
                      boxShadow: isBest && tier !== "lite" ? "0 0 8px -1px #38BDF8" : undefined,
                    }}
                  />
                </div>
              );
            })}
          </div>

          {/* Baseline */}
          <div className="h-[1.5px] w-full rounded-full bg-white/[0.15] mt-0.5" />

          {/* Day initials */}
          <div className="mt-1 flex gap-1">
            {rhythm.map((r) => {
              const isBest = bestDay && r.day === bestDay.day && r.avgMins > 0;
              return (
                <div
                  key={`l-${r.day}`}
                  className={cn(
                    "flex-1 text-center text-[0.6rem] font-semibold tabular-nums",
                    isBest ? "text-[#38BDF8]" : "text-white/45",
                  )}
                >
                  {r.label.charAt(0)}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── CARD 3: 30-DAY CONSISTENCY & GOALS ───────────────────────── */}
      <div className="flex min-h-[148px] flex-col justify-between rounded-[16px] border border-white/[0.08] bg-white/[0.025] p-4 transition-all duration-200 hover:border-white/[0.14] hover:bg-white/[0.04]">
        <div>
          {/* Top Bar */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="grid h-7 w-7 place-items-center rounded-lg bg-emerald-500/15 text-emerald-400">
                <Target size={15} strokeWidth={2.2} aria-hidden />
              </div>
              <span className="text-[0.72rem] font-semibold uppercase tracking-wider text-white/50">
                30-Day Consistency
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              <span className="rounded-full border border-white/10 bg-white/[0.05] px-2 py-0.5 text-[0.62rem] font-semibold text-white/70">
                {last30.length > 0 ? fmtDateRange(last30[0].date, last30[last30.length - 1].date) : "30 Days"}
              </span>
              <span className="rounded-full bg-white/[0.05] px-2 py-0.5 text-[0.62rem] font-medium text-white/50">
                {consistencyPct >= 70 ? "Consistent" : consistencyPct >= 40 ? "Building" : "Developing"}
              </span>
            </div>
          </div>

          {/* Hero: Gauge Ring + Big Percentage */}
          <div className="mt-3 flex items-center gap-3">
            <div className="relative h-10 w-10 shrink-0">
              <svg viewBox="0 0 38 38" className="h-full w-full -rotate-90">
                <circle
                  cx={19}
                  cy={19}
                  r={donutR}
                  fill="none"
                  stroke="rgba(255,255,255,0.08)"
                  strokeWidth={3.8}
                />
                <circle
                  cx={19}
                  cy={19}
                  r={donutR}
                  fill="none"
                  stroke={consistencyPct >= 70 ? "#10B981" : consistencyPct >= 40 ? "#2563EB" : "#EF4444"}
                  strokeWidth={3.8}
                  strokeLinecap="round"
                  strokeDasharray={`${donutFill} ${donutC}`}
                  style={{
                    transition: "stroke-dasharray 700ms cubic-bezier(0.16,1,0.3,1)",
                  }}
                />
              </svg>
              <div className="absolute inset-0 grid place-items-center">
                <CircleDot size={11} strokeWidth={2.5} className="text-white/35" aria-hidden />
              </div>
            </div>

            <div className="min-w-0">
              <div className="flex items-baseline gap-1.5">
                <span className="text-2xl font-black tabular-nums text-content-primary">
                  {consistencyPct}%
                </span>
                <span className="text-xs font-semibold text-white/60">study frequency</span>
              </div>
              <div className="flex items-center gap-1.5 text-[0.7rem] text-white/50">
                <CheckCircle2 size={12} className="shrink-0 text-emerald-400" aria-hidden />
                <span className="truncate">
                  {active} active of {last30.length} days ({Math.max(0, last30.length - active)} rest)
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Details: Target Goal Met Days */}
        <div className="mt-3 flex items-center justify-between border-t border-white/[0.06] pt-2.5">
          <div className="flex items-center gap-1.5">
            <Award size={13} className="text-emerald-400 shrink-0" aria-hidden />
            <span className="text-[0.68rem] font-medium text-white/50">Target Crushed:</span>
            <span className="text-[0.72rem] font-bold tabular-nums text-white">
              {metTargetCount ?? 0} {metTargetCount === 1 ? "day" : "days"}
            </span>
          </div>
          <span className="text-[0.66rem] font-medium tabular-nums text-emerald-400/90">
            {targetMins && targetMins > 0 ? `≥ ${fmtHM(targetMins)}/day` : "No goal set"}
          </span>
        </div>
      </div>
    </div>
  );
}
