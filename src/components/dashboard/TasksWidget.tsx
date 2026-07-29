/**
 * To-Do list widget — an advanced dashboard task list. Supports inline quick-add,
 * check/uncheck, delete, plus a per-task detail row for PRIORITY (none/low/med/high),
 * a DUE DATE, and a MATERIAL LINK (deep-links a specific lesson into the player).
 *
 * Interaction model (design-taste): the high-frequency path is inline — type a title +
 * Enter to add, click the checkbox to complete, hover to reveal delete. Setting
 * priority/due/link happens in a compact expander under the row (not a heavy modal),
 * preserving spatial context. All writes are OPTIMISTIC (flip locally → persist →
 * roll back on error), which suits a single-user local app with zero conflict risk.
 *
 * Data: `ipc.listTasks` on mount; `createTask`/`setTaskDone`/`deleteTask`/`updateTask`
 * for mutations. Material linking reuses `ipc.searchMaterials` (the Ctrl+K FTS index).
 *
 * Aesthetic (ui-ux-pro-max): translucent glass shell, priority accent dots, a due-date
 * chip that turns orange when overdue, lime check when done. lucide-react (ui-styling).
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Plus,
  Check,
  Trash2,
  Flag,
  CalendarClock,
  Link2,
  Play,
  X,
  Search,
} from "lucide-react";
import { ipc, isTauri } from "../../lib/ipc";
import { cn } from "../../lib/utils";
import type { SearchResult, Task } from "../../lib/types";

/** Priority → label + accent color (0 none / 1 low / 2 med / 3 high). */
const PRIORITY: { label: string; dot: string; text: string }[] = [
  { label: "None", dot: "bg-white/20", text: "text-white/40" },
  { label: "Low", dot: "bg-sky-300", text: "text-sky-300" },
  { label: "Medium", dot: "bg-orange", text: "text-orange" },
  { label: "High", dot: "bg-red-400", text: "text-red-400" },
];

/** Local YYYY-MM-DD for today (matches the app's date handling). */
function todayIso(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Format an ISO due date to a short human label; flags overdue. */
function dueLabel(due: string): { text: string; overdue: boolean } {
  const iso = due.slice(0, 10);
  const today = todayIso();
  const d = new Date(`${iso}T00:00:00`);
  const label = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return { text: label, overdue: iso < today };
}

function TasksWidgetView() {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [preview, setPreview] = useState(false);
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!isTauri()) {
      setPreview(true);
      setLoaded(true);
      return;
    }
    try {
      const rows = await ipc.listTasks();
      setTasks(rows);
    } catch {
      /* keep whatever we have */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const addTask = useCallback(async () => {
    const title = draft.trim();
    if (!title || !isTauri()) {
      setDraft("");
      return;
    }
    setDraft("");
    // Optimistic temp row.
    const tempId = -Date.now();
    const optimistic: Task = {
      id: tempId,
      title,
      done: false,
      priority: 0,
      due_at: null,
      material_id: null,
      material_name: null,
      material_type: null,
      sort_order: 0,
      estimated_mins: null,
      completed_at: null,
      created_at: new Date().toISOString(),
    };
    setTasks((cur) => [optimistic, ...cur]);
    try {
      const realId = await ipc.createTask(title, 0, null, null);
      setTasks((cur) => cur.map((t) => (t.id === tempId ? { ...t, id: realId } : t)));
    } catch {
      setTasks((cur) => cur.filter((t) => t.id !== tempId));
    }
  }, [draft]);

  const toggleDone = useCallback(async (task: Task) => {
    const next = !task.done;
    setTasks((cur) => cur.map((t) => (t.id === task.id ? { ...t, done: next } : t)));
    try {
      await ipc.setTaskDone(task.id, next);
    } catch {
      setTasks((cur) => cur.map((t) => (t.id === task.id ? { ...t, done: !next } : t)));
    }
  }, []);

  const removeTask = useCallback(async (task: Task) => {
    const snapshot = task;
    setTasks((cur) => cur.filter((t) => t.id !== task.id));
    if (editingId === task.id) setEditingId(null);
    try {
      await ipc.deleteTask(task.id);
    } catch {
      setTasks((cur) => [snapshot, ...cur]);
    }
  }, [editingId]);

  // Apply a detail edit (priority/due/material). Optimistic; reloads on failure.
  const applyEdit = useCallback(
    async (task: Task, patch: Partial<Pick<Task, "priority" | "due_at" | "material_id" | "material_name" | "material_type">>) => {
      const merged = { ...task, ...patch };
      setTasks((cur) => cur.map((t) => (t.id === task.id ? merged : t)));
      try {
        await ipc.updateTask(
          task.id,
          merged.title,
          merged.priority,
          merged.due_at,
          merged.material_id,
          merged.estimated_mins,
        );
      } catch {
        void load();
      }
    },
    [load],
  );

  const openMaterial = (id: number) =>
    navigate(`/library/material/${id}`, { state: { source: "courses" } });

  const remaining = useMemo(() => tasks.filter((t) => !t.done).length, [tasks]);

  return (
    <section className="tasks-widget relative flex h-full flex-col overflow-hidden rounded-[24px] border border-white/[0.06] bg-white/[0.02] p-6 shadow-2xl backdrop-blur-xl">
      <header className="mb-3 flex items-center gap-2">
        <Check size={17} strokeWidth={2.5} className="text-lime" aria-hidden />
        <h2 className="text-base font-semibold text-content-primary">To-do</h2>
        {loaded && !preview && remaining > 0 && (
          <span className="ml-auto text-xs text-white/40">{remaining} open</span>
        )}
      </header>

      {/* Quick-add */}
      {!preview && (
        <div className="mb-3 flex items-center gap-2 rounded-[14px] border border-white/[0.06] bg-black/30 px-3 py-2 focus-within:border-lime/30">
          <Plus size={16} strokeWidth={2} className="shrink-0 text-white/40" aria-hidden />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void addTask();
              }
            }}
            placeholder="Add a task…"
            aria-label="Add a task"
            className="min-w-0 flex-1 bg-transparent text-sm text-content-primary placeholder:text-white/30 focus:outline-none"
          />
        </div>
      )}

      {/* List */}
      <div className="scroll-thin -mx-1 flex max-h-[19rem] flex-1 flex-col overflow-y-auto px-1">
        {preview ? (
          <div className="flex flex-1 items-center justify-center py-8 text-center text-sm text-white/40">
            Preview mode — open in the desktop app to manage tasks.
          </div>
        ) : tasks.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-8 text-center">
            <p className="text-sm text-content-secondary">No tasks yet</p>
            <p className="max-w-[16rem] text-xs text-white/40">
              Add a to-do above — set a due date, priority, or link a specific lesson.
            </p>
          </div>
        ) : (
          tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              expanded={editingId === task.id}
              onToggleExpand={() => setEditingId((cur) => (cur === task.id ? null : task.id))}
              onToggleDone={() => void toggleDone(task)}
              onDelete={() => void removeTask(task)}
              onOpenMaterial={openMaterial}
              onEdit={(patch) => void applyEdit(task, patch)}
            />
          ))
        )}
      </div>
    </section>
  );
}

/** One task row + its inline detail expander. */
function TaskRow({
  task,
  expanded,
  onToggleExpand,
  onToggleDone,
  onDelete,
  onOpenMaterial,
  onEdit,
}: {
  task: Task;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleDone: () => void;
  onDelete: () => void;
  onOpenMaterial: (id: number) => void;
  onEdit: (patch: Partial<Pick<Task, "priority" | "due_at" | "material_id" | "material_name" | "material_type">>) => void;
}) {
  const prio = PRIORITY[task.priority] ?? PRIORITY[0];
  const due = task.due_at ? dueLabel(task.due_at) : null;

  return (
    <div className="border-b border-white/[0.04] last:border-b-0">
      <div className="group flex items-center gap-3 py-2.5">
        {/* Checkbox */}
        <button
          type="button"
          onClick={onToggleDone}
          aria-pressed={task.done}
          aria-label={task.done ? "Mark not done" : "Mark done"}
          className={cn(
            "grid h-6 w-6 shrink-0 place-items-center rounded-full border transition-colors",
            task.done
              ? "border-lime bg-lime text-ink-900"
              : "border-white/20 text-transparent hover:border-lime/50",
          )}
        >
          <Check size={13} strokeWidth={3} aria-hidden />
        </button>

        {/* Priority dot (click cycles priority 0→3) */}
        {task.priority > 0 && !task.done && (
          <span className={cn("h-2 w-2 shrink-0 rounded-full", prio.dot)} aria-hidden />
        )}

        {/* Title + link chip */}
        <button
          type="button"
          onClick={onToggleExpand}
          className="min-w-0 flex-1 text-left"
          aria-expanded={expanded}
        >
          <span
            className={cn(
              "block truncate text-sm",
              task.done ? "text-white/30 line-through" : "text-content-primary",
            )}
          >
            {task.title}
          </span>
          {(due || task.material_name) && (
            <span className="mt-0.5 flex items-center gap-2 text-[0.68rem]">
              {due && (
                <span className={cn("flex items-center gap-1", due.overdue && !task.done ? "text-orange" : "text-white/40")}>
                  <CalendarClock size={11} strokeWidth={2} aria-hidden />
                  {due.text}
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

        {/* Open linked material */}
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

        {/* Delete (reveal on hover/focus) */}
        <button
          type="button"
          onClick={onDelete}
          aria-label="Delete task"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-white/25 opacity-0 transition-all hover:bg-red-400/10 hover:text-red-400 focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Trash2 size={14} strokeWidth={2} aria-hidden />
        </button>
      </div>

      {expanded && <TaskEditor task={task} onEdit={onEdit} />}
    </div>
  );
}

/** Inline detail editor: priority pills, due date input, material linker. */
function TaskEditor({
  task,
  onEdit,
}: {
  task: Task;
  onEdit: (patch: Partial<Pick<Task, "priority" | "due_at" | "material_id" | "material_name" | "material_type">>) => void;
}) {
  return (
    <div className="mb-2 ml-9 flex flex-col gap-3 rounded-[12px] border border-white/[0.05] bg-black/30 p-3">
      {/* Priority */}
      <div className="flex items-center gap-2">
        <Flag size={13} strokeWidth={2} className="shrink-0 text-white/40" aria-hidden />
        <div className="flex flex-wrap gap-1.5">
          {PRIORITY.map((p, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onEdit({ priority: i })}
              className={cn(
                "flex items-center gap-1 rounded-full border px-2.5 py-1 text-[0.68rem] font-medium transition-colors",
                task.priority === i
                  ? "border-white/20 bg-white/[0.08] text-content-primary"
                  : "border-white/[0.06] text-white/50 hover:bg-white/[0.04]",
              )}
            >
              {i > 0 && <span className={cn("h-1.5 w-1.5 rounded-full", p.dot)} aria-hidden />}
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Due date */}
      <div className="flex items-center gap-2">
        <CalendarClock size={13} strokeWidth={2} className="shrink-0 text-white/40" aria-hidden />
        <input
          type="date"
          value={task.due_at ? task.due_at.slice(0, 10) : ""}
          onChange={(e) => onEdit({ due_at: e.target.value || null })}
          aria-label="Due date"
          className="rounded-btn border border-white/[0.06] bg-black/40 px-2.5 py-1 text-xs text-content-primary [color-scheme:dark] focus:border-lime/30 focus:outline-none"
        />
        {task.due_at && (
          <button
            type="button"
            onClick={() => onEdit({ due_at: null })}
            className="flex items-center gap-1 text-[0.68rem] text-white/40 hover:text-white/70"
          >
            <X size={11} strokeWidth={2} aria-hidden />
            Clear
          </button>
        )}
      </div>

      {/* Material link */}
      <MaterialLinker task={task} onEdit={onEdit} />
    </div>
  );
}

/** A tiny FTS-backed picker to link a material to the task (reuses searchMaterials). */
function MaterialLinker({
  task,
  onEdit,
}: {
  task: Task;
  onEdit: (patch: Partial<Pick<Task, "material_id" | "material_name" | "material_type">>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const debounceRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    window.clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults([]);
      return;
    }
    debounceRef.current = window.setTimeout(() => {
      void ipc
        .searchMaterials(query, "all")
        .then((r) => setResults(r.slice(0, 6)))
        .catch(() => setResults([]));
    }, 300);
    return () => window.clearTimeout(debounceRef.current);
  }, [query, open]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Link2 size={13} strokeWidth={2} className="shrink-0 text-white/40" aria-hidden />
        {task.material_name ? (
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-xs text-cyan-400/90">{task.material_name}</span>
            <button
              type="button"
              onClick={() =>
                onEdit({ material_id: null, material_name: null, material_type: null })
              }
              className="flex items-center gap-1 text-[0.68rem] text-white/40 hover:text-white/70"
            >
              <X size={11} strokeWidth={2} aria-hidden />
              Unlink
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="text-xs text-white/50 hover:text-content-primary"
          >
            {open ? "Cancel" : "Link a lesson…"}
          </button>
        )}
      </div>

      {open && !task.material_name && (
        <div className="rounded-[10px] border border-white/[0.06] bg-black/40 p-2">
          <div className="flex items-center gap-2 rounded-btn bg-white/[0.04] px-2 py-1.5">
            <Search size={13} strokeWidth={2} className="text-white/40" aria-hidden />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search materials…"
              aria-label="Search materials to link"
              className="min-w-0 flex-1 bg-transparent text-xs text-content-primary placeholder:text-white/30 focus:outline-none"
            />
          </div>
          {results.length > 0 && (
            <ul className="mt-2 flex flex-col">
              {results.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onEdit({
                        material_id: r.id,
                        material_name: r.file_name,
                        material_type: r.file_type,
                      });
                      setOpen(false);
                      setQuery("");
                      setResults([]);
                    }}
                    className="flex w-full items-center gap-2 rounded-btn px-2 py-1.5 text-left text-xs text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content-primary"
                  >
                    <span className="truncate">{r.file_name}</span>
                    <span className="ml-auto shrink-0 text-[0.62rem] uppercase text-white/30">
                      {r.file_type}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {query.trim() && results.length === 0 && (
            <p className="mt-2 px-2 text-[0.68rem] text-white/30">No matches.</p>
          )}
        </div>
      )}
    </div>
  );
}

export default memo(TasksWidgetView);
