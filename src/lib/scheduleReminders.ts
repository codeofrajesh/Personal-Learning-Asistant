/**
 * scheduleReminders — the block reminder ladder, event-driven and durable.
 *
 * ## Why not a poll
 *
 * The task reminder engine polls `listTasks()` every 60s: 1,440 IPC round-trips a day, and a
 * reminder can still land up to 60s late. Both problems come from the same mistake — asking
 * "is anything due?" repeatedly instead of computing WHEN the next interesting instant is and
 * sleeping until then. This module arms exactly one `setTimeout` at the next rung of the
 * ladder: roughly 30 wakeups a day, and each fires on time.
 *
 * ## The ladder
 *
 * Per open block, in order:
 *   * `T-10`  — "Physics starts in 10 minutes" (info). Enough time to actually arrive.
 *   * `start` — "Physics starts now", with a one-tap Start action + the shared `playChime()`.
 *   * `over`  — fires ~5 min past the block's end if it is still `active`: the student is in
 *               overrun, which is the moment the recovery card is worth surfacing.
 *
 * A `skipped` rung is NOT re-fired later. Escalation exists to catch attention before the
 * moment passes; a "starts in 10 minutes" toast delivered 40 minutes late is noise, and noise
 * is what gets notifications switched off.
 *
 * ## Durability (the actual bug being fixed)
 *
 * `toastStore`'s dedupe is an in-memory `_cooldowns` map, so every reminder re-fired on the
 * next launch — reopening the app at 21:00 replayed the whole day. Each rung is now CLAIMED
 * through `ipc.claimReminder(key, now)`, a single atomic upsert in SQLite: it resolves `true`
 * only for the caller that gets to fire, and the row survives restart. `key` is
 * `block-<id>-<rung>`, so it is stable across reloads and unique per rung.
 *
 * Snooze routes back through the ledger too (`ipc.snoozeReminder`), so a snoozed block goes
 * quiet across a restart rather than shouting again on boot.
 */

import { useEffect, useState } from "react";
import { create } from "zustand";
import { ipc, isTauri } from "./ipc";
import { toast } from "./toastStore";
import { playChime } from "./timerStore";
import {
  clockNow,
  dayMinsToMs,
  hhmmToMins,
  localDateTime,
  useScheduleClock,
} from "./scheduleClock";
import type { PlanBlock } from "./types";

/** Lead time for the heads-up rung. 10 minutes is long enough to act, short enough to still
 *  be about the block rather than a vague future. */
const LEAD_MINS = 10;
/** How long past a block's end before overrun is worth mentioning. */
const OVERRUN_MINS = 5;
/** Rungs more than this far in the past are skipped rather than replayed. */
const STALE_MINS = 20;
/** Never sleep longer than this, so a plan edited hours ahead still gets picked up. */
const MAX_SLEEP_MS = 15 * 60_000;
/** Default snooze. */
export const SNOOZE_MINS = 10;

type Rung = "t10" | "start" | "over";

interface Due {
  key: string;
  block: PlanBlock;
  rung: Rung;
  atMs: number;
}

/** All rungs a block still owes, as absolute instants. */
function rungsFor(block: PlanBlock): Due[] {
  const startMins = hhmmToMins(block.effective_start);
  if (startMins == null) return [];
  const startMs = dayMinsToMs(block.day, startMins);
  const endMs = startMs + block.effective_mins * 60_000;
  const out: Due[] = [];

  // A block already finished (or deliberately abandoned) has nothing left to announce.
  if (block.status === "pending") {
    out.push({ key: `block-${block.id}-t10`, block, rung: "t10", atMs: startMs - LEAD_MINS * 60_000 });
    out.push({ key: `block-${block.id}-start`, block, rung: "start", atMs: startMs });
  }
  if (block.status === "pending" || block.status === "active") {
    out.push({ key: `block-${block.id}-over`, block, rung: "over", atMs: endMs + OVERRUN_MINS * 60_000 });
  }
  return out;
}

function fire(due: Due) {
  const { block, rung } = due;
  const name = block.title;
  const snooze = {
    label: `Snooze ${SNOOZE_MINS}m`,
    run: () => {
      const until = new Date(Date.now() + SNOOZE_MINS * 60_000);
      void ipc.snoozeReminder(due.key, localDateTime(until)).catch(() => {});
    },
  };

  if (rung === "t10") {
    toast({
      tone: "info",
      title: `${name} starts in ${LEAD_MINS} min`,
      body: block.target_name ? `Up next: ${block.target_name}` : undefined,
      key: due.key,
      action: snooze,
    });
    return;
  }

  if (rung === "start") {
    // Same chime as a Pomodoro phase change, deliberately: a second distinct sound would
    // just train the student to ignore both.
    playChime();
    toast({
      tone: "focus",
      title: `${name} starts now`,
      body: `${block.effective_mins} min planned${block.target_name ? ` · ${block.target_name}` : ""}`,
      duration: 12_000,
      key: due.key,
      action: {
        label: "Start",
        run: () => {
          void ipc
            .startPlanBlock(block.id)
            .then(() => ipc.ackReminder(due.key))
            .then(() => useScheduleClock.getState().sync())
            .catch(() => {});
        },
      },
    });
    return;
  }

  toast({
    tone: "warning",
    title: `${name} has run over`,
    body: "Open Planning to shift the rest of the day, or mark it done.",
    duration: 14_000,
    key: due.key,
    action: snooze,
  });
}

/**
 * Arm the ladder for a day's blocks. Returns a disposer.
 *
 * Called by the Today surface with the blocks it already loaded — this module never fetches,
 * so there is no second source of truth for the day and no duplicate IPC. Re-arming after a
 * mutation is just calling it again with the new blocks.
 */
export function armReminders(blocks: PlanBlock[]): () => void {
  if (!isTauri() || blocks.length === 0) return () => {};

  let timer: number | undefined;
  let disposed = false;

  const pump = async () => {
    if (disposed) return;
    const { nowMs } = clockNow();

    const pending = blocks
      .flatMap(rungsFor)
      .filter((d) => d.atMs <= nowMs && d.atMs > nowMs - STALE_MINS * 60_000)
      .sort((a, b) => a.atMs - b.atMs);

    for (const due of pending) {
      if (disposed) return;
      try {
        // The claim is the gate: `false` means another tab, an earlier run, or a pre-restart
        // session already fired this rung, or it is snoozed.
        if (await ipc.claimReminder(due.key, localDateTime(new Date(due.atMs)))) fire(due);
      } catch {
        // A failed claim must not silence the ladder for the rest of the day; the next
        // wakeup retries, and the ledger still guarantees at-most-once.
      }
    }
    if (disposed) return;

    // Sleep until the next future rung (or a bounded ceiling), never a fixed poll.
    const nextAt = blocks
      .flatMap(rungsFor)
      .map((d) => d.atMs)
      .filter((ms) => ms > nowMs)
      .sort((a, b) => a - b)[0];
    const wait = nextAt == null ? MAX_SLEEP_MS : Math.min(Math.max(nextAt - Date.now(), 1_000), MAX_SLEEP_MS);
    timer = window.setTimeout(() => void pump(), wait);
  };

  void pump();

  return () => {
    disposed = true;
    window.clearTimeout(timer);
  };
}

/** Drop ledger rows older than a fortnight, so the table stays bounded. Best-effort. */
export function pruneReminderLedger() {
  if (!isTauri()) return;
  void ipc.pruneReminders(14).catch(() => {});
}

/**
 * Revision counter for "today's plan has changed".
 *
 * The reminder ladder must run on EVERY route (a student watching a video is exactly who needs
 * telling that the next block started), so it is armed once in `AppShell` — not by the Planning
 * page, which is usually unmounted. But the Planning page is where blocks get edited, and it
 * would otherwise have no way to tell the global ladder that the day changed.
 *
 * A counter is the cheapest correct link: writers bump it, the global hook refetches. The
 * alternative — the ladder polling for changes — is the poll this whole design removed.
 */
export const usePlanRevision = create<{ revision: number; bump: () => void }>((set) => ({
  revision: 0,
  bump: () => set((s) => ({ revision: s.revision + 1 })),
}));

/** Announce that today's plan changed (called after any block mutation). */
export function bumpPlanRevision() {
  usePlanRevision.getState().bump();
}

/**
 * Arm the block reminder ladder app-wide. Mounted ONCE in `AppShell`, so reminders reach the
 * student on the player route, the dashboard, anywhere — which is the entire point of a reminder.
 *
 * Refetches today's blocks only when there is a reason to: the local day rolls over, or a block
 * was edited (`usePlanRevision`). No interval.
 */
export function useBlockReminders() {
  const day = useScheduleClock((s) => s.day);
  const revision = usePlanRevision((s) => s.revision);
  const [blocks, setBlocks] = useState<PlanBlock[]>([]);

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    void ipc
      .planDay(day)
      .then((p) => {
        if (alive) setBlocks(p.blocks);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [day, revision]);

  useEffect(() => {
    pruneReminderLedger();
  }, []);

  useEffect(() => armReminders(blocks), [blocks]);
}
