/**
 * Chapter card for the Subject page (Section 8, Page 4).
 *
 * A compact glass row: chapter name, material tally + completed count, and a slim lime
 * completion bar. Links into the Chapter page. Memoized.
 */

import { memo } from "react";
import { Link } from "react-router-dom";
import { ChevronRightIcon } from "../ui/icons";
import type { ChapterSummary } from "../../lib/types";

function ChapterCardView({ chapter }: { chapter: ChapterSummary }) {
  const { id, name, material_count, completed_count } = chapter;
  const pct =
    material_count > 0 ? Math.round((completed_count / material_count) * 100) : 0;

  return (
    <Link
      to={`/library/chapter/${id}`}
      className="glass group flex items-center gap-4 rounded-card p-card shadow-card transition-all hover:scale-[1.01] hover:shadow-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/40"
    >
      <span
        aria-hidden="true"
        className="grid h-10 w-10 shrink-0 place-items-center rounded-btn bg-white/[0.04] text-lg"
      >
        📂
      </span>

      <div className="min-w-0 flex-1">
        <h3 className="truncate font-semibold text-content-primary" title={name}>
          {name}
        </h3>
        <p className="mt-0.5 text-xs text-content-muted">
          {material_count} file{material_count === 1 ? "" : "s"}
          {completed_count > 0 && ` · ${completed_count} done`}
        </p>
      </div>

      <div className="hidden w-28 shrink-0 sm:block">
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

      <span className="shrink-0 text-sm font-medium text-content-secondary">{pct}%</span>
      <ChevronRightIcon
        width={18}
        height={18}
        className="shrink-0 text-content-faint transition-colors group-hover:text-content-secondary"
      />
    </Link>
  );
}

export default memo(ChapterCardView);
