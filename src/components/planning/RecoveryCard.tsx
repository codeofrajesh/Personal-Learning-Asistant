/**
 * RecoveryCard — the inline offer to adjust a day that has drifted.
 *
 * ## Why it reads the way it does
 *
 * This is the highest-stakes copy in the app. The student is already behind; the card either
 * helps them re-enter the day or confirms that the day is a write-off. So every choice here is
 * about keeping agency with the student:
 *
 *   * **Consequences in content terms, never counts.** "Chemistry won't fit" beats "3 changes".
 *     The backend already phrases `summary` this way; we lead with it and keep the numbers small
 *     and secondary.
 *   * **A recommendation, not a decision.** The recommended plan is pre-selected and visually
 *     ahead, but all options are equally reachable and nothing applies without a click.
 *   * **"Leave it alone" is a first-class option**, not an X in the corner. Sometimes the honest
 *     answer is that today is lost and tomorrow starts clean, and a card that only offers
 *     rescue teaches the student to lie to it.
 *   * **The diff is opt-in.** The summary is enough to decide; the per-block moves are there for
 *     when it isn't, behind a disclosure so the default state isn't a wall of times.
 *
 * Rendered inline in the Today rail — deliberately not a modal (see `useRecovery`).
 */

import { useMemo, useState } from "react";
import { ArrowRight, ChevronDown, LifeBuoy, RotateCcw } from "lucide-react";
import { fmtHhmmLabel, fmtMins } from "./planningUtils";
import { cn } from "../../lib/utils";
import type { BlockMove, RecoveryPlan } from "../../lib/types";
import type { RecoveryState } from "./useRecovery";

export default function RecoveryCard({ recovery }: { recovery: RecoveryState }) {
  const { report, visible, canOpen, busy, undoToken, open, apply, undo, dismiss } = recovery;

  // The undo affordance outlives the card: applying hides the offer, but the student still needs
  // those ten seconds to change their mind.
  if (undoToken) return <UndoBar busy={busy} onUndo={() => void undo()} />;
  // Answered already, but the day is still behind. One quiet line instead of a re-opened card:
  // the student stays in control of when they revisit the decision.
  if (canOpen && report) return <ReopenRow driftMins={report.drift_mins} onOpen={open} />;
  if (!visible || !report) return null;

  // Past the hard stop: work is still open but there is no schedulable time left, so the only
  // move is forward. The backend signals this as "doesn't fit AND nothing can be placed".
  const outOfTime = !report.fits && report.usable_mins <= 0;

  return (
    <section
      // `polite`, not `assertive`: this is an offer, and it must not interrupt a screen reader
      // mid-sentence to deliver bad news.
      aria-live="polite"
      className="plan-panel rounded-[24px] border border-amber-400/25 bg-amber-400/[0.04] p-6 shadow-2xl backdrop-blur-xl"
    >
      <header className="mb-1 flex items-center gap-2">
        <LifeBuoy size={16} strokeWidth={2} className="text-amber-300" aria-hidden />
        <h3 className="text-sm font-semibold text-content-primary">
          {report.fits
            ? "The day still fits — just later"
            : outOfTime
              ? "Today's over — move this to tomorrow"
              : "This day needs a rethink"}
        </h3>
      </header>

      {/* Three states, because they need three different sentences. Telling a student at 23:25
          that they have "0m left" to fit "1h" of work is arithmetic, not help — past the hard
          stop the only honest thing to say is that the work moves. */}
      <p className="text-sm leading-relaxed text-content-secondary">
        {report.fits
          ? `You're about ${fmtMins(report.drift_mins)} behind. Everything still fits if it shifts.`
          : outOfTime
            ? `There's no time left today, and ${fmtMins(
                report.required_mins,
              )} still unfinished. Carry it to tomorrow so it isn't lost.`
            : `You're about ${fmtMins(report.drift_mins)} behind, with ${fmtMins(
                report.usable_mins,
              )} left and ${fmtMins(report.required_mins)} still planned.`}
      </p>

      <div className="mt-4 flex flex-col gap-2">
        {report.plans.map((plan) => (
          <PlanOption key={plan.id} plan={plan} busy={busy} onApply={() => void apply(plan.id)} />
        ))}
      </div>

      <button
        type="button"
        onClick={() => void dismiss()}
        disabled={busy}
        className="mt-3 w-full rounded-full px-3 py-2 text-xs font-medium text-white/45 transition-colors hover:bg-white/[0.05] hover:text-content-secondary disabled:opacity-50"
      >
        Leave it as it is
      </button>

      <p className="mt-2 text-center text-[0.66rem] leading-snug text-white/35">
        Nothing is deleted. Anything that won't fit moves to tomorrow, and you get ten seconds to
        undo.
      </p>
    </section>
  );
}

/**
 * The quiet state: they've already answered for today, but the day is still behind. A single
 * understated line, not a card — re-asserting a dismissed prompt is how a helpful feature turns
 * into one the student learns to ignore.
 */
function ReopenRow({ driftMins, onOpen }: { driftMins: number; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2 rounded-[16px] border border-white/[0.06] bg-white/[0.02] px-4 py-2.5 text-left transition-colors hover:border-amber-400/25 hover:bg-amber-400/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime"
    >
      <LifeBuoy size={13} strokeWidth={2} className="shrink-0 text-white/40" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-[0.72rem] text-content-secondary">
        Still about {fmtMins(driftMins)} behind
      </span>
      <span className="shrink-0 text-[0.68rem] font-semibold text-amber-300/80">Adjust</span>
    </button>
  );
}

/** One strategy. The recommended one leads and is styled ahead, but all are one click away. */
function PlanOption({
  plan,
  busy,
  onApply,
}: {
  plan: RecoveryPlan;
  busy: boolean;
  onApply: () => void;
}) {
  const [showDiff, setShowDiff] = useState(false);
  const moved = useMemo(() => plan.moves.filter((m) => m.action !== "keep"), [plan.moves]);

  return (
    <div
      className={cn(
        "rounded-[16px] border p-3 transition-colors",
        plan.recommended
          ? "border-lime/30 bg-lime/[0.06]"
          : "border-white/[0.07] bg-white/[0.02] hover:border-white/[0.14]",
      )}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-semibold text-content-primary">{plan.label}</p>
            {plan.recommended && (
              <span className="shrink-0 rounded-full border border-lime/25 bg-lime/10 px-2 py-0.5 text-[0.6rem] font-semibold text-lime">
                Suggested
              </span>
            )}
          </div>
          {/* The consequence, in the backend's content-level phrasing. */}
          <p className="mt-0.5 text-[0.72rem] leading-snug text-content-secondary">{plan.summary}</p>
          <p className="mt-1 text-[0.66rem] text-white/40">
            Keeps {Math.round(plan.coverage * 100)}% of what today was worth · {fmtMins(plan.scheduled_mins)}
            {plan.dropped_count > 0 && ` · ${plan.dropped_count} to tomorrow`}
          </p>
        </div>

        <button
          type="button"
          onClick={onApply}
          disabled={busy}
          className={cn(
            "shrink-0 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-transform hover:scale-[1.02] disabled:opacity-50 disabled:hover:scale-100",
            plan.recommended
              ? "bg-lime text-ink-900 shadow-glow-lime"
              : "border border-white/[0.1] bg-white/[0.05] text-content-primary hover:bg-white/[0.1]",
          )}
        >
          Use this
        </button>
      </div>

      {moved.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowDiff((v) => !v)}
            aria-expanded={showDiff}
            className="mt-2 flex items-center gap-1 rounded text-[0.66rem] font-medium text-white/45 transition-colors hover:text-content-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime"
          >
            <ChevronDown
              size={11}
              strokeWidth={2.5}
              className={cn("transition-transform", showDiff && "rotate-180")}
              aria-hidden
            />
            {showDiff ? "Hide" : "Show"} what moves ({moved.length})
          </button>

          {showDiff && (
            <ul className="mt-1.5 flex flex-col gap-1 border-t border-white/[0.06] pt-1.5">
              {moved.map((m) => (
                <MoveRow key={m.block_id} move={m} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/** A literal before → after. Both sides come from the backend, so nothing is recomputed here. */
function MoveRow({ move }: { move: BlockMove }) {
  const tone =
    move.action === "drop"
      ? "text-amber-300"
      : move.action === "compress"
        ? "text-cyan-300"
        : "text-white/55";

  return (
    <li className="flex items-center gap-2 text-[0.68rem]">
      <span className="min-w-0 flex-1 truncate text-content-secondary">{move.title}</span>
      {move.action === "drop" ? (
        <span className={cn("shrink-0 font-medium", tone)}>→ tomorrow</span>
      ) : (
        <span className={cn("flex shrink-0 items-center gap-1 font-medium", tone)}>
          {fmtHhmmLabel(move.from_start)}
          <ArrowRight size={9} strokeWidth={2.5} aria-hidden />
          {fmtHhmmLabel(move.to_start)}
          {move.action === "compress" && ` · ${fmtMins(move.to_mins)}`}
        </span>
      )}
    </li>
  );
}

/**
 * The 10-second undo. This is what makes recommending a default defensible: the cost of the
 * app guessing wrong is one click, not a rebuilt afternoon.
 */
function UndoBar({ busy, onUndo }: { busy: boolean; onUndo: () => void }) {
  return (
    <section
      aria-live="polite"
      className="plan-panel flex items-center gap-3 rounded-[24px] border border-lime/25 bg-lime/[0.05] p-4 shadow-2xl backdrop-blur-xl"
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-content-primary">Day adjusted</p>
        <p className="text-[0.7rem] text-content-secondary">
          Nothing was deleted — anything that didn't fit is on tomorrow.
        </p>
      </div>
      <button
        type="button"
        onClick={onUndo}
        disabled={busy}
        className="flex shrink-0 items-center gap-1.5 rounded-full border border-white/[0.1] bg-white/[0.05] px-3.5 py-1.5 text-xs font-semibold text-content-primary transition-colors hover:bg-white/[0.1] disabled:opacity-50"
      >
        <RotateCcw size={12} strokeWidth={2.5} aria-hidden />
        Undo
      </button>
    </section>
  );
}
