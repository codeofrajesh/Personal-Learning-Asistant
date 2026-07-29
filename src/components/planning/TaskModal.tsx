/**
 * TaskModal — a gorgeous glass create/edit surface for a task, replacing the cramped
 * inline pill row. One clean modal: title, priority (segmented), deadline (glass
 * DateTimePicker), estimated minutes, and a material link (FTS search). Keeps the main
 * list pristine — configuring details never clutters a row.
 *
 * Works for both new tasks (`task` null → returns a NewTaskInput to `onCreate`) and
 * editing (returns a patch to `onSave`). Built on the shared `Modal` (focus trap, Esc,
 * backdrop close, GSAP entrance).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Flag, Link2, Search, X, Clock } from "lucide-react";
import Modal from "../ui/Modal";
import DateTimePicker from "./DateTimePicker";
import { PRIORITY_META } from "./planningUtils";
import { ipc } from "../../lib/ipc";
import { cn } from "../../lib/utils";
import type { SearchResult, Task } from "../../lib/types";
import type { NewTaskInput } from "./usePlanningTasks";

interface Props {
  open: boolean;
  onClose: () => void;
  /** The task being edited, or null to create a new one. */
  task: Task | null;
  onCreate: (input: NewTaskInput) => void;
  onSave: (task: Task, patch: Partial<Task>) => void;
}

const EST_PRESETS = [15, 30, 45, 60, 90, 120];

export default function TaskModal({ open, onClose, task, onCreate, onSave }: Props) {
  const editing = task != null;
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState(0);
  const [dueAt, setDueAt] = useState<string | null>(null);
  const [estMins, setEstMins] = useState<number | null>(null);
  const [materialId, setMaterialId] = useState<number | null>(null);
  const [materialName, setMaterialName] = useState<string | null>(null);
  const [materialType, setMaterialType] = useState<string | null>(null);

  // Sync form state when opened / target changes.
  useEffect(() => {
    if (!open) return;
    setTitle(task?.title ?? "");
    setPriority(task?.priority ?? 0);
    setDueAt(task?.due_at ?? null);
    setEstMins(task?.estimated_mins ?? null);
    setMaterialId(task?.material_id ?? null);
    setMaterialName(task?.material_name ?? null);
    setMaterialType(task?.material_type ?? null);
  }, [open, task]);

  const canSave = title.trim().length > 0;

  const submit = () => {
    if (!canSave) return;
    if (editing && task) {
      onSave(task, {
        title: title.trim(),
        priority,
        due_at: dueAt,
        estimated_mins: estMins,
        material_id: materialId,
        material_name: materialName,
        material_type: materialType,
      });
    } else {
      onCreate({
        title: title.trim(),
        priority,
        due_at: dueAt,
        estimated_mins: estMins,
        material_id: materialId,
        material_name: materialName,
        material_type: materialType,
      });
    }
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? "Edit task" : "New task"}
      subtitle={editing ? "Update the details of this task." : "Add a task with a deadline, priority, and an optional lesson link."}
      widthClass="max-w-lg"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-btn border border-white/10 px-4 py-2 text-sm text-content-secondary transition-colors hover:bg-white/[0.05]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSave}
            className="rounded-btn bg-lime px-4 py-2 text-sm font-semibold text-ink-900 shadow-glow-lime transition-transform hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {editing ? "Save changes" : "Add task"}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {/* Title */}
        <label className="flex flex-col gap-2">
          <span className="text-xs font-medium text-content-secondary">Task</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
            }}
            placeholder="What needs to get done?"
            aria-label="Task title"
            className="rounded-btn border border-white/[0.08] bg-black/30 px-3 py-2.5 text-sm text-content-primary placeholder:text-white/30 focus:border-lime/30 focus:outline-none"
          />
        </label>

        {/* Priority */}
        <div className="flex flex-col gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium text-content-secondary">
            <Flag size={12} strokeWidth={2} aria-hidden /> Priority
          </span>
          <div className="grid grid-cols-4 gap-1.5">
            {PRIORITY_META.map((p, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setPriority(i)}
                className={cn(
                  "flex items-center justify-center gap-1.5 rounded-btn border px-2 py-2 text-xs font-medium transition-colors",
                  priority === i
                    ? "border-white/20 bg-white/[0.08] text-content-primary shadow-[inset_0_1px_1px_rgba(255,255,255,0.1)]"
                    : "border-white/[0.06] text-white/50 hover:bg-white/[0.04]",
                )}
              >
                {i > 0 && <span className={cn("h-1.5 w-1.5 rounded-full", p.dot)} aria-hidden />}
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* Deadline */}
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-content-secondary">Deadline</span>
          <DateTimePicker value={dueAt} onChange={setDueAt} />
        </div>

        {/* Estimate */}
        <div className="flex flex-col gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium text-content-secondary">
            <Clock size={12} strokeWidth={2} aria-hidden /> Time estimate
          </span>
          <div className="flex flex-wrap gap-1.5">
            {EST_PRESETS.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setEstMins(estMins === m ? null : m)}
                className={cn(
                  "rounded-full border px-3 py-1 text-[0.7rem] font-medium transition-colors",
                  estMins === m
                    ? "border-lime/40 bg-lime/10 text-lime"
                    : "border-white/[0.06] text-white/50 hover:bg-white/[0.04]",
                )}
              >
                {m < 60 ? `${m}m` : `${m / 60}h`}
              </button>
            ))}
          </div>
        </div>

        {/* Material link */}
        <div className="flex flex-col gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium text-content-secondary">
            <Link2 size={12} strokeWidth={2} aria-hidden /> Linked lesson
          </span>
          <MaterialPicker
            materialName={materialName}
            onPick={(r) => {
              setMaterialId(r.id);
              setMaterialName(r.file_name);
              setMaterialType(r.file_type);
            }}
            onClear={() => {
              setMaterialId(null);
              setMaterialName(null);
              setMaterialType(null);
            }}
          />
        </div>
      </div>
    </Modal>
  );
}

/** FTS-backed material picker (search → pick), matching the app's search palette. */
function MaterialPicker({
  materialName,
  onPick,
  onClear,
}: {
  materialName: string | null;
  onPick: (r: SearchResult) => void;
  onClear: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const debounceRef = useRef<number | undefined>(undefined);

  useEffect(() => {
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
  }, [query]);

  const linkedMaterial = useMemo(() => materialName, [materialName]);

  if (linkedMaterial) {
    return (
      <div className="flex items-center gap-2 rounded-btn border border-cyan-400/20 bg-cyan-400/[0.06] px-3 py-2">
        <Link2 size={14} strokeWidth={2} className="shrink-0 text-cyan-400" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm text-cyan-300">{linkedMaterial}</span>
        <button
          type="button"
          onClick={onClear}
          aria-label="Unlink lesson"
          className="flex items-center gap-1 text-xs text-white/40 hover:text-white/70"
        >
          <X size={12} strokeWidth={2} aria-hidden />
          Unlink
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-btn border border-white/[0.08] bg-black/30 p-2">
      <div className="flex items-center gap-2 rounded-btn bg-white/[0.04] px-2.5 py-2">
        <Search size={14} strokeWidth={2} className="text-white/40" aria-hidden />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search a lesson to link…"
          aria-label="Search materials to link"
          className="min-w-0 flex-1 bg-transparent text-sm text-content-primary placeholder:text-white/30 focus:outline-none"
        />
      </div>
      {results.length > 0 && (
        <ul className="mt-2 flex flex-col">
          {results.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => {
                  onPick(r);
                  setQuery("");
                  setResults([]);
                }}
                className="flex w-full items-center gap-2 rounded-btn px-2 py-2 text-left text-sm text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content-primary"
              >
                <span className="min-w-0 flex-1 truncate">{r.file_name}</span>
                <span className="shrink-0 text-[0.62rem] uppercase text-white/30">{r.file_type}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {query.trim() && results.length === 0 && (
        <p className="mt-2 px-2 text-xs text-white/30">No matches.</p>
      )}
    </div>
  );
}
