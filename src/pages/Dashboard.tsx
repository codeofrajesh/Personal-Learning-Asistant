/**
 * Dashboard (home) — Section 8, Page 1. The HERO page (Section 15), modelled on
 * `dashboard Designs/image 3 fav.png`: deep-black panels, massive soft shadows, and a
 * lime→cyan duotone ambient-light backdrop.
 *
 * Layout is now DATA-DRIVEN: the visible widgets + their order come from the saved
 * dashboard layout config (Settings → Dashboard widgets), resolved over the widget
 * registry (`lib/dashboardLayout.ts`) and persisted to a `settings` DB row. Each widget
 * knows its column span; the grid places them in the saved order.
 *
 * Widgets: Progress · Current course · Activity · Next up (scheduling) · To-do · Recent
 * (recency) · Quick access. All are premium glassmorphic cards (bg-white/[0.02] +
 * border-white/[0.06] + shadow-2xl + backdrop-blur-xl + rounded-[24px]) — translucent so
 * the ambient lighting bleeds through. Real data only (honest zeros / empty states).
 *
 * Full-width on large monitors (`w-full max-w-none px-10`). Motion: the mandated
 * staggered entrance via a plain gsap.context(), gated on prefers-reduced-motion.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { gsap } from "gsap";
import { Flame } from "lucide-react";
import ActivityChart from "../components/dashboard/ActivityChart";
import CurrentCourse from "../components/dashboard/ContinueLearning";
import NextUp from "../components/dashboard/NextUp";
import PomodoroWidget from "../components/dashboard/PomodoroWidget";
import ProgressStatsCard from "../components/dashboard/ProgressStatsCard";
import QuickAccess from "../components/dashboard/QuickAccess";
import RecentStrip from "../components/dashboard/RecentStrip";
import TasksWidget from "../components/dashboard/TasksWidget";
import { ipc, isTauri, NotInTauriError, onLibraryChanged } from "../lib/ipc";
import { motionAllowed } from "../lib/perfStore";
import {
  defaultLayout,
  loadLayout,
  widgetMeta,
  type DashboardLayout,
  type WidgetId,
} from "../lib/dashboardLayout";
import type { DashboardData } from "../lib/types";

type State =
  | { kind: "loading" }
  | { kind: "ready"; data: DashboardData }
  | { kind: "preview" } // outside Tauri (browser preview)
  | { kind: "error"; message: string };

/** Greeting tuned to the local hour — small touch, real data (the clock). */
function greeting(hour: number): string {
  if (hour < 5) return "Still up";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

const LONG_DATE: Intl.DateTimeFormatOptions = {
  weekday: "long",
  month: "long",
  day: "numeric",
};

/** ISO YYYY-MM-DD for a Date, local time (matches backend `date('now')`). */
function isoLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Consecutive active days ending today (or yesterday, if today is idle). */
function currentStreak(activeDays: string[]): number {
  const active = new Set(activeDays);
  const cursor = new Date();
  if (!active.has(isoLocal(cursor))) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (active.has(isoLocal(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

export default function Dashboard() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [layout, setLayout] = useState<DashboardLayout>(defaultLayout);
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!isTauri()) {
      setState({ kind: "preview" });
      return;
    }
    setState({ kind: "loading" });
    try {
      const data = await ipc.dashboardData();
      setState({ kind: "ready", data });
    } catch (err) {
      const message =
        err instanceof NotInTauriError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      setState({ kind: "error", message });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Load the saved widget layout (show/hide + order). Re-read on window focus so a
  // change made in Settings takes effect when the user returns to the Dashboard.
  useEffect(() => {
    let alive = true;
    const refresh = () => void loadLayout().then((l) => alive && setLayout(l));
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      alive = false;
      window.removeEventListener("focus", refresh);
    };
  }, []);

  // Live-refresh when a watched folder changes (activity/progress/stats update).
  useEffect(() => {
    let unlisten: () => void = () => {};
    void onLibraryChanged(() => void load()).then((u) => {
      unlisten = u;
    });
    return () => unlisten();
  }, [load]);

  const visibleIds = useMemo<WidgetId[]>(
    () => layout.filter((w) => w.visible).map((w) => w.id),
    [layout],
  );

  // Mandated entrance (Section 15): the visible widgets fade/slide in, staggered.
  // Reduced-motion safe. Re-runs when data becomes ready or the visible set changes.
  useLayoutEffect(() => {
    if (state.kind !== "ready") return;
    // Gated on the tier (motionAllowed), not just reduced-motion: on `lite` the widgets
    // appear instantly with no stagger tween — smoother first paint on weak hardware.
    if (!motionAllowed()) return;

    const ctx = gsap.context(() => {
      gsap.from(".dash-widget", {
        y: 26,
        opacity: 0,
        duration: 0.5,
        ease: "power2.out",
        stagger: 0.08,
      });
    }, rootRef);

    return () => ctx.revert();
  }, [state.kind, visibleIds]);

  const now = new Date();
  const dateLabel = now.toLocaleDateString(undefined, LONG_DATE);

  const streak = useMemo(
    () => (state.kind === "ready" ? currentStreak(state.data.active_days) : 0),
    [state],
  );

  /** Render one widget by id (only called when state is ready). */
  const renderWidget = (id: WidgetId, data: DashboardData) => {
    switch (id) {
      case "progress":
        return <ProgressStatsCard stats={data.stats} />;
      case "current":
        return <CurrentCourse item={data.continue_learning[0] ?? null} />;
      case "activity":
        return <ActivityChart activity={data.activity} />;
      case "pomodoro":
        return <PomodoroWidget />;
      case "nextup":
        return <NextUp items={data.next_up} />;
      case "tasks":
        return <TasksWidget />;
      case "recent":
        return <RecentStrip items={data.continue_learning} />;
      case "quickaccess":
        return <QuickAccess items={data.bookmarks} />;
      default:
        return null;
    }
  };

  return (
    <div className="relative min-h-full p-6 lg:p-8">
      {/* Ambient lighting now lives on the unified app canvas (AppShell), so the page
          itself is transparent and hovers over it. */}
      <div ref={rootRef} className="w-full max-w-none px-10">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-content-primary lg:text-3xl">
              {greeting(now.getHours())}
            </h1>
            <p className="mt-1 text-sm text-white/40">{dateLabel}</p>
          </div>
          {state.kind === "ready" && (
            <span
              className="flex items-center gap-2 rounded-full border border-orange/25 bg-orange/10 px-4 py-2 text-sm font-semibold text-orange"
              title="Consecutive days with study activity"
            >
              <Flame size={16} strokeWidth={2} aria-hidden />
              {streak} {streak === 1 ? "day" : "days"} streak
            </span>
          )}
        </header>

        {state.kind === "loading" && (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className={
                  "animate-pulse rounded-[24px] border border-white/[0.06] bg-white/[0.02] " +
                  (i === 5 ? "min-h-[14rem] lg:col-span-2" : "min-h-[20rem]")
                }
                aria-hidden="true"
              />
            ))}
          </div>
        )}

        {state.kind === "ready" && (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            {visibleIds.map((id) => {
              const meta = widgetMeta(id);
              const span = meta?.span === 2 ? "lg:col-span-2" : "";
              return (
                <div key={id} className={"dash-widget " + span}>
                  {renderWidget(id, state.data)}
                </div>
              );
            })}
            {visibleIds.length === 0 && (
              <div className="lg:col-span-3 rounded-[24px] border border-white/[0.06] bg-white/[0.02] p-card text-center text-sm text-white/40 shadow-2xl backdrop-blur-xl">
                All widgets are hidden. Turn some back on in Settings → Dashboard widgets.
              </div>
            )}
          </div>
        )}

        {state.kind === "preview" && (
          <div className="grid min-h-40 place-items-center rounded-[24px] border border-white/[0.06] bg-white/[0.02] p-card text-center text-sm text-white/40 shadow-2xl backdrop-blur-xl">
            Preview mode — open inside the desktop app to see your live dashboard.
          </div>
        )}

        {state.kind === "error" && (
          <div className="rounded-[24px] border border-orange/30 bg-orange/[0.06] p-card text-sm text-orange">
            Could not load your dashboard: {state.message}
            <button
              type="button"
              onClick={() => void load()}
              className="ml-3 rounded-btn border border-orange/40 px-2.5 py-1 text-xs text-orange transition-colors hover:bg-orange/10"
            >
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
