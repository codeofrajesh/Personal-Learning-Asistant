/**
 * CourseHubSection — one horizontal section ("swimlane") of the Courses hub.
 *
 * A header row (icon + title + count, and a right-aligned "Explore ›" link when there's
 * more than fits) sits above a CAPPED responsive grid of FolderCards. We deliberately DON'T
 * use a sideways-scrolling swimlane: the UX rules flag horizontal scroll as harmful on
 * small screens, and a wrapping grid is far cheaper on weak GPUs. The row shows up to
 * `cap` cards (default 5, reflowing 2→3→4→5 by breakpoint); the rest live behind Explore.
 *
 * This component renders no motion of its own — the parent hub drives the GSAP entrance
 * (gated on `motionAllowed()`), so this stays a pure layout primitive.
 */

import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import FolderCard from "./FolderCard";
import type { NodeCard } from "../../lib/types";

export default function CourseHubSection({
  title,
  icon: Icon,
  nodes,
  exploreTo,
  cap = 5,
  accent,
  pinnedIds,
  onTogglePin,
}: {
  title: string;
  icon: LucideIcon;
  nodes: NodeCard[];
  /** Route for the "Explore ›" full-list page. */
  exploreTo: string;
  /** Max cards shown inline (default 5). */
  cap?: number;
  /** Optional accent color for the section icon (defaults to lime). */
  accent?: string;
  /** Ids currently pinned (so cards reflect optimistic state from the parent). */
  pinnedIds?: Set<number>;
  onTogglePin?: (node: NodeCard) => void;
}) {
  const shown = nodes.slice(0, cap);
  const hasMore = nodes.length > cap;

  return (
    <section className="hub-section">
      <div className="mb-4 flex items-end justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <span
            className="grid h-8 w-8 place-items-center rounded-btn bg-white/[0.04] text-lime"
            style={accent ? { color: accent } : undefined}
            aria-hidden
          >
            <Icon size={17} strokeWidth={2.25} />
          </span>
          <h2 className="font-display text-lg font-bold text-content-primary">
            {title}
          </h2>
          <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-xs font-medium text-content-muted">
            {nodes.length}
          </span>
        </div>

        {hasMore && (
          <Link
            to={exploreTo}
            className="group inline-flex shrink-0 items-center gap-1 rounded-btn px-2.5 py-1.5 text-sm font-semibold text-lime transition-colors hover:bg-lime/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/40"
          >
            Explore
            <ChevronRight
              size={15}
              strokeWidth={2.5}
              aria-hidden
              className="transition-transform duration-200 group-hover:translate-x-0.5"
            />
          </Link>
        )}
      </div>

      <div className="grid grid-cols-2 gap-gutter lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
        {shown.map((node) => (
          <FolderCard
            key={node.id}
            node={node}
            pinned={pinnedIds?.has(node.id) ?? node.is_pinned}
            onTogglePin={onTogglePin ? () => onTogglePin(node) : undefined}
          />
        ))}
      </div>
    </section>
  );
}
