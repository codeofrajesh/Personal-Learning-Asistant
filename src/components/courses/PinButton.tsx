/**
 * PinButton — the Courses hub "Pin"/favorite toggle (schema v8 `nodes.is_pinned`).
 *
 * Reused on FolderCard (as an overlay on the cover) and on the Explore list rows. It owns
 * NOTHING: the parent passes the current `pinned` state and an async `onToggle`, so the
 * parent can optimistically flip local state (exactly like the bookmark toggle on
 * CoursesPage) without a refetch/re-stagger. Stops click propagation so pinning a card
 * doesn't also drill into it.
 *
 * Motion: color-only transition (scoped, never `transition-all`) so the `data-perf="lite"`
 * kill-switch in index.css fully neutralizes it — zero hover scaling, zero lag.
 */

import { Pin } from "lucide-react";
import { cn } from "../../lib/utils";

export default function PinButton({
  pinned,
  onToggle,
  size = "md",
  className,
}: {
  pinned: boolean;
  onToggle: () => void;
  /** `md` for card overlays, `sm` for dense list rows. */
  size?: "sm" | "md";
  className?: string;
}) {
  const dim = size === "sm" ? "h-8 w-8" : "h-9 w-9";
  const icon = size === "sm" ? 15 : 16;

  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
      aria-label={pinned ? "Unpin from hub" : "Pin to hub"}
      aria-pressed={pinned}
      title={pinned ? "Unpin" : "Pin to hub"}
      className={cn(
        "grid shrink-0 place-items-center rounded-btn border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/40",
        dim,
        pinned
          ? "border-lime/40 bg-lime/15 text-lime hover:bg-lime/25"
          : "border-glass-border bg-black/40 text-white/60 hover:border-white/20 hover:bg-black/60 hover:text-white/90",
        className,
      )}
    >
      <Pin
        size={icon}
        strokeWidth={2}
        fill={pinned ? "currentColor" : "none"}
        aria-hidden
      />
    </button>
  );
}
