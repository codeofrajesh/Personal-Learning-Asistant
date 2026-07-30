/**
 * AddFolderModal — the single, global "Add a folder" flow (mounted once in AppShell,
 * driven by `useMaterialManager`). Replaces the three separately-mounted
 * AddFolderWizard instances.
 *
 * With the v6 infinite-depth tree (Section 11), a picked disk folder is no longer forced
 * into a Goal→Subject→Chapter shape. Instead its whole sub-folder tree is mirrored as
 * nodes to ANY depth, under a destination the user chooses:
 *
 *   Step 1 · Folder        — a clear "Browse…" button (native picker); shows the path.
 *   Step 2 · Destination   — where should this live?
 *                              (a) New goal     → free-text `new_root_name`
 *                              (b) Add into…    → a drill-down node picker → `parent_node_id`
 *   Step 3 · Review        — depth-aware tree preview + depth-cap warning, then Import
 *                            (live progress via `scan://progress`).
 *   Done / Error           — success summary or a retry path.
 *
 * The backend upserts nodes by name and derives the sub-folder tree from disk, so all
 * this flow sends is the destination (a new root name OR an existing parent node id).
 *
 * Degrades cleanly outside the Tauri shell (Browse shows an explanatory error).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderOpen, Check, ChevronLeft, Plus, FolderTree } from "lucide-react";
import Modal from "../ui/Modal";
import FolderPreview from "./FolderPreview";
import NodePicker from "./NodePicker";
import ComboSelect from "./ComboSelect";
import { useMaterialManager } from "../../lib/materialManagerStore";
import { ipc, isTauri, pickFolder, onScanProgress } from "../../lib/ipc";
import { cn } from "../../lib/utils";
import type {
  FolderPreview as FolderPreviewDTO,
  GoalSummary,
  ImportResult,
  NodeCard,
  ScanProgress,
} from "../../lib/types";

type Step = "folder" | "destination" | "review" | "scanning" | "done" | "error";
/** Which destination mode the user picked on the Destination step. */
type DestMode = "new" | "existing";

const STEPS: { id: Step; label: string }[] = [
  { id: "folder", label: "Folder" },
  { id: "destination", label: "Destination" },
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
  const [destMode, setDestMode] = useState<DestMode>("new");
  const [newRootName, setNewRootName] = useState("");
  const [parentNode, setParentNode] = useState<NodeCard | null>(null);
  const [goals, setGoals] = useState<GoalSummary[]>([]);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string>("");

  // Reset everything each time the modal opens.
  useEffect(() => {
    if (!open) return;
    setStep("folder");
    setPath(null);
    setPreview(null);
    setDestMode("new");
    setNewRootName("");
    setParentNode(null);
    setProgress(null);
    setResult(null);
    setError("");
  }, [open]);

  // Load existing goals once (names power the "new goal" reuse hint + combo).
  useEffect(() => {
    if (!open || !isTauri()) return;
    let cancelled = false;
    ipc
      .listLibrary()
      .then((g) => {
        if (!cancelled) setGoals(g);
      })
      .catch(() => {
        /* empty list is fine */
      });
    return () => {
      cancelled = true;
    };
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
      // Read the folder preview in the background; seed a suggested new-goal name.
      const p = await ipc.previewFolder(folder);
      setPreview(p);
      setNewRootName((s) => s || p.suggested_subject);
      setStep("destination");
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
      const res = await ipc.scanAndImport(
        destMode === "existing" && parentNode
          ? { path, parent_node_id: parentNode.id }
          : { path, new_root_name: newRootName.trim() },
      );
      setResult(res);
      setStep("done");
      notifyImported(res);
    } catch (err) {
      setError(errMsg(err));
      setStep("error");
    } finally {
      unlisten();
    }
  }, [path, destMode, parentNode, newRootName, notifyImported]);

  const activeStepIndex = STEPS.findIndex((s) => s.id === step);
  const showRail = activeStepIndex >= 0; // folder/destination/review

  const destinationReady =
    destMode === "new" ? newRootName.trim().length > 0 : parentNode != null;

  const canContinue = useMemo(() => {
    switch (step) {
      case "folder":
        return path != null;
      case "destination":
        return destinationReady;
      case "review":
        return destinationReady && (preview?.total_files ?? 0) > 0;
      default:
        return false;
    }
  }, [step, path, destinationReady, preview]);

  const goBack = () => {
    if (step === "destination") setStep("folder");
    else if (step === "review") setStep("destination");
  };
  const goNext = () => {
    if (step === "folder") setStep("destination");
    else if (step === "destination") setStep("review");
    else if (step === "review") void runImport();
  };

  // A human label for the chosen destination (Review step + summary).
  const destinationLabel =
    destMode === "existing" && parentNode
      ? parentNode.name
      : newRootName.trim() || "—";
  const reusesExistingGoal =
    destMode === "new" && goals.some((g) => g.name === newRootName.trim());

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
            Pick a folder of videos and documents. Its sub-folders (at any depth) are mirrored as a browsable tree.
          </p>
        </div>
      )}

      {step === "destination" && (
        <div className="space-y-4">
          <div className="rounded-card border border-glass-border bg-white/[0.02] px-3.5 py-2.5 text-xs text-content-secondary">
            Where should this folder live?
          </div>

          {/* Destination mode toggle */}
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Destination">
            <DestOption
              active={destMode === "new"}
              onClick={() => setDestMode("new")}
              icon={<Plus size={16} strokeWidth={2.5} aria-hidden />}
              label="New goal"
              hint="Start a fresh top-level goal"
            />
            <DestOption
              active={destMode === "existing"}
              onClick={() => setDestMode("existing")}
              icon={<FolderTree size={16} strokeWidth={2} aria-hidden />}
              label="Add into existing"
              hint="Nest inside a folder you already have"
            />
          </div>

          {destMode === "new" ? (
            <ComboSelect
              id="wizard-new-root"
              label="Goal name"
              value={newRootName}
              onChange={setNewRootName}
              options={goals.map((g) => ({ id: g.id, name: g.name }))}
              forceTextFallback={!isTauri()}
              placeholder="Pick a goal…"
              createNewPlaceholder="e.g. Become a Full-Stack Developer"
              helperText="Reused if a goal with this name already exists."
              emptyHint="No goals yet — create your first one."
            />
          ) : (
            <NodePicker
              selectedId={parentNode?.id ?? null}
              onSelect={setParentNode}
            />
          )}
        </div>
      )}

      {step === "review" && preview && (
        <div className="space-y-4">
          <div className="rounded-card border border-glass-border bg-white/[0.02] p-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-content-muted">Destination</dt>
              <dd className="flex min-w-0 items-center gap-2 truncate font-medium text-content-primary">
                <span className="truncate">{destinationLabel}</span>
                <span className="shrink-0 rounded-full bg-white/[0.06] px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-content-muted">
                  {destMode === "existing"
                    ? "existing folder"
                    : reusesExistingGoal
                      ? "existing goal"
                      : "new goal"}
                </span>
              </dd>
              <dt className="text-content-muted">Files</dt>
              <dd className="font-medium text-lime">{preview.total_files}</dd>
              <dt className="text-content-muted">Folders</dt>
              <dd className="font-medium text-lime">{preview.chapters.length}</dd>
              <dt className="text-content-muted">Max depth</dt>
              <dd className="font-medium text-content-primary">{preview.max_depth}</dd>
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
            <span className="font-semibold text-lime">{result.chapters_created}</span> folder
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

/** A destination-mode radio card (New goal | Add into existing). */
function DestOption({
  active,
  onClick,
  icon,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        "flex flex-col items-start gap-1 rounded-card border px-3.5 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/40",
        active
          ? "border-lime/50 bg-lime/[0.06]"
          : "border-glass-border bg-white/[0.02] hover:bg-white/[0.04]",
      )}
    >
      <span className={cn("flex items-center gap-2 text-sm font-semibold", active ? "text-lime" : "text-content-primary")}>
        {icon}
        {label}
      </span>
      <span className="text-xs text-content-muted">{hint}</span>
    </button>
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
