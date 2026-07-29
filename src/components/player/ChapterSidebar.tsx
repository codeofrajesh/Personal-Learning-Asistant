/**
 * Chapter sidebar (Section 8 Page 6): the collapsible list of sibling materials in the
 * current chapter. The current material is highlighted with the lime accent; each item
 * shows a mini progress bar and a done badge. Clicking an item navigates to that
 * material's player route (the URL is the source of truth, so back/forward + refresh
 * work). Collapsible via the chevron.
 */

import { memo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRightIcon, CheckCircleIcon } from "../ui/icons";
import type { MaterialRow } from "../../lib/types";
import { cn } from "../../lib/utils";

const TYPE_GLYPH: Record<string, string> = {
  video: "🎬",
  pdf: "📄",
  note: "📝",
  image: "🖼️",
  audio: "🎧",
};

interface Props {
  siblings: MaterialRow[];
  currentId: number;
  chapterName: string;
}

function ChapterSidebarView({ siblings, currentId, chapterName }: Props) {
  const [open, setOpen] = useState(true);

  return (
    <aside className="glass flex w-full flex-col rounded-card p-card shadow-card lg:w-80 lg:shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center justify-between gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/40"
        aria-expanded={open}
      >
        <div className="min-w-0">
          <p className="text-xs text-content-muted">Chapter</p>
          <h2 className="truncate text-sm font-semibold text-content-primary" title={chapterName}>
            {chapterName}
          </h2>
        </div>
        <ChevronRightIcon
          width={18}
          height={18}
          className={cn(
            "shrink-0 text-content-faint transition-transform",
            open && "rotate-90",
          )}
        />
      </button>

      {open && (
        <ul className="mt-3 flex flex-col gap-1 overflow-y-auto">
          {siblings.map((m) => {
            const isCurrent = m.id === currentId;
            const pct = Math.max(0, Math.min(100, m.progress_pct));
            const missing = m.status === "missing";
            const rowClass = cn(
              "flex items-center gap-2.5 rounded-btn px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/40",
              isCurrent ? "bg-lime/10 ring-1 ring-lime/30" : "hover:bg-white/[0.05]",
              missing && "opacity-50",
            );
            const inner = (
              <>
                <span aria-hidden="true" className="shrink-0 text-sm">
                  {TYPE_GLYPH[m.file_type] ?? "📁"}
                </span>
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      "truncate text-xs",
                      isCurrent ? "font-medium text-lime" : "text-content-primary",
                    )}
                    title={m.file_name}
                  >
                    {m.file_name}
                  </p>
                  {pct > 0 && !m.is_completed && (
                    <div className="mt-1 h-0.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
                      <div className="h-full rounded-full bg-lime" style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </div>
                {missing ? (
                  <span className="shrink-0 text-[0.7rem] text-orange">⚠</span>
                ) : (
                  m.is_completed && (
                    <CheckCircleIcon width={14} height={14} className="shrink-0 text-lime" />
                  )
                )}
              </>
            );
            return (
              <li key={m.id}>
                {missing ? (
                  <div className={rowClass} title="File not found on disk">
                    {inner}
                  </div>
                ) : (
                  <Link
                    to={`/library/material/${m.id}`}
                    className={rowClass}
                    aria-current={isCurrent ? "true" : undefined}
                  >
                    {inner}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

export default memo(ChapterSidebarView);
