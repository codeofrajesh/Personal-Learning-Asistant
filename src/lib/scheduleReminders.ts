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
 *   * `T-10`  — "Physics starts in 10 minutes" (info). Enough time to actually arrive. The lead
 *               is the TARGET, not a promise: a block created 3 minutes before it starts fires
 *               this rung late (see the replay window below) and says "starts in 3 min".
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
import { ipc, isTauri } from "./ipc";
import { toast } from "./toastStore";
import { playChime } from "./timerStore";
import { usePlanRevision } from "./planRevision";
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
  /** The block's own start instant, so a rung can describe the real time left rather than its
   *  nominal lead. See `fire`. */
  startMs: number;
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
    out.push({ key: `block-${block.id}-t10`, block, rung: "t10", atMs: startMs - LEAD_MINS * 60_000, startMs });
    out.push({ key: `block-${block.id}-start`, block, rung: "start", atMs: startMs, startMs });
  }
  if (block.status === "pending" || block.status === "active") {
    out.push({ key: `block-${block.id}-over`, block, rung: "over", atMs: endMs + OVERRUN_MINS * 60_000, startMs });
  }
  return out;
}

/**
 * Minutes from `now` until a block starts, rounded the way a person reads a clock.
 *
 * `Math.round` is wrong here: at 3 minutes 29 seconds out it says "3 min", and the student who
 * looks at the clock sees 3 minutes they do not have. Rounding UP never promises time that has
 * already gone. Returns at least 1, because "starts in 0 min" is what the `start` rung is for.
 */
function minsUntil(startMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((startMs - nowMs) / 60_000));
}

function fire(due: Due, nowMs: number) {
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
    // The lead is NOT always 10 minutes. A block created 3 minutes before it starts has its
    // T-10 instant already in the past, and the pump still fires it (that is the STALE_MINS
    // replay window doing its job — the heads-up is the only warning that block will get).
    // Hardcoding "10 min" there tells the student a flat lie about their own schedule, so the
    // text is computed from the gap that actually remains at the moment of firing.
    const left = minsUntil(due.startMs, nowMs);
    toast({
      tone: "info",
      title: `${name} starts in ${left} min`,
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
      // A heads-up for a block that has ALREADY started is not a heads-up. This is reachable
      // whenever the T-10 instant is inside the replay window but the start is behind us (a
      // block added a few minutes late, or the app opened just after one began) — the `start`
      // rung is queued in the same pass and says the true thing, so firing both would mean
      // "starts in 1 min" immediately followed by "starts now".
      .filter((d) => d.rung !== "t10" || d.startMs > nowMs)
      .sort((a, b) => a.atMs - b.atMs);

    for (const due of pending) {
      if (disposed) return;
      try {
        // The claim is the gate: `false` means another tab, an earlier run, or a pre-restart
        // session already fired this rung, or it is snoozed.
        // `Date.now()` rather than the loop's `nowMs`: each claim is an awaited round-trip, so by
        // the time a later rung fires the captured instant is seconds stale — and this number is
        // shown to the student.
        if (await ipc.claimReminder(due.key, localDateTime(new Date(due.atMs)))) fire(due, Date.now());
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
