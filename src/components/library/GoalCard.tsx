/**
 * Goal card for the Library grid.
 *
 * A compact glass card (Section 7 DNA): the goal's emoji + name, a subject/material
 * tally, and a slim completion bar tinted to the goal's accent color. Memoized since
 * the Library re-renders the whole grid on refetch.
 */

import { memo } from "react";
import { Link } from "react-router-dom";
import type { GoalSummary } from "../../lib/types";

function GoalCardView({ goal }: { goal: GoalSummary }) {
  const { id, name, icon, color, subject_count, material_count, completed_count } = goal;
  const pct =
    material_count > 0 ? Math.round((completed_count / material_count) * 100) : 0;

  return (
    <Link
      to={`/library/goal/${id}`}
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
            {subject_count} subject{subject_count === 1 ? "" : "s"} ·{" "}
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
            className="h-full rounded-full transition-[width] duration-300 ease-smooth"
            style={{ width: `${pct}%`, backgroundColor: color || "#AAFF00" }}
          />
        </div>
      </div>
    </Link>
  );
}

export default memo(GoalCardView);
