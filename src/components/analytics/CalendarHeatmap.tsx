/**
 * CalendarHeatmap — a navigable multi-month consistency tracker (GitHub/Linear-style).
 *
 * Shows 4 calendar months side-by-side in a "window". The student can page back/forward
 * between 4-month windows (prev/next arrows) or jump to any year via a year-pill dropdown,
 * and navigate directly between the 4-month windows of the year:
 *   Window 0: Jan – Apr (months 1–4)
 *   Window 1: May – Aug (months 5–8)
 *   Window 2: Sep – Dec (months 9–12)
 * 3 windows × 4 months = 12 months in total.
 *
 * Each day is a compact squircle colored by performance vs the daily target:
 *   warm amber → below target    |   cyan → target met    |   emerald+gold → over
 *   muted translucent → rest day
 *
 * Hovering shows date + hours + status. Clicking any two days seeds the Day-vs-Day compare.
 * Pure CSS/DOM; glows static, gated OFF on lite. Navigation transitions use GSAP on
 * high/balanced, instant on lite.
 */

import { useLayoutEffect, useRef, useState, useMemo, useEffect } from "react";
import { gsap } from "gsap";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import type { DayStudy } from "../../lib/types";
import { useScheduleClock } from "../../lib/scheduleClock";
import { motionAllowed } from "../../lib/perfStore";
import { ipc, isTauri } from "../../lib/ipc";
import { localUtcOffsetMins } from "../planning/usePeakHours";
import {
  performanceTone,
  fmtDateShort,
  fmtHM,
  calendarMonthsOfWindow,
  CALENDAR_WINDOWS,
  parseLocalDay,
  DEFAULT_TARGET_MINS,
} from "./analyticsUtils";
import { cn } from "../../lib/utils";

interface Props {
  daily: DayStudy[];
  targetMins: number | null;
  onPickDay?: (date: string) => void;
  selectedDays?: string[];
}

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

export default function CalendarHeatmap({ daily, targetMins, onPickDay, selectedDays }: Props) {
  const today = useScheduleClock((s) => s.day);
  const target = targetMins ?? 0;

  const baseDate = parseLocalDay(today);
  const currentYear = baseDate.getFullYear();
  const currentMonth = baseDate.getMonth();
  const currentWindowIndex = Math.floor(currentMonth / 4);

  // Selected year and 4-month window (0: Jan-Apr, 1: May-Aug, 2: Sep-Dec)
  const [selectedYear, setSelectedYear] = useState(currentYear);
  const [windowIndex, setWindowIndex] = useState(currentWindowIndex);
  const [yearPickerOpen, setYearPickerOpen] = useState(false);

  // Cache past years loaded via ipc.studyRange
  const [pastYearDaily, setPastYearDaily] = useState<Record<number, DayStudy[]>>({});

  // Asynchronously fetch past year data if user selects a prior year
  useEffect(() => {
    if (selectedYear === currentYear) return;
    if (pastYearDaily[selectedYear]) return;
    if (!isTauri()) return;

    let alive = true;
    void ipc
      .studyRange(`${selectedYear}-01-01`, `${selectedYear}-12-31`, localUtcOffsetMins())
      .then((res) => {
        if (alive && res?.daily) {
          setPastYearDaily((prev) => ({ ...prev, [selectedYear]: res.daily }));
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [selectedYear, currentYear, pastYearDaily]);

  const activeDaily = selectedYear === currentYear ? daily : (pastYearDaily[selectedYear] ?? []);
  const byDate = useMemo(() => new Map(activeDaily.map((d) => [d.date, d])), [activeDaily]);

  const gridRef = useRef<HTMLDivElement>(null);
  const months = useMemo(() => calendarMonthsOfWindow(selectedYear, windowIndex), [selectedYear, windowIndex]);

  // Year choices: browsable up to 4 years back
  const years = useMemo(() => Array.from({ length: 4 }, (_, i) => currentYear - i), [currentYear]);

  // Prev / Next limits
  const cannotGoPrev = selectedYear <= currentYear - 3 && windowIndex === 0;
  const cannotGoNext = selectedYear === currentYear && windowIndex >= currentWindowIndex;

  function goPrev() {
    if (windowIndex > 0) {
      setWindowIndex(windowIndex - 1);
    } else if (selectedYear > currentYear - 3) {
      setSelectedYear(selectedYear - 1);
      setWindowIndex(2); // Go to Sep–Dec of previous year
    }
  }

  function goNext() {
    if (windowIndex < 2) {
      if (selectedYear === currentYear && windowIndex + 1 > currentWindowIndex) return;
      setWindowIndex(windowIndex + 1);
    } else if (selectedYear < currentYear) {
      setSelectedYear(selectedYear + 1);
      setWindowIndex(0); // Go to Jan–Apr of next year
    }
  }

  // GSAP entrance for the month grid when navigating
  useLayoutEffect(() => {
    if (!motionAllowed()) return;
    const el = gridRef.current;
    if (!el) return;
    const ctx = gsap.context(() => {
      gsap.from(el.children, {
        y: 12,
        opacity: 0,
        duration: 0.35,
        ease: "power2.out",
        stagger: 0.06,
      });
    }, el);
    return () => ctx.revert();
  }, [selectedYear, windowIndex]);

  // Compute window study metrics to give motivating stats
  const windowMetrics = useMemo(() => {
    let studiedDays = 0;
    let metDays = 0;
    let totalMins = 0;
    const effectiveTarget = target > 0 ? target : DEFAULT_TARGET_MINS;
    for (const m of months) {
      for (const { date } of m.days) {
        if (date > today) continue;
        const e = byDate.get(date);
        if (e && e.work_mins > 0) {
          studiedDays++;
          totalMins += e.work_mins;
          if (e.work_mins >= effectiveTarget) {
            metDays++;
          }
        }
      }
    }
    return { studiedDays, metDays, totalMins };
  }, [months, byDate, today, target]);

  return (
    <div
      className="relative overflow-hidden rounded-[24px] border border-white/[0.08] p-6 backdrop-blur-2xl shadow-2xl"
      style={{
        background: "radial-gradient(ellipse at 50% -15%, rgba(37, 99, 235, 0.07) 0%, transparent 65%), #0d0d12",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.06), 0 20px 40px -15px rgba(0,0,0,0.6)",
      }}
    >
      {/* Header with navigation */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-1.5 text-[0.68rem] font-semibold uppercase tracking-wider text-white/50">
            <CalendarDays size={14} strokeWidth={2.25} className="text-blue-400" aria-hidden />
            Consistency Tracker
          </span>

          {/* Year pill */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setYearPickerOpen((v) => !v)}
              className={cn(
                "flex items-center gap-1 rounded-full border px-3 py-1 text-[0.7rem] font-semibold tabular-nums transition-colors",
                yearPickerOpen
                  ? "border-blue-500/40 bg-blue-500/10 text-blue-300"
                  : "border-white/[0.08] bg-white/[0.03] text-content-secondary hover:bg-white/[0.06] hover:text-white",
              )}
            >
              {selectedYear}
              <ChevronRight
                size={11}
                strokeWidth={2.5}
                className={cn("transition-transform duration-200", yearPickerOpen && "rotate-90")}
                aria-hidden
              />
            </button>
            {yearPickerOpen && (
              <div className="absolute left-0 top-full z-30 mt-1.5 min-w-[5.5rem] rounded-[14px] border border-white/10 bg-[#16161c]/95 p-1.5 shadow-2xl backdrop-blur-xl">
                {years.map((yr) => (
                  <button
                    key={yr}
                    type="button"
                    onClick={() => {
                      setSelectedYear(yr);
                      if (yr === currentYear) {
                        setWindowIndex((cur) => Math.min(cur, currentWindowIndex));
                      }
                      setYearPickerOpen(false);
                    }}
                    className={cn(
                      "block w-full rounded-[10px] px-3 py-1.5 text-left text-[0.72rem] font-semibold tabular-nums transition-colors",
                      yr === selectedYear
                        ? "bg-blue-500/20 text-blue-300 font-bold"
                        : "text-content-secondary hover:bg-white/[0.06] hover:text-white",
                    )}
                  >
                    {yr}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Month window navigation pill (4 months in one window, 4*3 = 12 months) */}
          <div className="flex items-center rounded-full border border-white/[0.08] bg-white/[0.025] p-0.5 text-[0.64rem]">
            {CALENDAR_WINDOWS.map((winLabel, idx) => {
              const isFuture = selectedYear === currentYear && idx > currentWindowIndex;
              const isSelected = windowIndex === idx;
              return (
                <button
                  key={winLabel}
                  type="button"
                  disabled={isFuture}
                  onClick={() => setWindowIndex(idx)}
                  className={cn(
                    "rounded-full px-3 py-1 font-medium transition-all duration-200",
                    isSelected
                      ? "bg-white/12 font-semibold text-white shadow-sm border border-white/10"
                      : isFuture
                        ? "opacity-25 cursor-not-allowed text-white/30"
                        : "text-white/45 hover:text-white/80 hover:bg-white/[0.04]",
                  )}
                >
                  {winLabel}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-3">
          {onPickDay && (
            <span className="text-[0.64rem] font-medium text-white/35">
              Click two days to compare
            </span>
          )}

          {/* Prev / Next 4 months */}
          <div className="flex items-center gap-1 rounded-full border border-white/[0.08] bg-white/[0.025] p-0.5">
            <button
              type="button"
              onClick={goPrev}
              disabled={cannotGoPrev}
              aria-label="Previous 4 months"
              title="Previous 4 months"
              className="grid h-7 w-7 place-items-center rounded-full text-white/60 transition-colors hover:bg-white/[0.08] hover:text-white disabled:opacity-20"
            >
              <ChevronLeft size={14} aria-hidden />
            </button>
            <button
              type="button"
              onClick={goNext}
              disabled={cannotGoNext}
              aria-label="Next 4 months"
              title="Next 4 months"
              className="grid h-7 w-7 place-items-center rounded-full text-white/60 transition-colors hover:bg-white/[0.08] hover:text-white disabled:opacity-20"
            >
              <ChevronRight size={14} aria-hidden />
            </button>
          </div>
        </div>
      </div>

      {/* Month grids (4 months side-by-side) */}
      <div ref={gridRef} className="grid grid-cols-1 gap-x-6 gap-y-6 sm:grid-cols-2 xl:grid-cols-4">
        {months.map((m) => {
          const isCurrentMonth = m.year === currentYear && m.monthIndex === currentMonth;
          return (
            <div key={`${m.year}-${m.monthIndex}`} className="flex flex-col">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-[0.75rem] font-semibold tracking-tight text-white/90">
                  {m.label}
                </span>
                {isCurrentMonth && (
                  <span className="rounded-full border border-blue-500/30 bg-blue-500/15 px-1.5 py-0.5 text-[0.55rem] font-semibold uppercase tracking-wider text-blue-300">
                    Current
                  </span>
                )}
              </div>
              <div className="grid grid-cols-7 gap-1.5">
                {WEEKDAYS.map((w, i) => (
                  <div key={`h${i}`} className="pb-1 text-center text-[0.55rem] font-semibold tracking-wider text-white/30 select-none">
                    {w}
                  </div>
                ))}
                {Array.from({ length: m.leading }).map((_, i) => (
                  <div key={`pad${i}`} aria-hidden />
                ))}
                {m.days.map(({ date, dom }) => {
                  const entry = byDate.get(date);
                  const isToday = date === today;
                  const isFuture = date > today;
                  const selected = selectedDays?.includes(date) ?? false;

                  // Future day: completely hollow dashed stencil, unmistakably distinct from rest days
                  if (isFuture) {
                    return (
                      <div
                        key={date}
                        title={`${fmtDateShort(date)} · Future date`}
                        className="grid aspect-square place-items-center rounded-[7px] border border-dashed border-white/[0.07] bg-transparent text-[0.62rem] font-normal text-white/20 select-none cursor-default"
                      >
                        {dom}
                      </div>
                    );
                  }

                  // Active study day: smooth, consistent, satisfying solid color box
                  if (entry && entry.work_mins > 0) {
                    const tone = performanceTone(entry.work_mins, target);
                    return (
                      <button
                        key={date}
                        type="button"
                        onClick={() => onPickDay?.(date)}
                        disabled={!onPickDay}
                        title={`${fmtDateShort(date)} · ${fmtHM(entry.work_mins)} · ${tone.label}`}
                        className={cn(
                          "relative grid aspect-square place-items-center rounded-[7px] text-[0.66rem] font-semibold tabular-nums transition-transform duration-150 active:scale-95",
                          tone.cellText,
                          onPickDay && "hover:scale-[1.08] hover:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60",
                          selected && "ring-2 ring-white/90 ring-offset-1 ring-offset-[#0d0d12]",
                          isToday && "ring-2 ring-blue-400 ring-offset-2 ring-offset-[#0d0d12]",
                        )}
                        style={{
                          backgroundColor: tone.cellBg,
                        }}
                      >
                        {dom}
                      </button>
                    );
                  }

                  // Rest day: smooth quiet solid dark tile (zero white border lines)
                  return (
                    <button
                      key={date}
                      type="button"
                      onClick={() => onPickDay?.(date)}
                      disabled={!onPickDay}
                      title={`${fmtDateShort(date)} · Rest day`}
                      className={cn(
                        "grid aspect-square place-items-center rounded-[7px] bg-[#181820] text-[0.62rem] font-medium text-white/35 tabular-nums transition-colors duration-150",
                        onPickDay && "hover:bg-[#23232c] hover:text-white/70 active:scale-95",
                        selected && "ring-2 ring-white/80 ring-offset-1 ring-offset-[#0d0d12]",
                        isToday && "ring-2 ring-blue-400 ring-offset-2 ring-offset-[#0d0d12] text-white font-semibold",
                      )}
                    >
                      {dom}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Legend & stats bar */}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-y-3 border-t border-white/[0.06] pt-4.5">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <span className="flex items-center gap-2 text-[0.65rem] font-medium text-white/60">
            <span className="h-3 w-3 rounded-[4px] bg-[#EF4444]" aria-hidden />
            Below target
          </span>
          <span className="flex items-center gap-2 text-[0.65rem] font-medium text-white/60">
            <span className="h-3 w-3 rounded-[4px] bg-[#2563EB]" aria-hidden />
            Target met
          </span>
          <span className="flex items-center gap-2 text-[0.65rem] font-medium text-white/60">
            <span className="h-3 w-3 rounded-[4px] bg-[#F97316]" aria-hidden />
            Over target
          </span>
          <span className="flex items-center gap-2 text-[0.65rem] font-medium text-white/60">
            <span className="h-3 w-3 rounded-[4px] bg-[#181820]" aria-hidden />
            Rest day
          </span>
          <span className="flex items-center gap-2 text-[0.65rem] font-medium text-white/40">
            <span className="h-3 w-3 rounded-[4px] border border-dashed border-white/20 bg-transparent" aria-hidden />
            Future date
          </span>
        </div>

        {windowMetrics.studiedDays > 0 && (
          <div className="flex items-center gap-3 text-[0.68rem] text-white/40 tabular-nums">
            <span>
              Total focus: <strong className="font-semibold text-white/80">{fmtHM(windowMetrics.totalMins)}</strong>
            </span>
            <span className="text-white/20">·</span>
            <span>
              Goal met: <strong className="font-semibold text-white/80">{windowMetrics.metDays}</strong> of <strong className="font-semibold text-white/80">{windowMetrics.studiedDays}</strong> study days
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
