/**
 * CourseCard — one subject in the Courses "All Courses" grid (image fav.png).
 *
 * A thumbnail cover (the subject's random video thumbnail, or a lime-tinted gradient
 * placeholder with the subject's icon when no thumbnail exists), the course title, a
 * chapter/lesson tally, a slim completion bar, and a "View Details" affordance. The
 * whole card routes to the Course detail page.
 *
 * Memoized — the grid re-renders when the goal pill switches, and identical cards
 * shouldn't re-render when a sibling's data changes.
 */

import { memo } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import type { SubjectSummary } from "../../lib/types";
import CoverArt from "../ui/CoverArt";

interface CourseCardProps {
  subject: SubjectSummary;
  /** Parent goal name, shown as a quiet caption (the reference's "BY …" line). */
  goalName?: string;
}

function CourseCardView({ subject, goalName }: CourseCardProps) {
  const {
    id,
    name,
    icon,
    chapter_count,
    material_count,
    completed_count,
    thumbnail_path,
  } = subject;
  const pct =
    material_count > 0 ? Math.round((completed_count / material_count) * 100) : 0;

  return (
    <Link
      to={`/courses/${id}`}
      className="course-card group flex flex-col overflow-hidden rounded-card border border-white/[0.05] bg-white/[0.02] shadow-2xl backdrop-blur-md transition-all duration-200 hover:scale-[1.02] hover:border-white/10 hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
    >
      {/* Cover — extracted thumbnail, else a deterministic brand gradient (never empty). */}
      <div className="relative aspect-video w-full overflow-hidden">
        <CoverArt
          thumbnailPath={thumbnail_path}
          seed={id}
          glyph={icon || "📚"}
          className="h-full w-full transition-transform duration-500 ease-smooth group-hover:scale-105"
        />
        {/* Completion badge over the cover */}
        <div className="absolute bottom-2 left-2 z-10 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-medium text-content-primary backdrop-blur-sm">
          {pct}% done
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col p-4">
        <h3 className="line-clamp-2 font-semibold text-content-primary" title={name}>
          {name}
        </h3>
        <p className="mt-1 text-xs text-content-muted">
          {chapter_count} chapter{chapter_count === 1 ? "" : "s"} · {material_count} lesson
          {material_count === 1 ? "" : "s"}
        </p>
        {goalName && (
          <p className="mt-0.5 truncate text-xs text-content-faint">{goalName}</p>
        )}

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

        <div className="mt-3 flex items-center justify-between">
          <span className="text-xs font-medium text-content-secondary">View Details</span>
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

export default memo(CourseCardView);
