import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Play,
  Search,
  Loader2,
  FileText,
  Video,
  Music,
  Image as ImageIcon,
  FolderOpen,
  CheckCircle2,
  Inbox,
  Filter,
} from "lucide-react";
import { tg } from "./api";
import type { TgImportedMaterial } from "./api";
import { cn } from "../../lib/utils";
import { motion } from "framer-motion";

// ── Formatting helpers (pure, local) ─────────────────────────────────────────

function formatDuration(secs: number | null | undefined): string {
  if (secs == null || secs <= 0) return "";
  const total = Math.round(secs);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

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
  video: { icon: Video, tint: "text-[#2AABEE] bg-[#2AABEE]/10 border-[#2AABEE]/20 group-hover:bg-[#2AABEE]/20", label: "Video" },
  audio: { icon: Music, tint: "text-purple-400 bg-purple-400/10 border-purple-400/20 group-hover:bg-purple-400/20", label: "Audio" },
  pdf: { icon: FileText, tint: "text-orange bg-orange/10 border-orange/20 group-hover:bg-orange/20", label: "PDF" },
  image: { icon: ImageIcon, tint: "text-pink-400 bg-pink-400/10 border-pink-400/20 group-hover:bg-pink-400/20", label: "Image" },
  note: { icon: FileText, tint: "text-lime bg-lime/10 border-lime/20 group-hover:bg-lime/20", label: "Note" },
};

const TYPE_META_FALLBACK = {
  icon: FileText,
  tint: "text-content-secondary bg-white/[0.05] border-white/10 group-hover:bg-white/[0.08]",
  label: "File",
};

// ── Filter / sort model ─────────────────────────────────────────────────────

type TypeFilter = "all" | "video" | "audio" | "pdf" | "image" | "note";
type StatusFilter = "all" | "not-started" | "in-progress" | "completed";
type SortKey = "recent" | "name" | "progress" | "duration" | "size";

const TYPE_FILTERS: { id: TypeFilter; label: string }[] = [
  { id: "all", label: "All Types" },
  { id: "video", label: "Video" },
  { id: "pdf", label: "PDF" },
  { id: "audio", label: "Audio" },
  { id: "image", label: "Image" },
  { id: "note", label: "Notes" },
];

const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "Any Status" },
  { id: "not-started", label: "Not Started" },
  { id: "in-progress", label: "In Progress" },
  { id: "completed", label: "Completed" },
];

// ── One row ─────────────────────────────────────────────────────────────────

const HistoryRow = memo(function HistoryRow({ item }: { item: TgImportedMaterial }) {
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
    <Link
      to={`/library/material/${item.material_id}`}
      title={`${item.file_name} — click to open in the player`}
      className="group relative flex items-center gap-4 rounded-xl border border-white/[0.04] bg-white/[0.02] px-4 py-3.5 transition-all hover:-translate-y-[2px] hover:border-[#2AABEE]/30 hover:bg-white/[0.04] hover:shadow-[0_4px_20px_rgba(42,171,238,0.1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2AABEE]/40"
    >
      {/* Type glyph */}
      <span
        aria-hidden
        className={cn(
          "grid h-12 w-12 shrink-0 place-items-center rounded-xl border transition-colors",
          meta.tint
        )}
      >
        <TypeIcon size={20} strokeWidth={2} />
      </span>

      {/* Name + location + meta */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-semibold text-content-primary transition-colors group-hover:text-[#2AABEE]">{item.file_name}</p>
          {item.is_completed && (
            <CheckCircle2
              size={14}
              strokeWidth={2.5}
              className="shrink-0 text-lime"
              aria-label="Completed"
            />
          )}
        </div>
        <p className="mt-1.5 flex items-center gap-1.5 truncate text-xs text-content-faint">
          <FolderOpen size={13} strokeWidth={2} aria-hidden className="shrink-0" />
          <span className="truncate">{item.node_path}</span>
        </p>
        <p className="mt-1 text-[0.65rem] uppercase tracking-wider font-medium text-content-muted">{metaBits}</p>
      </div>

      {/* Progress */}
      {item.file_type === "video" || item.file_type === "audio" ? (
        <div className="hidden w-32 shrink-0 sm:block px-2">
          <div className="mb-1.5 flex items-center justify-between text-[0.65rem] font-medium text-content-faint">
            <span>{resumed ? "In progress" : pct === 100 ? "Done" : "Not started"}</span>
            <span className="tabular-nums text-content-secondary">{pct}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06] shadow-inner">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-700 ease-out",
                pct >= 100 ? "bg-lime shadow-glow-lime" : "bg-[#2AABEE] shadow-[0_0_8px_#2AABEE]"
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      ) : (
        <div className="hidden shrink-0 text-right sm:block px-4">
          {item.last_opened_at ? (
            <p className="text-xs text-content-faint">{relative}</p>
          ) : (
            <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-[#2AABEE]">Ready</p>
          )}
        </div>
      )}

      {/* Play / resume affordance */}
      <span
        aria-hidden
        className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-white/10 bg-white/[0.05] text-content-secondary transition-all group-hover:border-[#2AABEE]/30 group-hover:bg-[#2AABEE] group-hover:text-white group-hover:shadow-[0_0_15px_rgba(42,171,238,0.4)]"
      >
        <Play size={16} strokeWidth={2.5} className="translate-x-[1px]" />
      </span>
    </Link>
  );
});

// ── Component ───────────────────────────────────────────────────────────────

export default function ImportHistory({ refreshKey = 0 }: { refreshKey?: number }) {
  const [items, setItems] = useState<TgImportedMaterial[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [type, setType] = useState<TypeFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<SortKey>("recent");
  const searchRef = useRef<HTMLInputElement>(null);

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
        return pct > 0 && pct < 100 && !i.is_completed;
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
        break;
    }
    return sorted;
  }, [items, search, type, status, sort]);

  const isLoading = items === null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-6">
          <div className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.02] p-1 shadow-inner">
            {TYPE_FILTERS.map((f) => (
              <button
                key={f.id}
                onClick={() => setType(f.id)}
                className={cn(
                  "relative rounded-full px-4 py-1.5 text-xs font-semibold transition-colors z-10",
                  type === f.id ? "text-white" : "text-content-secondary hover:text-content-primary"
                )}
              >
                {type === f.id && (
                  <motion.div
                    layoutId="type-filter-pill"
                    className="absolute inset-0 rounded-full bg-[#2AABEE] shadow-[0_0_10px_rgba(42,171,238,0.3)] -z-10"
                    initial={false}
                    transition={{ type: "spring", stiffness: 400, damping: 30 }}
                  />
                )}
                {f.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.02] p-1 shadow-inner">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.id}
                onClick={() => setStatus(f.id)}
                className={cn(
                  "relative rounded-full px-4 py-1.5 text-xs font-semibold transition-colors z-10",
                  status === f.id ? "text-ink-900" : "text-content-secondary hover:text-content-primary"
                )}
              >
                {status === f.id && (
                  <motion.div
                    layoutId="status-filter-pill"
                    className="absolute inset-0 rounded-full bg-lime shadow-glow-lime -z-10"
                    initial={false}
                    transition={{ type: "spring", stiffness: 400, damping: 30 }}
                  />
                )}
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* Search & Sort */}
        <div className="flex items-center gap-3">
          <div className="relative w-full max-w-[200px]">
            <Search
              size={14}
              strokeWidth={2.5}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-content-faint"
            />
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search..."
              className="w-full rounded-full border border-white/10 bg-white/[0.03] py-2 pl-9 pr-4 text-xs font-medium text-content-primary outline-none transition-all placeholder:text-content-faint focus:border-[#2AABEE]/50 focus:bg-[#2AABEE]/5 focus:shadow-[0_0_10px_rgba(42,171,238,0.1)]"
            />
          </div>
          <div className="relative">
             <Filter size={14} strokeWidth={2.5} className="absolute left-3 top-1/2 -translate-y-1/2 text-content-faint pointer-events-none" />
             <select
               value={sort}
               onChange={(e) => setSort(e.target.value as SortKey)}
               className="rounded-full border border-white/10 bg-white/[0.03] pl-9 pr-3 py-2 text-xs font-medium text-content-secondary outline-none transition-all focus:border-[#2AABEE]/50 focus:text-content-primary appearance-none hover:bg-white/[0.05] cursor-pointer"
             >
               <option value="recent">Recent</option>
               <option value="name">A–Z</option>
               <option value="progress">Progress</option>
               <option value="size">Size</option>
             </select>
          </div>
        </div>
      </div>

      <div className="glass rounded-2xl border border-white/15 bg-[#050506]/50 shadow-[0_8px_32px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.1)] max-h-[calc(100vh-380px)] min-h-[250px] overflow-y-auto relative scroll-thin">
        {isLoading && (
          <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-3 text-content-muted">
            <Loader2 size={24} strokeWidth={2.5} className="animate-spin text-[#2AABEE]" />
            <p className="text-sm font-medium">Loading your library...</p>
          </div>
        )}

        {!isLoading && error && (
          <div className="m-4 rounded-xl border border-orange/30 bg-orange/10 p-5 text-orange">
            <p className="text-sm font-medium">{error}</p>
          </div>
        )}

        {!isLoading && !error && visible && visible.length === 0 && (
          <div className="flex h-full min-h-[200px] flex-col items-center justify-center px-4 text-center">
            <span className="grid h-16 w-16 place-items-center rounded-2xl border border-white/[0.08] bg-white/[0.03] shadow-inner">
              {items && items.length > 0 ? (
                <Search size={26} strokeWidth={2} className="text-content-faint" />
              ) : (
                <Inbox size={26} strokeWidth={2} className="text-content-faint" />
              )}
            </span>
            <p className="mt-5 font-display text-lg font-semibold text-content-primary">
              {items && items.length > 0 ? "No matches found" : "Your library is empty"}
            </p>
            <p className="mt-2 max-w-sm text-sm text-content-muted leading-relaxed">
              {items && items.length > 0
                ? "Try adjusting your filters or search term."
                : "Import some media from Telegram to get started. Your progress will be tracked automatically."}
            </p>
          </div>
        )}

        {!isLoading && !error && visible && visible.length > 0 && (
          <motion.ul 
            className="flex flex-col gap-1.5 p-2"
            initial="hidden"
            animate="show"
            variants={{
              hidden: {},
              show: { transition: { staggerChildren: 0.04 } }
            }}
          >
            {visible.map((item) => (
              <motion.li
                 key={item.material_id}
                 variants={{
                    hidden: { opacity: 0, y: 15 },
                    show: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 350, damping: 25 } }
                 }}
              >
                 <HistoryRow item={item} />
              </motion.li>
            ))}
          </motion.ul>
        )}
      </div>
    </div>
  );
}
