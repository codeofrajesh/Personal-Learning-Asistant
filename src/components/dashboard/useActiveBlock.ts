/**
 * useActiveBlock — the block the focus timer is currently crediting, for display.
 *
 * The BINDING itself is entirely server-side: `plan::attribute_time` credits whichever block is
 * `active` when a `work` session lands (and `plan::attribute_completion` does the same for
 * finished lessons). This hook exists only so the timer can *say* what it's crediting — a student
 * who sees "counting toward Physics" trusts the number on the Today axis, and one who sees
 * nothing assumes the timer and the planner are unrelated tools.
 *
 * Two consumers now: the Dashboard's Pomodoro widget and the global `HeaderTimeBox`. It lives in
 * `dashboard/` for history rather than for ownership. Both mount at most once at a time, and each
 * subscribes to the same shared minute clock, so the second consumer costs one extra read per
 * minute while a focus phase is live.
 *
 * Deliberately NOT a store: nothing writes through it. It polls on the shared minute clock rather
 * than its own interval, and only while a `work` phase is live — an idle timer has nothing to
 * credit and shouldn't be asking.
 */

import { useEffect, useState } from "react";
import { ipc, isTauri } from "../../lib/ipc";
import { useScheduleClock } from "../../lib/scheduleClock";
import { usePlanRevision } from "../../lib/planRevision";
import { useTimerStore } from "../../lib/timerStore";
import type { PlanBlock } from "../../lib/types";

export function useActiveBlock(): PlanBlock | null {
  const phase = useTimerStore((s) => s.phase);
  const running = useTimerStore((s) => s.running);
  // One subscription to the app-wide clock, so this costs one read a minute at most.
  const minutes = useScheduleClock((s) => s.minutes);
  // Starting a block from the Today view bumps this, so the label updates immediately
  // instead of waiting for the next minute tick.
  const revision = usePlanRevision((s) => s.revision);
  const [block, setBlock] = useState<PlanBlock | null>(null);

  const live = running && phase === "work";

  useEffect(() => {
    if (!isTauri() || !live) {
      // Clear on stop: a stale "counting toward Physics" under a paused timer is a lie.
      setBlock(null);
      return;
    }
    let alive = true;
    void ipc
      .activePlanBlock()
      .then((b) => {
        if (alive) setBlock(b);
      })
      .catch(() => {
        /* display-only — a failed read just means no label */
      });
    return () => {
      alive = false;
    };
  }, [live, minutes, revision]);

  return block;
}
