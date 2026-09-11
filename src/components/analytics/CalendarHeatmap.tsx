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

  return (
    <div
      className="rounded-[20px] border border-white/[0.06] bg-[#121215] p-5 backdrop-blur-xl"
      style={{ boxShadow: "inset 0 1px 1px rgba(255,255,255,0.04)" }}
    >
      {/* Header with navigation */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-1.5 text-[0.62rem] font-medium uppercase tracking-wide text-white/40">
            <CalendarDays size={13} strokeWidth={2.25} className="text-lime" aria-hidden />
            Consistency
          </span>

          {/* Year pill */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setYearPickerOpen((v) => !v)}
              className={cn(
                "flex items-center gap-1 rounded-full border px-2.5 py-1 text-[0.68rem] font-semibold tabular-nums transition-colors",
                yearPickerOpen
                  ? "border-lime/40 bg-lime/10 text-lime"
                  : "border-white/[0.08] bg-white/[0.03] text-content-secondary hover:bg-white/[0.06]",
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
              <div className="absolute left-0 top-full z-30 mt-1.5 min-w-[5.5rem] rounded-[14px] border border-white/[0.08] bg-[#1a1a1e]/95 p-1.5 shadow-xl backdrop-blur-xl">
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
                        ? "bg-lime/15 text-lime"
                        : "text-content-secondary hover:bg-white/[0.06]",
                    )}
                  >
                    {yr}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Month window navigation pill (4 months in one window, 4*3 = 12 months) */}
          <div className="flex items-center rounded-full border border-white/[0.08] bg-white/[0.03] p-0.5 text-[0.62rem]">
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
                    "rounded-full px-2.5 py-0.5 font-medium transition-all duration-200",
                    isSelected
                      ? "bg-lime/15 font-semibold text-lime shadow-[0_0_8px_-2px_rgba(190,255,61,0.3)]"
                      : isFuture
                        ? "opacity-25 cursor-not-allowed text-white/30"
                        : "text-white/40 hover:text-white/70 hover:bg-white/[0.04]",
                  )}
                >
                  {winLabel}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {onPickDay && <span className="text-[0.6rem] text-white/30">Click two days to compare</span>}

          {/* Prev / Next 4 months */}
          <div className="flex items-center gap-0.5 rounded-full border border-white/[0.06] bg-white/[0.02] p-0.5">
            <button
              type="button"
              onClick={goPrev}
              disabled={cannotGoPrev}
              aria-label="Previous 4 months"
              title="Previous 4 months"
              className="grid h-6 w-6 place-items-center rounded-full text-content-secondary transition-colors hover:bg-white/[0.06] disabled:opacity-25"
            >
              <ChevronLeft size={14} aria-hidden />
            </button>
            <button
              type="button"
              onClick={goNext}
              disabled={cannotGoNext}
              aria-label="Next 4 months"
              title="Next 4 months"
              className="grid h-6 w-6 place-items-center rounded-full text-content-secondary transition-colors hover:bg-white/[0.06] disabled:opacity-25"
            >
              <ChevronRight size={14} aria-hidden />
            </button>
          </div>
        </div>
      </div>

      {/* Month grids (4 months side-by-side) */}
      <div ref={gridRef} className="grid grid-cols-1 gap-x-6 gap-y-6 sm:grid-cols-2 xl:grid-cols-4">
        {months.map((m) => (
          <div key={`${m.year}-${m.monthIndex}`}>
            <div className="mb-2 text-[0.72rem] font-semibold text-content-secondary">{m.label}</div>
            <div className="grid grid-cols-7 gap-1">
              {WEEKDAYS.map((w, i) => (
                <div key={`h${i}`} className="pb-0.5 text-center text-[0.5rem] font-medium text-white/25">
                  {w}
                </div>
              ))}
              {Array.from({ length: m.leading }).map((_, i) => (
                <div key={`pad${i}`} aria-hidden />
              ))}
              {m.days.map(({ date, dom }) => {
                const entry = byDate.get(date);
                if (!entry) {
                  // Outside the fetched window or in the future — a quiet, non-interactive slot.
                  return <div key={date} className="aspect-square rounded-[6px] border border-white/[0.03]" aria-hidden />;
                }
                const tone = performanceTone(entry.work_mins, target);
                const selected = selectedDays?.includes(date) ?? false;
                return (
                  <button
                    key={date}
                    type="button"
                    onClick={() => onPickDay?.(date)}
                    disabled={!onPickDay}
                    title={`${fmtDateShort(date)} · ${fmtHM(entry.work_mins)} · ${tone.label}`}
                    className={cn(
                      "grid aspect-square place-items-center rounded-[6px] border text-[0.62rem] font-semibold tabular-nums transition-transform duration-150",
                      tone.cellText,
                      onPickDay && "hover:scale-[1.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50",
                      selected && "ring-2 ring-white/80",
                    )}
                    style={{
                      background: tone.cellBg,
                      borderColor: tone.cellBorder,
                      boxShadow: tone.key !== "none" ? "inset 0 1px 0 rgba(255,255,255,0.18)" : undefined,
                    }}
                  >
                    {dom}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-white/[0.05] pt-4">
        {[
          { c: "#DC2626", l: "Below target" },
          { c: "#F59E0B", l: "Target met" },
          { c: "#22C55E", l: "Over target" },
          { c: "#27272A", l: "Rest day" },
        ].map((x) => (
          <span key={x.l} className="flex items-center gap-1.5 text-[0.62rem] font-medium text-white/45">
            <span
              className="h-2.5 w-2.5 rounded-[4px] border border-white/10"
              style={{ background: x.c }}
              aria-hidden
            />
            {x.l}
          </span>
        ))}
      </div>
    </div>
  );
}
