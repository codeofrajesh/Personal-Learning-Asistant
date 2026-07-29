/**
 * ViewTab — the full-screen "View" surface. Takes over the content area (no side
 * panels) and hosts a secondary Timeline | Table sub-toggle. Timeline is the default.
 * Both views read the shared task state and open the same edit modal.
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { GanttChartSquare, Table2 } from "lucide-react";
import CalendarTimeline from "./CalendarTimeline";
import TableView from "./TableView";
import TaskModal from "./TaskModal";
import { cn } from "../../lib/utils";
import type { Task } from "../../lib/types";
import type { PlanningTasks } from "./usePlanningTasks";

type SubView = "timeline" | "table";

interface Props {
  planning: PlanningTasks;
}

export default function ViewTab({ planning }: Props) {
  const navigate = useNavigate();
  const { tasks, toggleDone, removeTask, addTask, applyEdit } = planning;
  const [sub, setSub] = useState<SubView>("timeline");
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [modalOpen, setModalOpen] = useState(false);
  const [editTask, setEditTask] = useState<Task | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 30_000); // 30s is plenty here
    return () => window.clearInterval(id);
  }, []);

  const openMaterial = (id: number) => navigate(`/library/material/${id}`, { state: { source: "courses" } });
  const openTask = (t: Task) => { setEditTask(t); setModalOpen(true); };

  return (
    <div className="flex h-[calc(100vh-11rem)] min-h-[32rem] flex-col rounded-[24px] border border-white/[0.06] bg-white/[0.02] p-5 shadow-2xl backdrop-blur-xl">
      {/* Sub-toggle */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-1 rounded-full border border-white/[0.06] bg-white/[0.02] p-1">
          {([
            { key: "timeline", label: "Timeline", icon: GanttChartSquare },
            { key: "table", label: "Table", icon: Table2 },
          ] as const).map((v) => (
            <button
              key={v.key}
              type="button"
              onClick={() => setSub(v.key)}
              aria-pressed={sub === v.key}
              className={cn(
                "flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors",
                sub === v.key
                  ? "bg-white/[0.06] text-content-primary shadow-[inset_0_1px_1px_rgba(255,255,255,0.1)]"
                  : "text-content-secondary hover:bg-white/[0.04]",
              )}
            >
              <v.icon size={14} strokeWidth={2} aria-hidden />
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1">
        {sub === "timeline" ? (
          <CalendarTimeline
            tasks={tasks}
            now={nowTick}
            onToggleDone={(t) => void toggleDone(t)}
            onOpenTask={openTask}
            onOpenMaterial={openMaterial}
          />
        ) : (
          <TableView
            tasks={tasks}
            now={nowTick}
            onToggleDone={(t) => void toggleDone(t)}
            onOpenTask={openTask}
            onDelete={(t) => void removeTask(t)}
            onOpenMaterial={openMaterial}
          />
        )}
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
