/**
 * Task reminders — deadline alerts for to-do items.
 *
 * ## What changed and why
 *
 * This used to own a 60s `setInterval` that refetched `listTasks()` — 1,440 IPC calls a day
 * whether anything was due or not, and a reminder could still land up to 60s late. It also
 * deduped purely through `toastStore`'s in-memory cooldown map, so **every reminder re-fired
 * after an app restart**: reopening at 21:00 replayed the whole day's alerts.
 *
 * Both problems are now handled by shared machinery:
 *   * Time comes from `useScheduleClock` — ONE app-wide minute tick, so this hook costs a
 *     `useMemo` per minute instead of its own timer and its own fetch.
 *   * Dedupe goes through the durable `reminder_state` ledger (`ipc.claimReminder`), a single
 *     atomic upsert that survives restart. The in-memory cooldown is now just a fast path.
 *   * Tasks come from the caller's already-loaded list, so there is no second fetch and no
 *     second source of truth.
 *
 * Tiers (each claimed once, ever, per task):
 *   * due within 60 min → "due soon"
 *   * deadline crossed  → "overdue" (claimed only while still fresh, so an app opened days
 *     later doesn't shout about deadlines the student already knows about)
 */

import { useEffect, useState } from "react";
import { ipc, isTauri } from "../lib/ipc";
import { toast } from "../lib/toastStore";
import { localDateTime, useScheduleClock } from "../lib/scheduleClock";
import { dueMs } from "./planning/planningUtils";
import type { Task } from "../lib/types";

const SOON_MS = 60 * 60_000;
/** How long after a deadline an overdue alert is still worth raising. */
const OVERDUE_FRESH_MS = 6 * 60 * 60_000;

function humanLeft(ms: number): string {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.round(m / 60)} h`;
}

/**
 * Raise reminders for `tasks`. Pass the list you already have (AppShell fetches it once);
 * omitting it makes the hook fetch once on mount rather than on a schedule.
 */
export function useTaskReminders(tasks?: Task[]) {
  const nowMs = useScheduleClock((s) => s.nowMs);
  const [ownTasks, setOwnTasks] = useState<Task[]>([]);

  // Only when the caller has no list of its own: one fetch, not a poll.
  useEffect(() => {
    if (tasks || !isTauri()) return;
    let alive = true;
    void ipc
      .listTasks()
      .then((t) => {
        if (alive) setOwnTasks(t);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [tasks]);

  const list = tasks ?? ownTasks;

  useEffect(() => {
    if (!isTauri() || list.length === 0) return;
    let alive = true;

    const run = async () => {
      for (const task of list) {
        if (!alive) return;
        if (task.done) continue;
        const due = dueMs(task.due_at);
        if (due == null) continue;
        const left = due - nowMs;

        let key: string | null = null;
        let payload: { title: string; body: string } | null = null;
        if (left < 0 && left > -OVERDUE_FRESH_MS) {
          key = `task-overdue-${task.id}`;
          payload = {
            title: "Task overdue",
            body: `"${task.title}" is now past its deadline.`,
          };
        } else if (left > 0 && left <= SOON_MS) {
          key = `task-soon-${task.id}`;
          payload = {
            title: "Task due soon",
            body: `"${task.title}" is due in ${humanLeft(left)}.`,
          };
        }
        if (!key || !payload) continue;

        try {
          // The ledger decides. `false` = already fired (possibly in a previous run of the
          // app), acknowledged, or snoozed.
          if (!(await ipc.claimReminder(key, localDateTime(new Date())))) continue;
        } catch {
          continue;
        }
        if (!alive) return;
        toast({ tone: "warning", title: payload.title, body: payload.body, key });
      }
    };

    void run();
    return () => {
      alive = false;
    };
  }, [list, nowMs]);
}

