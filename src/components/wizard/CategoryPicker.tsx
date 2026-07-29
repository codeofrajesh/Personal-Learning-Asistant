/**
 * Category picker — the wizard's form step (Step 1 of the Courses re-architecture).
 *
 * "What does this folder contain?" The picked folder maps to one Subject under a
 * Goal, its sub-folders to Chapters, the files inside them to materials.
 *
 * Two custom combo-boxes (ComboSelect) replace the old plain text inputs:
 *   - Goal:    pick an existing goal (from `ipc.listLibrary`) or "Create new…".
 *   - Subject: pick an existing subject under the selected goal (from
 *              `ipc.goalView`) or "Create new…". Gated on a goal being chosen.
 *
 * The parent wizard still owns two strings (goalName / subjectName) and feeds them
 * straight to `scan_and_import`, whose backend upserts by name — so the combo-boxes
 * stay name-based and the wizard contract is unchanged.
 *
 * Form conventions (design-taste-frontend / ui-ux-pro-max): label ABOVE control, real
 * focus rings (ring-lime/25), WCAG-AA contrast on labels/values/options/helper text,
 * no placeholder-as-label, helper text present. Outside the Tauri shell the combo-boxes
 * degrade to plain controlled inputs (browser-preview fallback).
 */

import { useEffect, useMemo, useState } from "react";
import ComboSelect, { type ComboOption } from "./ComboSelect";
import { ipc, isTauri } from "../../lib/ipc";
import type { GoalSummary, SubjectSummary } from "../../lib/types";

interface CategoryPickerProps {
  goalName: string;
  subjectName: string;
  onGoalChange: (v: string) => void;
  onSubjectChange: (v: string) => void;
  disabled?: boolean;
  /** Render the Goal combo (default true). The stepper shows Goal + Subject separately. */
  showGoal?: boolean;
  /** Render the Subject combo (default true). */
  showSubject?: boolean;
}

export default function CategoryPicker({
  goalName,
  subjectName,
  onGoalChange,
  onSubjectChange,
  disabled = false,
  showGoal = true,
  showSubject = true,
}: CategoryPickerProps) {
  const inApp = isTauri();
  const [goals, setGoals] = useState<GoalSummary[]>([]);
  const [subjects, setSubjects] = useState<SubjectSummary[]>([]);
  const [subjectsLoading, setSubjectsLoading] = useState(false);

  // Load every goal once on mount (backs the Goal combo). Failures leave the list
  // empty — the combo still works via "Create new…".
  useEffect(() => {
    if (!inApp) return;
    let cancelled = false;
    ipc
      .listLibrary()
      .then((g) => {
        if (!cancelled) setGoals(g);
      })
      .catch(() => {
        /* empty list is fine — Create new still works */
      });
    return () => {
      cancelled = true;
    };
  }, [inApp]);

  // Resolve the selected goal's id from its name (combo-boxes are name-based).
  const selectedGoalId = useMemo(() => {
    const g = goals.find((x) => x.name === goalName);
    return g?.id ?? null;
  }, [goals, goalName]);

  // Load the selected goal's subjects whenever the goal changes.
  useEffect(() => {
    if (!inApp || selectedGoalId == null) {
      setSubjects([]);
      setSubjectsLoading(false);
      return;
    }
    let cancelled = false;
    setSubjectsLoading(true);
    ipc
      .goalView(selectedGoalId)
      .then((view) => {
        if (!cancelled) {
          setSubjects(view.subjects);
          setSubjectsLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSubjects([]);
          setSubjectsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [inApp, selectedGoalId]);

  const goalOptions: ComboOption[] = useMemo(
    () => goals.map((g) => ({ id: g.id, name: g.name })),
    [goals],
  );
  const subjectOptions: ComboOption[] = useMemo(
    () => subjects.map((s) => ({ id: s.id, name: s.name })),
    [subjects],
  );

  // Subject combo is gated on a goal being selected (only inside the app, where the
  // gating data exists — in browser preview both fields are plain inputs).
  const subjectDisabled = disabled || (inApp && selectedGoalId == null);

  return (
    <div className="space-y-4">
      {showGoal && showSubject && (
        <div className="rounded-card border border-glass-border bg-white/[0.02] px-3.5 py-2.5 text-xs text-content-secondary">
          This folder becomes a <span className="text-content-primary">Subject</span>.
          Its sub-folders become{" "}
          <span className="text-content-primary">Chapters</span>, and the files inside
          them become your materials.
        </div>
      )}

      {showGoal && (
        <ComboSelect
          id="wizard-goal"
          label="Goal"
          value={goalName}
          onChange={onGoalChange}
          options={goalOptions}
          disabled={disabled}
          forceTextFallback={!inApp}
          placeholder="Pick a goal…"
          createNewPlaceholder="e.g. Become a Full-Stack Developer"
          helperText="Reused if a goal with this name already exists."
          emptyHint="No goals yet — create your first one."
        />
      )}

      {showSubject && (
        <ComboSelect
          id="wizard-subject"
          label="Subject"
          value={subjectName}
          onChange={onSubjectChange}
          options={subjectOptions}
          loading={subjectsLoading}
          disabled={subjectDisabled}
          forceTextFallback={!inApp}
          placeholder={subjectDisabled ? "Pick a goal first…" : "Pick a subject…"}
          createNewPlaceholder="e.g. React Fundamentals"
          helperText={
            subjectDisabled
              ? "Choose a goal above to see its subjects, or create a new one."
              : "Pre-filled from the folder name. Edit it if you like."
          }
          emptyHint="No subjects in this goal yet — create a new one."
        />
      )}
    </div>
  );
}
