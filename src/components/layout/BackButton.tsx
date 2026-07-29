/**
 * BackButton — the app's universal, noticeable back affordance (lucide ArrowLeft).
 *
 * Two routing modes:
 *   - `to` given     → navigates to that explicit destination (the LOGICAL PARENT,
 *                      used by drill-down pages so "back" always lands on the proper
 *                      parent surface rather than wherever the history stack happens
 *                      to point — e.g. Player → its course/chapter, not lesson N-1).
 *   - `to` omitted   → browser-style history back (`navigate(-1)`) when the history
 *                      stack has a previous entry, else `fallbackTo` (default "/").
 *                      Used by the top-level nav pages (Dashboard/Courses/Library/
 *                      Settings) which have no single logical parent.
 *
 * Behaviour guarantees:
 *   - `state` is forwarded when `to` is used, so launch context (courses/library)
 *      survives the trip back.
 *   - In history mode at the root of the stack the button renders DISABLED but still
 *      VISIBLE (greyed, like a browser's back button on a fresh tab) — never removed,
 *      so the layout never jumps.
 *   - `shrink-0` + inline-flex keeps it visible and un-collapsed next to breadcrumbs.
 */

import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { cn } from "../../lib/utils";

interface BackButtonProps {
  /** Explicit destination (logical parent). Omit for history-back mode. */
  to?: string;
  /** Router state forwarded when `to` is used (e.g. { source: "courses" }). */
  state?: unknown;
  /** Where history-back mode lands when there's no previous entry. Default "/". */
  fallbackTo?: string;
  /** Visible label next to the arrow. */
  label?: string;
  className?: string;
}

export default function BackButton({
  to,
  state,
  fallbackTo = "/",
  label = "Back",
  className,
}: BackButtonProps) {
  const navigate = useNavigate();

  // The `history` package (used by HashRouter) stores the stack index in
  // `history.state.idx`; 0 = the entry the app was opened on (nothing to go back to).
  const canGoBack =
    typeof window !== "undefined" &&
    ((window.history.state as { idx?: number } | null)?.idx ?? 0) > 0;

  const historyMode = to == null;
  const disabled = historyMode && !canGoBack;

  const handleClick = () => {
    if (to != null) {
      navigate(to, { state });
      return;
    }
    if (canGoBack) {
      navigate(-1);
      return;
    }
    navigate(fallbackTo);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        "group inline-flex shrink-0 items-center gap-2 rounded-btn border border-white/10 bg-white/[0.03] px-3 py-1.5 text-sm font-medium text-content-secondary transition-colors hover:border-white/20 hover:bg-white/[0.07] hover:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
    >
      <ArrowLeft
        size={15}
        strokeWidth={2.25}
        aria-hidden
        className="transition-transform duration-200 group-hover:-translate-x-0.5"
      />
      <span>{label}</span>
    </button>
  );
}
