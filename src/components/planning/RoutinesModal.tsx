/**
 * RoutinesModal — manage routine days ("my normal weekday") and apply one to a date.
 *
 * ## Why routines are authored by CAPTURE, not by form
 *
 * Nobody builds a good routine in an empty form. They build a good *day*, realise they want it
 * back, and then want to save it. So the primary path here is "Save this day as a routine"
 * (`saveDay`), and per-block editing exists only for touching up what capture produced. That is
 * also why the backend captures `planned_*` rather than `effective_*`: the routine should be the
 * intention, not one morning's adjustments baked in permanently.
 *
 * ## Applying is additive and idempotent
 *
 * Applying a routine never clears the day — it inserts the blocks that aren't already there.
 * Wiping a day the student has been working in would be indistinguishable from data loss, and
 * the whole planner design rule is "propose, never silently rewrite".
 */

import { useEffect, useState } from "react";
import { CalendarPlus, ChevronDown, Layers, Plus, Trash2, X } from "lucide-react";
import { fmtHhmmLabel, fmtMins } from "./planningUtils";
import { DOW_LABELS, dowLabel, localWeekday, type TemplatesState } from "./useTemplates";
import { cn } from "../../lib/utils";
import type { PlanTemplate, PlanTemplateBlock } from "../../lib/types";

interface Props {
  open: boolean;
  onClose: () => void;
  /** The day the "apply" and "save this day" actions operate on. */
  day: string;
  templates: TemplatesState;
  /** Called after blocks land on the day, so the caller can refetch. */
  onApplied: () => void;
}

export default function RoutinesModal({ open, onClose, day, templates, onApplied }: Props) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [mask, setMask] = useState(0b0111110); // Mon–Fri: the common case
  const [expanded, setExpanded] = useState<number | null>(null);

  // Reset the capture form each time the modal opens — a stale half-typed name from last time
  // is confusing, and this form is short enough that nothing valuable is lost.
  useEffect(() => {
    if (!open) return;
    setCreating(false);
    setName("");
    setMask(1 << localWeekday(day));
    setExpanded(null);
  }, [open, day]);

  // Escape closes, matching the app's other overlays.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const submitCapture = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const ok = await templates.saveDay(day, name.trim(), mask);
    if (ok) {
      setCreating(false);
      setName("");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Routine days"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-[24px] border border-white/[0.08] bg-ink-900/95 p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-1 flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <Layers size={17} strokeWidth={2} className="text-cyan-400" aria-hidden />
            <h2 className="text-base font-semibold text-content-primary">Routine days</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 place-items-center rounded-full text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content-primary"
          >
            <X size={16} strokeWidth={2} aria-hidden />
          </button>
        </header>
        <p className="mb-5 text-xs leading-relaxed text-white/40">
          A routine is a day's shape you can drop onto any date. Applying one adds its blocks —
          it never clears what's already there.
        </p>

        {/* ── Capture: the primary authoring path ── */}
        {creating ? (
          <form
            onSubmit={submitCapture}
            className="mb-5 rounded-[16px] border border-lime/25 bg-lime/[0.04] p-4"
          >
            <label className="block text-[0.66rem] uppercase tracking-wide text-white/40">
              Routine name
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My weekday"
                className="mt-1 w-full rounded-[10px] border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-sm text-content-primary outline-none transition-colors placeholder:text-white/25 focus:border-lime/40"
              />
            </label>

            <fieldset className="mt-3">
              <legend className="text-[0.66rem] uppercase tracking-wide text-white/40">
                Suits which days
              </legend>
              <div className="mt-1.5 flex gap-1">
                {DOW_LABELS.map((label, i) => {
                  const on = (mask & (1 << i)) !== 0;
                  return (
                    <button
                      key={label}
                      type="button"
                      onClick={() => setMask((m) => m ^ (1 << i))}
                      aria-pressed={on}
                      className={cn(
                        "flex-1 rounded-[8px] border py-1.5 text-[0.62rem] font-medium transition-colors",
                        on
                          ? "border-lime/40 bg-lime/10 text-lime"
                          : "border-white/[0.06] text-white/40 hover:bg-white/[0.04]",
                      )}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1.5 text-[0.62rem] text-white/30">
                Used to offer this routine automatically on a matching empty day.
              </p>
            </fieldset>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCreating(false)}
                className="rounded-full px-3.5 py-1.5 text-xs font-medium text-content-secondary transition-colors hover:bg-white/[0.06]"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!name.trim()}
                className="rounded-full bg-lime px-4 py-1.5 text-xs font-semibold text-ink-900 shadow-glow-lime transition-transform hover:scale-[1.02] disabled:opacity-40 disabled:hover:scale-100"
              >
                Save this day
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="mb-5 flex w-full items-center justify-center gap-1.5 rounded-[14px] border border-dashed border-white/[0.12] py-2.5 text-xs font-semibold text-content-secondary transition-colors hover:border-lime/30 hover:bg-lime/[0.04] hover:text-content-primary"
          >
            <CalendarPlus size={13} strokeWidth={2.5} aria-hidden />
            Save this day as a routine
          </button>
        )}

        {/* ── The list ── */}
        {templates.templates.length === 0 ? (
          <p className="py-6 text-center text-xs text-white/35">
            No routines yet. Build a day you'd want again, then save it here.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {templates.templates.map((t) => (
              <RoutineRow
                key={t.id}
                template={t}
                expanded={expanded === t.id}
                onToggle={() => setExpanded((cur) => (cur === t.id ? null : t.id))}
                templates={templates}
                onApply={async () => {
                  const n = await templates.apply(t.id, day);
                  if (n > 0) {
                    onApplied();
                    onClose();
                  }
                }}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function RoutineRow({
  template,
  expanded,
  onToggle,
  templates,
  onApply,
}: {
  template: PlanTemplate;
  expanded: boolean;
  onToggle: () => void;
  templates: TemplatesState;
  onApply: () => void;
}) {
  const [blocks, setBlocks] = useState<PlanTemplateBlock[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Blocks load only when a row is opened — the list view needs counts, not contents, and
  // fetching every routine's blocks up front would be a query per row for nothing.
  useEffect(() => {
    if (!expanded || blocks) return;
    let alive = true;
    void templates.blocksFor(template.id).then((b) => {
      if (alive) setBlocks(b);
    });
    return () => {
      alive = false;
    };
  }, [expanded, blocks, templates, template.id]);

  return (
    <li className="rounded-[16px] border border-white/[0.06] bg-white/[0.02]">
      <div className="flex items-center gap-2 p-3">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronDown
            size={13}
            strokeWidth={2.5}
            className={cn("shrink-0 text-white/35 transition-transform", expanded && "rotate-180")}
            aria-hidden
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-content-primary">
                {template.name}
              </span>
              {!template.is_active && (
                <span className="shrink-0 rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[0.58rem] text-white/40">
                  Off
                </span>
              )}
            </span>
            <span className="mt-0.5 block truncate text-[0.66rem] text-white/40">
              {dowLabel(template.dow_mask)} · {template.block_count}{" "}
              {template.block_count === 1 ? "block" : "blocks"} · {fmtMins(template.planned_mins)}
            </span>
          </span>
        </button>

        <button
          type="button"
          onClick={onApply}
          className="shrink-0 rounded-full border border-lime/30 bg-lime/10 px-3 py-1.5 text-[0.68rem] font-semibold text-lime transition-colors hover:bg-lime/20"
        >
          Use
        </button>
      </div>

      {expanded && (
        <div className="border-t border-white/[0.06] px-3 pb-3 pt-2">
          {blocks == null ? (
            <p className="py-2 text-center text-[0.66rem] text-white/30">Loading…</p>
          ) : blocks.length === 0 ? (
            <p className="py-2 text-center text-[0.66rem] text-white/30">This routine is empty.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {blocks.map((b) => (
                <li key={b.id} className="flex items-center gap-2 text-[0.7rem]">
                  <span className="w-12 shrink-0 tabular-nums text-white/45">
                    {fmtHhmmLabel(b.planned_start)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-content-secondary">{b.title}</span>
                  <span className="shrink-0 text-white/35">{fmtMins(b.planned_mins)}</span>
                  <button
                    type="button"
                    onClick={async () => {
                      await templates.removeBlock(b.id);
                      setBlocks((cur) => cur?.filter((x) => x.id !== b.id) ?? null);
                    }}
                    aria-label={`Remove ${b.title} from this routine`}
                    className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-white/25 transition-colors hover:bg-white/[0.08] hover:text-red-300"
                  >
                    <Trash2 size={11} strokeWidth={2} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-3 flex items-center justify-between gap-2 border-t border-white/[0.06] pt-2.5">
            <button
              type="button"
              onClick={() =>
                void templates.saveTemplate({
                  id: template.id,
                  name: template.name,
                  dow_mask: template.dow_mask,
                  is_active: !template.is_active,
                })
              }
              className="rounded-full px-2.5 py-1 text-[0.66rem] font-medium text-content-secondary transition-colors hover:bg-white/[0.06]"
            >
              {template.is_active ? "Stop suggesting" : "Suggest again"}
            </button>

            {/* Two-step delete: routines take real effort to build, so one stray click must
                not destroy one. */}
            {confirmDelete ? (
              <span className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="rounded-full px-2.5 py-1 text-[0.66rem] text-content-secondary hover:bg-white/[0.06]"
                >
                  Keep
                </button>
                <button
                  type="button"
                  onClick={() => void templates.removeTemplate(template.id)}
                  className="rounded-full bg-red-500/15 px-2.5 py-1 text-[0.66rem] font-semibold text-red-300 transition-colors hover:bg-red-500/25"
                >
                  Delete routine
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="flex items-center gap-1 rounded-full px-2.5 py-1 text-[0.66rem] text-white/35 transition-colors hover:bg-white/[0.06] hover:text-red-300"
              >
                <Trash2 size={11} strokeWidth={2} aria-hidden />
                Delete
              </button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

/** The inline offer on an empty day. One tap to a full day, or dismissed by simply ignoring it. */
export function RoutineSuggestion({
  template,
  onApply,
  onManage,
}: {
  template: PlanTemplate | null;
  onApply: () => void;
  onManage: () => void;
}) {
  if (!template) {
    return (
      <button
        type="button"
        onClick={onManage}
        className="flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.03] px-3.5 py-2 text-xs font-medium text-content-secondary transition-colors hover:bg-white/[0.07] hover:text-content-primary"
      >
        <Layers size={12} strokeWidth={2} aria-hidden />
        Routines
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      <button
        type="button"
        onClick={onApply}
        className="flex items-center gap-1.5 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-3.5 py-2 text-xs font-semibold text-cyan-300 transition-colors hover:bg-cyan-400/20"
      >
        <Plus size={12} strokeWidth={2.5} aria-hidden />
        Use "{template.name}" ({template.block_count}{" "}
        {template.block_count === 1 ? "block" : "blocks"})
      </button>
      <button
        type="button"
        onClick={onManage}
        className="rounded-full px-3 py-2 text-xs font-medium text-white/40 transition-colors hover:bg-white/[0.06] hover:text-content-secondary"
      >
        All routines
      </button>
    </div>
  );
}
