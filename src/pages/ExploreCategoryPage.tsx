/**
 * ExploreCategoryPage — the full-list drill-down behind each Courses hub "Explore ›" link
 * (`/explore/:category`). Where the hub caps each section at 5 cards, this lists EVERY
 * course in the category, with the browse tools a large library needs: in-page search,
 * sort, and status filter chips.
 *
 * Categories: `pinned` | `in-progress` | `recent` | `all`, each backed by its own hub feed
 * (pinnedNodes / nodesInProgress / recentNodes / nodeChildren(null)).
 *
 * PERFORMANCE — this is the "instant drill-down" page. Unlike the hub, it runs NO GSAP
 * stagger, even on the high tier: browsing a 500-course list has to feel snappy, and a
 * per-card entrance would delay the first meaningful paint. Cheap virtualization comes from
 * the existing `perf-card` marker (`content-visibility:auto` + `contain-intrinsic-size`), so
 * off-screen cards aren't painted — no new dependency. All hover/transition motion is scoped
 * and neutralized by the `data-perf="lite"` kill-switch.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { Search, ArrowDownUp } from "lucide-react";
import BackButton from "../components/layout/BackButton";
import FolderCard from "../components/courses/FolderCard";
import { ipc, isTauri, NotInTauriError, onLibraryChanged } from "../lib/ipc";
import { useMaterialManager } from "../lib/materialManagerStore";
import { cn } from "../lib/utils";
import type { NodeCard } from "../lib/types";

type Category = "pinned" | "in-progress" | "recent" | "all";
type SortKey = "default" | "name" | "progress" | "content";
type StatusFilter = "all" | "in-progress" | "completed" | "not-started";

const CATEGORY_META: Record<Category, { title: string; blurb: string }> = {
  pinned: { title: "Pinned", blurb: "Courses you've pinned to your hub." },
  "in-progress": { title: "In Progress", blurb: "Courses you've started but not finished." },
  recent: { title: "Recently Added", blurb: "Your newest courses, newest first." },
  all: { title: "All Courses", blurb: "Every course in your library." },
};

const SORTS: { key: SortKey; label: string }[] = [
  { key: "default", label: "Default" },
  { key: "name", label: "A–Z" },
  { key: "progress", label: "% complete" },
  { key: "content", label: "Most content" },
];

const STATUS_CHIPS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "in-progress", label: "In progress" },
  { key: "completed", label: "Completed" },
  { key: "not-started", label: "Not started" },
];

type Boot =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "preview" }
  | { kind: "error"; message: string };

function isCategory(v: string | undefined): v is Category {
  return v === "pinned" || v === "in-progress" || v === "recent" || v === "all";
}

/** Completion helpers on a NodeCard's rolled-up counts. */
function pctOf(n: NodeCard): number {
  return n.material_count > 0
    ? Math.round((n.completed_count / n.material_count) * 100)
    : 0;
}

export default function ExploreCategoryPage() {
  const { category: categoryParam } = useParams();
  const category: Category = isCategory(categoryParam) ? categoryParam : "all";
  const meta = CATEGORY_META[category];

  const [boot, setBoot] = useState<Boot>({ kind: "loading" });
  const [nodes, setNodes] = useState<NodeCard[]>([]);
  const [pinnedIds, setPinnedIds] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("default");
  const [status, setStatus] = useState<StatusFilter>("all");
  const importNonce = useMaterialManager((s) => s.importNonce);

  const errMsg = (err: unknown) =>
    err instanceof NotInTauriError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);

  const fetchCategory = useCallback((): Promise<NodeCard[]> => {
    switch (category) {
      case "pinned":
        return ipc.pinnedNodes();
      case "in-progress":
        return ipc.nodesInProgress();
      case "recent":
        return ipc.recentNodes();
      case "all":
      default:
        return ipc.nodeChildren(null);
    }
  }, [category]);

  const load = useCallback(async () => {
    if (!isTauri()) {
      setBoot({ kind: "preview" });
      return;
    }
    setBoot({ kind: "loading" });
    try {
      const rows = await fetchCategory();
      setNodes(rows);
      setPinnedIds(new Set(rows.filter((n) => n.is_pinned).map((n) => n.id)));
      setBoot({ kind: "ready" });
    } catch (err) {
      setBoot({ kind: "error", message: errMsg(err) });
    }
  }, [fetchCategory]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let unlisten: () => void = () => {};
    void onLibraryChanged(() => void load()).then((u) => {
      unlisten = u;
    });
    return () => unlisten();
  }, [load]);

  useEffect(() => {
    if (importNonce > 0) void load();
  }, [importNonce, load]);

  // Pin toggle: optimistic local flip + persist. On the Pinned page an unpin also drops
  // the card from the list (it no longer belongs to the category); elsewhere it stays.
  const togglePin = useCallback(
    async (node: NodeCard) => {
      const next = !pinnedIds.has(node.id);
      setPinnedIds((prev) => {
        const copy = new Set(prev);
        if (next) copy.add(node.id);
        else copy.delete(node.id);
        return copy;
      });
      if (category === "pinned" && !next) {
        setNodes((prev) => prev.filter((n) => n.id !== node.id));
      }
      try {
        await ipc.setNodePinned(node.id, next);
      } catch {
        setPinnedIds((prev) => {
          const copy = new Set(prev);
          if (next) copy.delete(node.id);
          else copy.add(node.id);
          return copy;
        });
        if (category === "pinned" && !next) void load();
      }
    },
    [pinnedIds, category, load],
  );

  // Derived: filter by search + status, then sort. Pure + memoized — no refetch on typing.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let rows = nodes.filter((n) => {
      if (q && !n.name.toLowerCase().includes(q)) return false;
      const pct = pctOf(n);
      switch (status) {
        case "in-progress":
          return pct > 0 && pct < 100;
        case "completed":
          return n.material_count > 0 && pct === 100;
        case "not-started":
          return pct === 0;
        default:
          return true;
      }
    });
    rows = [...rows];
    switch (sort) {
      case "name":
        rows.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "progress":
        rows.sort((a, b) => pctOf(b) - pctOf(a));
        break;
      case "content":
        rows.sort((a, b) => b.material_count - a.material_count);
        break;
      default:
        break;
    }
    return rows;
  }, [nodes, query, status, sort]);

  return (
    <div className="relative min-h-full p-6 lg:p-10 xl:p-14">
      <div className="mx-auto max-w-[100rem]">
        <div className="flex items-center gap-3">
          <BackButton to="/courses" />
          <div className="min-w-0">
            <h1 className="font-display truncate text-3xl font-bold text-content-primary">
              {meta.title}
            </h1>
          </div>
        </div>
        <p className="mb-6 mt-1.5 text-sm text-content-muted">{meta.blurb}</p>

        {/* Controls: search + sort + status chips */}
        {boot.kind === "ready" && nodes.length > 0 && (
          <div className="mb-8 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-1 flex-wrap items-center gap-3">
              <label className="relative flex min-w-[16rem] flex-1 items-center lg:max-w-sm">
                <Search
                  size={16}
                  strokeWidth={2}
                  aria-hidden
                  className="pointer-events-none absolute left-3 text-content-faint"
                />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`Search ${meta.title.toLowerCase()}…`}
                  aria-label={`Search ${meta.title}`}
                  className="w-full rounded-btn border border-glass-border bg-white/[0.03] py-2 pl-9 pr-3 text-sm text-content-primary placeholder:text-content-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/40"
                />
              </label>

              <div className="flex flex-wrap items-center gap-1.5">
                {STATUS_CHIPS.map((chip) => (
                  <button
                    key={chip.key}
                    type="button"
                    onClick={() => setStatus(chip.key)}
                    aria-pressed={status === chip.key}
                    className={cn(
                      "rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/40",
                      status === chip.key
                        ? "border-lime/40 bg-lime/15 text-lime"
                        : "border-glass-border text-content-muted hover:bg-white/[0.05] hover:text-content-secondary",
                    )}
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
            </div>

            <label className="flex shrink-0 items-center gap-2 text-sm text-content-muted">
              <ArrowDownUp size={15} strokeWidth={2} aria-hidden />
              <span className="sr-only lg:not-sr-only">Sort</span>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                aria-label="Sort courses"
                className="rounded-btn border border-glass-border bg-white/[0.03] px-2.5 py-1.5 text-sm text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/40"
              >
                {SORTS.map((s) => (
                  <option key={s.key} value={s.key} className="bg-ink-800">
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {/* Result count */}
        {boot.kind === "ready" && nodes.length > 0 && (
          <p className="mb-4 text-xs text-content-faint">
            {visible.length} of {nodes.length} course{nodes.length === 1 ? "" : "s"}
          </p>
        )}

        {/* Loading skeleton */}
        {boot.kind === "loading" && (
          <div className="grid grid-cols-2 gap-gutter lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {Array.from({ length: 10 }).map((_, i) => (
              <div
                key={i}
                className="h-64 animate-pulse rounded-card border border-glass-border bg-ink-800"
                aria-hidden
              />
            ))}
          </div>
        )}

        {/* Grid — no stagger, instant paint; perf-card handles off-screen virtualization */}
        {boot.kind === "ready" && visible.length > 0 && (
          <div className="grid grid-cols-2 gap-gutter lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {visible.map((node) => (
              <FolderCard
                key={node.id}
                node={node}
                pinned={pinnedIds.has(node.id)}
                onTogglePin={() => void togglePin(node)}
              />
            ))}
          </div>
        )}

        {/* Empty: no data at all, vs filtered-to-nothing */}
        {boot.kind === "ready" && nodes.length === 0 && (
          <div className="glass flex min-h-52 flex-col items-center justify-center gap-2 rounded-card p-card text-center">
            <div className="text-4xl" aria-hidden>📚</div>
            <p className="font-medium text-content-primary">Nothing here yet</p>
            <p className="text-sm text-content-muted">{meta.blurb}</p>
          </div>
        )}

        {boot.kind === "ready" && nodes.length > 0 && visible.length === 0 && (
          <div className="glass flex min-h-40 flex-col items-center justify-center gap-2 rounded-card p-card text-center">
            <p className="font-medium text-content-primary">No matches</p>
            <p className="text-sm text-content-muted">
              Try a different search or filter.
            </p>
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setStatus("all");
              }}
              className="mt-1 rounded-btn border border-glass-border px-3 py-1.5 text-sm text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content-primary"
            >
              Clear filters
            </button>
          </div>
        )}

        {boot.kind === "preview" && (
          <div className="glass grid min-h-40 place-items-center rounded-card p-card text-center text-sm text-content-muted">
            Preview mode — open inside the desktop app to browse your courses.
          </div>
        )}

        {boot.kind === "error" && (
          <div className="rounded-card border border-orange/30 bg-orange/[0.06] p-card text-sm text-orange">
            Could not load this list: {boot.message}
            <button
              type="button"
              onClick={() => void load()}
              className="ml-3 rounded-btn border border-orange/40 px-2.5 py-1 text-xs text-orange transition-colors hover:bg-orange/10"
            >
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
