/**
 * Task reminders — raises deduped toasts for tasks approaching or past their deadline.
 *
 * Low-CPU by design: ONE poll every 60s (not per-second), and each poll is a single
 * cheap `listTasks` read. There is no per-task timer. Dedupe is handled by the toast
 * store's `key` + `cooldownMs`, so a task that's "due in 1h" only alerts once per
 * window, never on every poll.
 *
 * Reminder tiers (each fires at most once per task per app session, plus a long
 * cooldown as a backstop):
 *   - due within 60 min  → "due soon" (orange)
 *   - just crossed due    → "overdue" (warning)
 * Completed tasks never alert. Runs only while mounted (AppShell) — unmount clears it.
 */

import { useEffect } from "react";
import { ipc, isTauri } from "../lib/ipc";
import { toast } from "../lib/toastStore";
import type { Task } from "../lib/types";

const POLL_MS = 60_000; // once a minute — cheap, no per-second work
const SOON_MS = 60 * 60_000; // 60 minutes

/** Parse a task's due_at into epoch ms (tolerates date / 'T' / ' ' forms). */
function dueMs(task: Task): number | null {
  if (!task.due_at) return null;
  const t = new Date(task.due_at.replace(" ", "T")).getTime();
  return isNaN(t) ? null : t;
}

function humanLeft(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  return `${Math.round(m / 60)} h`;
}

export function useTaskReminders() {
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;

    const check = async () => {
      let tasks: Task[];
      try {
        tasks = await ipc.listTasks();
      } catch {
        return;
      }
      if (!alive) return;
      const now = Date.now();
      for (const task of tasks) {
        if (task.done) continue;
        const due = dueMs(task);
        if (due == null) continue;
        const left = due - now;
        if (left < 0 && left > -POLL_MS * 1.5) {
          // Just crossed the deadline (within ~the last poll window) → one overdue alert.
          toast({
            tone: "warning",
            title: "Task overdue",
            body: `"${task.title}" is now past its deadline.`,
            key: `task-overdue-${task.id}`,
            cooldownMs: 12 * 3600_000, // at most once per 12h per task
          });
        } else if (left > 0 && left <= SOON_MS) {
          // Approaching deadline → one "due soon" alert per task.
          toast({
            tone: "warning",
            title: "Task due soon",
            body: `"${task.title}" is due in ${humanLeft(left)}.`,
            key: `task-soon-${task.id}`,
            cooldownMs: 6 * 3600_000, // at most once per 6h per task
          });
        }
      }
    };

    // First check shortly after mount (let the app settle), then every minute.
    const first = window.setTimeout(() => void check(), 4000);
    const interval = window.setInterval(() => void check(), POLL_MS);
    return () => {
      alive = false;
      window.clearTimeout(first);
      window.clearInterval(interval);
    };
  }, []);
}
