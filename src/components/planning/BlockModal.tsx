/**
 * BlockModal — create / edit one time block.
 *
 * Deliberately NOT the TaskModal with extra fields. A block answers "when will I sit down and
 * for how long", a task answers "what must be finished" — the shapes only look similar. Reusing
 * one modal would mean a form where half the controls are irrelevant whichever mode you're in.
 *
 * The fields that exist here and nowhere else all feed the solver, and each is the input for a
 * specific behaviour:
 *   * `weight`          — value density for triage (what gets protected when the day overflows).
 *   * `is_anchored`     — "this cannot move" (a class, a call). Carved out of capacity entirely.
 *   * `min_viable_mins` — the floor below which compressing is pointless, so the solver DROPS
 *                         the block rather than shrinking it into a token 5 minutes.
 *
 * Built on the shared `Modal` (focus trap, Esc, backdrop close, GSAP entrance).
 */

import { useEffect, useMemo, useState } from "react";
import { Anchor, Clock, Flag, Link2, Search, Timer, X } from "lucide-react";
import Modal from "../ui/Modal";
import { PRIORITY_META } from "./planningUtils";
import { hhmmToMins, minsToHhmm } from "../../lib/scheduleClock";
import { ipc, isTauri } from "../../lib/ipc";
import { cn } from "../../lib/utils";
import type { BlockInput, BlockTargetKind, NodeCard, PlanBlock, SearchResult } from "../../lib/types";

interface Props {
  open: boolean;
  onClose: () => void;
  /** The day being planned (used for a new block). */
  day: string;
  /** The block being edited, or null to create. */
  block: PlanBlock | null;
  /**
   * Persist the block. Resolves `null` on success, or the reason it was refused (e.g. an
   * overlap with an existing block) — in which case the modal STAYS OPEN holding the student's
   * input, so they can fix the time instead of retyping everything.
   */
  onSave: (input: BlockInput) => Promise<string | null>;
  onDelete?: (block: PlanBlock) => void;
}

const DURATION_PRESETS = [25, 45, 60, 90, 120];
/** Common start times, so the usual case is one tap rather than typing. */
const START_PRESETS = ["06:00", "08:00", "10:00", "14:00", "16:00", "19:00"];

export default function BlockModal({ open, onClose, day, block, onSave, onDelete }: Props) {
  const editing = block != null;
  const [title, setTitle] = useState("");
  const [start, setStart] = useState("06:00");
  const [mins, setMins] = useState(60);
  const [weight, setWeight] = useState(2);
  const [anchored, setAnchored] = useState(false);
  const [minViable, setMinViable] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const [kind, setKind] = useState<BlockTargetKind>("freeform");
  const [materialId, setMaterialId] = useState<number | null>(null);
  const [nodeId, setNodeId] = useState<number | null>(null);
  const [targetName, setTargetName] = useState<string | null>(null);
  const [count, setCount] = useState<number | null>(null);
  // A refused save (an overlap) is a normal outcome, so it needs somewhere to be shown.
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSaving(false);
    setTitle(block?.title ?? "");
    // Edit the PLANNED position, not the effective one: editing a block that a recovery shifted
    // should change the intention, not silently bake the adjustment in as the new plan.
    setStart(block?.planned_start?.slice(0, 5) ?? "06:00");
    setMins(block?.planned_mins ?? 60);
    setWeight(block?.weight ?? 2);
    setAnchored(block?.is_anchored ?? false);
    setMinViable(block?.min_viable_mins ?? null);
    setNotes(block?.notes ?? "");
    setKind(block?.target_kind ?? "freeform");
    setMaterialId(block?.target_material_id ?? null);
    setNodeId(block?.target_node_id ?? null);
    setTargetName(block?.target_name ?? null);
    setCount(block?.target_count ?? null);
  }, [open, block]);

  const startMins = hhmmToMins(start);
  const endLabel = useMemo(
    () => (startMins == null ? "—" : minsToHhmm(Math.min(startMins + mins, 1439))),
    [startMins, mins],
  );
  const canSave =
    title.trim().length > 0 && startMins != null && mins >= 1 && mins <= 1440 && !saving;

  /**
   * Offer the free time the backend named, as a one-tap fix.
   *
   * The message is authored server-side (it knows the whole day), so the time is parsed back out
   * of it rather than duplicating the conflict search here — two implementations of "where does
   * this fit" would drift, and the one in the modal would be the wrong one.
   */
  const suggested = useMemo(() => {
    const m = /that fits is (\d{2}:\d{2})/.exec(error ?? "");
    return m ? m[1] : null;
  }, [error]);

  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    const reason = await onSave({
      id: block?.id ?? null,
      day: block?.day ?? day,
      planned_start: start,
      planned_mins: mins,
      title: title.trim(),
      target_kind: kind,
      target_material_id: kind === "material" ? materialId : null,
      target_node_id: kind === "node_count" || kind === "node_minutes" ? nodeId : null,
      target_task_id: null,
      target_count: kind === "node_count" ? count : null,
      weight,
      is_anchored: anchored,
      // A floor longer than the block itself would make it un-compressible and instantly
      // droppable, which is never what the student means.
      min_viable_mins: minViable != null ? Math.min(minViable, mins) : null,
      notes: notes.trim() || null,
    });
    setSaving(false);
    if (reason) {
      // Keep the form exactly as they left it. Closing here is what made the earlier behaviour
      // look like the block silently disappearing.
      setError(reason);
      return;
    }
    onClose();
  };

  /** Clear a stale conflict message as soon as they change the thing it was about. */
  const editTime = (next: string) => {
    setStart(next);
    setError(null);
  };
  const editMins = (next: number) => {
    setMins(next);
    setError(null);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? "Edit block" : "New time block"}
      subtitle={
        editing
          ? "Change when this work happens and how protected it is."
          : "Block out when you'll actually sit down, and how long for."
      }
      widthClass="max-w-lg"
      footer={
        <>
          {editing && onDelete && (
            <button
              type="button"
              onClick={() => {
                onDelete(block);
                onClose();
              }}
              className="mr-auto rounded-btn border border-red-400/20 px-4 py-2 text-sm text-red-300/90 transition-colors hover:bg-red-400/10"
            >
              Delete
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-btn border border-white/10 px-4 py-2 text-sm text-content-secondary transition-colors hover:bg-white/[0.05]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSave}
            className="rounded-btn bg-lime px-4 py-2 text-sm font-semibold text-ink-900 shadow-glow-lime transition-transform hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? "Saving…" : editing ? "Save changes" : "Add block"}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {/* The refusal, with the fix attached. `alert` because the student pressed Save and is
            waiting on the outcome — this is the answer to their action, not ambient news. */}
        {error && (
          <div
            role="alert"
            className="flex flex-col gap-2 rounded-btn border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2.5"
          >
            <p className="text-xs leading-snug text-amber-200">{error}</p>
            {suggested && (
              <button
                type="button"
                onClick={() => editTime(suggested)}
                className="w-fit rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1 text-[0.7rem] font-semibold text-amber-200 transition-colors hover:bg-amber-400/20"
              >
                Move it to {suggested}
              </button>
            )}
          </div>
        )}

        <label className="flex flex-col gap-2">
          <span className="text-xs font-medium text-content-secondary">Block</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
            }}
            placeholder="Physics — rotational motion"
            aria-label="Block title"
            className="rounded-btn border border-white/[0.08] bg-black/30 px-3 py-2.5 text-sm text-content-primary placeholder:text-white/30 focus:border-lime/30 focus:outline-none"
          />
        </label>

        {/* When */}
        <div className="flex flex-col gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium text-content-secondary">
            <Clock size={12} strokeWidth={2} aria-hidden /> Starts
            <span className="ml-auto font-normal text-white/40">
              {start} – {endLabel}
            </span>
          </span>
          <div className="flex items-center gap-2">
            <input
              type="time"
              value={start}
              onChange={(e) => editTime(e.target.value)}
              aria-label="Start time"
              className="rounded-btn border border-white/[0.08] bg-black/30 px-3 py-2 text-sm text-content-primary focus:border-lime/30 focus:outline-none [color-scheme:dark]"
            />
            <div className="flex flex-wrap gap-1.5">
              {START_PRESETS.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => editTime(t)}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-[0.7rem] transition-colors",
                    start === t
                      ? "border-lime/30 bg-lime/10 text-lime"
                      : "border-white/[0.06] text-white/50 hover:bg-white/[0.04]",
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Duration */}
        <div className="flex flex-col gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium text-content-secondary">
            <Timer size={12} strokeWidth={2} aria-hidden /> Length
          </span>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={5}
              max={1440}
              step={5}
              value={mins}
              onChange={(e) => editMins(Math.max(1, Math.min(1440, Number(e.target.value) || 0)))}
              aria-label="Length in minutes"
              className="w-20 rounded-btn border border-white/[0.08] bg-black/30 px-3 py-2 text-sm text-content-primary focus:border-lime/30 focus:outline-none"
            />
            <span className="text-xs text-white/40">min</span>
            <div className="flex flex-wrap gap-1.5">
              {DURATION_PRESETS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => editMins(d)}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-[0.7rem] transition-colors",
                    mins === d
                      ? "border-cyan-400/30 bg-cyan-400/10 text-cyan-300"
                      : "border-white/[0.06] text-white/50 hover:bg-white/[0.04]",
                  )}
                >
                  {d < 60 ? `${d}m` : `${d / 60}h`}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Priority — the solver's value density, so it is worth naming honestly. */}
        <div className="flex flex-col gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium text-content-secondary">
            <Flag size={12} strokeWidth={2} aria-hidden /> Priority
            <span className="ml-auto font-normal text-white/35">Protected first when the day overflows</span>
          </span>
          <div className="grid grid-cols-4 gap-1.5">
            {PRIORITY_META.map((p, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setWeight(i)}
                aria-pressed={weight === i}
                className={cn(
                  "flex items-center justify-center gap-1.5 rounded-btn border px-2 py-2 text-xs font-medium transition-colors",
                  weight === i
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

        {/* Anchor + floor */}
        <div className="grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => setAnchored((v) => !v)}
            aria-pressed={anchored}
            className={cn(
              "flex items-start gap-2.5 rounded-btn border p-3 text-left transition-colors",
              anchored
                ? "border-orange/30 bg-orange/[0.08]"
                : "border-white/[0.06] hover:bg-white/[0.04]",
            )}
          >
            <Anchor size={14} strokeWidth={2} className={cn("mt-0.5 shrink-0", anchored ? "text-orange" : "text-white/40")} aria-hidden />
            <span className="min-w-0">
              <span className="block text-xs font-semibold text-content-primary">Fixed time</span>
              <span className="block text-[0.68rem] leading-snug text-white/40">
                A class or call — never moved by an adjustment.
              </span>
            </span>
          </button>

          <label className="flex flex-col gap-1.5 rounded-btn border border-white/[0.06] p-3">
            <span className="text-xs font-semibold text-content-primary">Minimum useful time</span>
            <span className="text-[0.68rem] leading-snug text-white/40">
              Below this, shortening is pointless — drop it instead.
            </span>
            <div className="mt-1 flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={mins}
                step={5}
                value={minViable ?? ""}
                placeholder="—"
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setMinViable(e.target.value === "" || v <= 0 ? null : Math.min(v, mins));
                }}
                aria-label="Minimum useful minutes"
                className="w-20 rounded-btn border border-white/[0.08] bg-black/30 px-2.5 py-1.5 text-xs text-content-primary focus:border-lime/30 focus:outline-none"
              />
              <span className="text-[0.68rem] text-white/40">min</span>
            </div>
          </label>
        </div>

        {/* What it's for */}
        <TargetPicker
          kind={kind}
          setKind={setKind}
          targetName={targetName}
          count={count}
          setCount={setCount}
          nodeId={nodeId}
          onPickMaterial={(m) => {
            setMaterialId(m.id);
            setTargetName(m.file_name);
            if (!title.trim()) setTitle(m.file_name);
          }}
          onPickNode={(n) => {
            setNodeId(n?.id ?? null);
            setTargetName(n?.name ?? null);
            if (n && !title.trim()) setTitle(n.name);
          }}
          onClearTarget={() => {
            setMaterialId(null);
            setNodeId(null);
            setTargetName(null);
          }}
          hasTarget={materialId != null || nodeId != null}
        />

        <label className="flex flex-col gap-2">
          <span className="text-xs font-medium text-content-secondary">Notes</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="Optional — what exactly to cover."
            className="scroll-thin resize-none rounded-btn border border-white/[0.08] bg-black/30 px-3 py-2 text-sm text-content-primary placeholder:text-white/30 focus:border-lime/30 focus:outline-none"
          />
        </label>
      </div>
    </Modal>
  );
}

/**
 * Target picker. `freeform` is the honest default: it is the only kind the app cannot verify
 * automatically, so choosing it is choosing to confirm the block by hand later. Linking a
 * lesson instead means playback closes the block on its own.
 */
function TargetPicker({
  kind,
  setKind,
  targetName,
  count,
  setCount,
  nodeId,
  onPickMaterial,
  onPickNode,
  onClearTarget,
  hasTarget,
}: {
  kind: BlockTargetKind;
  setKind: (k: BlockTargetKind) => void;
  targetName: string | null;
  count: number | null;
  setCount: (n: number | null) => void;
  nodeId: number | null;
  onPickMaterial: (m: SearchResult) => void;
  onPickNode: (n: NodeCard | null) => void;
  onClearTarget: () => void;
  hasTarget: boolean;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);

  // Debounced FTS search, same shape as TaskModal's lesson linker.
  useEffect(() => {
    if (kind !== "material" || query.trim().length < 2 || !isTauri()) {
      setResults([]);
      return;
    }
    let alive = true;
    const id = window.setTimeout(() => {
      void ipc
        .searchMaterials(query.trim())
        .then((r) => {
          if (alive) setResults(r.slice(0, 6));
        })
        .catch(() => {});
    }, 220);
    return () => {
      alive = false;
      window.clearTimeout(id);
    };
  }, [kind, query]);

  return (
    <div className="flex flex-col gap-2">
      <span className="flex items-center gap-1.5 text-xs font-medium text-content-secondary">
        <Link2 size={12} strokeWidth={2} aria-hidden /> What it's for
      </span>

      <div className="flex flex-wrap gap-1.5">
        {(
          [
            { k: "freeform", label: "Anything" },
            { k: "material", label: "A lesson" },
            { k: "node_count", label: "N lessons of a course" },
            { k: "node_minutes", label: "Time on a course" },
          ] as const
        ).map((o) => (
          <button
            key={o.k}
            type="button"
            onClick={() => {
              setKind(o.k);
              onClearTarget();
            }}
            aria-pressed={kind === o.k}
            className={cn(
              "rounded-full border px-3 py-1.5 text-[0.7rem] transition-colors",
              kind === o.k
                ? "border-white/20 bg-white/[0.08] text-content-primary"
                : "border-white/[0.06] text-white/50 hover:bg-white/[0.04]",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>

      {kind === "freeform" && (
        <p className="text-[0.68rem] leading-snug text-white/35">
          This one can't be tracked automatically — you'll confirm it yourself when it's done.
        </p>
      )}

      {kind === "material" &&
        (hasTarget && targetName ? (
          <div className="flex items-center gap-2 rounded-btn border border-cyan-400/20 bg-cyan-400/[0.06] px-3 py-2">
            <Link2 size={12} className="shrink-0 text-cyan-400" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-xs text-content-primary">{targetName}</span>
            <button
              type="button"
              onClick={onClearTarget}
              aria-label="Remove lesson link"
              className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-white/40 hover:bg-white/[0.08] hover:text-content-primary"
            >
              <X size={11} strokeWidth={2.5} aria-hidden />
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 rounded-btn border border-white/[0.08] bg-black/30 px-3 py-2">
              <Search size={12} className="shrink-0 text-white/30" aria-hidden />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search your lessons…"
                aria-label="Search lessons to link"
                className="min-w-0 flex-1 bg-transparent text-xs text-content-primary placeholder:text-white/30 focus:outline-none"
              />
            </div>
            {results.length > 0 && (
              <div className="scroll-thin max-h-40 overflow-y-auto rounded-btn border border-white/[0.06]">
                {results.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => {
                      onPickMaterial(m);
                      setQuery("");
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-white/[0.05]"
                  >
                    <span className="min-w-0 flex-1 truncate text-xs text-content-primary">{m.file_name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}

      {kind === "node_count" && (
        <label className="flex items-center gap-2 text-xs text-content-secondary">
          How many lessons
          <input
            type="number"
            min={1}
            max={99}
            value={count ?? ""}
            onChange={(e) => setCount(e.target.value === "" ? null : Math.max(1, Number(e.target.value)))}
            aria-label="Number of lessons"
            className="w-16 rounded-btn border border-white/[0.08] bg-black/30 px-2.5 py-1.5 text-xs text-content-primary focus:border-lime/30 focus:outline-none"
          />
        </label>
      )}

      {(kind === "node_count" || kind === "node_minutes") && (
        <CoursePicker nodeId={nodeId} onPick={onPickNode} />
      )}
    </div>
  );
}

/**
 * Course picker for the `node_*` kinds — the fix for "it is impossible to link a block to a
 * course".
 *
 * The modal used to say "pick the course from the Today list after saving", and no such control
 * existed anywhere: the block saved with `target_node_id = null`, so the automatic progress
 * tracking those two kinds exist for could never fire. Linking has to happen HERE, while the
 * student is already deciding what the block is for.
 *
 * Roots only, matching `ExamsCard`: a course is a root node, and offering the whole tree would
 * turn one field into a file browser. A native `<select>` is deliberate — the list is short, and
 * keyboard/screen-reader behaviour comes free. Options are explicitly dark-styled (see the
 * white-on-white bug the exam picker had).
 */
function CoursePicker({
  nodeId,
  onPick,
}: {
  nodeId: number | null;
  onPick: (n: NodeCard | null) => void;
}) {
  const [courses, setCourses] = useState<NodeCard[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!isTauri()) {
      setLoaded(true);
      return;
    }
    let alive = true;
    void ipc
      .nodeChildren(null)
      .then((c) => {
        if (alive) setCourses(c);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[0.68rem] font-medium text-content-secondary">Which course</span>
      <select
        value={nodeId ?? ""}
        onChange={(e) =>
          onPick(e.target.value === "" ? null : courses.find((c) => c.id === Number(e.target.value)) ?? null)
        }
        aria-label="Course for this block"
        className="rounded-btn border border-white/[0.08] bg-black/30 px-3 py-2 text-xs text-content-primary [color-scheme:dark] focus:border-lime/30 focus:outline-none"
      >
        <option value="" className="bg-ink-850 text-content-primary">
          {loaded && courses.length === 0 ? "No courses imported yet" : "Choose a course…"}
        </option>
        {courses.map((c) => (
          <option key={c.id} value={c.id} className="bg-ink-850 text-content-primary">
            {c.name}
          </option>
        ))}
      </select>
      <span className="text-[0.68rem] leading-snug text-white/35">
        {nodeId == null
          ? "Without a course this block can't track itself — you'll have to confirm it by hand."
          : "Progress tracks itself as you watch lessons in this course."}
      </span>
    </label>
  );
}
