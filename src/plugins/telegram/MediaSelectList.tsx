/**
 * The review step both import paths end at: a list of what was found, with the choosing left
 * to the student.
 *
 * "Browse channel" and "Range" ask different questions ("what's in here?" vs "give me these
 * fifty") but the answer has the same shape — a set of files, some already in the library —
 * so they share one list rather than two that drift apart. Both flows commit the ticked rows
 * through `tg_import_batch`.
 *
 * Rows already in the library are shown, not hidden, and can't be selected: seeing "In library"
 * is what tells a student their last import worked, and hiding them would make a re-run look
 * like it found less than it did.
 */

import { useMemo } from "react";
import {
  Check,
  Download,
  FileText,
  FileType2,
  FolderTree,
  Image as ImageIcon,
  Loader2,
  Music,
  Play,
  Sparkles,
} from "lucide-react";
import { motion } from "framer-motion";
import type { TgMediaItem } from "./api";
import { cn } from "../../lib/utils";

/** Which kinds of file the list is showing. */
export type MediaFilter = "all" | "videos" | "documents";

const TYPE_GLYPH: Record<string, typeof Play> = {
  video: Play,
  audio: Music,
  pdf: FileText,
  image: ImageIcon,
  note: FileType2,
};

export function formatSize(bytes: number): string {
  if (bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatDuration(secs: number | null): string {
  if (secs == null || secs <= 0) return "";
  const total = Math.round(secs);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

interface MediaSelectListProps {
  items: TgMediaItem[];
  filter: MediaFilter;
  onFilterChange: (filter: MediaFilter) => void;
  selected: Set<number>;
  onSelectedChange: (next: Set<number>) => void;
  /** Message ids with an import in flight. */
  importing: Set<number>;
  /** Import one row on its own. */
  onImportOne: (item: TgMediaItem) => void;
  /** Import every ticked row. */
  onImportSelected: () => void;
  /** Blocks importing until a destination is chosen. */
  destinationName: string | null;
  busy: boolean;
  /** Shown above the list — what this particular sweep found. */
  summary?: string;
  /** Shown instead of the list when `items` is empty. */
  emptyMessage: string;
}

export default function MediaSelectList({
  items,
  filter,
  onFilterChange,
  selected,
  onSelectedChange,
  importing,
  onImportOne,
  onImportSelected,
  destinationName,
  busy,
  summary,
  emptyMessage,
}: MediaSelectListProps) {
  const filtered = useMemo(
    () =>
      items.filter((item) => {
        if (filter === "all") return true;
        if (filter === "videos") return item.file_type === "video";
        return item.file_type !== "video";
      }),
    [items, filter],
  );

  // Only rows that aren't already in the library can be selected, so "Select all" means all of
  // *those* — otherwise the count would promise imports that can't happen.
  const selectable = useMemo(() => filtered.filter((i) => !i.already_imported), [filtered]);
  const allSelected =
    selectable.length > 0 && selectable.every((i) => selected.has(i.message_id));

  const totalBytes = filtered.reduce((sum, i) => sum + (i.size_bytes ?? 0), 0);

  const toggle = (messageId: number) => {
    const next = new Set(selected);
    if (next.has(messageId)) next.delete(messageId);
    else next.add(messageId);
    onSelectedChange(next);
  };

  const toggleAll = () => {
    const next = new Set(selected);
    for (const item of selectable) {
      if (allSelected) next.delete(item.message_id);
      else next.add(item.message_id);
    }
    onSelectedChange(next);
  };

  if (items.length === 0) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="glass rounded-2xl border border-white/15 bg-[#050506]/50 p-4 shadow-[0_8px_32px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.1)]"
      >
        <div className="flex flex-col items-center justify-center py-10 text-center">
          <span className="grid h-12 w-12 place-items-center rounded-xl bg-white/[0.03]">
            <FolderTree size={20} className="text-content-faint" aria-hidden />
          </span>
          <p className="mt-4 text-sm text-content-muted">{emptyMessage}</p>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass scroll-thin relative max-h-[calc(100vh-380px)] min-h-[250px] overflow-y-auto rounded-2xl border border-white/15 bg-[#050506]/50 p-4 shadow-[0_8px_32px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.1)] xl:max-h-[calc(100vh-420px)]"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-3 px-1 pb-4 pt-1 text-xs text-content-faint">
        <span className="flex items-center gap-1.5">
          <Sparkles size={14} strokeWidth={2} className="text-[#2AABEE]" aria-hidden />
          <span className="font-medium text-content-secondary">
            {summary ?? `${filtered.length} file${filtered.length === 1 ? "" : "s"}`}
          </span>
          {totalBytes > 0 && <span>· {formatSize(totalBytes)}</span>}
        </span>

        <div className="mx-1 hidden h-4 w-px bg-white/10 sm:block" />

        <div className="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.02] p-1 shadow-inner">
          {(["all", "videos", "documents"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => onFilterChange(f)}
              className={cn(
                "relative rounded-full px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#2AABEE]",
                filter === f
                  ? "text-white"
                  : "text-content-secondary hover:bg-white/5 hover:text-content-primary",
              )}
            >
              {filter === f && (
                <motion.div
                  layoutId="tg-media-filter"
                  className="absolute inset-0 rounded-full border border-blue-400/30 bg-gradient-to-br from-blue-600/90 to-blue-400/90 shadow-[inset_0_1px_0_rgba(255,255,255,0.3),_0_0_15px_rgba(59,130,246,0.5)]"
                  transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
                />
              )}
              <span className="relative z-10 capitalize">{f}</span>
            </button>
          ))}
        </div>

        {selectable.length > 0 && (
          <button
            type="button"
            onClick={toggleAll}
            className="flex items-center gap-1.5 rounded bg-white/[0.04] px-2 py-1 transition-colors hover:bg-white/[0.08]"
          >
            <span
              className={cn(
                "flex h-3.5 w-3.5 items-center justify-center rounded-[3px] border",
                allSelected
                  ? "border-[#2AABEE] bg-[#2AABEE] text-white"
                  : "border-white/20 bg-transparent text-transparent",
              )}
            >
              <Check size={10} strokeWidth={3} aria-hidden />
            </span>
            Select {allSelected ? "none" : "all"}
          </button>
        )}

        <div className="flex-1" />

        {selected.size > 0 ? (
          <button
            type="button"
            onClick={onImportSelected}
            disabled={destinationName == null || busy}
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-lime px-3 py-1 font-semibold text-ink-900 shadow-glow-lime transition-transform hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:hover:scale-100"
          >
            {busy ? (
              <Loader2 size={12} strokeWidth={2.5} className="animate-spin" aria-hidden />
            ) : (
              <Download size={12} strokeWidth={2.5} aria-hidden />
            )}
            Import {selected.size} selected
          </button>
        ) : destinationName == null ? (
          <span className="rounded-full bg-orange/10 px-2 py-0.5 text-orange">
            Choose destination
          </span>
        ) : (
          <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-lime/20 bg-lime/10 px-2.5 py-0.5 text-lime">
            <Check size={12} strokeWidth={3} aria-hidden />
            Dest: {destinationName}
          </span>
        )}
      </div>

      <ul className="flex flex-col gap-2">
        {filtered.length === 0 ? (
          <li className="py-8 text-center text-sm text-content-faint">
            No files match the selected filter.
          </li>
        ) : (
          filtered.map((item) => {
            const isImporting = importing.has(item.message_id);
            const isSelected = selected.has(item.message_id);
            const Glyph = TYPE_GLYPH[item.file_type] ?? FileType2;
            const meta = [formatDuration(item.duration_secs), formatSize(item.size_bytes)]
              .filter(Boolean)
              .join(" · ");
            return (
              <li
                key={item.message_id}
                onClick={() => {
                  if (item.already_imported || isImporting) return;
                  toggle(item.message_id);
                }}
                className={cn(
                  "group flex cursor-pointer items-center gap-4 rounded-xl border px-4 py-3 transition-all hover:-translate-y-[1px]",
                  isSelected
                    ? "border-[#2AABEE]/40 bg-[#2AABEE]/10 shadow-[0_0_15px_rgba(42,171,238,0.05)]"
                    : "border-white/[0.04] bg-white/[0.02] hover:border-white/10 hover:bg-white/[0.04]",
                )}
              >
                <span
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
                    item.already_imported
                      ? "border-lime/30 bg-lime/10 text-lime"
                      : isSelected
                        ? "border-[#2AABEE] bg-[#2AABEE] text-white"
                        : "border-white/20 bg-black/20 text-transparent group-hover:border-white/40",
                  )}
                >
                  <Check size={11} strokeWidth={3} aria-hidden />
                </span>

                <span
                  aria-hidden
                  className={cn(
                    "grid h-10 w-10 shrink-0 place-items-center rounded-xl border",
                    item.file_type === "video"
                      ? "border-lime/20 bg-lime/10 text-lime shadow-[0_0_10px_rgba(163,230,53,0.1)]"
                      : item.file_type === "pdf"
                        ? "border-orange/20 bg-orange/10 text-orange"
                        : "border-white/10 bg-white/[0.05] text-content-secondary",
                  )}
                >
                  <Glyph size={18} strokeWidth={2} />
                </span>

                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-content-primary transition-colors group-hover:text-white">
                    {item.file_name}
                  </p>
                  <p className="mt-1 flex items-center gap-2 text-xs text-content-muted">
                    <span className="rounded bg-white/5 px-1.5 py-0.5 uppercase tracking-wide text-content-faint">
                      {item.file_type}
                    </span>
                    {meta && <span>{meta}</span>}
                  </p>
                </div>

                {item.already_imported ? (
                  <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-lime/20 bg-lime/10 px-3 py-1.5 text-xs font-semibold text-lime shadow-[0_0_8px_rgba(163,230,53,0.1)]">
                    <Check size={14} strokeWidth={2.5} aria-hidden />
                    In library
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onImportOne(item);
                    }}
                    disabled={isImporting || destinationName == null}
                    className={cn(
                      "inline-flex h-[34px] min-w-[80px] shrink-0 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 text-xs font-semibold text-content-secondary transition-all hover:border-[#2AABEE]/40 hover:bg-[#2AABEE]/10 hover:text-[#2AABEE] active:scale-[0.97]",
                      (isImporting || destinationName == null) &&
                        "cursor-not-allowed opacity-40 hover:border-white/10 hover:bg-white/[0.03] hover:text-content-secondary",
                    )}
                  >
                    {isImporting ? (
                      <Loader2 size={13} strokeWidth={2.5} className="animate-spin" aria-hidden />
                    ) : (
                      <Download size={13} strokeWidth={2} aria-hidden />
                    )}
                    {isImporting ? "…" : "Import"}
                  </button>
                )}
              </li>
            );
          })
        )}
      </ul>
    </motion.div>
  );
}
