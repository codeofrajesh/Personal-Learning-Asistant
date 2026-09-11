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

import { useLayoutEffect, useRef, useState } from "react";
import { gsap } from "gsap";
import { Activity, CalendarClock, CalendarRange, CalendarDays, Columns2, Target, Settings2, Info } from "lucide-react";
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
import { useStudyAnalytics, useTargetSetting, useDayWindow } from "../components/analytics/useStudyAnalytics";
import { parseLocalDay, type Granularity } from "../components/analytics/analyticsUtils";
import { useStudyMeter } from "../components/layout/useStudyMeter";
import { useScheduleClock } from "../lib/scheduleClock";
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
  const [view, setView] = useState<ViewMode>("month");
  const [targetOpen, setTargetOpen] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  // Compare-mode state, owned here so the heatmap can seed a Day-vs-Day comparison.
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

  const daily = data?.daily ?? [];
  const hourly = data?.hourly_today ?? [];

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

  // Tiered entrance: stagger the panels once data settles. `motionAllowed()` is false on lite and
  // under reduced-motion, so those render final-state instantly. Re-runs on view switch so the
  // freshly-shown panels animate in too.
  useLayoutEffect(() => {
    if (!loaded || !motionAllowed()) return;
    const ctx = gsap.context(() => {
      const targets = rootRef.current?.querySelectorAll(".analytics-panel");
      if (targets && targets.length > 0) {
        gsap.from(targets, { y: 18, opacity: 0, duration: 0.5, ease: "power2.out", stagger: 0.07 });
      }
    }, rootRef);
    return () => ctx.revert();
  }, [loaded, view]);

  return (
    <div className="min-h-full p-6 lg:p-8">
      <div ref={rootRef} className="w-full max-w-none px-4 lg:px-10">
        <Breadcrumb items={[{ label: "Analytics" }]} />

        <header className="mb-6 mt-3 flex flex-wrap items-end justify-between gap-4">
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
            {/* KPI overview */}
            <div className="analytics-panel">
              <KpiCards
                daily={daily}
                focusSessions={data?.focus_sessions ?? 0}
                avgSessionSecs={data?.avg_session_secs ?? 0}
              />
            </div>

            {/* Chart + pace/peak */}
            <div className="mt-4 grid items-stretch gap-4 lg:grid-cols-3">
              <div className="analytics-panel lg:col-span-2">
                <PeriodChart daily={daily} hourlyToday={hourly} period={view} targetMins={target.targetMins} />
              </div>
              <div className="flex h-full flex-col gap-4">
                <div className="analytics-panel flex-1">
                  <PaceGauge
                    meter={meter}
                    nowMins={nowMins}
                    wakeMins={dayWindow.wakeMins}
                    hardStopMins={dayWindow.hardStopMins}
                    targetMins={target.targetMins}
                  />
                </div>
                <div className="analytics-panel flex-1">
                  <PeakHoursPanel />
                </div>
              </div>
            </div>


            {/* Tier 3: study velocity (wide) + focus quality */}
            <div className="mt-4 grid items-stretch gap-4 lg:grid-cols-3">
              <div className="analytics-panel h-full lg:col-span-2">
                <CumulativeVelocity daily={daily} targetMins={target.targetMins} />
              </div>
              <div className="analytics-panel h-full">
                <FocusQualityBento
                  daily={daily}
                  focusSessions={data?.focus_sessions ?? 0}
                  avgSessionSecs={data?.avg_session_secs ?? 0}
                  longestSessionSecs={data?.longest_session_secs ?? 0}
                  targetMins={target.targetMins}
                />
              </div>
            </div>

            {/* Tier 4: multi-month consistency tracker (full width) */}
            <div className="analytics-panel mt-4">
              <CalendarHeatmap daily={daily} targetMins={target.targetMins} onPickDay={onPickDay} selectedDays={picks} />
            </div>
          </>
        )}
      </div>

      <TargetSettings open={targetOpen} onClose={() => setTargetOpen(false)} targetMins={target.targetMins} onSave={target.save} />
      <DataPrivacySheet open={dataOpen} onClose={() => setDataOpen(false)} />
      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}
