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
  SETTING_RETENTION_DAYS,
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
 * The student's ambition target, backed by the SHARED `study.daily_goal_mins` setting — the same
 * key the sidebar Study Meter falls back to on unplanned days. Saving bumps the plan revision so
 * the meter + pace gauge re-read at once. `null` = no target set (falls back to the 2h default).
 */
export function useTargetSetting(): {
  targetMins: number | null;
  loaded: boolean;
  save: (mins: number | null) => Promise<void>;
} {
  const [targetMins, setTargetMins] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!isTauri()) {
      setLoaded(true);
      return;
    }
    let alive = true;
    void ipc
      .getSetting(SETTING_DAILY_GOAL)
      .then((v) => {
        if (!alive) return;
        const n = v ? parseInt(v, 10) : NaN;
        setTargetMins(Number.isFinite(n) && n > 0 ? n : null);
        setLoaded(true);
      })
      .catch(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, []);

  const save = useCallback(async (mins: number | null) => {
    const clean = mins && mins > 0 ? Math.round(mins) : null;
    setTargetMins(clean);
    if (!isTauri()) return;
    // "" clears it: the backend parse fails and falls back to the default, without a delete IPC.
    await ipc.setSetting(SETTING_DAILY_GOAL, clean == null ? "" : String(clean));
    bumpPlanRevision();
  }, []);

  return { targetMins, loaded, save };
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

