/**
 * Folder preview pane — the wizard's signature element.
 *
 * Renders the read-only `FolderPreview` DTO from `preview_folder`: how each
 * sub-folder maps to a Chapter, plus a per-type file tally. This is the "see the
 * result before you commit" moment (Section 2) that makes registration feel
 * effortless, so it earns the visual weight: a bordered list of 📁 → chapter rows
 * with per-row counts, and a compact type tally chip row.
 *
 * States are handled by the parent (AddFolderWizard); this component assumes a
 * resolved preview and focuses on presentation.
 */

import { memo } from "react";
import type { FolderPreview } from "../../lib/types";

/** Emoji glyph per coarse file type (matches the brand's emoji-icon choice). */
const TYPE_GLYPH: Record<string, string> = {
  video: "🎬",
  pdf: "📄",
  note: "📝",
  image: "🖼️",
  audio: "🎧",
};

function FolderPreviewView({ preview }: { preview: FolderPreview }) {
  const { chapters, total_files, type_counts } = preview;

  if (total_files === 0) {
    return (
      <div className="rounded-card border border-glass-border bg-white/[0.02] p-5 text-center text-sm text-content-muted">
        No supported files found in this folder. Supported types include video, PDF,
        notes, images, and audio.
      </div>
    );
  }

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

      {/* Chapter mapping */}
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-content-faint">
          {chapters.length} chapter{chapters.length === 1 ? "" : "s"} will be created
        </p>
        <ul className="divide-y divide-glass-border overflow-hidden rounded-card border border-glass-border">
          {chapters.map((c) => (
            <li
              key={c.chapter}
              className="flex items-center gap-3 bg-white/[0.02] px-3.5 py-2.5 text-sm"
            >
              <span aria-hidden="true" className="text-base">
                📁
              </span>
              <span className="min-w-0 flex-1 truncate font-medium text-content-primary">
                {c.chapter}
              </span>
              <span
                className="shrink-0 rounded-full bg-lime/10 px-2 py-0.5 text-xs font-semibold text-lime"
                title={`${c.file_count} file(s)`}
              >
                {c.file_count}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default memo(FolderPreviewView);
