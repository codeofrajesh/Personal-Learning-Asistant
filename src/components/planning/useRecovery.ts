/**
 * useRecovery — decides WHEN the Recovery Card may speak, and owns apply/undo/dismiss.
 *
 * The whole difficulty of this feature is restraint. A student who is 40 minutes behind does not
 * need to be told four times; they need one clear offer, at a moment they can act on it. So:
 *
 *   * **One prompt per day, then only on request.** The gate is `plan_days.adjust_state`
 *     (server-side), not a ref: a component remount or an app restart must not re-open a card
 *     they already declined. Once answered, the offer stays available through `canOpen`/`open()`
 *     rather than re-asserting itself.
 *   * **Never during fullscreen video.** Interrupting a lecture the student is actively watching
 *     to tell them they're behind on watching lectures is self-defeating. We hold the card and
 *     show it when they come back.
 *   * **Never a modal.** The card renders inline in the Today rail. A modal over a schedule you
 *     need to read in order to answer the question is a dialog that has to be dismissed first.
 *   * **Read-only until the student picks.** `recoveryPlans` mutates nothing, so previewing is
 *     free and we can recompute on every clock tick without consequence.
 *
 * `applyRecovery` returns an undo token, and the 10s window is the reason the card can afford to
 * recommend a default at all: a wrong guess costs one click to reverse.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ipc, isTauri } from "../../lib/ipc";
import { subscribeFullscreen } from "../../lib/fullscreen";
import { dayOffset, useScheduleClock } from "../../lib/scheduleClock";
import { bumpPlanRevision } from "../../lib/scheduleReminders";
import { toast } from "../../lib/toastStore";
import type { RecoveryReport } from "../../lib/types";
import type { DayPlanState } from "./useDayPlan";

/** Below this, drift is noise — a 6-minute overrun is not a scheduling crisis. */
const DRIFT_FLOOR_MINS = 15;
/** How long the student can take the adjustment back. */
export const UNDO_WINDOW_MS = 10_000;

export interface RecoveryState {
  /** The current report, or `null` when there is nothing to say. */
  report: RecoveryReport | null;
  /** True when the card should be on screen right now. */
  visible: boolean;
  /** True when there are options to show but the card is being quiet — drives the manual entry. */
  canOpen: boolean;
  busy: boolean;
  /** Set for `UNDO_WINDOW_MS` after an apply; drives the inline Undo affordance. */
  undoToken: string | null;
  /** Student-initiated open. The only way back in once they've answered for the day. */
  open: () => void;
  apply: (planId: string) => Promise<void>;
  undo: () => Promise<void>;
  dismiss: () => Promise<void>;
}

export function useRecovery(schedule: DayPlanState): RecoveryState {
  const { day, isToday, plan, reload } = schedule;
  const nowMins = useScheduleClock((s) => s.minutes);

  const [report, setReport] = useState<RecoveryReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [undoToken, setUndoToken] = useState<string | null>(null);
  // Set when the student answers in THIS session, so the card closes on the spot instead of
  // waiting for the `reload()` round-trip to bring `adjust_state` back.
  const [answered, setAnswered] = useState(false);
  // Set by `open()`. Overrides the answered gates for one viewing.
  const [forced, setForced] = useState(false);

  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => subscribeFullscreen(setFullscreen), []);

  const undoTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(undoTimer.current), []);

  // `adjust_state` comes from the server payload, so a dismissal survives a remount.
  const adjustState = plan?.adjust_state ?? null;

  // Recompute the report on each minute tick. Read-only, so this is safe to do freely; the cost
  // is one cheap query a minute, only while parked on today.
  useEffect(() => {
    if (!isTauri() || !isToday) {
      setReport(null);
      return;
    }
    let alive = true;
    void ipc
      .recoveryPlans(day, nowMins)
      .then((r) => {
        if (alive) setReport(r);
      })
      .catch(() => {
        /* a failed advisory read must never break the Today view */
      });
    return () => {
      alive = false;
    };
  }, [day, isToday, nowMins]);

  // Reset the per-day gates when the student navigates to a different day.
  useEffect(() => {
    setAnswered(false);
    setForced(false);
  }, [day]);

  /** There is a real, actionable offer to make — independent of whether we're allowed to speak. */
  const hasOffer = useMemo(
    () =>
      !!report &&
      isToday &&
      !report.nothing_to_do &&
      report.plans.length > 0 &&
      report.drift_mins >= DRIFT_FLOOR_MINS,
    [report, isToday],
  );

  // One prompt per day, unless the student asks again. `adjust_state` is the authoritative gate
  // and it survives restarts; `answered` just closes the card without waiting for the refetch.
  //
  // Deliberately NOT escalating on worsening drift: `adjust_state` records only THAT the student
  // answered, not at what drift, so after a restart there is no way to tell a fresh escalation
  // from the one they already declined — and re-opening a dismissed card is the single most
  // annoying thing this feature could do. Falling further behind surfaces `canOpen` instead.
  const silenced = answered || adjustState != null;

  const visible = useMemo(() => {
    if (!hasOffer) return false;
    // Suppressed, not skipped: when the student leaves fullscreen the card is still here.
    // Checked after `hasOffer` so `canOpen` stays true and the manual entry point survives.
    if (fullscreen) return false;
    return forced || !silenced;
  }, [hasOffer, fullscreen, forced, silenced]);

  /** Something to offer, but we're staying quiet. Lets Today show a subtle way back in. */
  const canOpen = hasOffer && !visible;

  const open = useCallback(() => setForced(true), []);

  const apply = useCallback(
    async (planId: string) => {
      if (!isTauri() || busy) return;
      setBusy(true);
      try {
        // The backend re-derives the plan from `planId` rather than trusting a client-sent diff,
        // so a stale preview cannot be committed as-is.
        const token = await ipc.applyRecovery(day, planId, nowMins, dayOffset(day, 1));
        setAnswered(true);
        setForced(false);
        setUndoToken(token);
        window.clearTimeout(undoTimer.current);
        undoTimer.current = window.setTimeout(() => setUndoToken(null), UNDO_WINDOW_MS);
        await reload();
        // Times moved, so the reminder ladder must re-arm against the new starts.
        bumpPlanRevision();
      } catch {
        toast({ tone: "warning", title: "Couldn't adjust the day", key: "recovery-apply-failed" });
      } finally {
        setBusy(false);
      }
    },
    [busy, day, nowMins, reload],
  );

  const undo = useCallback(async () => {
    const token = undoToken;
    if (!isTauri() || !token) return;
    setBusy(true);
    try {
      await ipc.undoRecovery(token);
      setUndoToken(null);
      window.clearTimeout(undoTimer.current);
      // Undo clears `adjust_state` server-side, so the card may offer again — the student
      // reversed the decision, they didn't decline to make one.
      setAnswered(false);
      await reload();
      bumpPlanRevision();
    } catch {
      toast({ tone: "warning", title: "Couldn't undo the adjustment", key: "recovery-undo-failed" });
    } finally {
      setBusy(false);
    }
  }, [undoToken, reload]);

  const dismiss = useCallback(async () => {
    setAnswered(true);
    setForced(false);
    if (!isTauri()) return;
    try {
      await ipc.dismissRecovery(day);
      await reload();
    } catch {
      /* the in-session gate already closed the card; persistence is best-effort */
    }
  }, [day, reload]);

  return useMemo(
    () => ({ report, visible, canOpen, busy, undoToken, open, apply, undo, dismiss }),
    [report, visible, canOpen, busy, undoToken, open, apply, undo, dismiss],
  );
}
