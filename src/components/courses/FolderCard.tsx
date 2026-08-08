/**
 * FolderCard — one child folder node in the unified tree browser grid (Section 11,
 * Phase 5). The v6 analogue of CourseCard, but for an arbitrary-depth `NodeCard`
 * instead of a fixed Subject.
 *
 * A thumbnail cover (a random video thumbnail from the node's subtree, else a
 * deterministic brand gradient with the node's icon), the folder name, a sub-folder /
 * material tally, and a slim completion bar. Clicking drills into the node
 * (`/courses/:id`). Memoized so unaffected siblings don't re-render on a drill.
 */

import { memo } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, FolderOpen, Trash2 } from "lucide-react";
import type { NodeCard as NodeCardData } from "../../lib/types";
import CoverArt from "../ui/CoverArt";
import PinButton from "./PinButton";

function FolderCardView({
  node,
  pinned,
  onTogglePin,
  onDelete,
}: {
  node: NodeCardData;
  /** Current pinned state (parent-controlled for optimistic toggles). Omit to hide the pin. */
  pinned?: boolean;
  /** When provided, renders the hub Pin overlay wired to this handler. */
  onTogglePin?: () => void;
  /** When provided, renders a hover-revealed delete button. The click is stopped from
   *  bubbling so deleting never drills into the card's Link. */
  onDelete?: () => void;
}) {
  const {
    id,
    name,
    icon,
    child_count,
    material_count,
    completed_count,
    thumbnail_path,
  } = node;
  const pct =
    material_count > 0 ? Math.round((completed_count / material_count) * 100) : 0;
  const showPin = onTogglePin != null;
  const showDelete = onDelete != null;

  return (
    <Link
      to={`/courses/${id}`}
      className="course-card perf-card group relative flex flex-col overflow-hidden rounded-card border border-white/[0.05] bg-white/[0.02] shadow-2xl backdrop-blur-md transition-[transform,border-color,background-color] duration-200 hover:scale-[1.02] hover:border-white/10 hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
    >
      <div className="relative aspect-video w-full overflow-hidden">
        <CoverArt
          thumbnailPath={thumbnail_path}
          seed={id}
          glyph={icon || "📁"}
          className="h-full w-full transition-transform duration-500 ease-smooth group-hover:scale-105"
        />
        {material_count > 0 && (
          <div className="absolute bottom-2 left-2 z-10 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-medium text-content-primary backdrop-blur-sm">
            {pct}% done
          </div>
        )}
        {showPin && (
          <PinButton
            pinned={pinned ?? false}
            onToggle={onTogglePin}
            className="absolute right-2 top-2 z-10"
          />
        )}
        {showDelete && (
          <button
            type="button"
            onClick={(e) => {
              // CRITICAL: don't let the trash click drill into the card's Link.
              e.preventDefault();
              e.stopPropagation();
              onDelete();
            }}
            aria-label={`Delete folder: ${name}`}
            title="Delete folder"
            className="absolute right-2 top-2 z-10 grid h-9 w-9 place-items-center rounded-btn border border-white/10 bg-black/40 text-white/60 opacity-0 backdrop-blur-sm transition-all duration-200 hover:border-orange/40 hover:bg-orange/20 hover:text-orange focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange/40 group-hover:opacity-100"
            style={showPin ? { right: "3.25rem" } : undefined}
          >
            <Trash2 size={16} strokeWidth={2} aria-hidden />
          </button>
        )}
      </div>

      <div className="flex flex-1 flex-col p-4">
        <h3 className="line-clamp-2 font-semibold text-content-primary" title={name}>
          {name}
        </h3>
        <p className="mt-1 text-xs text-content-muted">
          {child_count > 0 && (
            <>
              {child_count} folder{child_count === 1 ? "" : "s"}
              {material_count > 0 ? " · " : ""}
            </>
          )}
          {material_count > 0 && (
            <>
              {material_count} file{material_count === 1 ? "" : "s"}
            </>
          )}
          {child_count === 0 && material_count === 0 && "Empty"}
        </p>

        {material_count > 0 && (
          <div
            className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${name} completion`}
          >
            <div
              className="h-full rounded-full bg-lime transition-[width] duration-500 ease-smooth"
              style={{ width: `${pct}%` }}
            />
          </div>
        )}

        <div className="mt-3 flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-xs font-medium text-content-secondary">
            <FolderOpen size={13} strokeWidth={2} className="text-content-faint" aria-hidden />
            Open
          </span>
          <ChevronRight
            size={16}
            strokeWidth={2.25}
            aria-hidden
            className="text-lime transition-transform duration-200 group-hover:translate-x-0.5"
          />
        </div>
      </div>
    </Link>
  );
}

export default memo(FolderCardView);
