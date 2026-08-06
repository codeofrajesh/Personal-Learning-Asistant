/**
 * ImportHistory — "Your Telegram library", the files already brought into PLE.
 *
 * A read-only, student-first view over `tg_import_history`: everything you pulled from
 * Telegram in one place, with quick-play straight into the player (which resolves the
 * stream URL and resumes your saved position), progress at a glance, and client-side
 * search / filter / sort so a big library stays navigable without any backend work.
 *
 * All of this is derived UI over the read-only IPC command — nothing here writes to the
 * DB, opens a session, or touches the streaming server. Refresh happens on mount and
 * whenever the parent bumps `refreshKey` (e.g. right after an import succeeds).
 */

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Play,
  Search,
  History,
  Loader2,
  FileText,
  Video,
  Music,
  Image as ImageIcon,
  FolderOpen,
  CheckCircle2,
  Inbox,
  ChevronRight,
} from "lucide-react";
import { tg } from "./api";
import type { TgImportedMaterial } from "./api";
import { cn } from "../../lib/utils";

// ── Formatting helpers (pure, local) ─────────────────────────────────────────

/** `1h 05m` / `12m 30s` — matches the rest of the app's duration rendering. */
function formatDuration(secs: number | null | undefined): string {
  if (secs == null || secs <= 0) return "";
  const total = Math.round(secs);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

/** Human file size (1024-based), consistent with `formatBytes` in lib/utils. */
function formatSize(bytes: number): string {
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

/** "3h ago" / "yesterday" / "2d ago" — compact relative time for `last_opened_at`. */
function formatRelative(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
}

// ── Type metadata: color + icon per PLE file type ───────────────────────────

const TYPE_META: Record<
  string,
  { icon: typeof Video; tint: string; label: string }
> = {
  video: { icon: Video, tint: "text-lime bg-lime/10 border-lime/20", label: "Video" },
  audio: { icon: Music, tint: "text-cyan-300 bg-cyan-300/10 border-cyan-300/20", label: "Audio" },
  pdf: { icon: FileText, tint: "text-orange bg-orange/10 border-orange/20", label: "PDF" },
  image: { icon: ImageIcon, tint: "text-purple-300 bg-purple-300/10 border-purple-300/20", label: "Image" },
  note: { icon: FileText, tint: "text-sky-300 bg-sky-300/10 border-sky-300/20", label: "Note" },
};

const TYPE_META_FALLBACK = {
  icon: FileText,
  tint: "text-content-secondary bg-white/[0.05] border-white/10",
  label: "File",
};

// ── Filter / sort model ─────────────────────────────────────────────────────

type TypeFilter = "all" | "video" | "audio" | "pdf" | "image" | "note";
type StatusFilter = "all" | "not-started" | "in-progress" | "completed";
type SortKey = "recent" | "name" | "progress" | "duration" | "size";

const TYPE_FILTERS: { id: TypeFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "video", label: "Video" },
  { id: "pdf", label: "PDF" },
  { id: "audio", label: "Audio" },
  { id: "image", label: "Image" },
  { id: "note", label: "Notes" },
];

const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "Any status" },
  { id: "not-started", label: "Not started" },
  { id: "in-progress", label: "In progress" },
  { id: "completed", label: "Completed" },
];

// ── One row ─────────────────────────────────────────────────────────────────

interface RowProps {
  item: TgImportedMaterial;
}

const HistoryRow = memo(function HistoryRow({ item }: RowProps) {
  const meta = TYPE_META[item.file_type] ?? TYPE_META_FALLBACK;
  const TypeIcon = meta.icon;
  const pct = Math.max(0, Math.min(100, Math.round(item.progress_pct)));
  const resumed = pct > 0 && pct < 100;
  const relative = formatRelative(item.last_opened_at);

  const metaBits = [
    meta.label,
    formatDuration(item.duration_secs),
    formatSize(item.file_size_bytes),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <li className="cv-row">
      <Link
        to={`/library/material/${item.material_id}`}
        title={`${item.file_name} — click to open in the player`}
        className="group relative flex items-center gap-3 rounded-card border border-white/[0.06] bg-white/[0.02] px-3 py-3 transition-all hover:border-lime/25 hover:bg-white/[0.04] hover:shadow-glow-lime focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/40"
      >
        {/* Type glyph */}
        <span
          aria-hidden
          className={cn(
            "grid h-11 w-11 shrink-0 place-items-center rounded-btn border",
            meta.tint
          )}
        >
          <TypeIcon size={20} strokeWidth={1.75} />
        </span>

        {/* Name + location + meta */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium text-content-primary">{item.file_name}</p>
            {item.is_completed && (
              <CheckCircle2
                size={14}
                strokeWidth={2}
                className="shrink-0 text-lime"
                aria-label="Completed"
              />
            )}
          </div>
          <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-content-faint">
            <FolderOpen size={11} strokeWidth={2} aria-hidden className="shrink-0" />
            <span className="truncate">{item.node_path}</span>
          </p>
          <p className="mt-0.5 text-xs text-content-muted">{metaBits}</p>
        </div>

        {/* Progress (not for PDFs/images/notes, which don't track watch time) */}
        {item.file_type === "video" || item.file_type === "audio" ? (
          <div className="hidden w-28 shrink-0 sm:block">
            <div className="mb-1 flex items-center justify-between text-[0.65rem] text-content-faint">
              <span>{resumed ? "In progress" : pct === 100 ? "Done" : "Not started"}</span>
              <span className="tabular-nums text-content-secondary">{pct}%</span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className={cn(
                  "h-full rounded-full transition-[width] duration-500",
                  pct >= 100 ? "bg-lime" : "bg-gradient-to-r from-lime/70 to-lime"
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        ) : (
          <div className="hidden shrink-0 text-right sm:block">
            {item.last_opened_at ? (
              <p className="text-[0.65rem] text-content-faint">{relative}</p>
            ) : (
              <p className="text-[0.65rem] uppercase tracking-wide text-content-faint">Ready</p>
            )}
          </div>
        )}

        {/* Play / resume affordance */}
        <span
          aria-hidden
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-lime/30 bg-lime/10 text-lime opacity-70 transition-all group-hover:scale-110 group-hover:bg-lime group-hover:text-ink-900 group-hover:opacity-100 group-hover:shadow-glow-lime"
        >
          <Play size={15} strokeWidth={2.5} className="translate-x-[1px]" />
        </span>
      </Link>
    </li>
  );
});

// ── Component ───────────────────────────────────────────────────────────────

interface ImportHistoryProps {
  /** Bump to refetch (e.g. after an import completes). */
  refreshKey?: number;
}

export default function ImportHistory({ refreshKey = 0 }: ImportHistoryProps) {
  const [items, setItems] = useState<TgImportedMaterial[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [type, setType] = useState<TypeFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<SortKey>("recent");
  const searchRef = useRef<HTMLInputElement>(null);

  // Fetch on mount + whenever the parent says "something was imported".
  useEffect(() => {
    let alive = true;
    setItems(null);
    setError(null);
    tg.importHistory()
      .then((rows) => {
        if (alive) setItems(rows);
      })
      .catch((e) => {
        if (alive) {
          setError(typeof e === "string" ? e : e instanceof Error ? e.message : "Couldn't load import history.");
          setItems([]);
        }
      });
    return () => {
      alive = false;
    };
  }, [refreshKey]);

  // Client-side pipeline: search → type → status → sort. All derived, never stored.
  const visible = useMemo(() => {
    if (!items) return null;
    const q = search.trim().toLowerCase();
    let list = items;
    if (q) {
      list = list.filter(
        (i) =>
          i.file_name.toLowerCase().includes(q) ||
          i.node_path.toLowerCase().includes(q)
      );
    }
    if (type !== "all") list = list.filter((i) => i.file_type === type);
    if (status !== "all") {
      list = list.filter((i) => {
        const pct = i.progress_pct;
        if (status === "completed") return i.is_completed || pct >= 100;
        if (status === "not-started") return pct <= 0 && !i.is_completed;
        return pct > 0 && pct < 100 && !i.is_completed; // in-progress
      });
    }
    const sorted = [...list];
    switch (sort) {
      case "name":
        sorted.sort((a, b) => a.file_name.localeCompare(b.file_name));
        break;
      case "progress":
        sorted.sort((a, b) => a.progress_pct - b.progress_pct);
        break;
      case "duration": {
        const d = (i: TgImportedMaterial) => i.duration_secs ?? -1;
        sorted.sort((a, b) => d(b) - d(a));
        break;
      }
      case "size":
        sorted.sort((a, b) => b.file_size_bytes - a.file_size_bytes);
        break;
      case "recent":
      default:
        // Backend returns newest-first; keep it.
        break;
    }
    return sorted;
  }, [items, search, type, status, sort]);

  const isLoading = items === null;

  return (
    <section
      aria-labelledby="tg-history-title"
      className="relative overflow-hidden rounded-panel glass shadow-card"
    >
      {/* Section header */}
      <div className="border-b border-white/[0.06] px-card pb-4 pt-card">
        <div className="flex flex-wrap items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-btn border border-lime/25 bg-lime/10">
            <History size={17} strokeWidth={2} className="text-lime" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="tg-history-title" className="font-display text-base font-semibold text-content-primary">
              Your Telegram library
            </h2>
            <p className="mt-0.5 text-xs text-content-muted">
              Everything you've imported, with progress and one-click resume.
            </p>
          </div>
          {!isLoading && items && (
            <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs font-medium tabular-nums text-content-secondary">
              {items.length} file{items.length === 1 ? "" : "s"}
            </span>
          )}
        </div>

        {/* Controls: search + sort + filters */}
        <div className="mt-4 flex flex-col gap-2.5 lg:flex-row lg:items-center">
          {/* Search */}
          <div className="relative min-w-0 flex-1">
            <Search
              size={14}
              strokeWidth={2}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-content-faint"
              aria-hidden
            />
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search your imports…"
              spellCheck={false}
              className="w-full rounded-btn border border-white/10 bg-white/[0.03] py-2 pl-9 pr-3 text-sm text-content-primary outline-none transition-colors placeholder:text-content-faint focus:border-lime/40"
              aria-label="Search imported files"
            />
          </div>

          {/* Sort */}
          <label className="flex shrink-0 items-center gap-2 text-xs text-content-muted">
            <span className="hidden sm:inline">Sort</span>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="rounded-btn border border-white/10 bg-white/[0.03] px-2.5 py-2 text-xs text-content-secondary outline-none transition-colors focus:border-lime/40"
              aria-label="Sort imported files"
            >
              <option value="recent">Recently opened</option>
              <option value="name">Name A–Z</option>
              <option value="progress">Progress ↑</option>
              <option value="duration">Longest first</option>
              <option value="size">Largest first</option>
            </select>
          </label>
        </div>

        {/* Type pills */}
        <div
          role="tablist"
          aria-label="Filter by file type"
          className="mt-3 flex flex-wrap gap-1.5"
        >
          {TYPE_FILTERS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={type === id}
              onClick={() => setType(id)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                type === id
                  ? "border-lime/40 bg-lime/15 text-lime"
                  : "border-white/10 bg-white/[0.02] text-content-secondary hover:bg-white/[0.05] hover:text-content-primary"
              )}
            >
              {label}
            </button>
          ))}
          <span className="mx-1 hidden w-px bg-white/10 sm:block" aria-hidden />
          {STATUS_FILTERS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              aria-pressed={status === id}
              onClick={() => setStatus(id)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                status === id
                  ? "border-orange/40 bg-orange/15 text-orange"
                  : "border-white/10 bg-white/[0.02] text-content-secondary hover:bg-white/[0.05] hover:text-content-primary"
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Body */}
      <div className="px-card py-card">
        {isLoading && (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-content-muted">
            <Loader2 size={16} strokeWidth={2} className="animate-spin text-lime" aria-hidden />
            Loading your library…
          </div>
        )}

        {!isLoading && error && (
          <p role="alert" className="rounded-btn border border-orange/25 bg-orange/10 px-3 py-2.5 text-sm text-orange">
            {error}
          </p>
        )}

        {!isLoading && !error && visible && visible.length === 0 && (
          <div className="flex flex-col items-center justify-center px-4 py-14 text-center">
            <span className="grid h-14 w-14 place-items-center rounded-2xl border border-white/[0.07] bg-white/[0.03]">
              {items && items.length > 0 ? (
                <Search size={22} strokeWidth={1.75} className="text-content-faint" aria-hidden />
              ) : (
                <Inbox size={22} strokeWidth={1.75} className="text-content-faint" aria-hidden />
              )}
            </span>
            <p className="mt-4 font-display text-base font-semibold text-content-primary">
              {items && items.length > 0 ? "No imports match" : "Nothing imported yet"}
            </p>
            <p className="mt-1 max-w-xs text-sm text-content-muted">
              {items && items.length > 0
                ? "Try a different search term or filter above."
                : "Paste a Telegram link above and it will show up here — with progress tracking and resume built in."}
            </p>
          </div>
        )}

        {!isLoading && !error && visible && visible.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {visible.map((item) => (
              <HistoryRow key={item.material_id} item={item} />
            ))}
          </ul>
        )}

        {!isLoading && !error && visible && visible.length > 0 && (
          <p className="mt-3 flex items-center gap-1 text-xs text-content-faint">
            <ChevronRight size={12} strokeWidth={2} aria-hidden />
            Open any file to stream it — your position is saved automatically.
          </p>
        )}
      </div>
    </section>
  );
}
