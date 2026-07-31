/**
 * Shared presentation helpers for the Planning views (Planner / Calendar / Table).
 * Centralising these keeps the priority palette + deadline logic identical across
 * every surface (design-taste "color consistency lock").
 */

import type { PlanBlock, Task } from "../../lib/types";

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

// ── Blocks (v9 schedule) ─────────────────────────────────────────────────────

/**
 * Presentation state of a block. Distinct from `BlockStatus` because two of these are
 * *derived from the clock*, not stored: a `pending` block reads differently at 05:00 (upcoming),
 * 06:05 (missed its start) and 09:00 (long gone). Deriving it here keeps that judgement in one
 * place instead of scattering `Date.now()` comparisons through the views.
 */
export type BlockVisualState =
  | "done"
  | "partial"
  | "skipped"
  | "spilled"
  | "active"
  | "overrun"
  | "late"
  | "now"
  | "upcoming";

/** How long past its start a pending block counts as "late" rather than just imminent. */
export const BLOCK_LATE_MINS = 5;

/**
 * Classify a block for display. `nowMins` is minutes since local midnight; `isToday` gates the
 * clock-derived states so browsing next Tuesday doesn't paint every block as "late".
 */
export function blockVisualState(
  block: PlanBlock,
  nowMins: number,
  isToday: boolean,
): BlockVisualState {
  switch (block.status) {
    case "done":
      return "done";
    case "partial":
      return "partial";
    case "skipped":
      return "skipped";
    case "spilled":
      return "spilled";
    default:
      break;
  }

  const start = blockStartMins(block);
  const end = start == null ? null : start + block.effective_mins;

  if (block.status === "active") {
    // Still running past its planned end — the moment worth offering a recovery for.
    return isToday && end != null && nowMins > end ? "overrun" : "active";
  }
  if (!isToday || start == null) return "upcoming";
  if (nowMins >= start + BLOCK_LATE_MINS) return "late";
  if (nowMins >= start) return "now";
  return "upcoming";
}

/** A block's effective start in minutes since midnight, or null when unparseable. */
export function blockStartMins(block: PlanBlock): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(block.effective_start);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Palette per visual state, reusing the task status vocabulary so the two surfaces agree. */
export const BLOCK_STATE_META: Record<
  BlockVisualState,
  { grad: string; rail: string; text: string; label: string }
> = {
  done: { grad: DONE_META.grad, rail: DONE_META.rail, text: DONE_META.text, label: "Done" },
  partial: {
    grad: "from-emerald-500/[0.10] to-amber-400/[0.04]",
    rail: "bg-emerald-500/50",
    text: "text-emerald-200/70",
    label: "Partly done",
  },
  skipped: {
    grad: "from-white/[0.04] to-white/[0.01]",
    rail: "bg-white/20",
    text: "text-white/35",
    label: "Skipped",
  },
  spilled: {
    grad: "from-violet-500/[0.14] to-white/[0.02]",
    rail: "bg-violet-400/60",
    text: "text-violet-200/80",
    label: "Moved on",
  },
  active: {
    grad: "from-lime/20 to-emerald-400/[0.05]",
    rail: "bg-lime",
    text: "text-lime",
    label: "In progress",
  },
  overrun: {
    grad: OVERDUE_META.grad,
    rail: OVERDUE_META.rail,
    text: OVERDUE_META.text,
    label: "Running over",
  },
  late: { grad: SOON_META.grad, rail: SOON_META.rail, text: SOON_META.text, label: "Late start" },
  now: {
    grad: "from-cyan-500/20 to-sky-400/[0.05]",
    rail: "bg-cyan-400",
    text: "text-cyan-300",
    label: "Starts now",
  },
  upcoming: {
    grad: UPCOMING_META.grad,
    rail: UPCOMING_META.rail,
    text: UPCOMING_META.text,
    label: "Upcoming",
  },
};

/** True when a block is still open work the adjustment engine would touch. */
export function isBlockOpen(block: PlanBlock): boolean {
  return block.status === "pending" || block.status === "active";
}

/**
 * The block's progress toward its OWN target, as short text ("1 / 2 lessons", "15m / 1h").
 *
 * The backend has tracked this since the attribution funnel landed, and the UI never showed it:
 * `progress_count` and `executed_mins` both moved while every surface displayed only a status
 * word, so a student watching lecture one of two got no acknowledgement that anything counted.
 * A silent tracker is indistinguishable from a broken one, which is exactly how it was reported.
 *
 * The unit follows the block's contract, because that is what the student agreed to:
 *
 *   * `node_count`   → items, the thing they asked for ("2 lessons"), with minutes available on
 *                      the bar underneath. Falls back to a bare count when no target is set.
 *   * `node_minutes` → minutes, since a time box is answered in minutes and `progress_count`
 *                      is only incidental there (it is counted, never used to complete).
 *   * `material`     → a single file: "done" or nothing. "0 / 1 lessons" is noise for a block
 *                      whose own title already names the one video.
 *   * everything else (task / freeform) → minutes against the plan when any time is logged.
 *
 * Returns `null` when there is genuinely nothing to say, so callers can omit the row entirely
 * rather than render an empty slot.
 */
export function blockProgressLabel(block: PlanBlock): string | null {
  const done = Math.max(0, Math.round(block.executed_mins));

  if (block.target_kind === "node_count") {
    const want = block.target_count ?? 0;
    const items = Math.max(0, block.progress_count);
    if (want > 0) return `${Math.min(items, want)} / ${want} lessons`;
    return items > 0 ? `${items} ${items === 1 ? "lesson" : "lessons"}` : null;
  }

  if (block.target_kind === "material") {
    return block.status === "done" ? "Watched" : null;
  }

  // Time-boxed and freeform work: minutes are the honest unit. Suppressed until something has
  // actually been logged, so an untouched block stays quiet instead of advertising "0m".
  if (done <= 0) return null;
  return `${fmtMins(done)} / ${fmtMins(block.effective_mins)}`;
}

/**
 * How much of a timeline block's content actually fits in its rendered height.
 *
 * A calendar block is a fixed-height flex column, and its rows do NOT declare `shrink-0` by
 * accident of writing them: flex's default `shrink: 1` means an overfull column compresses its
 * children BELOW their content height instead of clipping, which is what made the title and the
 * time/course line render on top of each other. Two things fix that together — the rows are now
 * `shrink-0` (so overflow clips at the rounded edge, the honest failure), and a row is only
 * mounted when the block is genuinely tall enough for it.
 *
 * The numbers are the real laid-out heights, not what the font size suggests: the meta row holds
 * `h-6` (24px) icon buttons for the linked lesson and skip, so it is 24px tall, not ~14px. The
 * old `height < 72` gate under-counted exactly that, so every block between 72px and 84px mounted
 * three rows into space for two.
 *
 *   p-2 top+bottom     16
 *   title row          24  → 40  (title only)
 *   mt-1 + meta row  4+24  → 68  (+ time range · state)
 *   pt-1 + progress  4+12  → 84  (+ executed bar)
 */
const BLOCK_H_META = 68;
const BLOCK_H_FULL = 84;

export type BlockDetail = "title" | "meta" | "full";

/** Which rows a block of `height` px can show without crushing its own text. */
export function blockDetail(height: number): BlockDetail {
  if (height >= BLOCK_H_FULL) return "full";
  if (height >= BLOCK_H_META) return "meta";
  return "title";
}

/** `"1h 20m"` / `"45m"` — matches the Rust `fmt_duration` so both sides read identically. */
export function fmtMins(mins: number): string {
  const m = Math.max(0, Math.round(mins));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

/** `'HH:MM'` (24h) → a friendly local label ("6:00 AM"), without re-parsing dates. */
export function fmtHhmmLabel(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm);
  if (!m) return hhmm;
  const h = Number(m[1]);
  const suffix = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]} ${suffix}`;
}
