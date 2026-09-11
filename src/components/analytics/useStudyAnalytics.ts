/**
 * Data hooks for the Analytics workspace.
 *
 * `useStudyAnalytics` fetches ONE 60-day series (+ today's hour histogram) that the whole workspace
 * slices — the KPI cards read the last 30 vs prior 30 days, the Month chart the last 30, the Week
 * chart the last 14, the Day view the last 2 + `hourly_today`. One round-trip, no refetch on toggle.
 *
 * Invalidation mirrors `useStudyMeter`: it re-reads when the local day rolls over and when the plan
 * revision bumps (which `ipc.logSession` fires on every logged session), so the series stays live
 * while the student studies — WITHOUT a per-minute poll of a 60-day query. The live "today" number
 * and the pace gauge get their minute-fresh value from `useStudyMeter` instead.
 */

import { useCallback, useEffect, useState } from "react";
import { ipc, isTauri } from "../../lib/ipc";
import { useScheduleClock, hhmmToMins } from "../../lib/scheduleClock";
import { usePlanRevision, bumpPlanRevision } from "../../lib/planRevision";
import { localUtcOffsetMins } from "../planning/usePeakHours";
import {
  SETTING_DAILY_GOAL,
  SETTING_WEEKLY_DAYS,
  SETTING_MONTHLY_DAYS,
  SETTING_RETENTION_DAYS,
  computeWeeklyGoalMins,
  computeMonthlyGoalMins,
  parseRetentionDays,
  retentionEarliestDate,
} from "./analyticsUtils";
import type { StudyAnalytics, StudyRange } from "../../lib/types";

/** The rolling window we fetch: 366 days covers a full calendar year for the 12-month
 *  consistency tracker and multi-month comparisons without extra round-trips. */
export const ANALYTICS_WINDOW_DAYS = 366;

export function useStudyAnalytics(days = ANALYTICS_WINDOW_DAYS): {
  data: StudyAnalytics | null;
  loaded: boolean;
} {
  const day = useScheduleClock((s) => s.day);
  const revision = usePlanRevision((s) => s.revision);
  const [data, setData] = useState<StudyAnalytics | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!isTauri()) {
      setLoaded(true);
      return;
    }
    let alive = true;
    void ipc
      .studyAnalytics(day, localUtcOffsetMins(), days)
      .then((d) => {
        if (alive) {
          setData(d);
          setLoaded(true);
        }
      })
      .catch(() => {
        // Encouragement display: keep the last good series rather than blanking on a failed read.
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [day, revision, days]);

  return { data, loaded };
}

/**
 * The student's ambition target and study rhythm, backed by:
 * - `study.daily_goal_mins` (daily ambition in minutes, default 120)
 * - `study.weekly_days` (active study days per week, 1..7, default 7)
 * - `study.monthly_days` (active study days per month, null = auto-scaled from weekly rhythm)
 *
 * Enforces strict mathematical upper bounds:
 * Weekly target <= daily target * 7
 * Monthly target <= daily target * totalDaysInMonth
 */
export function useTargetSetting(): {
  targetMins: number | null;
  weeklyDays: number;
  monthlyDays: number | null;
  weeklyTargetMins: number;
  monthlyTargetMins: (daysInMonth: number) => number;
  loaded: boolean;
  save: (dailyMins: number | null, weeklyDays?: number, monthlyDays?: number | null) => Promise<void>;
} {
  const [targetMins, setTargetMins] = useState<number | null>(null);
  const [weeklyDays, setWeeklyDays] = useState<number>(7);
  const [monthlyDays, setMonthlyDays] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!isTauri()) {
      setLoaded(true);
      return;
    }
    let alive = true;
    void Promise.all([
      ipc.getSetting(SETTING_DAILY_GOAL),
      ipc.getSetting(SETTING_WEEKLY_DAYS),
      ipc.getSetting(SETTING_MONTHLY_DAYS),
    ])
      .then(([dailyVal, weeklyVal, monthlyVal]) => {
        if (!alive) return;
        const dailyParsed = dailyVal ? parseInt(dailyVal, 10) : NaN;
        setTargetMins(Number.isFinite(dailyParsed) && dailyParsed > 0 ? dailyParsed : null);

        const weeklyParsed = weeklyVal ? parseInt(weeklyVal, 10) : NaN;
        setWeeklyDays(Number.isFinite(weeklyParsed) && weeklyParsed >= 1 && weeklyParsed <= 7 ? weeklyParsed : 7);

        const monthlyParsed = monthlyVal ? parseInt(monthlyVal, 10) : NaN;
        setMonthlyDays(Number.isFinite(monthlyParsed) && monthlyParsed >= 1 && monthlyParsed <= 31 ? monthlyParsed : null);

        setLoaded(true);
      })
      .catch(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, []);

  const save = useCallback(
    async (dailyMins: number | null, newWeeklyDays?: number, newMonthlyDays?: number | null) => {
      const cleanDaily = dailyMins && dailyMins > 0 ? Math.round(dailyMins) : null;
      const cleanWeekly =
        typeof newWeeklyDays === "number" && newWeeklyDays >= 1 && newWeeklyDays <= 7
          ? Math.round(newWeeklyDays)
          : 7;
      const cleanMonthly =
        typeof newMonthlyDays === "number" && newMonthlyDays >= 1 && newMonthlyDays <= 31
          ? Math.round(newMonthlyDays)
          : null;

      setTargetMins(cleanDaily);
      setWeeklyDays(cleanWeekly);
      setMonthlyDays(cleanMonthly);

      if (!isTauri()) return;
      await Promise.all([
        ipc.setSetting(SETTING_DAILY_GOAL, cleanDaily == null ? "" : String(cleanDaily)),
        ipc.setSetting(SETTING_WEEKLY_DAYS, cleanWeekly === 7 ? "7" : String(cleanWeekly)),
        ipc.setSetting(SETTING_MONTHLY_DAYS, cleanMonthly == null ? "" : String(cleanMonthly)),
      ]);
      bumpPlanRevision();
    },
    [],
  );

  const effectiveDaily = targetMins ?? 120;
  const weeklyTargetMins = computeWeeklyGoalMins(effectiveDaily, weeklyDays);
  const monthlyTargetMins = useCallback(
    (daysInMonth: number) => computeMonthlyGoalMins(effectiveDaily, monthlyDays, daysInMonth, weeklyDays),
    [effectiveDaily, monthlyDays, weeklyDays],
  );

  return {
    targetMins,
    weeklyDays,
    monthlyDays,
    weeklyTargetMins,
    monthlyTargetMins,
    loaded,
    save,
  };
}

/**
 * Today's usable window (wake → hard stop) in minutes-since-midnight, for the pace projection.
 * Reuses the existing `plan_day` payload (`resolve_day_window` precedence: per-day → setting →
 * default), so the gauge's "on track by 7:30 PM" math agrees with the planner's own day bounds.
 */
export function useDayWindow(): { wakeMins: number; hardStopMins: number } {
  const day = useScheduleClock((s) => s.day);
  const revision = usePlanRevision((s) => s.revision);
  // Sensible defaults mirror the backend's DEFAULT_WAKE (06:00) / DEFAULT_HARD_STOP (22:00).
  const [win, setWin] = useState<{ wakeMins: number; hardStopMins: number }>({
    wakeMins: 360,
    hardStopMins: 1320,
  });

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    void ipc
      .planDay(day)
      .then((p) => {
        if (!alive) return;
        const wake = hhmmToMins(p.wake_at) ?? 360;
        const stop = hhmmToMins(p.hard_stop_at) ?? 1320;
        setWin({ wakeMins: wake, hardStopMins: stop > wake ? stop : wake + 60 });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [day, revision]);

  return win;
}

/**
 * One arbitrary `[startDay, endDay]` period for Compare mode. Pass `null` days to stay idle (no
 * fetch). Re-reads on plan revision so a session logged mid-compare refreshes both periods.
 */
export function useStudyRange(
  startDay: string | null,
  endDay: string | null,
): { data: StudyRange | null; loaded: boolean } {
  const revision = usePlanRevision((s) => s.revision);
  const [data, setData] = useState<StudyRange | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!isTauri() || !startDay || !endDay) {
      setLoaded(true);
      return;
    }
    let alive = true;
    setLoaded(false);
    void ipc
      .studyRange(startDay, endDay, localUtcOffsetMins())
      .then((d) => {
        if (alive) {
          setData(d);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [startDay, endDay, revision]);

  return { data, loaded };
}

/**
 * The student's data retention setting (`study.retention_days`).
 * Returns retentionDays (e.g. 90, 180, 365, or null for keep-forever) and earliestDate.
 */
export function useRetentionSetting(): {
  retentionDays: number | null;
  earliestDate: string | null;
  loaded: boolean;
} {
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const today = useScheduleClock((s) => s.day);

  useEffect(() => {
    if (!isTauri()) {
      setLoaded(true);
      return;
    }
    let alive = true;
    void ipc
      .getSetting(SETTING_RETENTION_DAYS)
      .then((v) => {
        if (!alive) return;
        setRetentionDays(parseRetentionDays(v));
        setLoaded(true);
      })
      .catch(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, []);

  const earliestDate = retentionEarliestDate(today, retentionDays);
  return { retentionDays, earliestDate, loaded };
}

