/**
 * Subject card for the Goal page grid (Section 8, Page 3).
 *
 * Mirrors `GoalCard`: a glass card with the subject's emoji + name, a chapter/material
 * tally, and a slim lime completion bar. The whole card is a `Link` into the Subject
 * page. Memoized since the grid re-renders on refetch.
 */

import { memo } from "react";
import { Link } from "react-router-dom";
import type { SubjectSummary } from "../../lib/types";

function SubjectCardView({ subject }: { subject: SubjectSummary }) {
  const { id, name, icon, chapter_count, material_count, completed_count } = subject;
  const pct =
    material_count > 0 ? Math.round((completed_count / material_count) * 100) : 0;

  return (
    <Link
      to={`/library/subject/${id}`}
      className="glass group flex flex-col rounded-card p-card shadow-card transition-all hover:scale-[1.02] hover:shadow-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/40"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-btn bg-white/[0.04] text-xl"
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold text-content-primary" title={name}>
            {name}
          </h3>
          <p className="mt-0.5 text-xs text-content-muted">
            {chapter_count} chapter{chapter_count === 1 ? "" : "s"} ·{" "}
            {material_count} file{material_count === 1 ? "" : "s"}
          </p>
        </div>
      </div>

      <div className="mt-4">
        <div className="mb-1 flex items-center justify-between text-xs">
          <span className="text-content-faint">Progress</span>
          <span className="font-medium text-content-secondary">{pct}%</span>
        </div>
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${name} completion`}
        >
          <div
            className="h-full rounded-full bg-lime transition-[width] duration-300 ease-smooth"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </Link>
  );
}

export default memo(SubjectCardView);
