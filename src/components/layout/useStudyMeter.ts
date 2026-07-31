/**
 * useStudyMeter — today's real time on task, for the sidebar Study Meter.
 *
 * ## Why this polls the minute clock instead of owning an interval
 *
 * The meter lives in the sidebar, which is mounted on every route for the entire session. That
 * makes it the single most expensive place in the app to get wrong: a 1 Hz timer here would burn a
 * reconcile every second for the whole session, behind the player, on a 4 GB target. It subscribes
 * to the shared `useScheduleClock` minute tick instead (the same rule `useActiveBlock` and
 * `TodayTab` follow), so the sidebar re-renders at most once a minute and the query runs once per
 * minute rather than once per second.
 *
 * Minutes are also the honest resolution: the meter is rendered as "1h 20m" against a goal, so a
 * per-second refresh could not change a single pixel.
 *
 * ## Three things invalidate it
 *
 *   * the minute tick — new sessions land while the student studies;
 *   * `usePlanRevision` — the goal is derived from today's blocks, so editing the plan changes the
 *     denominator and the meter must not sit stale until the next minute;
 *   * the local day rolling over — `day` comes from the clock, so midnight refetches naturally
 *     and the meter resets instead of carrying yesterday's total into the morning.
 *
 * Read-only and failure-tolerant by design: this is an encouragement display, and a failed read
 * should leave the last good number on screen rather than blanking it or showing an error.
 */

import { useEffect, useState } from "react";
import { ipc, isTauri } from "../../lib/ipc";
import { useScheduleClock } from "../../lib/scheduleClock";
import { usePlanRevision } from "../../lib/scheduleReminders";
import type { StudyMeter } from "../../lib/types";

export function useStudyMeter(): StudyMeter | null {
  // Day and minute come from the ONE app-wide clock; this hook adds no timer of its own.
  const day = useScheduleClock((s) => s.day);
  const minutes = useScheduleClock((s) => s.minutes);
  const revision = usePlanRevision((s) => s.revision);
  const [meter, setMeter] = useState<StudyMeter | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    void ipc
      // NOTE the sign: `getTimezoneOffset()` is inverted relative to what the backend wants
      // (it returns +300 for UTC-5), and getting it backwards would file evening study on the
      // wrong day — the exact class of bug `study_meter` exists to avoid.
      .studyMeter(day, -new Date().getTimezoneOffset())
      .then((m) => {
        if (alive) setMeter(m);
      })
      .catch(() => {
        /* keep the last good value — a stale number beats a blank meter */
      });
    return () => {
      alive = false;
    };
  }, [day, minutes, revision]);

  return meter;
}
