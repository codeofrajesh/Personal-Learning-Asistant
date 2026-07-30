/**
 * Folder preview pane — the wizard's signature "see the result before you commit"
 * element (Section 2 / Section 11 tree import).
 *
 * Renders the read-only `FolderPreview` DTO from `preview_folder`. With the v6
 * infinite-depth tree, a picked folder no longer maps to a flat Subject→Chapter pair:
 * each sub-folder (at ANY depth) becomes a node. So the preview is a depth-aware,
 * indented folder tree (using `ChapterMapping.depth`) plus a per-type file tally.
 *
 * A depth-cap WARNING (not a block — the DB nests unlimited) shows when the detected
 * `max_depth` exceeds `DEPTH_CAP`: the import still works, we just hint that a very
 * deep tree gets harder to browse.
 *
 * States are handled by the parent (AddFolderModal); this component assumes a
 * resolved preview and focuses on presentation.
 */

import { memo } from "react";
import { AlertTriangle } from "lucide-react";
import type { FolderPreview } from "../../lib/types";

/** Emoji glyph per coarse file type (matches the brand's emoji-icon choice). */
const TYPE_GLYPH: Record<string, string> = {
  video: "🎬",
  pdf: "📄",
  note: "📝",
  image: "🖼️",
  audio: "🎧",
};

/** Nesting depth past which we surface a (non-blocking) "deep tree" warning. Mirrors
 *  the backend model note in Section 11 — the DB itself stays unlimited. */
export const DEPTH_CAP = 6;

/** Indent per depth level (folder root = depth 1 in the mapping, shown flush-left). */
const INDENT_REM = 1.15;

function FolderPreviewView({ preview }: { preview: FolderPreview }) {
  const { chapters, total_files, type_counts, max_depth } = preview;

  if (total_files === 0) {
    return (
      <div className="rounded-card border border-glass-border bg-white/[0.02] p-5 text-center text-sm text-content-muted">
        No supported files found in this folder. Supported types include video, PDF,
        notes, images, and audio.
      </div>
    );
  }

  // The mapping lists folders at their `depth` below the import root (0 = the import
  // root folder itself). We render each indented by its depth so the nesting reads at a
  // glance; the shallowest level (root) sits flush-left.
  const minDepth = chapters.reduce((m, c) => Math.min(m, c.depth), Infinity);
  const overCap = max_depth > DEPTH_CAP;

  return (
    <div className="space-y-4">
      {/* Type tally */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-content-faint">
          Found
        </span>
        {type_counts.map((t) => (
          <span
            key={t.file_type}
            className="inline-flex items-center gap-1.5 rounded-full border border-glass-border bg-white/[0.03] px-2.5 py-1 text-xs text-content-secondary"
          >
            <span aria-hidden="true">{TYPE_GLYPH[t.file_type] ?? "📁"}</span>
            <span className="font-semibold text-content-primary">{t.count}</span>
            <span className="text-content-muted">{t.file_type}</span>
          </span>
        ))}
        <span className="ml-auto text-xs text-content-muted">
          {total_files} file{total_files === 1 ? "" : "s"} total
        </span>
      </div>

      {/* Depth-cap warning — non-blocking (the tree still imports at full depth). */}
      {overCap && (
        <div
          className="flex items-start gap-2.5 rounded-card border border-orange/30 bg-orange/[0.06] px-3.5 py-2.5 text-xs text-orange"
          role="status"
        >
          <AlertTriangle size={15} strokeWidth={2} className="mt-px shrink-0" aria-hidden />
          <span>
            This folder nests <span className="font-semibold">{max_depth} levels</span> deep
            (past {DEPTH_CAP}). It'll import fine, but very deep trees are harder to browse —
            consider flattening some sub-folders.
          </span>
        </div>
      )}

      {/* Depth-aware folder tree */}
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-content-faint">
          {chapters.length} folder{chapters.length === 1 ? "" : "s"} will be created
        </p>
        <ul className="divide-y divide-glass-border overflow-hidden rounded-card border border-glass-border">
          {chapters.map((c, i) => {
            const level = Number.isFinite(minDepth) ? c.depth - minDepth : 0;
            return (
              <li
                key={`${c.depth}-${c.chapter}-${i}`}
                className="flex items-center gap-3 bg-white/[0.02] px-3.5 py-2.5 text-sm"
              >
                <span
                  className="flex min-w-0 flex-1 items-center gap-2"
                  style={{ paddingLeft: `${level * INDENT_REM}rem` }}
                >
                  {level > 0 && (
                    <span className="text-content-faint" aria-hidden>
                      └
                    </span>
                  )}
                  <span aria-hidden="true" className="text-base">
                    📁
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium text-content-primary">
                    {c.chapter}
                  </span>
                </span>
                <span
                  className="shrink-0 rounded-full bg-lime/10 px-2 py-0.5 text-xs font-semibold text-lime"
                  title={`${c.file_count} file(s) directly in this folder`}
                >
                  {c.file_count}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

export default memo(FolderPreviewView);
