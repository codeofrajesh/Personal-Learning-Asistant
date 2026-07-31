/**
 * Planning Hub (`/planning`) — top-level tabbed workspace.
 *
 *   Planner (default): dashboard-style two-pane layout (to-do list + quick-add,
 *     Consistency tracker, Next up). See `PlannerTab`.
 *   View: a full-screen surface with a Timeline (calendar) / Table sub-toggle. Timeline
 *     is the default. See `ViewTab`.
 *
 * Task state is owned once by `usePlanningTasks` and shared with both tabs so they stay
 * in sync from one load + one set of optimistic mutations. Glass + lime/cyan DNA;
 * GSAP entrance on the shell (reduced-motion gated).
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { gsap } from "gsap";
import { LayoutDashboard, CalendarRange, CalendarClock } from "lucide-react";
import Breadcrumb from "../components/layout/Breadcrumb";
import PlannerTab from "../components/planning/PlannerTab";
import TodayTab from "../components/planning/TodayTab";
import ViewTab from "../components/planning/ViewTab";
import { usePlanningTasks } from "../components/planning/usePlanningTasks";
import { useDayPlan } from "../components/planning/useDayPlan";
import { ipc, isTauri } from "../lib/ipc";
import { localDay } from "../lib/scheduleClock";
import { motionAllowed } from "../lib/perfStore";
import { cn } from "../lib/utils";

type Tab = "today" | "planner" | "view";

export default function PlanningHub() {
  const planning = usePlanningTasks();
  const schedule = useDayPlan();
  // Today is the default: the schedule is the thing you act on, the to-do list is the thing you
  // maintain. Opening on the list every time buries the blocks you're supposed to be doing.
  const [tab, setTab] = useState<Tab>("today");
  const rootRef = useRef<HTMLDivElement>(null);

  // Finish boot reconciliation with the TRUE local date. `lib.rs` already ran a conservative
  // UTC-dated pass, which can only err toward leaving a day open — this closes it correctly.
  useEffect(() => {
    if (!isTauri()) return;
    void ipc
      .reconcilePlan(localDay())
      .then((n) => {
        if (n > 0) void schedule.reload();
      })
      .catch(() => {});
    // Once per mount: reconciliation is a one-shot boot pass, not a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    if (!planning.loaded || planning.preview) return;
    if (!motionAllowed()) return;
    const ctx = gsap.context(() => {
      const targets = rootRef.current?.querySelectorAll(".plan-panel");
      if (targets && targets.length > 0) {
        gsap.from(targets, { y: 20, opacity: 0, duration: 0.5, ease: "power2.out", stagger: 0.1 });
      }
    }, rootRef);
    return () => ctx.revert();
  }, [planning.loaded, planning.preview, tab]);

  return (
    <div className="min-h-full p-6 lg:p-8">
      <div ref={rootRef} className="w-full max-w-none px-4 lg:px-10">
        <Breadcrumb items={[{ label: "Planning" }]} />
        <header className="mb-6 mt-3 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-bold text-content-primary lg:text-3xl">Planning</h1>
            <p className="mt-1 text-sm text-white/40">
              Plan your work, set deadlines, and keep your streak.
            </p>
          </div>

          {/* Top-level tabs: Today | Planner | View */}
          {!planning.preview && (
            <div className="flex items-center gap-1 rounded-full border border-white/[0.06] bg-white/[0.02] p-1">
              {([
                { key: "today", label: "Today", icon: CalendarClock },
                { key: "planner", label: "Planner", icon: LayoutDashboard },
                { key: "view", label: "View", icon: CalendarRange },
              ] as const).map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  aria-pressed={tab === t.key}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-medium transition-colors",
                    tab === t.key
                      ? "bg-white/[0.06] text-content-primary shadow-[inset_0_1px_1px_rgba(255,255,255,0.1)]"
                      : "text-content-secondary hover:bg-white/[0.04]",
                  )}
                >
                  <t.icon size={15} strokeWidth={2} aria-hidden />
                  {t.label}
                </button>
              ))}
            </div>
          )}
        </header>

        {planning.preview ? (
          <div className="grid min-h-40 place-items-center rounded-[24px] border border-white/[0.06] bg-white/[0.02] p-card text-center text-sm text-white/40 shadow-2xl backdrop-blur-xl">
            Preview mode — open inside the desktop app to plan tasks.
          </div>
        ) : tab === "today" ? (
          <TodayTab schedule={schedule} />
        ) : tab === "planner" ? (
          <PlannerTab planning={planning} />
        ) : (
          <ViewTab planning={planning} />
        )}
      </div>
    </div>
  );
}
