/**
 * Analytics (`/analytics`) — the dedicated Study Hours command center.
 *
 * A first-class sidebar route (below Planning). Dark glassmorphic, performance-colored (red/cyan/
 * emerald-gold vs the daily target), composed from small presentational pieces fed by a few hooks:
 *   • `useStudyAnalytics` — one 60-day series + hour histogram + sessionized focus quality;
 *   • `useStudyMeter` — today's live time-on-task for the pace gauge;
 *   • `useTargetSetting` / `useDayWindow` — the ambition target + today's usable window;
 *   • `useStudyRange` (inside CompareView) — two arbitrary periods for Compare mode.
 *
 * Tiered motion (strict): GSAP panel stagger on high/balanced, none on lite (via `motionAllowed`);
 * the cumulative line's draw-in is high-only (inside that component). All data-viz is composited
 * CSS/SVG — no canvas, no chart library, no polling — so it stays light behind the 60fps player.
 */

import { useLayoutEffect, useRef, useState, useMemo } from "react";
import { gsap } from "gsap";
import {
  Activity,
  CalendarClock,
  CalendarRange,
  CalendarDays,
  Columns2,
  Target,
  Settings2,
  Info,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
} from "lucide-react";
import Breadcrumb from "../components/layout/Breadcrumb";
import KpiCards from "../components/analytics/KpiCards";
import PaceGauge from "../components/analytics/PaceGauge";
import PeriodChart, { type Period } from "../components/analytics/PeriodChart";
import PeakHoursPanel from "../components/analytics/PeakHoursPanel";
import CumulativeVelocity from "../components/analytics/CumulativeVelocity";
import CalendarHeatmap from "../components/analytics/CalendarHeatmap";
import FocusQualityBento from "../components/analytics/FocusQualityBento";
import CompareView from "../components/analytics/CompareView";
import TargetSettings from "../components/analytics/TargetSettings";
import DataPrivacySheet from "../components/analytics/DataPrivacySheet";
import HelpModal from "../components/analytics/HelpModal";
import PeriodPicker from "../components/analytics/PeriodPicker";
import StreakBadge from "../components/analytics/StreakBadge";
import { useCurrentStreak } from "../components/analytics/useCurrentStreak";
import {
  useStudyAnalytics,
  useTargetSetting,
  useDayWindow,
  useRetentionSetting,
  useStudyRange,
} from "../components/analytics/useStudyAnalytics";
import {
  parseLocalDay,
  comparePeriod,
  slicePeriodDays,
  monthOffset,
  sumMins,
  studyStreaks,
  type Granularity,
} from "../components/analytics/analyticsUtils";
import { useStudyMeter } from "../components/layout/useStudyMeter";
import { useScheduleClock, dayOffset } from "../lib/scheduleClock";
import { motionAllowed } from "../lib/perfStore";
import { cn } from "../lib/utils";

type ViewMode = Period | "compare";

const VIEWS: { key: ViewMode; label: string; icon: typeof CalendarClock }[] = [
  { key: "day", label: "Day", icon: CalendarClock },
  { key: "week", label: "Week", icon: CalendarRange },
  { key: "month", label: "Month", icon: CalendarDays },
  { key: "compare", label: "Compare", icon: Columns2 },
];

/** Whole days between two local `YYYY-MM-DD` (negative = in the past relative to `today`). */
function dayIndex(date: string, today: string): number {
  return Math.round((parseLocalDay(date).getTime() - parseLocalDay(today).getTime()) / 86_400_000);
}

export default function AnalyticsHub() {
  // Default to Day view so arrival shows Current Month overview + Today's detailed stats
  const [view, setView] = useState<ViewMode>("day");
  const [targetOpen, setTargetOpen] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [periodPickerOpen, setPeriodPickerOpen] = useState(false);

  // Period navigation offsets (0 = current, negative = past)
  const [dayIdx, setDayIdx] = useState(0);
  const [weekIdx, setWeekIdx] = useState(0);
  const [monthIdx, setMonthIdx] = useState(0);

  // Compare-mode state
  const [gran, setGran] = useState<Granularity>("month");
  const [idxA, setIdxA] = useState(-1);
  const [idxB, setIdxB] = useState(0);
  const [picks, setPicks] = useState<string[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  const { data, loaded } = useStudyAnalytics();
  const meter = useStudyMeter();
  const target = useTargetSetting();
  const dayWindow = useDayWindow();
  const nowMins = useScheduleClock((s) => s.minutes);
  const today = useScheduleClock((s) => s.day);
  const { earliestDate } = useRetentionSetting();

  const daily = data?.daily ?? [];
  const hourly = data?.hourly_today ?? [];
  const byDate = useMemo(() => new Map(daily.map((d) => [d.date, d])), [daily]);

  // Compute active consistency streak across ambient sources + daily history
  const ambientStreak = useCurrentStreak();
  const streaks = useMemo(() => studyStreaks(daily, today), [daily, today]);
  const effectiveStreak = Math.max(ambientStreak, streaks.current);

  // Current granularity and index for period navigation
  const currentGran: Granularity = view === "week" ? "week" : view === "month" ? "month" : "day";
  const currentIdx = view === "week" ? weekIdx : view === "month" ? monthIdx : dayIdx;

  // Resolve active period
  const activePeriod = useMemo(
    () => comparePeriod(currentGran, currentIdx, today),
    [currentGran, currentIdx, today],
  );

  // Retention boundary checks for steppers
  const canStepBack = useMemo(() => {
    if (!earliestDate) return true;
    if (view === "day") {
      const prevDate = dayOffset(today, dayIdx - 1);
      return prevDate >= earliestDate;
    }
    if (view === "week") {
      const prevWeekEnd = comparePeriod("week", weekIdx - 1, today).end;
      return prevWeekEnd >= earliestDate;
    }
    if (view === "month") {
      const prevMonthEnd = comparePeriod("month", monthIdx - 1, today).end;
      return prevMonthEnd >= earliestDate;
    }
    return true;
  }, [earliestDate, view, dayIdx, weekIdx, monthIdx, today]);

  const canStepForward = currentIdx < 0;
  const isBrowsingPast = currentIdx < 0;

  function stepPeriod(delta: number) {
    if (view === "day") setDayIdx((i) => Math.min(0, i + delta));
    else if (view === "week") setWeekIdx((i) => Math.min(0, i + delta));
    else if (view === "month") setMonthIdx((i) => Math.min(0, i + delta));
  }

  function resetPeriod() {
    if (view === "day") setDayIdx(0);
    else if (view === "week") setWeekIdx(0);
    else if (view === "month") setMonthIdx(0);
  }

  // Fetch range data on demand for historical days/weeks/months
  const historicalDayRange = useStudyRange(
    view === "day" && dayIdx < 0 ? activePeriod.start : null,
    view === "day" && dayIdx < 0 ? activePeriod.end : null,
  );
  const weekRange = useStudyRange(
    view === "week" ? activePeriod.start : null,
    view === "week" ? activePeriod.end : null,
  );
  const monthRange = useStudyRange(
    view === "month" && monthIdx < 0 ? activePeriod.start : null,
    view === "month" && monthIdx < 0 ? activePeriod.end : null,
  );

  // Heatmap click → accumulate two days, then kick off a Day-vs-Day compare.
  function onPickDay(date: string) {
    setPicks((prev) => {
      if (prev.includes(date)) return prev.filter((d) => d !== date);
      const next = [...prev, date];
      if (next.length >= 2) {
        const [a, b] = next.slice(-2);
        const [older, newer] = parseLocalDay(a).getTime() <= parseLocalDay(b).getTime() ? [a, b] : [b, a];
        setGran("day");
        setIdxA(dayIndex(older, today));
        setIdxB(dayIndex(newer, today));
        setView("compare");
        return [];
      }
      return next;
    });
  }

  // Tiered entrance: stagger the panels once data settles (high & balanced only).
  useLayoutEffect(() => {
    if (!loaded) return;
    const targets = rootRef.current?.querySelectorAll(".analytics-panel");
    if (!targets || targets.length === 0) return;

    if (!motionAllowed()) {
      // In lite mode, instantly set all cards at rest with zero transform and zero delay
      gsap.set(targets, { y: 0, opacity: 1, clearProps: "all" });
      return;
    }
    const ctx = gsap.context(() => {
      gsap.from(targets, { y: 18, opacity: 0, duration: 0.5, ease: "power2.out", stagger: 0.07 });
    }, rootRef);
    return () => ctx.revert();
  }, [loaded, view]);

  // Derive dynamic slices for Top KPI row and lower cards based on current mode
  const {
    kpiTitle,
    kpiSub,
    kpiDays,
    kpiPrevDays,
    kpiSessions,
    kpiAvgSecs,
    chartHourly,
    selectedWeekDays,
    prevWeekDays,
    selectedMonthDays,
    paceStudiedMins,
    paceGoalMins,
    velocityDays,
    velocityMode,
    velocityTotalDays,
    focusQualityDays,
    focusSessionsCount,
    focusAvgSecs,
    focusLongestSecs,
  } = useMemo(() => {
    const dailyTarget = target.targetMins ?? 120;

    if (view === "day") {
      const isToday = dayIdx === 0;
      const selDate = activePeriod.start;
      const selDateObj = parseLocalDay(selDate);
      const mOffset = monthOffset(selDateObj.getFullYear(), selDateObj.getMonth(), today);
      const monthSlice = slicePeriodDays(daily, "month", mOffset, today);

      // Top row shows the month containing this day
      const kpiTitle = isToday ? "Total · This Month" : `Total · ${monthSlice.label}`;
      const kpiSub = "vs the previous month";
      const kpiDays = monthSlice.cur;
      const kpiPrevDays = monthSlice.prev;

      // When today, use overall month sessions; when past day, use range sessions
      const kpiSessions = isToday ? (data?.focus_sessions ?? 0) : (historicalDayRange.data?.focus_sessions ?? 0);
      const kpiAvgSecs = isToday ? (data?.avg_session_secs ?? 0) : (historicalDayRange.data?.avg_session_secs ?? 0);

      // Hourly data for the 24-hour graph
      const chartHourly = isToday ? hourly : (historicalDayRange.data?.hourly ?? []);

      // Day study minutes for the pace gauge
      const dayStudied = isToday
        ? (meter?.studied_mins ?? (daily[daily.length - 1]?.work_mins ?? 0))
        : (historicalDayRange.data?.daily?.[0]?.work_mins ?? (byDate.get(selDate)?.work_mins ?? 0));

      // Study velocity up to this selected day
      const velocityDays = monthSlice.cur.filter((d) => d.date <= selDate);

      // Focus quality for this single day
      const focusQualityDays = isToday
        ? [daily[daily.length - 1] ?? { date: today, work_mins: meter?.studied_mins ?? 0 }]
        : (historicalDayRange.data?.daily ?? [{ date: selDate, work_mins: dayStudied }]);

      return {
        kpiTitle,
        kpiSub,
        kpiDays,
        kpiPrevDays,
        kpiSessions,
        kpiAvgSecs,
        chartHourly,
        selectedWeekDays: undefined,
        prevWeekDays: undefined,
        selectedMonthDays: undefined,
        paceStudiedMins: dayStudied,
        paceGoalMins: dailyTarget,
        velocityDays,
        velocityMode: "month" as const,
        velocityTotalDays: monthSlice.cur.length,
        focusQualityDays,
        focusSessionsCount: isToday ? (data?.focus_sessions ?? 0) : (historicalDayRange.data?.focus_sessions ?? 0),
        focusAvgSecs: isToday ? (data?.avg_session_secs ?? 0) : (historicalDayRange.data?.avg_session_secs ?? 0),
        focusLongestSecs: isToday ? (data?.longest_session_secs ?? 0) : (historicalDayRange.data?.longest_session_secs ?? 0),
      };
    }

    if (view === "week") {
      const weekSlice = slicePeriodDays(daily, "week", weekIdx, today);
      const weekStudied = sumMins(weekSlice.cur);
      const weekGoal = target.weeklyTargetMins;

      const sessions = weekRange.data?.focus_sessions ?? 0;
      const avgSecs = weekRange.data?.avg_session_secs ?? 0;
      const longestSecs = weekRange.data?.longest_session_secs ?? 0;

      return {
        kpiTitle: `Total · ${activePeriod.label}`,
        kpiSub: "vs the previous week",
        kpiDays: weekSlice.cur,
        kpiPrevDays: weekSlice.prev,
        kpiSessions: sessions,
        kpiAvgSecs: avgSecs,
        chartHourly: weekRange.data?.hourly ?? [],
        selectedWeekDays: weekSlice.cur,
        prevWeekDays: weekSlice.prev,
        selectedMonthDays: undefined,
        paceStudiedMins: weekStudied,
        paceGoalMins: weekGoal,
        velocityDays: weekSlice.cur,
        velocityMode: "week" as const,
        velocityTotalDays: 7,
        focusQualityDays: weekSlice.cur,
        focusSessionsCount: sessions,
        focusAvgSecs: avgSecs,
        focusLongestSecs: longestSecs,
      };
    }

    // view === "month"
    const monthSlice = slicePeriodDays(daily, "month", monthIdx, today);
    const monthStudied = sumMins(monthSlice.cur);
    const monthGoal = target.monthlyTargetMins(monthSlice.cur.length);

    const sessions = monthIdx === 0 ? (data?.focus_sessions ?? 0) : (monthRange.data?.focus_sessions ?? 0);
    const avgSecs = monthIdx === 0 ? (data?.avg_session_secs ?? 0) : (monthRange.data?.avg_session_secs ?? 0);
    const longestSecs = monthIdx === 0 ? (data?.longest_session_secs ?? 0) : (monthRange.data?.longest_session_secs ?? 0);

    return {
      kpiTitle: `Total · ${activePeriod.label}`,
      kpiSub: "vs the previous month",
      kpiDays: monthSlice.cur,
      kpiPrevDays: monthSlice.prev,
      kpiSessions: sessions,
      kpiAvgSecs: avgSecs,
      chartHourly: monthIdx === 0 ? [] : (monthRange.data?.hourly ?? []),
      selectedWeekDays: undefined,
      prevWeekDays: undefined,
      selectedMonthDays: monthSlice.cur,
      paceStudiedMins: monthStudied,
      paceGoalMins: monthGoal,
      velocityDays: monthSlice.cur,
      velocityMode: "month" as const,
      velocityTotalDays: monthSlice.cur.length,
      focusQualityDays: monthSlice.cur,
      focusSessionsCount: sessions,
      focusAvgSecs: avgSecs,
      focusLongestSecs: longestSecs,
    };
  }, [
    view,
    dayIdx,
    weekIdx,
    monthIdx,
    activePeriod,
    today,
    daily,
    hourly,
    meter,
    data,
    target.targetMins,
    target.weeklyTargetMins,
    target.monthlyTargetMins,
    historicalDayRange.data,
    weekRange.data,
    monthRange.data,
    byDate,
  ]);

  return (
    <div className="min-h-full p-6 lg:p-8">
      <div ref={rootRef} className="w-full max-w-none px-4 lg:px-10">
        <Breadcrumb items={[{ label: "Analytics" }]} />

        <header className="mb-4 mt-3 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 font-display text-2xl font-bold text-content-primary lg:text-3xl">
              <Activity size={26} strokeWidth={2.25} className="text-lime" aria-hidden />
              Analytics
            </h1>
            <p className="mt-1 text-sm text-white/40">
              Your study hours over time, live pace, and the hours you focus best.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-full border border-white/[0.06] bg-white/[0.02] p-1">
              {VIEWS.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  onClick={() => setView(v.key)}
                  aria-pressed={view === v.key}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors",
                    view === v.key
                      ? "bg-white/[0.06] text-content-primary shadow-[inset_0_1px_1px_rgba(255,255,255,0.1)]"
                      : "text-content-secondary hover:bg-white/[0.04]",
                  )}
                >
                  <v.icon size={15} strokeWidth={2} aria-hidden />
                  {v.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => setTargetOpen(true)}
              title="Daily target"
              aria-label="Set daily target"
              className="grid h-9 w-9 place-items-center rounded-full border border-white/[0.06] bg-white/[0.02] text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-lime"
            >
              <Target size={17} strokeWidth={2} aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => setDataOpen(true)}
              title="Data & privacy"
              aria-label="Data and privacy settings"
              className="grid h-9 w-9 place-items-center rounded-full border border-white/[0.06] bg-white/[0.02] text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content-primary"
            >
              <Settings2 size={17} strokeWidth={2} aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => setHelpOpen(true)}
              className="flex items-center gap-1.5 rounded-full border border-white/[0.06] bg-white/[0.02] px-3 py-1.5 text-sm font-medium text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content-primary"
            >
              <Info size={15} strokeWidth={2} aria-hidden />
              How it works
            </button>
          </div>
        </header>

        {/* Period Navigation Stepper Bar (for Day, Week, Month modes) */}
        {view !== "compare" && (
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-[16px] border border-white/[0.06] bg-white/[0.02] px-4 py-2.5 backdrop-blur-xl">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => stepPeriod(-1)}
                disabled={!canStepBack}
                aria-label="Previous period"
                title={canStepBack ? "Previous period" : "Data retention limit reached"}
                className="grid h-8 w-8 place-items-center rounded-full border border-white/[0.08] bg-white/[0.02] text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content-primary disabled:opacity-25"
              >
                <ChevronLeft size={16} strokeWidth={2} aria-hidden />
              </button>

              <button
                type="button"
                onClick={() => setPeriodPickerOpen(true)}
                title="Click to pick a specific date or period"
                className="flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.04] px-3.5 py-1.5 text-sm font-medium text-content-primary transition-colors hover:border-lime/30 hover:bg-white/[0.08]"
              >
                <CalendarDays size={15} strokeWidth={2} className="text-lime" aria-hidden />
                <span>{activePeriod.label}</span>
                <span className="text-[0.7rem] text-white/40">({activePeriod.sub})</span>
              </button>

              <button
                type="button"
                onClick={() => stepPeriod(1)}
                disabled={!canStepForward}
                aria-label="Next period"
                title="Next period"
                className="grid h-8 w-8 place-items-center rounded-full border border-white/[0.08] bg-white/[0.02] text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content-primary disabled:opacity-25"
              >
                <ChevronRight size={16} strokeWidth={2} aria-hidden />
              </button>

              {/* Streak Badge right of date, month or week selected (hidden if streak <= 0) */}
              {effectiveStreak > 0 && (
                <StreakBadge streak={effectiveStreak} variant="header" className="ml-1" />
              )}
            </div>

            {/* Jump to current button when surfing the past */}
            {isBrowsingPast && (
              <button
                type="button"
                onClick={resetPeriod}
                className="flex items-center gap-1.5 rounded-full border border-lime/30 bg-lime/10 px-3 py-1 text-xs font-semibold text-lime transition-colors hover:bg-lime/20"
              >
                <RotateCcw size={12} strokeWidth={2.25} aria-hidden />
                {view === "day" ? "Jump to Today" : view === "week" ? "This Week" : "This Month"}
              </button>
            )}
          </div>
        )}

        {view === "compare" ? (
          <div className="analytics-panel">
            <CompareView
              targetMins={target.targetMins}
              gran={gran}
              setGran={setGran}
              idxA={idxA}
              idxB={idxB}
              setIdxA={setIdxA}
              setIdxB={setIdxB}
            />
          </div>
        ) : (
          <>
            {/* Dynamic KPI Overview */}
            <div className="analytics-panel">
              <KpiCards
                daily={daily}
                periodDays={kpiDays}
                prevDays={kpiPrevDays}
                periodLabel={kpiTitle}
                subLabel={kpiSub}
                focusSessions={kpiSessions}
                avgSessionSecs={kpiAvgSecs}
              />
            </div>

            {/* Dynamic Chart + Pace/Peak */}
            <div className="mt-4 grid items-stretch gap-4 lg:grid-cols-3">
              <div className="analytics-panel lg:col-span-2">
                <PeriodChart
                  daily={daily}
                  hourlyToday={hourly}
                  period={view}
                  targetMins={target.targetMins}
                  selectedDate={view === "day" ? activePeriod.start : undefined}
                  selectedHourly={chartHourly}
                  selectedWeekDays={selectedWeekDays}
                  prevWeekDays={prevWeekDays}
                  selectedMonthDays={selectedMonthDays}
                  periodLabel={activePeriod.label}
                />
              </div>
              <div className="flex h-full flex-col gap-4">
                <div className="analytics-panel flex-1">
                  <PaceGauge
                    meter={view === "day" && dayIdx === 0 ? meter : null}
                    nowMins={nowMins}
                    wakeMins={dayWindow.wakeMins}
                    hardStopMins={dayWindow.hardStopMins}
                    targetMins={target.targetMins}
                    mode={view === "week" ? "week" : view === "month" ? "month" : "day"}
                    isToday={view === "day" && dayIdx === 0}
                    periodLabel={activePeriod.label}
                    studiedMins={paceStudiedMins}
                    goalMins={paceGoalMins}
                    streakDays={effectiveStreak}
                  />
                </div>
                <div className="analytics-panel flex-1">
                  <PeakHoursPanel
                    hourly={chartHourly}
                    periodLabel={activePeriod.label}
                  />
                </div>
              </div>
            </div>

            {/* Tier 3: Study velocity (wide) + Focus quality */}
            <div className="mt-4 grid items-stretch gap-4 lg:grid-cols-3">
              <div className="analytics-panel h-full lg:col-span-2">
                <CumulativeVelocity
                  daily={daily}
                  targetMins={target.targetMins}
                  periodDays={velocityDays}
                  periodMode={velocityMode}
                  periodLabel={activePeriod.label}
                  totalDaysInPeriod={velocityTotalDays}
                  periodGoalMins={paceGoalMins}
                />
              </div>
              <div className="analytics-panel h-full">
                <FocusQualityBento
                  daily={daily}
                  periodDays={focusQualityDays}
                  periodLabel={activePeriod.label}
                  focusSessions={focusSessionsCount}
                  avgSessionSecs={focusAvgSecs}
                  longestSessionSecs={focusLongestSecs}
                  targetMins={target.targetMins}
                />
              </div>
            </div>

            {/* Tier 4: Multi-month consistency tracker with single-click Day inspect */}
            <div className="analytics-panel mt-4">
              <CalendarHeatmap
                daily={daily}
                targetMins={target.targetMins}
                onPickDay={onPickDay}
                onSelectDay={(date) => {
                  setView("day");
                  setDayIdx(dayIndex(date, today));
                }}
                selectedDays={picks}
                activeDate={view === "day" ? activePeriod.start : undefined}
                streakDays={effectiveStreak}
              />
            </div>
          </>
        )}
      </div>

      <PeriodPicker
        open={periodPickerOpen}
        onClose={() => setPeriodPickerOpen(false)}
        gran={currentGran}
        today={today}
        currentIndex={currentIdx}
        onSelect={(idx) => {
          if (view === "day") setDayIdx(idx);
          else if (view === "week") setWeekIdx(idx);
          else if (view === "month") setMonthIdx(idx);
        }}
      />

      <TargetSettings
        open={targetOpen}
        onClose={() => setTargetOpen(false)}
        targetMins={target.targetMins}
        weeklyDays={target.weeklyDays}
        monthlyDays={target.monthlyDays}
        onSave={target.save}
      />
      <DataPrivacySheet open={dataOpen} onClose={() => setDataOpen(false)} />
      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}
