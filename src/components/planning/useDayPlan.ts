/**
 * useDayPlan — state for one day's schedule (the Today surface).
 *
 * Mirrors `usePlanningTasks`: one owner, optimistic-ish writes, a single reload path. Kept
 * separate from it because blocks and tasks are separate tables for a real reason (a block is
 * a time *intention*, a task is a *deliverable*), and merging their state would force one to
 * refetch whenever the other changed.
 *
 * Two things it deliberately owns:
 *   * **The day pointer.** `day` follows the `scheduleClock` day when the student is looking at
 *     today, so an app left open past midnight rolls over on its own instead of showing
 *     yesterday's plan forever.
 *   * **Reminder arming.** The ladder is armed from the blocks already loaded here, so there is
 *     no second fetch and no second source of truth for the day.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ipc, isTauri } from "../../lib/ipc";
import { bumpPlanRevision } from "../../lib/scheduleReminders";
import { dayOffset, localDay, useScheduleClock } from "../../lib/scheduleClock";
import type { BlockInput, BlockStatus, DayPlan, PlanBlock } from "../../lib/types";

/**
 * Turn a Tauri IPC rejection into something worth showing a student.
 *
 * `AppError` serializes as its `Display` string, so an invalid input arrives as
 * `"invalid input: That overlaps “Physics” (11:10–11:55)."`. The prefix is for our logs, not for
 * the person who just tried to save a block, so it is stripped.
 */
function cleanIpcError(e: unknown): string {
  const raw = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
  const msg = raw.replace(/^invalid input:\s*/i, "").trim();
  return msg.length > 0 ? msg : "That block couldn't be saved.";
}

export interface DayPlanState {
  day: string;
  /** True when `day` is the real local today (drives the now-line + reminders). */
  isToday: boolean;
  plan: DayPlan | null;
  loaded: boolean;
  preview: boolean;
  goToDay: (day: string) => void;
  shiftDay: (delta: number) => void;
  goToToday: () => void;
  reload: () => Promise<void>;
  /** Resolves `null` on success, or a human-readable reason the save was refused. */
  saveBlock: (input: BlockInput) => Promise<string | null>;
  removeBlock: (block: PlanBlock) => Promise<void>;
  setStatus: (block: PlanBlock, status: BlockStatus, executedMins?: number | null) => Promise<void>;
  startBlock: (block: PlanBlock) => Promise<void>;
  setWindow: (wakeAt: string | null, hardStopAt: string | null) => Promise<void>;
}

export function useDayPlan(): DayPlanState {
  const clockDay = useScheduleClock((s) => s.day);
  const [day, setDay] = useState<string>(() => localDay());
  const [plan, setPlan] = useState<DayPlan | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [preview, setPreview] = useState(false);
  // Tracks whether the student is parked on "today". Only then do we follow the clock across
  // midnight; if they navigated to Friday, midnight must not yank them away from it.
  const pinnedRef = useRef(true);

  const isToday = day === clockDay;

  useEffect(() => {
    if (pinnedRef.current && day !== clockDay) setDay(clockDay);
  }, [clockDay, day]);

  const reload = useCallback(async () => {
    if (!isTauri()) {
      setPreview(true);
      setLoaded(true);
      return;
    }
    try {
      setPlan(await ipc.planDay(day));
    } catch {
      /* keep the previous plan on a transient failure rather than blanking the day */
    } finally {
      setLoaded(true);
    }
  }, [day]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // The reminder ladder is NOT armed here. It lives in AppShell (`useBlockReminders`) because a
  // reminder is worthless if it only fires while the Planning page happens to be open — the
  // student needs it most while they're on the player. This hook just announces that the day
  // changed, and the global ladder re-arms itself.
  const blocks = plan?.blocks;
  useEffect(() => {
    if (isToday && blocks) bumpPlanRevision();
  }, [isToday, blocks]);

  const goToDay = useCallback((next: string) => {
    pinnedRef.current = next === localDay();
    setDay(next);
  }, []);

  const shiftDay = useCallback((delta: number) => {
    setDay((cur) => {
      const next = dayOffset(cur, delta);
      pinnedRef.current = next === localDay();
      return next;
    });
  }, []);

  const goToToday = useCallback(() => {
    pinnedRef.current = true;
    setDay(localDay());
  }, []);

  const saveBlock = useCallback(
    async (input: BlockInput): Promise<string | null> => {
      if (!isTauri()) return null;
      try {
        await ipc.upsertPlanBlock({ ...input, day: input.day || day });
        return null;
      } catch (e) {
        // A rejected save is a NORMAL outcome now that overlaps are refused, not a crash: the
        // reason has to reach the student, and the modal has to stay open holding their input.
        // Swallowing it would look exactly like the block silently failing to appear.
        return cleanIpcError(e);
      } finally {
        // Always refetch: the backend recomputes the pre-mortem verdict and pace-adjusted
        // durations, so a locally-patched block would show numbers the solver disagrees with.
        await reload();
      }
    },
    [day, reload],
  );

  const removeBlock = useCallback(
    async (block: PlanBlock) => {
      if (!isTauri()) return;
      // Deletion is safe to reflect immediately — nothing else in the payload depends on a
      // block that no longer exists, and the refetch confirms it.
      setPlan((cur) => (cur ? { ...cur, blocks: cur.blocks.filter((b) => b.id !== block.id) } : cur));
      try {
        await ipc.deletePlanBlock(block.id);
      } finally {
        await reload();
      }
    },
    [reload],
  );

  const setStatus = useCallback(
    async (block: PlanBlock, status: BlockStatus, executedMins: number | null = null) => {
      if (!isTauri()) return;
      setPlan((cur) =>
        cur ? { ...cur, blocks: cur.blocks.map((b) => (b.id === block.id ? { ...b, status } : b)) } : cur,
      );
      try {
        // Pass the block's OWN day: confirming yesterday's block in an end-of-day review must
        // move yesterday's score, not today's.
        await ipc.setPlanBlockStatus(block.id, status, executedMins, block.day);
      } finally {
        await reload();
      }
    },
    [reload],
  );

  const startBlock = useCallback(
    async (block: PlanBlock) => {
      if (!isTauri()) return;
      try {
        await ipc.startPlanBlock(block.id);
        // The student acted, so the start reminder must never fire again for this block.
        await ipc.ackReminder(`block-${block.id}-start`).catch(() => {});
      } finally {
        await reload();
      }
    },
    [reload],
  );

  const setWindow = useCallback(
    async (wakeAt: string | null, hardStopAt: string | null) => {
      if (!isTauri()) return;
      try {
        await ipc.setPlanDayWindow(day, wakeAt, hardStopAt);
      } finally {
        await reload();
      }
    },
    [day, reload],
  );

  return useMemo(
    () => ({
      day,
      isToday,
      plan,
      loaded,
      preview,
      goToDay,
      shiftDay,
      goToToday,
      reload,
      saveBlock,
      removeBlock,
      setStatus,
      startBlock,
      setWindow,
    }),
    [
      day,
      isToday,
      plan,
      loaded,
      preview,
      goToDay,
      shiftDay,
      goToToday,
      reload,
      saveBlock,
      removeBlock,
      setStatus,
      startBlock,
      setWindow,
    ],
  );
}
