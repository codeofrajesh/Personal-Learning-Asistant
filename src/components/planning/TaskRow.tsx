/**
 * TaskRow — a single clean task row for the Planner list. No cramped inline editors:
 * a checkbox, priority dot, title, deadline + linked-lesson meta, a play affordance for
 * linked lessons, and hover actions (edit → opens TaskModal, delete). Editing detail is
 * delegated to the modal, keeping the row pristine (Phase 3 goal).
 */

import { Check, CalendarClock, Link2, Play, Pencil, Trash2 } from "lucide-react";
import { PRIORITY_META, deadlineLabel } from "./planningUtils";
import { cn } from "../../lib/utils";
import type { Task } from "../../lib/types";

interface Props {
  task: Task;
  now: number;
  onToggleDone: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onOpenMaterial: (id: number) => void;
}

export default function TaskRow({ task, now, onToggleDone, onEdit, onDelete, onOpenMaterial }: Props) {
  const prio = PRIORITY_META[task.priority] ?? PRIORITY_META[0];
  const deadline = task.due_at ? deadlineLabel(task.due_at, task.done, now) : null;

  return (
    <div className="group flex items-center gap-3 border-b border-white/[0.04] py-2.5 last:border-b-0">
      <button
        type="button"
        onClick={onToggleDone}
        aria-pressed={task.done}
        aria-label={task.done ? "Mark not done" : "Mark done"}
        className={cn(
          "grid h-6 w-6 shrink-0 place-items-center rounded-full border transition-colors",
          task.done ? "border-lime bg-lime text-ink-900" : "border-white/20 text-transparent hover:border-lime/50",
        )}
      >
        <Check size={13} strokeWidth={3} aria-hidden />
      </button>

      {task.priority > 0 && !task.done && (
        <span className={cn("h-2 w-2 shrink-0 rounded-full", prio.dot)} aria-hidden />
      )}

      <button type="button" onClick={onEdit} className="min-w-0 flex-1 text-left">
        <span className={cn("block truncate text-sm", task.done ? "text-white/30 line-through" : "text-content-primary")}>
          {task.title}
        </span>
        {(deadline || task.material_name) && (
          <span className="mt-0.5 flex items-center gap-2 text-[0.68rem]">
            {deadline && (
              <span className={cn("flex items-center gap-1", task.done ? "text-white/30" : deadline.tone)}>
                <CalendarClock size={11} strokeWidth={2} aria-hidden />
                {deadline.text}
              </span>
            )}
            {task.material_name && (
              <span className="flex min-w-0 items-center gap-1 text-cyan-400/80">
                <Link2 size={11} strokeWidth={2} aria-hidden />
                <span className="truncate">{task.material_name}</span>
              </span>
            )}
          </span>
        )}
      </button>

      {task.material_id != null && (
        <button
          type="button"
          onClick={() => onOpenMaterial(task.material_id as number)}
          aria-label="Open linked lesson"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-cyan-400/10 text-cyan-400 transition-colors hover:bg-cyan-400 hover:text-ink-900"
        >
          <Play size={12} strokeWidth={2.5} fill="currentColor" aria-hidden />
        </button>
      )}

      <button
        type="button"
        onClick={onEdit}
        aria-label="Edit task"
        className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-white/25 opacity-0 transition-all hover:bg-white/[0.06] hover:text-content-primary focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Pencil size={13} strokeWidth={2} aria-hidden />
      </button>

      <button
        type="button"
        onClick={onDelete}
        aria-label="Delete task"
        className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-white/25 opacity-0 transition-all hover:bg-red-400/10 hover:text-red-400 focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Trash2 size={14} strokeWidth={2} aria-hidden />
      </button>
    </div>
  );
}
