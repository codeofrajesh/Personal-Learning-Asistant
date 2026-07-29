/**
 * TableView — a professional, Notion-database-style task table. A quiet header row with
 * sortable columns (Task · Priority · Deadline · Lesson · Status), generous row height,
 * subtle `divide-y` separators (no heavy gridlines), inline status/priority pills, and
 * hover affordances. Clicking a row opens the edit modal; the checkbox toggles done.
 *
 * Sorting: click a column header to sort asc, click again for desc (arrow indicator).
 * Kept pristine per design-taste "don't look like a spreadsheet" — pills + whitespace,
 * not cell borders everywhere.
 */

import { useMemo, useState } from "react";
import { Check, ChevronUp, ChevronDown, Link2, Play, Pencil, Trash2 } from "lucide-react";
import { PRIORITY_META, dueMs, isOverdue, parseDue, taskStatus } from "./planningUtils";
import TaskGlyph from "./TaskGlyph";
import { cn } from "../../lib/utils";
import type { Task } from "../../lib/types";

type SortKey = "title" | "priority" | "due" | "lesson" | "status";
type Dir = "asc" | "desc";

interface Props {
  tasks: Task[];
  now: number;
  onToggleDone: (t: Task) => void;
  onOpenTask: (t: Task) => void;
  onDelete: (t: Task) => void;
  onOpenMaterial: (id: number) => void;
}

const COLUMNS: { key: SortKey; label: string; className: string }[] = [
  { key: "title", label: "Task", className: "min-w-0 flex-[2_1_0%]" },
  { key: "priority", label: "Priority", className: "w-28 shrink-0" },
  { key: "due", label: "Deadline", className: "w-36 shrink-0" },
  { key: "lesson", label: "Lesson", className: "min-w-0 flex-1" },
  { key: "status", label: "Status", className: "w-24 shrink-0" },
];

function fmtDeadline(due_at: string | null): string {
  const d = parseDue(due_at);
  if (!d) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function TableView({ tasks, now, onToggleDone, onOpenTask, onDelete, onOpenMaterial }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("due");
  const [dir, setDir] = useState<Dir>("asc");

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setDir("asc");
    }
  };

  const sorted = useMemo(() => {
    const arr = [...tasks];
    const mul = dir === "asc" ? 1 : -1;
    arr.sort((a, b) => {
      switch (sortKey) {
        case "title":
          return mul * a.title.localeCompare(b.title);
        case "priority":
          return mul * (a.priority - b.priority);
        case "due": {
          const da = dueMs(a.due_at) ?? Infinity;
          const db = dueMs(b.due_at) ?? Infinity;
          return mul * (da - db);
        }
        case "lesson":
          return mul * (a.material_name ?? "").localeCompare(b.material_name ?? "");
        case "status":
          return mul * (statusRank(a, now) - statusRank(b, now));
        default:
          return 0;
      }
    });
    return arr;
  }, [tasks, sortKey, dir, now]);

  return (
    <div className="scroll-thin h-full overflow-auto rounded-[18px] border border-white/[0.06] bg-black/20">
      <div className="flex min-h-full min-w-[42rem] flex-col">
      {/* Header and rows share one scrollport, so columns stay aligned on both axes. */}
      <div className="sticky top-0 z-10 flex items-center gap-4 border-b border-white/[0.08] bg-ink-900/95 px-4 py-2.5 backdrop-blur-xl">
        <span className="w-6 shrink-0" />
        {COLUMNS.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => toggleSort(c.key)}
            className={cn("flex items-center gap-1 text-left text-[0.66rem] font-semibold uppercase tracking-wide transition-colors", c.className, sortKey === c.key ? "text-content-primary" : "text-white/40 hover:text-content-secondary")}
          >
            {c.label}
            {sortKey === c.key && (dir === "asc" ? <ChevronUp size={12} strokeWidth={2.5} aria-hidden /> : <ChevronDown size={12} strokeWidth={2.5} aria-hidden />)}
          </button>
        ))}
        <span className="w-16 shrink-0" />
      </div>

      {/* Rows */}
      <div className="flex-1 divide-y divide-white/[0.04]">
        {sorted.length === 0 ? (
          <p className="p-6 text-center text-xs text-white/40">No tasks yet. Add one from the Planner tab.</p>
        ) : (
          sorted.map((task) => {
            const prio = PRIORITY_META[task.priority] ?? PRIORITY_META[0];
            const overdue = isOverdue(task, now);
            const status = taskStatus(task, now);
            return (
              <div key={task.id} className="group flex items-center gap-4 px-4 py-3 transition-colors hover:bg-white/[0.03]">
                <button
                  type="button"
                  onClick={() => onToggleDone(task)}
                  aria-label={task.done ? "Mark not done" : "Mark done"}
                  className={cn("grid h-6 w-6 shrink-0 place-items-center rounded-full border transition-colors", task.done ? "border-lime bg-lime text-ink-900" : "border-white/20 text-transparent hover:border-lime/50")}
                >
                  <Check size={13} strokeWidth={3} aria-hidden />
                </button>

                {/* Task */}
                <button type="button" onClick={() => onOpenTask(task)} className="flex min-w-0 flex-[2_1_0%] items-center gap-2 text-left text-sm">
                  <TaskGlyph task={task} size={13} className="shrink-0 text-white/40" />
                  <span className={cn("truncate", task.done ? "text-white/30 line-through" : "text-content-primary")}>{task.title}</span>
                </button>

                {/* Priority */}
                <div className="w-28 shrink-0">
                  {task.priority > 0 ? (
                    <span className={cn("inline-flex items-center gap-1.5 rounded-full border border-white/[0.06] bg-white/[0.03] px-2 py-0.5 text-[0.66rem] font-medium", prio.text)}>
                      <span className={cn("h-1.5 w-1.5 rounded-full", prio.dot)} aria-hidden />
                      {prio.label}
                    </span>
                  ) : (
                    <span className="text-[0.66rem] text-white/25">—</span>
                  )}
                </div>

                {/* Deadline */}
                <div className={cn("w-36 shrink-0 truncate text-xs", overdue ? "text-red-400" : "text-content-secondary")}>
                  {fmtDeadline(task.due_at)}
                  {overdue && <span className="ml-1 text-[0.6rem]">overdue</span>}
                </div>

                {/* Lesson */}
                <div className="min-w-0 flex-1 overflow-hidden">
                  {task.material_id != null ? (
                    <button type="button" onClick={() => onOpenMaterial(task.material_id as number)} className="flex min-w-0 max-w-full items-center gap-1 text-xs text-cyan-400/80 transition-colors hover:text-cyan-300">
                      <Link2 size={11} strokeWidth={2} className="shrink-0" aria-hidden />
                      <span className="truncate">{task.material_name}</span>
                      <Play size={9} strokeWidth={2.5} fill="currentColor" className="shrink-0" aria-hidden />
                    </button>
                  ) : (
                    <span className="text-[0.66rem] text-white/25">—</span>
                  )}
                </div>

                {/* Status */}
                <div className="w-24 shrink-0">
                  <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[0.64rem] font-semibold", status === "done" ? "bg-emerald-400/10 text-emerald-300" : status === "overdue" ? "bg-red-400/10 text-red-400" : status === "soon" ? "bg-amber-400/10 text-amber-300" : "bg-slate-400/10 text-slate-300")}>
                    {status === "done" ? "Done" : status === "overdue" ? "Overdue" : status === "soon" ? "Due soon" : task.due_at ? "Upcoming" : "Unscheduled"}
                  </span>
                </div>

                {/* Actions */}
                <div className="flex w-16 shrink-0 items-center justify-end gap-1">
                  <button type="button" onClick={() => onOpenTask(task)} aria-label="Edit task" className="grid h-7 w-7 place-items-center rounded-full text-white/25 opacity-0 transition-all hover:bg-white/[0.06] hover:text-content-primary focus-visible:opacity-100 group-hover:opacity-100">
                    <Pencil size={13} strokeWidth={2} aria-hidden />
                  </button>
                  <button type="button" onClick={() => onDelete(task)} aria-label="Delete task" className="grid h-7 w-7 place-items-center rounded-full text-white/25 opacity-0 transition-all hover:bg-red-400/10 hover:text-red-400 focus-visible:opacity-100 group-hover:opacity-100">
                    <Trash2 size={13} strokeWidth={2} aria-hidden />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
      </div>
    </div>
  );
}

function statusRank(task: Task, now: number): number {
  switch (taskStatus(task, now)) {
    case "overdue": return 0;
    case "soon": return 1;
    case "upcoming": return task.due_at ? 2 : 3;
    case "done": return 4;
  }
}
