/**
 * Shared presentation helpers for the Planning views (Planner / Calendar / Table).
 * Centralising these keeps the priority palette + deadline logic identical across
 * every surface (design-taste "color consistency lock").
 */

import type { Task } from "../../lib/types";

/** Priority index → label + solid dot + duotone gradient + accent text. */
export const PRIORITY_META: {
  label: string;
  dot: string;
  grad: string;
  rail: string;
  text: string;
}[] = [
  { label: "None", dot: "bg-white/25", grad: "from-white/[0.06] to-white/[0.01]", rail: "bg-white/25", text: "text-white/50" },
  { label: "Low", dot: "bg-lime", grad: "from-lime/20 to-emerald-400/[0.05]", rail: "bg-lime", text: "text-lime" },
  { label: "Medium", dot: "bg-cyan-400", grad: "from-cyan-500/20 to-sky-400/[0.05]", rail: "bg-cyan-400", text: "text-cyan-300" },
  { label: "High", dot: "bg-orange", grad: "from-orange-500/20 to-amber-400/[0.05]", rail: "bg-orange", text: "text-orange" },
];

/** Overdue styling (used when an open task's deadline has passed). */
export const OVERDUE_META = {
  grad: "from-red-500/20 to-orange-500/[0.05]",
  rail: "bg-red-400",
  text: "text-red-300",
  dot: "bg-red-400",
};

/** "Due soon" styling — an open task whose deadline is within SOON_WINDOW_MS. */
export const SOON_META = {
  grad: "from-amber-500/20 to-orange-400/[0.05]",
  rail: "bg-amber-400",
  text: "text-amber-300",
  dot: "bg-amber-400",
};

/** Completed styling — muted green, so done work recedes but reads as "success". */
export const DONE_META = {
  grad: "from-emerald-500/[0.12] to-emerald-400/[0.02]",
  rail: "bg-emerald-500/60",
  text: "text-emerald-300/70",
  dot: "bg-emerald-500/70",
};

/** Neutral status styling for work that is neither due soon, overdue, nor done. */
export const UPCOMING_META = {
  grad: "from-slate-400/[0.10] to-white/[0.02]",
  rail: "bg-slate-400",
  text: "text-slate-300",
  dot: "bg-slate-400",
};

/** How far ahead counts as "due soon" (amber). Default: next 24 hours. */
export const SOON_WINDOW_MS = 24 * 60 * 60 * 1000;

export type TaskStatus = "done" | "overdue" | "soon" | "upcoming";

/** Classify a task by status (done → overdue → soon → upcoming). */
export function taskStatus(task: Task, now: number): TaskStatus {
  if (task.done) return "done";
  const ms = dueMs(task.due_at);
  if (ms == null) return "upcoming";
  if (ms < now) return "overdue";
  if (ms - now <= SOON_WINDOW_MS) return "soon";
  return "upcoming";
}

/**
 * Status-first block styling for the calendar. Completed → green-muted, overdue → red,
 * due-soon → amber; upcoming → neutral slate. Priority remains a separate text/pill
 * signal rather than overloading the status color channel.
 */
export function statusStyle(
  task: Task,
  now: number,
): { grad: string; rail: string; text: string; dot: string } {
  switch (taskStatus(task, now)) {
    case "done":
      return DONE_META;
    case "overdue":
      return OVERDUE_META;
    case "soon":
      return SOON_META;
    default:
      return UPCOMING_META;
  }
}

/**
 * Fraction of the derived deadline window that has elapsed. This is deliberately not
 * task-completion progress: the UI labels it as a deadline window. Done → 1. Otherwise
 * we measure how far "now" has advanced through the task's derived window
 * (start = due − estimate) toward the deadline; clamped to [0,1]. With no estimate we
 * assume a 60-minute lead-in so the bar still fills as the deadline approaches.
 */
export function taskProgress(task: Task, now: number): number {
  if (task.done) return 1;
  const end = dueMs(task.due_at);
  if (end == null) return 0;
  const mins = task.estimated_mins && task.estimated_mins > 0 ? task.estimated_mins : 60;
  const start = end - mins * 60000;
  if (now <= start) return 0;
  if (now >= end) return 1;
  return (now - start) / (end - start);
}

/** Parse a task/ISO due string to epoch ms (tolerates date-only + 'T'/' ' separators). */
export function dueMs(due_at: string | null): number | null {
  if (!due_at) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due_at);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    const local = new Date(Number(year), Number(month) - 1, Number(day));
    return local.getTime();
  }
  const t = new Date(due_at.replace(" ", "T")).getTime();
  return isNaN(t) ? null : t;
}

export function parseDue(due_at: string | null): Date | null {
  const ms = dueMs(due_at);
  return ms == null ? null : new Date(ms);
}

/** True if the open task's deadline has passed. */
export function isOverdue(task: Task, now: number): boolean {
  if (task.done) return false;
  const ms = dueMs(task.due_at);
  return ms != null && ms < now;
}

/** Human relative label + tone for a deadline. */
export function deadlineLabel(
  due_at: string,
  done: boolean,
  now: number,
): { text: string; tone: string } {
  const due = dueMs(due_at);
  if (due == null) return { text: "", tone: "text-white/40" };
  const diff = due - now;
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const hrs = Math.round(abs / 3_600_000);
  const dys = Math.round(abs / 86_400_000);
  const rel = mins < 60 ? `${mins}m` : hrs < 24 ? `${hrs}h` : `${dys}d`;
  if (!done && diff < 0) return { text: `${rel} overdue`, tone: "text-red-400" };
  if (!done && diff < 3_600_000) return { text: `in ${rel}`, tone: "text-orange" };
  if (!done && diff < 86_400_000) return { text: `in ${rel}`, tone: "text-orange/80" };
  return { text: `in ${rel}`, tone: "text-white/40" };
}

/** Local YYYY-MM-DD. */
export function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Compose an ISO datetime the backend accepts: `YYYY-MM-DD HH:MM:SS`. */
export function toIsoDateTime(d: Date): string {
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:00`;
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function fmtTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * Semantic icon kind for a task. A linked material maps to its media type
 * (video/pdf/note/image/audio); an unlinked task is a generic "task" checklist item.
 * The component turns this string into a lucide icon (keeps JSX out of this .ts file).
 */
export type TaskIconKind = "video" | "pdf" | "note" | "image" | "audio" | "task";

export function taskIconKind(task: Task): TaskIconKind {
  switch (task.material_type) {
    case "video":
      return "video";
    case "pdf":
      return "pdf";
    case "note":
      return "note";
    case "image":
      return "image";
    case "audio":
      return "audio";
    default:
      return "task";
  }
}
