/**
 * AddFolderModal — the single, global "Add a folder" flow (mounted once in AppShell,
 * driven by `useMaterialManager`). Replaces the three separately-mounted
 * AddFolderWizard instances.
 *
 * Unlike the old wizard (which auto-opened the native picker on mount), this is a
 * deliberate, Goal-first stepper with a visible progress rail:
 *
 *   Step 1 · Folder   — a clear "Browse…" button (native picker); shows the picked path.
 *   Step 2 · Goal      — assign the folder to a Goal (existing or new). This is the one
 *                        categorization level not derived from disk, so it comes first.
 *   Step 3 · Subject   — editable Subject name (defaulted from the folder) beside a live
 *                        preview of the detected Chapter mapping + file-type tally.
 *   Step 4 · Review    — summary, then Import (progress via `scan://progress`).
 *   Done / Error       — success summary or a retry path.
 *
 * Categorization model (single-level, per product decision): the picked folder = one
 * Subject under the chosen Goal; each top-level sub-folder = one Chapter; files = the
 * materials. Backend upserts by name, so Goal/Subject names are all this flow sends.
 *
 * Degrades cleanly outside the Tauri shell (Browse shows an explanatory error).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderOpen, Check, ChevronLeft } from "lucide-react";
import Modal from "../ui/Modal";
import CategoryPicker from "./CategoryPicker";
import FolderPreview from "./FolderPreview";
import { useMaterialManager } from "../../lib/materialManagerStore";
import { ipc, isTauri, pickFolder, onScanProgress } from "../../lib/ipc";
import { cn } from "../../lib/utils";
import type {
  FolderPreview as FolderPreviewDTO,
  ImportResult,
  ScanProgress,
} from "../../lib/types";

type Step = "folder" | "goal" | "subject" | "review" | "scanning" | "done" | "error";

const STEPS: { id: Step; label: string }[] = [
  { id: "folder", label: "Folder" },
  { id: "goal", label: "Goal" },
  { id: "subject", label: "Subject" },
  { id: "review", label: "Review" },
];

const btnPrimary =
  "rounded-btn bg-lime px-4 py-2 text-sm font-semibold text-ink-900 shadow-glow-lime transition-transform hover:scale-[1.02] disabled:pointer-events-none disabled:opacity-50";
const btnGhost =
  "rounded-btn border border-glass-border px-4 py-2 text-sm text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content-primary";

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

export default function AddFolderModal() {
  const open = useMaterialManager((s) => s.addFolderOpen);
  const close = useMaterialManager((s) => s.closeAddFolder);
  const notifyImported = useMaterialManager((s) => s.notifyImported);

  const [step, setStep] = useState<Step>("folder");
  const [path, setPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<FolderPreviewDTO | null>(null);
  const [goalName, setGoalName] = useState("");
  const [subjectName, setSubjectName] = useState("");
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string>("");

  // Reset everything each time the modal opens.
  useEffect(() => {
    if (!open) return;
    setStep("folder");
    setPath(null);
    setPreview(null);
    setGoalName("");
    setSubjectName("");
    setProgress(null);
    setResult(null);
    setError("");
  }, [open]);

  const browse = useCallback(async () => {
    if (!isTauri()) {
      setError("Folder registration is only available inside the desktop app.");
      setStep("error");
      return;
    }
    try {
      const folder = await pickFolder();
      if (!folder) return; // cancelled — stay on the Folder step
      setPath(folder);
      // Read the folder preview in the background; seed the subject name from it.
      const p = await ipc.previewFolder(folder);
      setPreview(p);
      setSubjectName((s) => s || p.suggested_subject);
      setStep("goal");
    } catch (err) {
      setError(errMsg(err));
      setStep("error");
    }
  }, []);

  const runImport = useCallback(async () => {
    if (!path) return;
    setStep("scanning");
    setProgress(null);
    const unlisten = await onScanProgress((p) => setProgress(p));
    try {
      const res = await ipc.scanAndImport({
        path,
        goal_name: goalName.trim(),
        subject_name: subjectName.trim(),
      });
      setResult(res);
      setStep("done");
      notifyImported(res);
    } catch (err) {
      setError(errMsg(err));
      setStep("error");
    } finally {
      unlisten();
    }
  }, [path, goalName, subjectName, notifyImported]);

  const activeStepIndex = STEPS.findIndex((s) => s.id === step);
  const showRail = activeStepIndex >= 0; // folder/goal/subject/review

  const canContinue = useMemo(() => {
    switch (step) {
      case "folder":
        return path != null;
      case "goal":
        return goalName.trim().length > 0;
      case "subject":
        return subjectName.trim().length > 0 && (preview?.total_files ?? 0) > 0;
      case "review":
        return goalName.trim().length > 0 && subjectName.trim().length > 0 && (preview?.total_files ?? 0) > 0;
      default:
        return false;
    }
  }, [step, path, goalName, subjectName, preview]);

  const goBack = () => {
    if (step === "goal") setStep("folder");
    else if (step === "subject") setStep("goal");
    else if (step === "review") setStep("subject");
  };
  const goNext = () => {
    if (step === "folder") setStep("goal");
    else if (step === "goal") setStep("subject");
    else if (step === "subject") setStep("review");
    else if (step === "review") void runImport();
  };

  // ── Footer ──
  let footer: React.ReactNode = null;
  if (showRail) {
    footer = (
      <>
        {step !== "folder" ? (
          <button type="button" className={btnGhost} onClick={goBack}>
            <ChevronLeft size={15} strokeWidth={2} className="mr-1 inline align-[-2px]" aria-hidden />
            Back
          </button>
        ) : (
          <button type="button" className={btnGhost} onClick={close}>
            Cancel
          </button>
        )}
        <button type="button" className={btnPrimary} disabled={!canContinue} onClick={goNext}>
          {step === "review" ? "Scan & Import" : "Continue"}
        </button>
      </>
    );
  } else if (step === "done") {
    footer = (
      <button type="button" className={btnPrimary} onClick={close}>
        Done
      </button>
    );
  } else if (step === "error") {
    footer = (
      <>
        <button type="button" className={btnGhost} onClick={close}>
          Close
        </button>
        <button type="button" className={btnPrimary} onClick={() => setStep("folder")}>
          Start over
        </button>
      </>
    );
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Add a folder"
      subtitle={path ?? "Choose a folder of learning material"}
      footer={footer}
    >
      {/* Progress rail */}
      {showRail && (
        <ol className="mb-5 flex items-center gap-2" aria-label="Progress">
          {STEPS.map((s, i) => {
            const state = i < activeStepIndex ? "done" : i === activeStepIndex ? "current" : "todo";
            return (
              <li key={s.id} className="flex flex-1 items-center gap-2">
                <span
                  className={cn(
                    "grid h-6 w-6 shrink-0 place-items-center rounded-full border text-[0.7rem] font-semibold transition-colors",
                    state === "done" && "border-lime bg-lime text-ink-900",
                    state === "current" && "border-lime text-lime",
                    state === "todo" && "border-white/15 text-white/40",
                  )}
                  aria-current={state === "current" ? "step" : undefined}
                >
                  {state === "done" ? <Check size={13} strokeWidth={3} aria-hidden /> : i + 1}
                </span>
                <span className={cn("text-xs font-medium", state === "todo" ? "text-white/40" : "text-content-secondary")}>{s.label}</span>
                {i < STEPS.length - 1 && <span className={cn("mx-1 h-px flex-1", i < activeStepIndex ? "bg-lime/50" : "bg-white/10")} aria-hidden />}
              </li>
            );
          })}
        </ol>
      )}

      {/* Step body */}
      {step === "folder" && (
        <div className="py-4 text-center">
          <button
            type="button"
            onClick={() => void browse()}
            className="mx-auto flex flex-col items-center gap-3 rounded-[20px] border border-dashed border-white/15 bg-white/[0.02] px-10 py-8 text-content-secondary transition-colors hover:border-lime/40 hover:bg-white/[0.04] hover:text-content-primary"
          >
            <FolderOpen size={32} strokeWidth={1.5} className="text-lime" aria-hidden />
            <span className="text-sm font-medium">{path ? "Choose a different folder" : "Browse for a folder…"}</span>
          </button>
          {path && <p className="mt-4 truncate text-xs text-content-muted" title={path}>{path}</p>}
          <p className="mx-auto mt-4 max-w-sm text-xs text-content-faint">
            Pick a folder of videos and documents. It becomes a Subject; its sub-folders become Chapters.
          </p>
        </div>
      )}

      {step === "goal" && (
        <div className="space-y-4">
          <div className="rounded-card border border-glass-border bg-white/[0.02] px-3.5 py-2.5 text-xs text-content-secondary">
            Assign this folder to a <span className="text-content-primary">Goal</span> — pick an existing one or create a new one.
          </div>
          <CategoryPicker
            goalName={goalName}
            subjectName={subjectName}
            onGoalChange={setGoalName}
            onSubjectChange={setSubjectName}
            showSubject={false}
          />
        </div>
      )}

      {step === "subject" && preview && (
        <div className="grid gap-6 md:grid-cols-2">
          <CategoryPicker
            goalName={goalName}
            subjectName={subjectName}
            onGoalChange={setGoalName}
            onSubjectChange={setSubjectName}
            showGoal={false}
          />
          <FolderPreview preview={preview} />
        </div>
      )}

      {step === "review" && preview && (
        <div className="space-y-4">
          <div className="rounded-card border border-glass-border bg-white/[0.02] p-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-content-muted">Goal</dt>
              <dd className="truncate font-medium text-content-primary">{goalName}</dd>
              <dt className="text-content-muted">Subject</dt>
              <dd className="truncate font-medium text-content-primary">{subjectName}</dd>
              <dt className="text-content-muted">Files</dt>
              <dd className="font-medium text-lime">{preview.total_files}</dd>
              <dt className="text-content-muted">Chapters</dt>
              <dd className="font-medium text-lime">{preview.chapters.length}</dd>
            </dl>
          </div>
          <FolderPreview preview={preview} />
        </div>
      )}

      {step === "scanning" && <ScanningView progress={progress} />}

      {step === "done" && result && (
        <div className="py-4 text-center">
          <div className="mb-2 text-4xl" aria-hidden>✅</div>
          <p className="text-content-primary">
            Imported <span className="font-semibold text-lime">{result.materials_imported}</span> file
            {result.materials_imported === 1 ? "" : "s"} across{" "}
            <span className="font-semibold text-lime">{result.chapters_created}</span> chapter
            {result.chapters_created === 1 ? "" : "s"}.
          </p>
          <p className="mt-2 text-xs text-content-faint">Thumbnails are generating in the background.</p>
        </div>
      )}

      {step === "error" && (
        <div className="rounded-card border border-orange/30 bg-orange/[0.06] p-4 text-sm text-orange">{error}</div>
      )}
    </Modal>
  );
}

function ScanningView({ progress }: { progress: ScanProgress | null }) {
  const total = progress?.files_total ?? 0;
  const done = progress?.files_imported ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;
  const stage = progress?.stage ?? "Starting…";
  const label = stage === "walking" ? "Scanning files…" : stage === "done" ? "Finishing…" : stage;

  return (
    <div className="py-4">
      <div className="mb-2 flex items-center justify-between text-sm">
        <span className="text-content-secondary">Importing “{label}”</span>
        <span className="text-content-muted">{total > 0 ? `${done} / ${total}` : `${done}`}</span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-white/[0.06]"
        role="progressbar"
        aria-valuenow={pct ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-full bg-lime shadow-glow-lime transition-[width] duration-200 ease-smooth"
          style={{ width: pct != null ? `${pct}%` : "35%" }}
        />
      </div>
    </div>
  );
}
