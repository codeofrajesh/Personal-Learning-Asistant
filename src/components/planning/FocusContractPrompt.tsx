/**
 * FocusContractPrompt — the pre-commitment on a block, and the honest question afterwards.
 *
 * ## Why this is a prompt and not a gate
 *
 * The mechanism is: before you start, write in one line what "done" means; when you stop, say
 * whether you did it. That's all. Nothing is locked and nothing is punished, because a planner
 * that fights the student loses, and a commitment that was enforced teaches nothing about whether
 * they'd have kept it.
 *
 * ## Why the verdict is self-reported
 *
 * "Did I do what I said?" is not observable from playback. Inferring it from executed minutes
 * would score the wrong thing entirely — sitting in front of a lecture for 45 minutes is not the
 * same as finishing what you promised, and a student who knows the app is guessing stops
 * answering honestly.
 *
 * The keep-rate is shown only once three contracts are resolved (enforced by the backend), so an
 * early unlucky day doesn't become "you keep 0% of your promises".
 */

import { useEffect, useState } from "react";
import { Check, Handshake, X } from "lucide-react";
import { ipc, isTauri } from "../../lib/ipc";
import { cn } from "../../lib/utils";
import type { FocusContract, PlanBlock } from "../../lib/types";

interface Props {
  /** The block being committed to / reviewed. */
  block: PlanBlock;
  /** Called after any write, so the owner can refetch if it cares. */
  onChange?: () => void;
  /** Show the block's title. Set when the prompt appears away from its own row (the
   *  close-the-loop list), where "You said: …" would otherwise be unattributed. */
  showTitle?: boolean;
  /** Render ONLY an unresolved question, nothing else. Used by the close-the-loop list so it
   *  stays empty when there is nothing to answer. */
  askOnly?: boolean;
}

export default function FocusContractPrompt({
  block,
  onChange,
  showTitle = false,
  askOnly = false,
}: Props) {
  const [contract, setContract] = useState<FocusContract | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isTauri()) {
      setLoaded(true);
      return;
    }
    let alive = true;
    void ipc
      .focusContract(block.id)
      .then((c) => {
        if (!alive) return;
        setContract(c);
        setDraft(c?.intention ?? "");
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [block.id]);

  if (!loaded) return null;

  const commit = async () => {
    if (!draft.trim() || busy) return;
    setBusy(true);
    try {
      await ipc.commitFocus(block.id, draft.trim());
      setContract(await ipc.focusContract(block.id));
      onChange?.();
    } catch {
      /* the field keeps its text, so nothing the student typed is lost */
    } finally {
      setBusy(false);
    }
  };

  const resolve = async (kept: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      await ipc.resolveFocus(block.id, kept);
      setContract(await ipc.focusContract(block.id));
      onChange?.();
    } catch {
      /* leave the question on screen rather than pretending it was answered */
    } finally {
      setBusy(false);
    }
  };

  const finished = block.status === "done" || block.status === "partial";
  // `askOnly` callers want a list that disappears once everything is answered, so every state
  // except "committed but unanswered" renders nothing for them.
  if (askOnly && (contract == null || contract.kept != null || !finished)) return null;

  // ── Already answered: the record, stated plainly and without commentary. ──
  if (contract?.kept != null) {
    return (
      <div className="flex items-start gap-2 rounded-[12px] border border-white/[0.06] bg-white/[0.02] p-2.5">
        <Handshake
          size={12}
          strokeWidth={2}
          className={cn("mt-0.5 shrink-0", contract.kept ? "text-lime" : "text-white/35")}
          aria-hidden
        />
        <p className="min-w-0 flex-1 text-[0.68rem] leading-snug text-white/45">
          <span className={contract.kept ? "text-lime" : "text-amber-300"}>
            {contract.kept ? "Kept" : "Not this time"}
          </span>
          {" — "}
          <span className="text-content-secondary">{contract.intention}</span>
        </p>
      </div>
    );
  }

  // ── Committed, block finished: ask. One question, two buttons, no third option. ──
  if (contract && finished) {
    return (
      <div className="rounded-[12px] border border-cyan-400/25 bg-cyan-400/[0.05] p-2.5">
        {showTitle && (
          <p className="mb-0.5 truncate text-[0.66rem] font-semibold text-content-primary">
            {block.title}
          </p>
        )}
        <p className="text-[0.68rem] leading-snug text-content-secondary">
          You said: <span className="font-medium text-content-primary">{contract.intention}</span>
        </p>
        <div className="mt-2 flex items-center gap-2">
          <span className="text-[0.66rem] text-white/40">Did you?</span>
          <button
            type="button"
            onClick={() => void resolve(true)}
            disabled={busy}
            className="flex items-center gap-1 rounded-full border border-lime/30 bg-lime/10 px-2.5 py-1 text-[0.66rem] font-semibold text-lime transition-colors hover:bg-lime/20 disabled:opacity-50"
          >
            <Check size={10} strokeWidth={3} aria-hidden />
            Yes
          </button>
          <button
            type="button"
            onClick={() => void resolve(false)}
            disabled={busy}
            className="flex items-center gap-1 rounded-full border border-white/[0.1] bg-white/[0.04] px-2.5 py-1 text-[0.66rem] font-medium text-content-secondary transition-colors hover:bg-white/[0.08] disabled:opacity-50"
          >
            <X size={10} strokeWidth={3} aria-hidden />
            No
          </button>
        </div>
        <p className="mt-1.5 text-[0.6rem] leading-snug text-white/30">
          Answering honestly is the only thing that makes this useful — nothing is scored on it.
        </p>
      </div>
    );
  }

  // ── Committed, still in flight: show the promise as a reminder of what "done" means. ──
  if (contract) {
    return (
      <div className="flex items-start gap-2 rounded-[12px] border border-cyan-400/20 bg-cyan-400/[0.04] p-2.5">
        <Handshake size={12} strokeWidth={2} className="mt-0.5 shrink-0 text-cyan-300" aria-hidden />
        <p className="min-w-0 flex-1 text-[0.68rem] leading-snug">
          <span className="text-white/40">Done means: </span>
          <span className="text-content-primary">{contract.intention}</span>
        </p>
      </div>
    );
  }

  // ── No contract yet: offer one. Only worth asking while the block can still be worked. ──
  if (finished || block.status === "skipped" || block.status === "spilled") return null;

  return (
    <div className="rounded-[12px] border border-white/[0.06] bg-white/[0.02] p-2.5">
      <label className="flex items-center gap-1.5 text-[0.62rem] uppercase tracking-wide text-white/35">
        <Handshake size={11} strokeWidth={2} aria-hidden />
        What does done look like?
      </label>
      <div className="mt-1.5 flex gap-1.5">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            }
          }}
          maxLength={200}
          placeholder="Finish the chapter 4 problems"
          aria-label="What done looks like for this block"
          className="min-w-0 flex-1 rounded-[8px] border border-white/[0.08] bg-black/30 px-2.5 py-1.5 text-[0.7rem] text-content-primary outline-none transition-colors placeholder:text-white/25 focus:border-cyan-400/40"
        />
        <button
          type="button"
          onClick={() => void commit()}
          disabled={!draft.trim() || busy}
          className="shrink-0 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-3 py-1.5 text-[0.66rem] font-semibold text-cyan-300 transition-colors hover:bg-cyan-400/20 disabled:opacity-40"
        >
          Commit
        </button>
      </div>
      <p className="mt-1.5 text-[0.6rem] leading-snug text-white/30">
        Deciding this before you start is what stops "I'll just watch a bit more" from becoming the
        whole session.
      </p>
    </div>
  );
}
