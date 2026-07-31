/**
 * usePeakHours — when this student actually focuses, learned from logged sessions.
 *
 * ## The sign trap this hook exists to contain
 *
 * `Date.getTimezoneOffset()` returns the INVERSE of the offset people mean: for UTC+5:30 it
 * returns -330, not +330. The backend wants a true offset (minutes to ADD to UTC), so the
 * negation happens here, once, rather than at each call site where it would eventually be
 * forgotten and silently rotate every histogram the wrong way.
 *
 * ## Why a confidence gate
 *
 * Advice built on two sessions is noise wearing a lab coat. `confident` is false until the data
 * could plausibly show a habit, and the UI says "not enough yet" instead of pointing at whichever
 * hour happened to win a coin toss.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ipc, isTauri } from "../../lib/ipc";
import { useScheduleClock } from "../../lib/scheduleClock";
import type { PeakHour } from "../../lib/types";

/** Minutes to ADD to UTC to get local time. Inverts `getTimezoneOffset`'s backwards sign. */
export function localUtcOffsetMins(): number {
  return -new Date().getTimezoneOffset();
}

/** Below this much logged focus, "your best hour" is a coin toss, not a pattern. */
const MIN_TOTAL_MINS = 180;
/** And it has to be spread over enough separate days to be a habit rather than one long night. */
const MIN_DAYS = 4;

export interface PeakHoursState {
  hours: PeakHour[];
  loaded: boolean;
  /** True once there's enough signal to make a claim about the student's rhythm. */
  confident: boolean;
  /** The best contiguous 2-hour window, or `null` while not confident. */
  bestWindow: { startHour: number; mins: number } | null;
  /** Total focus in the sampled window, for the "not enough yet" copy. */
  totalMins: number;
  reload: () => Promise<void>;
}

export function usePeakHours(days = 60): PeakHoursState {
  const clockDay = useScheduleClock((s) => s.day);
  const [hours, setHours] = useState<PeakHour[]>([]);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    if (!isTauri()) {
      setLoaded(true);
      return;
    }
    try {
      setHours(await ipc.peakHours(localUtcOffsetMins(), days));
    } catch {
      /* keep prior data */
    } finally {
      setLoaded(true);
    }
  }, [days]);

  useEffect(() => {
    void reload();
  }, [reload, clockDay]);

  const derived = useMemo(() => {
    const totalMins = hours.reduce((s, h) => s + h.total_mins, 0);
    const distinctDays = hours.reduce((m, h) => Math.max(m, h.days), 0);
    const confident = totalMins >= MIN_TOTAL_MINS && distinctDays >= MIN_DAYS;

    let bestWindow: { startHour: number; mins: number } | null = null;
    if (confident) {
      const byHour = new Map(hours.map((h) => [h.hour, h.total_mins]));
      // A 2-hour window rather than a single hour: "you're sharpest around 9-11" is something a
      // student can schedule against, while a single hour is a spike that may just be when a
      // long lecture happened to start.
      for (let h = 0; h <= 22; h++) {
        const mins = (byHour.get(h) ?? 0) + (byHour.get(h + 1) ?? 0);
        if (!bestWindow || mins > bestWindow.mins) bestWindow = { startHour: h, mins };
      }
      if (bestWindow && bestWindow.mins <= 0) bestWindow = null;
    }

    return { totalMins, confident, bestWindow };
  }, [hours]);

  return useMemo(
    () => ({ hours, loaded, reload, ...derived }),
    [hours, loaded, reload, derived],
  );
}
