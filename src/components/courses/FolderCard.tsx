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
import { ChevronRight, FolderOpen } from "lucide-react";
import type { NodeCard as NodeCardData } from "../../lib/types";
import CoverArt from "../ui/CoverArt";

function FolderCardView({ node }: { node: NodeCardData }) {
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

  return (
    <Link
      to={`/courses/${id}`}
      className="course-card group flex flex-col overflow-hidden rounded-card border border-white/[0.05] bg-white/[0.02] shadow-2xl backdrop-blur-md transition-all duration-200 hover:scale-[1.02] hover:border-white/10 hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
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
