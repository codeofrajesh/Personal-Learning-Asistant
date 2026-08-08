/**
 * ConfirmDeleteModal — the premium glassmorphism confirmation dialog for the unified
 * deletion flow (folder subtree vs single material).
 *
 * Distinguishes the two targets so the copy is honest:
 *   · `folder`  → a prominent orange warning that the ENTIRE subtree (all subfolders +
 *                 media inside it) goes away.
 *   · `material`→ a calm single-line "remove this lesson" confirmation.
 *
 * Design DNA (Section 7): frosted `.glass` panel over a dimmed, blurred backdrop, danger
 * handled with the brand orange rather than a foreign red. Motion runs through Framer
 * Motion (already a project dependency and used by CoursesPage/ImportHistory) and is
 * gated on `prefers-reduced-motion`, matching the Modal.tsx accessibility contract:
 *   - `role="dialog"` + `aria-modal` + labelled by its title.
 *   - Esc closes; clicking the backdrop closes; focus moves to the dialog on open and
 *     is trapped (Tab cycles Cancel ↔ Delete).
 *   - Focus returns to the trigger on close.
 */

import { useEffect, useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { AlertTriangle, Trash2 } from "lucide-react";
import { cn } from "../../lib/utils";

interface ConfirmDeleteModalProps {
  open: boolean;
  /** `folder` → whole-subtree warning; `material` → single lesson. */
  kind: "folder" | "material";
  /** Name of the thing being deleted (rendered verbatim in the confirmation line). */
  name: string;
  /** Optional secondary line, e.g. "8 files · 3 subfolders". */
  detail?: string;
  /** Show the in-progress state on the confirm button (disables both buttons). */
  isBusy?: boolean;
  /** Backend error string to surface inside the dialog (from the failed delete). */
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function ConfirmDeleteModal({
  open,
  kind,
  name,
  detail,
  isBusy = false,
  error = null,
  onCancel,
  onConfirm,
}: ConfirmDeleteModalProps) {
  const reduce = useReducedMotion();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const titleId = useRef(`confirm-delete-${Math.random().toString(36).slice(2, 8)}`);

  const isFolder = kind === "folder";

  // Entrance focus + restore on close (Modal.tsx contract).
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => previouslyFocused?.focus?.();
  }, [open]);

  // Esc-to-close + a minimal focus trap across the two action buttons.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        if (!isBusy) onCancel();
        return;
      }
      if (e.key === "Tab") {
        const cancel = cancelRef.current;
        const confirm = confirmRef.current;
        if (!cancel || !confirm) return;
        const active = document.activeElement as HTMLElement;
        if (e.shiftKey && active === cancel) {
          e.preventDefault();
          confirm.focus();
        } else if (!e.shiftKey && active === confirm) {
          e.preventDefault();
          cancel.focus();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, isBusy, onCancel]);

  const dur = reduce ? 0 : undefined;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: dur ?? 0.18, ease: "easeOut" }}
          onMouseDown={(e) => {
            // Close only when the backdrop itself (not a child) is pressed.
            if (e.target === e.currentTarget && !isBusy) onCancel();
          }}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId.current}
            tabIndex={-1}
            className="glass w-full max-w-md rounded-panel p-6 shadow-card-hover outline-none"
            initial={{ opacity: 0, scale: 0.96, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 6 }}
            transition={
              reduce
                ? { duration: 0 }
                : { type: "spring", stiffness: 380, damping: 28, mass: 0.9 }
            }
          >
            {/* Header: danger glyph + title */}
            <div className="flex items-start gap-3.5">
              <span
                aria-hidden
                className={cn(
                  "grid h-11 w-11 shrink-0 place-items-center rounded-card",
                  isFolder
                    ? "border border-orange/30 bg-orange/10 text-orange"
                    : "border border-white/10 bg-white/[0.04] text-content-secondary",
                )}
              >
                <Trash2 size={20} strokeWidth={2} />
              </span>
              <div className="min-w-0">
                <h2
                  id={titleId.current}
                  className="font-display text-lg font-bold text-content-primary"
                >
                  {isFolder ? "Delete folder" : "Delete lesson"}
                </h2>
                <p className="mt-0.5 truncate text-sm text-content-muted" title={name}>
                  {name}
                </p>
                {detail && (
                  <p className="mt-0.5 text-xs font-medium text-content-faint">{detail}</p>
                )}
              </div>
            </div>

            {/* Folder warning — the whole subtree goes away */}
            {isFolder && (
              <div className="mt-5 flex items-start gap-2.5 rounded-card border border-orange/25 bg-orange/[0.06] px-3.5 py-3">
                <AlertTriangle
                  size={16}
                  strokeWidth={2.25}
                  aria-hidden
                  className="mt-0.5 shrink-0 text-orange"
                />
                <p className="text-sm leading-relaxed text-orange/95">
                  <span className="font-semibold">Warning:</span> This will delete all
                  subfolders and media inside it.
                </p>
              </div>
            )}

            {/* Material line */}
            {!isFolder && (
              <p className="mt-5 text-sm leading-relaxed text-content-secondary">
                This lesson will be removed from your library. Study history stays on the
                dashboard.
              </p>
            )}

            {/* Backend error (only when a delete actually failed) */}
            {error && (
              <div className="mt-4 rounded-card border border-orange/30 bg-orange/[0.08] px-3.5 py-2.5 text-sm text-orange">
                {error}
              </div>
            )}

            {/* Actions */}
            <div className="mt-6 flex items-center justify-end gap-3">
              <button
                ref={cancelRef}
                type="button"
                onClick={onCancel}
                disabled={isBusy}
                className="inline-flex items-center justify-center gap-2 rounded-btn border border-glass-border px-4 py-2 text-sm font-medium text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 disabled:pointer-events-none disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                ref={confirmRef}
                type="button"
                onClick={onConfirm}
                disabled={isBusy}
                className="inline-flex items-center justify-center gap-2 rounded-btn bg-orange px-4 py-2 text-sm font-semibold text-ink-900 shadow-[0_0_18px_rgba(255,107,53,0.35)] transition-[transform,filter] hover:scale-[1.02] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange/50 disabled:pointer-events-none disabled:opacity-60"
              >
                {isBusy && (
                  <span
                    aria-hidden
                    className="h-4 w-4 animate-spin rounded-full border-2 border-ink-900/30 border-t-ink-900"
                  />
                )}
                {isBusy ? "Deleting…" : "Delete"}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
