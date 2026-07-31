/**
 * useExams — dated exams and their backward plans.
 *
 * The plans are DERIVED on the backend on every read, never cached there, because the inputs
 * (materials added, watched, completed; learned pace) change constantly. So this hook refetches
 * on the day boundary and whenever the student edits an exam — not on a timer.
 *
 * `examPlans` is the only call that matters for display; `listExams` exists for the editor,
 * where the raw rows are what a form needs.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ipc, isTauri } from "../../lib/ipc";
import { localDay, useScheduleClock } from "../../lib/scheduleClock";
import { toast } from "../../lib/toastStore";
import type { ExamInput, ExamPlan } from "../../lib/types";

export interface ExamsState {
  plans: ExamPlan[];
  loaded: boolean;
  reload: () => Promise<void>;
  save: (input: ExamInput) => Promise<boolean>;
  remove: (id: number) => Promise<void>;
}

export function useExams(): ExamsState {
  // Follow the clock's day, not a poll: a countdown that says "14 days" must not still say 14
  // tomorrow morning.
  const clockDay = useScheduleClock((s) => s.day);
  const [plans, setPlans] = useState<ExamPlan[]>([]);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    if (!isTauri()) {
      setLoaded(true);
      return;
    }
    try {
      setPlans(await ipc.examPlans(localDay()));
    } catch {
      /* keep prior plans — a failed read must not blank the card */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, clockDay]);

  const save = useCallback(
    async (input: ExamInput) => {
      if (!isTauri()) return false;
      try {
        await ipc.upsertExam(input);
        await reload();
        return true;
      } catch {
        toast({
          tone: "warning",
          title: "Couldn't save that exam",
          body: "Check the date and name.",
          key: "exam-save-failed",
        });
        return false;
      }
    },
    [reload],
  );

  const remove = useCallback(
    async (id: number) => {
      if (!isTauri()) return;
      setPlans((cur) => cur.filter((p) => p.exam.id !== id));
      try {
        await ipc.deleteExam(id);
      } finally {
        await reload();
      }
    },
    [reload],
  );

  return useMemo(() => ({ plans, loaded, reload, save, remove }), [plans, loaded, reload, save, remove]);
}
