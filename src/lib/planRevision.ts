/**
 * planRevision — a global counter meaning "today's plan has changed".
 *
 * Split out of `scheduleReminders` so the IPC layer can bump it without a circular import
 * (`scheduleReminders` imports `ipc`; `ipc` must not import back into it). This module has no
 * dependencies at all.
 *
 * Why a counter: the reminder ladder runs on EVERY route (a student watching a video is exactly
 * who needs telling that the next block started), so it is armed once in `AppShell`. Writers
 * that observe a change to today's plan bump this counter; the global hook refetches. A counter
 * is the cheapest correct link — the alternative (polling for changes) is the poll this design
 * removed.
 *
 * The "watch path" is the new writer: `log_session` credits the active block's `executed_mins`,
 * and the block card on the Planning page and the sidebar Study Meter must see that move even
 * while the mini-player is still playing in the corner. `ipc.logSession` bumps this on success,
 * and `useDayPlan` re-reads the day on every bump (guarded so its own reloads converge).
 */

import { create } from "zustand";

export const usePlanRevision = create<{ revision: number; bump: () => void }>((set) => ({
  revision: 0,
  bump: () => set((s) => ({ revision: s.revision + 1 })),
}));

/** Announce that today's plan changed (called after any block-affecting mutation). */
export function bumpPlanRevision() {
  usePlanRevision.getState().bump();
}
