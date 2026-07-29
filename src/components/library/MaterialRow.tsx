/**
 * Material row for the Chapter page (Section 8, Page 5 — the leaf).
 *
 * Shows the file's type glyph, name, size + duration, a progress bar, and bookmark /
 * completed badges. Links into the Player page (`/library/material/:id`), where the
 * Video / PDF / Image / Audio viewer opens it.
 */

import { memo } from "react";
import { Link } from "react-router-dom";
import { BookmarkIcon, CheckCircleIcon } from "../ui/icons";
import { formatBytes, formatDuration } from "../../lib/utils";
import type { MaterialRow as MaterialRowData } from "../../lib/types";

const TYPE_GLYPH: Record<string, string> = {
  video: "🎬",
  pdf: "📄",
  note: "📝",
  image: "🖼️",
  audio: "🎧",
};

function MaterialRowView({ material }: { material: MaterialRowData }) {
  const {
    id,
    file_name,
    file_type,
    file_size_bytes,
    duration_secs,
    progress_pct,
    is_bookmarked,
    is_completed,
    status,
  } = material;
  const pct = Math.max(0, Math.min(100, progress_pct));
  const missing = status === "missing";

  // A missing file can't be opened — render a dimmed, non-linking row with a badge
  // (Section 3: show ⚠️ "File not found", don't hard-delete).
  if (missing) {
    return (
      <div className="glass flex items-center gap-4 rounded-card px-card py-3.5 opacity-60">
        <span
          aria-hidden="true"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-btn bg-white/[0.05] text-lg"
        >
          {TYPE_GLYPH[file_type] ?? "📁"}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-content-secondary" title={file_name}>
            {file_name}
          </p>
          <p className="mt-0.5 text-xs text-content-faint">file not found on disk</p>
        </div>
        <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-orange">
          ⚠ Missing
        </span>
      </div>
    );
  }

  return (
    <Link
      to={`/library/material/${id}`}
      className="glass group flex items-center gap-4 rounded-card px-card py-3.5 shadow-card transition-all hover:scale-[1.01] hover:shadow-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/40"
    >
      <span
        aria-hidden="true"
        className="grid h-11 w-11 shrink-0 place-items-center rounded-btn bg-white/[0.05] text-lg"
      >
        {TYPE_GLYPH[file_type] ?? "📁"}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium text-content-primary" title={file_name}>
            {file_name}
          </p>
          {is_bookmarked && (
            <BookmarkIcon width={14} height={14} className="shrink-0 text-lime" aria-label="Bookmarked" />
          )}
        </div>
        <p className="mt-0.5 text-xs text-content-muted">
          <span className="uppercase tracking-wide">{file_type}</span>
          {" · "}
          {formatBytes(file_size_bytes)}
          {file_type === "video" && ` · ${formatDuration(duration_secs)}`}
        </p>
        {pct > 0 && !is_completed && (
          <div className="mt-2 h-1 w-full max-w-xs overflow-hidden rounded-full bg-white/[0.06]">
            <div className="h-full rounded-full bg-lime" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>

      {is_completed ? (
        <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-lime">
          <CheckCircleIcon width={16} height={16} />
          Done
        </span>
      ) : (
        <span className="shrink-0 text-sm text-content-faint transition-colors group-hover:text-content-secondary">
          Open →
        </span>
      )}
    </Link>
  );
}

export default memo(MaterialRowView);
