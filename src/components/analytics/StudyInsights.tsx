/**
 * StudyInsights — a compact "below the chart" strip with genuinely useful derived signals.
 *
 * Three sections, inline:
 *   1. **Streaks** — current + longest consecutive-day streak, with a flame animation on active days.
 *   2. **Weekly rhythm** — which day of the week the student is strongest, tiny bar breakdown.
 *   3. **Consistency rate** — % of days studied in the last 30, with a mini donut + goal count.
 *
 * All data is derived from the `daily` array already fetched — zero new IPC calls. Glows and
 * bar transitions respect the performance tier; the flame pulse is high-tier only.
 */

import { useLayoutEffect, useRef, useMemo } from "react";
import { gsap } from "gsap";
import { Flame, BarChart3, CircleDot } from "lucide-react";
import type { DayStudy } from "../../lib/types";
import { useScheduleClock } from "../../lib/scheduleClock";
import { currentTier, motionAllowed } from "../../lib/perfStore";
import { studyStreaks, weekdayRhythm, fmtHM, activeDays } from "./analyticsUtils";
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

  // Best weekday
  const bestDay = useMemo(() => {
    const sorted = [...rhythm].sort((a, b) => b.avgMins - a.avgMins);
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
        y: 8,
        opacity: 0,
        duration: 0.4,
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

  // Mini donut SVG for consistency
  const donutR = 14;
  const donutC = Math.PI * 2 * donutR;
  const donutFill = (consistencyPct / 100) * donutC;

  return (
    <div
      ref={rootRef}
      className={cn("grid gap-3 sm:grid-cols-3", className)}
    >
      {/* Streaks */}
      <div className="flex items-center gap-3 rounded-[14px] border border-white/[0.05] bg-white/[0.02] px-3.5 py-2.5">
        <div
          ref={flameRef}
          className={cn(
            "grid h-9 w-9 shrink-0 place-items-center rounded-[10px]",
            streaks.activeToday
              ? "bg-[#FACC15]/10 text-[#FACC15]"
              : "bg-white/[0.04] text-white/30",
          )}
          style={{
            boxShadow:
              streaks.activeToday && tier !== "lite"
                ? "0 0 12px -2px rgba(250,204,21,0.35)"
                : undefined,
          }}
        >
          <Flame size={18} strokeWidth={2} aria-hidden />
        </div>
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-bold tabular-nums text-content-primary leading-none">
              {streaks.current}
            </span>
            <span className="text-[0.6rem] font-medium text-white/35">day streak</span>
          </div>
          <div className="mt-0.5 text-[0.62rem] text-white/30">
            Longest: <span className="font-semibold tabular-nums text-white/50">{streaks.longest}</span> days
          </div>
        </div>
      </div>

      {/* Weekly rhythm — mini bar chart */}
      <div className="rounded-[14px] border border-white/[0.05] bg-white/[0.02] px-3.5 py-2.5">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-[0.6rem] font-medium text-white/40">
            <BarChart3 size={12} strokeWidth={2} className="text-[#38BDF8]" aria-hidden />
            Weekly rhythm
          </span>
          {bestDay && bestDay.avgMins > 0 && (
            <span className="text-[0.58rem] font-medium text-[#38BDF8]">
              Best: {bestDay.label} · {fmtHM(bestDay.avgMins)} avg
            </span>
          )}
        </div>
        <div className="flex items-end gap-[5px] h-6">
          {rhythm.map((r) => {
            const h = maxAvg > 0 ? Math.max(r.avgMins > 0 ? 3 : 0, (r.avgMins / maxAvg) * 100) : 0;
            const isBest = bestDay && r.day === bestDay.day && r.avgMins > 0;
            return (
              <div key={r.day} className="flex flex-1 flex-col items-center gap-0.5">
                <div
                  className="w-full rounded-t-[3px] transition-[height] duration-500"
                  style={{
                    height: `${h}%`,
                    background: isBest
                      ? "linear-gradient(to top, #0e7490, #38BDF8)"
                      : r.avgMins > 0
                        ? "linear-gradient(to top, rgba(56,189,248,0.15), rgba(56,189,248,0.4))"
                        : "transparent",
                    boxShadow:
                      isBest && tier !== "lite" ? "0 0 8px -2px #38BDF8" : undefined,
                    minHeight: r.avgMins > 0 ? "3px" : undefined,
                  }}
                  title={`${r.label} · avg ${fmtHM(r.avgMins)} · ${r.pct}%`}
                />
              </div>
            );
          })}
        </div>
        <div className="mt-1 flex gap-[5px]">
          {rhythm.map((r) => (
            <div key={`l-${r.day}`} className="flex-1 text-center text-[0.48rem] font-medium text-white/25">
              {r.label.charAt(0)}
            </div>
          ))}
        </div>
      </div>

      {/* Consistency rate — mini donut */}
      <div className="flex items-center gap-3 rounded-[14px] border border-white/[0.05] bg-white/[0.02] px-3.5 py-2.5">
        <div className="relative h-9 w-9 shrink-0">
          <svg viewBox="0 0 36 36" className="h-full w-full -rotate-90">
            {/* Track */}
            <circle
              cx={18}
              cy={18}
              r={donutR}
              fill="none"
              stroke="rgba(255,255,255,0.07)"
              strokeWidth={3.5}
            />
            {/* Fill */}
            <circle
              cx={18}
              cy={18}
              r={donutR}
              fill="none"
              stroke={consistencyPct >= 70 ? "#22C55E" : consistencyPct >= 40 ? "#F59E0B" : "#DC2626"}
              strokeWidth={3.5}
              strokeLinecap="round"
              strokeDasharray={`${donutFill} ${donutC}`}
              style={{
                transition: "stroke-dasharray 700ms cubic-bezier(0.16,1,0.3,1)",
              }}
            />
          </svg>
          <div className="absolute inset-0 grid place-items-center">
            <CircleDot size={10} strokeWidth={2.5} className="text-white/25" aria-hidden />
          </div>
        </div>
        <div className="min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className="text-lg font-bold tabular-nums text-content-primary leading-none">
              {consistencyPct}%
            </span>
          </div>
          <div className="mt-0.5 text-[0.62rem] text-white/30 truncate">
            Active {active}/{last30.length}d{metTargetCount != null ? ` · ${metTargetCount} hit goal` : " · 30d"}
          </div>
        </div>
      </div>
    </div>
  );
}
