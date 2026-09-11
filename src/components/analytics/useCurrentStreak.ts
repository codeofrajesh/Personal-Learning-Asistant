/**
 * useCurrentStreak — ambient hook that computes the active consecutive study streak count.
 *
 * Checks:
 *   1. ipc.streakStatus(day) — official streak (with earned bad days bridged)
 *   2. ipc.dashboardData()   — active_days array
 *   3. ipc.studyAnalytics()  — consecutive active study days from daily log
 *
 * Returns the maximum valid streak number so whichever system logged consistency is respected.
 * Returns 0 if there is no active streak.
 */

import { useEffect, useState } from "react";
import { ipc, isTauri } from "../../lib/ipc";
import { useScheduleClock, localDay } from "../../lib/scheduleClock";
import { usePlanRevision } from "../../lib/planRevision";
import { localUtcOffsetMins } from "../planning/usePeakHours";
import { studyStreaks } from "./analyticsUtils";

function calcActiveDaysStreak(activeDays: string[]): number {
  if (!activeDays || activeDays.length === 0) return 0;
  const active = new Set(activeDays);
  const cursor = new Date();
  if (!active.has(localDay(cursor))) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (active.has(localDay(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

export function useCurrentStreak(): number {
  const day = useScheduleClock((s) => s.day);
  const revision = usePlanRevision((s) => s.revision);
  const [streak, setStreak] = useState(0);

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;

    Promise.allSettled([
      ipc.streakStatus(day),
      ipc.dashboardData(),
      ipc.studyAnalytics(day, localUtcOffsetMins(), 60),
    ])
      .then(([streakRes, dashRes, analyticsRes]) => {
        if (!alive) return;
        let maxStreak = 0;

        if (streakRes.status === "fulfilled" && streakRes.value?.streak) {
          maxStreak = Math.max(maxStreak, streakRes.value.streak);
        }
        if (dashRes.status === "fulfilled" && dashRes.value?.active_days) {
          const dStreak = calcActiveDaysStreak(dashRes.value.active_days);
          maxStreak = Math.max(maxStreak, dStreak);
        }
        if (analyticsRes.status === "fulfilled" && analyticsRes.value?.daily) {
          const st = studyStreaks(analyticsRes.value.daily, day);
          maxStreak = Math.max(maxStreak, st.current);
        }

        setStreak(maxStreak);
      })
      .catch(() => {
        /* silently ignore */
      });

    return () => {
      alive = false;
    };
  }, [day, revision]);

  return streak;
}
