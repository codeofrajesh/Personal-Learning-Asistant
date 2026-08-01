/**
 * useTemplates — routine ("my normal weekday") state for the Today surface.
 *
 * Kept out of `useDayPlan` on purpose: routines are edited rarely and read on almost every empty
 * day, so folding them into the day payload would refetch a template list on every block edit.
 * This hook loads lazily — nothing fetches until something actually needs to show a routine.
 *
 * The suggestion is weekday-matched LOCALLY (`localWeekday()`), never with SQLite's
 * `strftime('%w')`: that is UTC, so planning at 22:00 would offer tomorrow's routine.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ipc, isTauri } from "../../lib/ipc";
import { bumpPlanRevision } from "../../lib/planRevision";
import { toast } from "../../lib/toastStore";
import type { PlanTemplate, PlanTemplateBlock, TemplateBlockInput, TemplateInput } from "../../lib/types";

/** 0 = Sunday, matching `Date.getDay()` and the backend's bit numbering. */
export function localWeekday(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).getDay();
}

export const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Human summary of a weekday mask: "Mon–Fri", "Every day", "Sat, Sun". */
export function dowLabel(mask: number): string {
  const bits = (mask & 0x7f) >>> 0;
  if (bits === 0x7f) return "Every day";
  if (bits === 0b0111110) return "Mon–Fri";
  if (bits === 0b1000001) return "Weekends";
  const on = DOW_LABELS.filter((_, i) => (bits & (1 << i)) !== 0);
  return on.length === 0 ? "No days" : on.join(", ");
}

export interface TemplatesState {
  templates: PlanTemplate[];
  loaded: boolean;
  /** The routine matching the given day's weekday, if any. */
  suggestionFor: (day: string) => PlanTemplate | null;
  reload: () => Promise<void>;
  blocksFor: (templateId: number) => Promise<PlanTemplateBlock[]>;
  apply: (templateId: number, day: string) => Promise<number>;
  saveDay: (day: string, name: string, dowMask: number) => Promise<boolean>;
  saveTemplate: (input: TemplateInput) => Promise<void>;
  removeTemplate: (id: number) => Promise<void>;
  saveBlock: (input: TemplateBlockInput) => Promise<void>;
  removeBlock: (id: number) => Promise<void>;
}

export function useTemplates(): TemplatesState {
  const [templates, setTemplates] = useState<PlanTemplate[]>([]);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    if (!isTauri()) {
      setLoaded(true);
      return;
    }
    try {
      setTemplates(await ipc.listPlanTemplates());
    } catch {
      /* keep prior list */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Matched client-side from the already-loaded list rather than through
  // `suggested_plan_template`: the data is here, and a round-trip per day navigation to learn
  // something we can compute from a bitmask is a round-trip for nothing.
  const suggestionFor = useCallback(
    (day: string): PlanTemplate | null => {
      const wd = localWeekday(day);
      return (
        templates.find((t) => t.is_active && t.block_count > 0 && (t.dow_mask & (1 << wd)) !== 0) ??
        null
      );
    },
    [templates],
  );

  const blocksFor = useCallback(async (templateId: number) => {
    if (!isTauri()) return [];
    try {
      return await ipc.planTemplateBlocks(templateId);
    } catch {
      return [];
    }
  }, []);

  const apply = useCallback(async (templateId: number, day: string) => {
    if (!isTauri()) return 0;
    try {
      const n = await ipc.applyPlanTemplate(templateId, day);
      // New blocks mean new start times, so the reminder ladder must re-arm.
      bumpPlanRevision();
      if (n === 0) {
        toast({
          tone: "info",
          title: "Already there",
          body: "That routine's blocks are already on this day.",
          key: "routine-noop",
        });
      }
      return n;
    } catch {
      toast({ tone: "warning", title: "Couldn't apply that routine", key: "routine-apply-failed" });
      return 0;
    }
  }, []);

  const saveDay = useCallback(
    async (day: string, name: string, dowMask: number) => {
      if (!isTauri()) return false;
      try {
        await ipc.saveDayAsTemplate(day, name, dowMask);
        await reload();
        return true;
      } catch {
        // The backend refuses to save an empty day rather than leave a routine that silently
        // does nothing when applied.
        toast({
          tone: "warning",
          title: "Nothing to save",
          body: "Add at least one block to this day first.",
          key: "routine-save-empty",
        });
        return false;
      }
    },
    [reload],
  );

  const saveTemplate = useCallback(
    async (input: TemplateInput) => {
      if (!isTauri()) return;
      try {
        await ipc.upsertPlanTemplate(input);
      } finally {
        await reload();
      }
    },
    [reload],
  );

  const removeTemplate = useCallback(
    async (id: number) => {
      if (!isTauri()) return;
      setTemplates((cur) => cur.filter((t) => t.id !== id));
      try {
        await ipc.deletePlanTemplate(id);
      } finally {
        await reload();
      }
    },
    [reload],
  );

  const saveBlock = useCallback(
    async (input: TemplateBlockInput) => {
      if (!isTauri()) return;
      try {
        await ipc.upsertPlanTemplateBlock(input);
      } finally {
        // Counts and totals live on the parent row, so the list needs refreshing too.
        await reload();
      }
    },
    [reload],
  );

  const removeBlock = useCallback(
    async (id: number) => {
      if (!isTauri()) return;
      try {
        await ipc.deletePlanTemplateBlock(id);
      } finally {
        await reload();
      }
    },
    [reload],
  );

  return useMemo(
    () => ({
      templates,
      loaded,
      suggestionFor,
      reload,
      blocksFor,
      apply,
      saveDay,
      saveTemplate,
      removeTemplate,
      saveBlock,
      removeBlock,
    }),
    [
      templates,
      loaded,
      suggestionFor,
      reload,
      blocksFor,
      apply,
      saveDay,
      saveTemplate,
      removeTemplate,
      saveBlock,
      removeBlock,
    ],
  );
}
