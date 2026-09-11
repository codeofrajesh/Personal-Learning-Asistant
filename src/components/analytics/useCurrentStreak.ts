/**
 * useCurrentStreak — ambient hook that computes the active consecutive study streak count.
 *
 * Grounded in real study watch time (Path B):
 *   - Each consecutive active study day increments the streak count.
 *   - Any day with 0 study time that is NOT marked as a Rest Day breaks the streak to 0.
 *   - Marked Rest Days (fever, illness, busy schedules) bridge the streak without penalty.
 *
 * Exports:
 *   - `useCurrentStreak()`: returns the raw streak number (0 if broken).
 *   - `useStreakDetails()`: returns full streak stats including rest days taken inside the run.
 */

import { useEffect, useState, useMemo } from "react";
import { ipc, isTauri } from "../../lib/ipc";
import { useScheduleClock } from "../../lib/scheduleClock";
import { usePlanRevision } from "../../lib/planRevision";
import { localUtcOffsetMins } from "../planning/usePeakHours";
import { studyStreaks } from "./analyticsUtils";
import { useRestDayStore } from "../../lib/restDayStore";

export interface StreakDetails {
  streak: number;
  restDaysInStreak: number;
  restDatesInStreak: string[];
  isRestToday: boolean;
  activeToday: boolean;
  startDate: string | null;
  endDate: string | null;
}

const DEFAULT_DETAILS: StreakDetails = {
  streak: 0,
  restDaysInStreak: 0,
  restDatesInStreak: [],
  isRestToday: false,
  activeToday: false,
  startDate: null,
  endDate: null,
};

export function useStreakDetails(): StreakDetails {
  const day = useScheduleClock((s) => s.day);
  const revision = usePlanRevision((s) => s.revision);
  const restDaysMap = useRestDayStore((s) => s.restDays);
  const [details, setDetails] = useState<StreakDetails>(DEFAULT_DETAILS);

  const restDaysSet = useMemo(() => new Set(Object.keys(restDaysMap)), [restDaysMap]);

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;

    ipc.studyAnalytics(day, localUtcOffsetMins(), 60)
      .then((analytics) => {
        if (!alive || !analytics?.daily) return;
        const st = studyStreaks(analytics.daily, day, restDaysSet);
        setDetails({
          streak: st.current,
          restDaysInStreak: st.restDaysInStreak,
          restDatesInStreak: st.restDatesInStreak,
          isRestToday: st.isRestToday,
          activeToday: st.activeToday,
          startDate: st.currentStartDate,
          endDate: st.currentEndDate,
        });
      })
      .catch(() => {
        /* silently ignore */
      });

    return () => {
      alive = false;
    };
  }, [day, revision, restDaysSet]);

  return details;
}

export function useCurrentStreak(): number {
  return useStreakDetails().streak;
}
