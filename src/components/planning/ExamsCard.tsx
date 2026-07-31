/**
 * ExamsCard — dated exams with their backward plans, plus the editor.
 *
 * ## Why this card is allowed to deliver bad news
 *
 * Backward planning is only useful if it is honest early. A student who learns in week one that
 * the syllabus needs 2h/day can still choose: give it more time, or decide now what they're not
 * going to cover. A card that softens that until the week before is worse than no card, so when
 * `required > target` this says so directly and names both numbers.
 *
 * The verdict copy comes from the BACKEND (`plan.message`) so the phrasing can't drift from the
 * maths behind it. This component decides tone and layout, not conclusions.
 *
 * The revision tail is a first-class input, not a detail: a plan that has you learning new
 * material the night before an exam is a plan that has already failed.
 */

import { useEffect, useState } from "react";
import { CalendarClock, GraduationCap, Plus, Trash2, X } from "lucide-react";
import { ipc, isTauri } from "../../lib/ipc";
import { fmtMins } from "./planningUtils";
import { localDay } from "../../lib/scheduleClock";
import { cn } from "../../lib/utils";
import type { ExamPlan, NodeCard } from "../../lib/types";
import type { ExamsState } from "./useExams";

export default function ExamsCard({ exams }: { exams: ExamsState }) {
  const [editing, setEditing] = useState<ExamPlan | null>(null);
  const [creating, setCreating] = useState(false);

  // Nothing to show and nothing being added: stay out of the way rather than occupying the rail
  // with an empty state. The Add affordance still needs to exist, so it lives in the header.
  const empty = exams.loaded && exams.plans.length === 0;

  return (
    <section className="plan-panel rounded-[24px] border border-white/[0.06] bg-white/[0.02] p-6 shadow-2xl backdrop-blur-xl">
      <header className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <GraduationCap size={16} strokeWidth={2} className="text-orange" aria-hidden />
          <h3 className="text-sm font-semibold text-content-primary">Exams ahead</h3>
        </div>
        <button
          type="button"
          onClick={() => {
            setEditing(null);
            setCreating(true);
          }}
          aria-label="Add an exam"
          className="grid h-7 w-7 place-items-center rounded-full border border-white/[0.08] text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content-primary"
        >
          <Plus size={13} strokeWidth={2.5} aria-hidden />
        </button>
      </header>

      {empty ? (
        <p className="py-2 text-[0.72rem] leading-relaxed text-white/40">
          Add an exam and this works backwards from the date: what's left of the course, how long
          you have, and what that actually costs per day.
        </p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {exams.plans.map((p) => (
            <ExamRow key={p.exam.id} plan={p} onEdit={() => setEditing(p)} />
          ))}
        </div>
      )}

      {(creating || editing) && (
        <ExamEditor
          plan={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSave={async (input) => {
            if (await exams.save(input)) {
              setCreating(false);
              setEditing(null);
            }
          }}
          onDelete={
            editing
              ? async () => {
                  await exams.remove(editing.exam.id);
                  setEditing(null);
                }
              : undefined
          }
        />
      )}
    </section>
  );
}

function ExamRow({ plan, onEdit }: { plan: ExamPlan; onEdit: () => void }) {
  const { exam, days_until, on_track, out_of_time, remaining_items } = plan;
  const past = days_until < 0;
  const done = remaining_items === 0 && !past;

  // Tone tracks reality, not proximity: an exam next week you're on top of is calmer than one
  // next month you aren't.
  const tone = past
    ? { ring: "border-white/[0.06]", text: "text-white/35", bar: "bg-white/20" }
    : done
      ? { ring: "border-lime/25", text: "text-lime", bar: "bg-lime" }
      : out_of_time
        ? { ring: "border-red-400/30", text: "text-red-300", bar: "bg-red-400" }
        : on_track
          ? { ring: "border-lime/25", text: "text-lime", bar: "bg-lime" }
          : { ring: "border-amber-400/30", text: "text-amber-300", bar: "bg-amber-400" };

  // How much of the intended daily budget the syllabus actually eats. Over 100% is the whole
  // point of the bar, so it's clamped for width but the number still speaks in the copy.
  const load =
    plan.target_daily_mins > 0
      ? Math.min(1, plan.required_daily_mins / plan.target_daily_mins)
      : 0;

  return (
    <button
      type="button"
      onClick={onEdit}
      className={cn(
        "rounded-[16px] border bg-white/[0.02] p-3 text-left transition-colors hover:bg-white/[0.05]",
        tone.ring,
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-content-primary">
          {exam.name}
        </span>
        <span className={cn("shrink-0 text-[0.68rem] font-semibold", tone.text)}>
          {past
            ? "passed"
            : days_until === 0
              ? "today"
              : days_until === 1
                ? "tomorrow"
                : `${days_until} days`}
        </span>
      </div>

      {exam.node_name && (
        <p className="mt-0.5 truncate text-[0.66rem] text-white/35">{exam.node_name}</p>
      )}

      {/* The verdict, phrased by the backend so copy and maths can't diverge. */}
      <p className="mt-1.5 text-[0.7rem] leading-snug text-content-secondary">{plan.message}</p>

      {!past && remaining_items > 0 && (
        <>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.08]">
            <div
              className={cn("h-full rounded-full", tone.bar)}
              style={{ width: `${Math.max(3, Math.round(load * 100))}%` }}
            />
          </div>
          <p className="mt-1 text-[0.62rem] text-white/35">
            {fmtMins(plan.remaining_mins)} left over {plan.study_days}{" "}
            {plan.study_days === 1 ? "study day" : "study days"}
            {exam.revision_days > 0 && ` · ${exam.revision_days}d revision reserved`}
          </p>
        </>
      )}
    </button>
  );
}

/** Create/edit form. Inline in the card, matching the planner's no-modal-for-small-things rule. */
function ExamEditor({
  plan,
  onClose,
  onSave,
  onDelete,
}: {
  plan: ExamPlan | null;
  onClose: () => void;
  onSave: (input: {
    id?: number | null;
    name: string;
    node_id: number | null;
    exam_date: string;
    daily_target_mins: number;
    revision_days: number;
  }) => void;
  onDelete?: () => void;
}) {
  const [name, setName] = useState(plan?.exam.name ?? "");
  const [date, setDate] = useState(plan?.exam.exam_date ?? localDay());
  const [nodeId, setNodeId] = useState<number | null>(plan?.exam.node_id ?? null);
  const [target, setTarget] = useState(plan?.exam.daily_target_mins ?? 60);
  const [revision, setRevision] = useState(plan?.exam.revision_days ?? 3);
  const [courses, setCourses] = useState<NodeCard[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Root nodes only: an exam is set on a course, and offering the whole tree would turn a
  // two-field form into a file browser.
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    void ipc
      .nodeChildren(null)
      .then((c) => {
        if (alive) setCourses(c);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !date) return;
    onSave({
      id: plan?.exam.id ?? null,
      name: name.trim(),
      node_id: nodeId,
      exam_date: date,
      daily_target_mins: target,
      revision_days: revision,
    });
  };

  return (
    <form
      onSubmit={submit}
      className="mt-3 rounded-[16px] border border-white/[0.08] bg-black/20 p-3.5"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[0.66rem] uppercase tracking-wide text-white/40">
          {plan ? "Edit exam" : "New exam"}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cancel"
          className="grid h-6 w-6 place-items-center rounded-full text-white/35 hover:bg-white/[0.06] hover:text-content-primary"
        >
          <X size={12} strokeWidth={2} aria-hidden />
        </button>
      </div>

      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Physics final"
        aria-label="Exam name"
        className="w-full rounded-[10px] border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-sm text-content-primary outline-none transition-colors placeholder:text-white/25 focus:border-lime/40"
      />

      <div className="mt-2 flex gap-2">
        <label className="flex-1 text-[0.62rem] uppercase tracking-wide text-white/40">
          Date
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="mt-1 w-full rounded-[10px] border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-xs text-content-primary outline-none focus:border-lime/40"
          />
        </label>
        <label className="flex-1 text-[0.62rem] uppercase tracking-wide text-white/40">
          Course
          {/* The dropdown LIST is drawn by the OS, not by us: it ignores the trigger's
              translucent `bg-white/[0.03]` and falls back to the platform default (white on
              Windows), so white option text rendered invisible until hovered. Each option needs an
              opaque colour of its own, and `[color-scheme:dark]` tells the platform widget which
              palette to use for the parts CSS can't reach (scrollbar, focus ring). */}
          <select
            value={nodeId ?? ""}
            onChange={(e) => setNodeId(e.target.value === "" ? null : Number(e.target.value))}
            aria-label="Course this exam covers"
            className="mt-1 w-full rounded-[10px] border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-xs text-content-primary outline-none [color-scheme:dark] focus:border-lime/40"
          >
            <option value="" className="bg-ink-850 text-content-primary">
              Not linked
            </option>
            {courses.map((c) => (
              <option key={c.id} value={c.id} className="bg-ink-850 text-content-primary">
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-2 flex gap-2">
        <label className="flex-1 text-[0.62rem] uppercase tracking-wide text-white/40">
          Minutes/day
          <input
            type="number"
            min={5}
            max={960}
            value={target}
            onChange={(e) => setTarget(Math.max(5, Number(e.target.value) || 5))}
            className="mt-1 w-full rounded-[10px] border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-xs text-content-primary outline-none focus:border-lime/40"
          />
        </label>
        <label className="flex-1 text-[0.62rem] uppercase tracking-wide text-white/40">
          Revision days
          <input
            type="number"
            min={0}
            max={60}
            value={revision}
            onChange={(e) => setRevision(Math.max(0, Number(e.target.value) || 0))}
            className="mt-1 w-full rounded-[10px] border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-xs text-content-primary outline-none focus:border-lime/40"
          />
        </label>
      </div>

      <p className="mt-2 flex items-start gap-1.5 text-[0.62rem] leading-snug text-white/35">
        <CalendarClock size={11} strokeWidth={2} className="mt-0.5 shrink-0" aria-hidden />
        New material stops that many days before the exam, leaving the tail for revision. Linking
        a course is what lets this measure what's actually left.
      </p>

      <div className="mt-3 flex items-center justify-between gap-2">
        {onDelete ? (
          confirmDelete ? (
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
                onClick={onDelete}
                className="rounded-full bg-red-500/15 px-2.5 py-1 text-[0.66rem] font-semibold text-red-300 hover:bg-red-500/25"
              >
                Delete
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
          )
        ) : (
          <span />
        )}

        <button
          type="submit"
          disabled={!name.trim() || !date}
          className="rounded-full bg-lime px-4 py-1.5 text-xs font-semibold text-ink-900 shadow-glow-lime transition-transform hover:scale-[1.02] disabled:opacity-40 disabled:hover:scale-100"
        >
          Save
        </button>
      </div>
    </form>
  );
}
