/**
 * PlannerTab — the default Planning surface (dashboard-style two-pane layout):
 *   Left: quick-add + the grouped to-do list (Overdue · Today · This week · Later ·
 *     No date). Rows are pristine; detail editing opens the glass TaskModal.
 *   Right: the Consistency engine (score + heatmap when enabled) + a "Next up" list.
 *
 * All task state comes from the shared `usePlanningTasks` hook (passed in), so the
 * Planner and View tabs stay in sync. A mounted-only 1 Hz tick refreshes relative
 * deadline labels (no global loop).
 */

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ListChecks, CalendarClock, Play, ChevronRight } from "lucide-react";
import QuickAddBar from "./QuickAddBar";
import TaskRow from "./TaskRow";
import TaskModal from "./TaskModal";
import ConsistencyHeatmap, { HeatmapLegend } from "./ConsistencyHeatmap";
import ConsistencyScore from "./ConsistencyScore";
import { dueMs } from "./planningUtils";
import { cn } from "../../lib/utils";
import type { Task } from "../../lib/types";
import type { PlanningTasks } from "./usePlanningTasks";

type Bucket = "overdue" | "today" | "week" | "later" | "none";
const BUCKET_LABEL: Record<Bucket, string> = {
  overdue: "Overdue",
  today: "Today",
  week: "This week",
  later: "Later",
  none: "No date",
};
const BUCKET_ORDER: Bucket[] = ["overdue", "today", "week", "later", "none"];

function startOfDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function bucketOf(task: Task, now: number): Bucket {
  const due = dueMs(task.due_at);
  if (due == null) return "none";
  if (!task.done && due < now) return "overdue";
  const todayStart = startOfDay(now);
  if (due < todayStart + 86_400_000) return "today";
  if (due < todayStart + 7 * 86_400_000) return "week";
  return "later";
}

interface Props {
  planning: PlanningTasks;
}

export default function PlannerTab({ planning }: Props) {
  const navigate = useNavigate();
  const { tasks, consistency, nextUp, loaded, addTask, toggleDone, removeTask, applyEdit } = planning;

  const [nowTick, setNowTick] = useState(() => Date.now());
  const [modalOpen, setModalOpen] = useState(false);
  const [editTask, setEditTask] = useState<Task | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const openMaterial = (id: number) => navigate(`/library/material/${id}`, { state: { source: "courses" } });

  const grouped = useMemo(() => {
    const g: Record<Bucket, Task[]> = { overdue: [], today: [], week: [], later: [], none: [] };
    for (const t of tasks) g[bucketOf(t, nowTick)].push(t);
    for (const b of BUCKET_ORDER) {
      g[b].sort((a, b2) => {
        if (a.done !== b2.done) return a.done ? 1 : -1;
        const da = dueMs(a.due_at) ?? Infinity;
        const db = dueMs(b2.due_at) ?? Infinity;
        if (da !== db) return da - db;
        return b2.priority - a.priority;
      });
    }
    return g;
  }, [tasks, nowTick]);

  const openCount = useMemo(() => tasks.filter((t) => !t.done).length, [tasks]);

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.6fr_1fr]">
      {/* ── Left: quick-add + grouped list ── */}
      <section className="plan-panel flex flex-col rounded-[24px] border border-white/[0.06] bg-white/[0.02] p-6 shadow-2xl backdrop-blur-xl">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-content-primary">To-do</h2>
          {loaded && openCount > 0 && <span className="text-xs text-white/40">{openCount} open</span>}
        </div>

        <div className="mb-4">
          <QuickAddBar onAdd={addTask} onOpenModal={() => { setEditTask(null); setModalOpen(true); }} />
        </div>

        {tasks.length === 0 && loaded ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-12 text-center">
            <ListChecks size={28} className="text-white/20" aria-hidden />
            <p className="text-sm text-content-secondary">No tasks yet</p>
            <p className="max-w-[18rem] text-xs text-white/40">
              Add a task above — try typing <span className="text-content-secondary">/high /today</span> to set
              priority and a deadline inline.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {BUCKET_ORDER.map((b) => {
              const rows = grouped[b];
              if (rows.length === 0) return null;
              return (
                <div key={b}>
                  <div className="mb-1 flex items-center gap-2">
                    <h3 className={cn("text-xs font-semibold uppercase tracking-wide", b === "overdue" ? "text-red-400" : "text-content-secondary")}>
                      {BUCKET_LABEL[b]}
                    </h3>
                    <span className="text-[0.66rem] text-white/30">{rows.length}</span>
                  </div>
                  <div className="flex flex-col">
                    {rows.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        now={nowTick}
                        onToggleDone={() => void toggleDone(task)}
                        onEdit={() => { setEditTask(task); setModalOpen(true); }}
                        onDelete={() => void removeTask(task)}
                        onOpenMaterial={openMaterial}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Right: consistency + next up ── */}
      <div className="flex flex-col gap-6">
        <section className="plan-panel rounded-[24px] border border-white/[0.06] bg-white/[0.02] p-6 shadow-2xl backdrop-blur-xl">
          {consistency?.enabled ? (
            <>
              <ConsistencyScore score={consistency.score} streak={consistency.streak} days={consistency.days} />
              <div className="mt-6 border-t border-white/[0.06] pt-5">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-content-primary">Consistency</h3>
                  <HeatmapLegend />
                </div>
                <ConsistencyHeatmap days={consistency.days} />
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center gap-2 py-6 text-center">
              <ListChecks size={26} className="text-white/20" aria-hidden />
              <p className="text-sm font-medium text-content-secondary">Consistency tracking is off</p>
              <p className="max-w-[20rem] text-xs text-white/40">
                Turn it on in Settings to see your score, streak, and a heatmap. We quietly track it in the
                background, so you'll get a full history the moment you enable it.
              </p>
              <button
                type="button"
                onClick={() => navigate("/settings")}
                className="mt-2 rounded-full border border-white/[0.08] bg-white/[0.04] px-4 py-2 text-xs font-semibold text-content-primary transition-colors hover:bg-white/[0.08]"
              >
                Open Settings
              </button>
            </div>
          )}
        </section>

        <section className="plan-panel rounded-[24px] border border-white/[0.06] bg-white/[0.02] p-6 shadow-2xl backdrop-blur-xl">
          <header className="mb-3 flex items-center gap-2">
            <CalendarClock size={16} strokeWidth={2} className="text-cyan-400" aria-hidden />
            <h3 className="text-sm font-semibold text-content-primary">Next up</h3>
          </header>
          {nextUp.length === 0 ? (
            <p className="py-4 text-center text-xs text-white/40">
              No lessons queued — every course is complete or none imported yet.
            </p>
          ) : (
            <div className="-mx-1 flex flex-col">
              {nextUp.slice(0, 5).map((item) => (
                <button
                  key={item.root_id}
                  type="button"
                  onClick={() => openMaterial(item.id)}
                  className="group flex items-center gap-3 rounded-[12px] px-3 py-2.5 text-left transition-colors hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/40"
                >
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-cyan-400/25 bg-cyan-400/10 text-cyan-400">
                    <Play size={12} strokeWidth={2.5} fill="currentColor" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-content-primary">{item.file_name}</p>
                    <p className="truncate text-[0.7rem] text-white/40">{item.root_name}</p>
                  </div>
                  <span className="shrink-0 text-[0.62rem] text-white/30">{item.remaining} left</span>
                  <ChevronRight size={14} className="shrink-0 text-white/25 transition-transform group-hover:translate-x-0.5" aria-hidden />
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      <TaskModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        task={editTask}
        onCreate={addTask}
        onSave={applyEdit}
      />
    </div>
  );
}
