/**
 * CoursesPage — the unified file-explorer tree browser (Section 11, Phase 5), the
 * single content hub that replaces the old Library/Goal/Subject/Chapter pages.
 *
 * The v6 store is an infinite-depth `nodes` tree, so this one page browses ANY level:
 *   - `/courses`          → the root goals (parent = null)
 *   - `/courses/:nodeId`  → that node's child folders + the files directly on it
 *
 * Layout:
 *   1. Breadcrumb — the node's ancestry from `ipc.nodeAncestors`, root-first, each rung
 *      a drill link. Scrolls horizontally when deep; past DEPTH_CAP the trailing rungs
 *      get a subtle "deep" cue (web-design-guidelines: overflow + aria-current).
 *   2. Folder grid — child nodes as FolderCards (`ipc.nodeChildren`), click to drill.
 *   3. Files — materials sitting directly on the current node (`ipc.nodeMaterials`),
 *      opened in the player (MaterialRow), carrying `source: "courses"` so the player's
 *      back/breadcrumb returns here.
 *
 * Data: at the root we also fetch the Continue-Learning feature card (dashboardData).
 * Everything refetches on `library://changed` + a successful import (importNonce).
 *
 * Motion (Dashboard pattern: gsap.context + ctx.revert, reduced-motion gated): folder
 * cards + file rows re-stagger on each drill.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { gsap } from "gsap";
import { Play, Plus } from "lucide-react";
import Breadcrumb from "../components/layout/Breadcrumb";
import BackButton from "../components/layout/BackButton";
import FolderCard from "../components/courses/FolderCard";
import MaterialRow from "../components/library/MaterialRow";
import ProgressRing from "../components/courses/ProgressRing";
import CoverArt from "../components/ui/CoverArt";
import { DEPTH_CAP } from "../components/wizard/FolderPreview";
import { useMaterialManager } from "../lib/materialManagerStore";
import { ipc, isTauri, NotInTauriError, onLibraryChanged } from "../lib/ipc";
import type {
  MaterialRow as MaterialRowData,
  NodeCard,
  NodeCrumb,
  RecentMaterial,
} from "../lib/types";

type Boot =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "preview" }
  | { kind: "error"; message: string };

const TYPE_GLYPH: Record<string, string> = {
  video: "🎬",
  pdf: "📄",
  note: "📝",
  image: "🖼️",
  audio: "🎧",
};

const btnPrimary =
  "inline-flex items-center justify-center gap-2 rounded-btn bg-lime px-4 py-2 text-sm font-semibold text-ink-900 shadow-glow-lime transition-transform hover:scale-[1.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/40 disabled:pointer-events-none disabled:opacity-50";
const btnGhost =
  "inline-flex items-center justify-center gap-2 rounded-btn border border-glass-border px-4 py-2 text-sm font-medium text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/40";

export default function CoursesPage() {
  const { nodeId: nodeIdParam } = useParams();
  const nodeId = nodeIdParam != null ? Number(nodeIdParam) : null;
  const isRoot = nodeId == null;
  const navigate = useNavigate();

  const [boot, setBoot] = useState<Boot>({ kind: "loading" });
  const [children, setChildren] = useState<NodeCard[] | null>(null);
  const [materials, setMaterials] = useState<MaterialRowData[] | null>(null);
  const [crumbs, setCrumbs] = useState<NodeCrumb[]>([]);
  const [recent, setRecent] = useState<RecentMaterial | null>(null);
  const openAddFolder = useMaterialManager((s) => s.openAddFolder);
  const importNonce = useMaterialManager((s) => s.importNonce);
  const rootRef = useRef<HTMLDivElement>(null);

  const errMsg = (err: unknown) =>
    err instanceof NotInTauriError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);

  // ── load the current node: children + files + breadcrumb (+ continue card at root) ──
  const load = useCallback(async () => {
    if (!isTauri()) {
      setBoot({ kind: "preview" });
      return;
    }
    setBoot({ kind: "loading" });
    setChildren(null);
    setMaterials(null);
    try {
      const [kids, files, ancestry, dash] = await Promise.all([
        ipc.nodeChildren(nodeId),
        isRoot ? Promise.resolve<MaterialRowData[]>([]) : ipc.nodeMaterials(nodeId),
        isRoot ? Promise.resolve<NodeCrumb[]>([]) : ipc.nodeAncestors(nodeId),
        isRoot ? ipc.dashboardData() : Promise.resolve(null),
      ]);
      setChildren(kids);
      setMaterials(files);
      setCrumbs(ancestry);
      setRecent(dash ? (dash.continue_learning[0] ?? null) : null);
      setBoot({ kind: "ready" });
    } catch (err) {
      setBoot({ kind: "error", message: errMsg(err) });
    }
  }, [nodeId, isRoot]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live-refresh when a watched folder changes (new imports / rescans).
  useEffect(() => {
    let unlisten: () => void = () => {};
    void onLibraryChanged(() => {
      void load();
    }).then((u) => {
      unlisten = u;
    });
    return () => unlisten();
  }, [load]);

  // Refetch after a successful import from the global Add-Folder modal.
  useEffect(() => {
    if (importNonce > 0) void load();
  }, [importNonce, load]);

  // ── GSAP entrances (Dashboard pattern: gsap.context + ctx.revert, reduced-motion) ──
  const prefersReduced = useCallback(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  useLayoutEffect(() => {
    if (boot.kind !== "ready" || prefersReduced()) return;
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ defaults: { ease: "power3.out", duration: 0.45 } });
      if (document.querySelector(".continue-card")) {
        tl.from(".continue-card", { y: 24, opacity: 0 });
      }
      if (document.querySelector(".course-card")) {
        tl.fromTo(
          ".course-card",
          { y: 24, opacity: 0 },
          { y: 0, opacity: 1, stagger: 0.05 },
          "-=0.15",
        );
      }
      if (document.querySelector(".cv-row-lg")) {
        tl.fromTo(
          ".cv-row-lg",
          { y: 14, opacity: 0 },
          { y: 0, opacity: 1, stagger: 0.04 },
          "-=0.2",
        );
      }
    }, rootRef);
    return () => ctx.revert();
  }, [boot.kind, nodeId, prefersReduced]);

  // ── render helpers ──
  const currentName = isRoot
    ? "Courses"
    : (crumbs[crumbs.length - 1]?.name ?? "Folder");
  const parentId = crumbs.length >= 2 ? crumbs[crumbs.length - 2].id : null;
  const maxCrumbDepth = crumbs.length > 0 ? crumbs[crumbs.length - 1].depth : 0;

  const breadcrumbItems = [
    { label: "Courses", to: "/courses" },
    ...crumbs.map((c, i) => ({
      label: c.name,
      to: i < crumbs.length - 1 ? `/courses/${c.id}` : undefined,
    })),
  ];

  const recentPct = recent ? Math.max(0, Math.min(100, recent.progress_pct)) : 0;
  const childCount = children?.length ?? 0;
  const fileCount = materials?.length ?? 0;
  const isEmpty =
    boot.kind === "ready" && childCount === 0 && fileCount === 0;

  return (
    <div className="relative min-h-full p-6">
      <div ref={rootRef} className="mx-auto max-w-7xl">
        {/* Breadcrumb (scrolls when deep) + optional back button */}
        <div className="flex items-center gap-3">
          {!isRoot && (
            <BackButton to={parentId != null ? `/courses/${parentId}` : "/courses"} />
          )}
          <div className="min-w-0 flex-1 overflow-x-auto">
            <Breadcrumb items={breadcrumbItems} />
          </div>
        </div>

        <header className="mb-6 mt-3 flex items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="font-display truncate text-2xl font-bold text-content-primary">
              {currentName}
            </h1>
            <p className="mt-1 text-sm text-content-muted">
              {isRoot
                ? "Browse your goals, or start something new."
                : `${childCount} folder${childCount === 1 ? "" : "s"}${
                    fileCount > 0
                      ? ` · ${fileCount} file${fileCount === 1 ? "" : "s"}`
                      : ""
                  }`}
            </p>
          </div>
          {boot.kind !== "preview" && (
            <button type="button" onClick={openAddFolder} className={btnPrimary}>
              <Plus size={16} strokeWidth={2.5} aria-hidden />
              Add Folder
            </button>
          )}
        </header>

        {/* Depth-cap cue (non-blocking) */}
        {boot.kind === "ready" && maxCrumbDepth > DEPTH_CAP && (
          <div className="mb-6 rounded-card border border-orange/25 bg-orange/[0.05] px-3.5 py-2 text-xs text-orange/90">
            You're {maxCrumbDepth} levels deep. Very deep trees are harder to browse —
            consider flattening some folders.
          </div>
        )}

        {/* Continue Learning featured card — root only */}
        {boot.kind === "ready" && isRoot && recent && (
          <section className="continue-card mb-10 overflow-hidden rounded-panel border border-white/[0.05] bg-white/[0.02] shadow-2xl backdrop-blur-md">
            <div className="grid md:grid-cols-2">
              <div className="relative aspect-video w-full overflow-hidden md:aspect-auto md:min-h-[18rem]">
                <CoverArt
                  thumbnailPath={recent.thumbnail_path}
                  seed={recent.subject_id}
                  glyph={TYPE_GLYPH[recent.file_type] ?? "📚"}
                  className="h-full w-full"
                />
                <div className="pointer-events-none absolute inset-0 z-10 bg-gradient-to-t from-ink-900/70 via-transparent to-transparent" />
              </div>

              <div className="flex flex-col justify-between gap-6 p-6 lg:p-8">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-lime">
                    Continue Learning
                  </p>
                  <h2 className="font-display mt-2 text-2xl font-bold text-content-primary lg:text-3xl">
                    {recent.subject_name}
                  </h2>
                  <p className="mt-2 text-sm text-content-muted">
                    Up next · <span className="text-content-secondary">{recent.file_name}</span>
                  </p>
                  <p className="mt-1 text-xs text-content-faint">
                    {recent.goal_name} · {recent.chapter_name}
                  </p>
                </div>

                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-4">
                    <ProgressRing
                      pct={recentPct}
                      size={92}
                      strokeWidth={9}
                      ariaLabel={`${recent.subject_name} progress`}
                    />
                    <div className="hidden sm:block">
                      <p className="text-sm font-semibold text-content-primary">
                        {recentPct}% complete
                      </p>
                      <p className="text-xs text-content-muted">Keep the streak going.</p>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2">
                    <Link to={`/courses/${recent.subject_id}`} className={btnPrimary}>
                      To the course
                    </Link>
                    <Link
                      to={`/library/material/${recent.id}`}
                      state={{ source: "courses" }}
                      className={btnGhost}
                    >
                      <Play size={14} strokeWidth={2.5} aria-hidden />
                      Resume lesson
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* Loading skeleton */}
        {boot.kind === "loading" && (
          <div className="grid grid-cols-1 gap-gutter sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="h-64 animate-pulse rounded-card border border-glass-border bg-ink-800"
                aria-hidden
              />
            ))}
          </div>
        )}

        {/* Folder grid */}
        {boot.kind === "ready" && childCount > 0 && (
          <section className="mb-10">
            {!isRoot && (
              <h2 className="font-display mb-4 text-sm font-semibold uppercase tracking-wide text-content-secondary">
                Folders <span className="ml-1 text-xs font-normal text-content-faint">{childCount}</span>
              </h2>
            )}
            <div className="grid grid-cols-1 gap-gutter sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {children!.map((node) => (
                <FolderCard key={node.id} node={node} />
              ))}
            </div>
          </section>
        )}

        {/* Files directly on this node */}
        {boot.kind === "ready" && fileCount > 0 && (
          <section>
            <h2 className="font-display mb-4 text-sm font-semibold uppercase tracking-wide text-content-secondary">
              Files <span className="ml-1 text-xs font-normal text-content-faint">{fileCount}</span>
            </h2>
            <div className="flex flex-col gap-2.5">
              {materials!.map((m) => (
                <div key={m.id} className="cv-row-lg">
                  <MaterialRow material={m} />
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Empty state */}
        {isEmpty && (
          <div className="glass flex min-h-52 flex-col items-center justify-center gap-3 rounded-card p-card text-center">
            <div className="text-4xl" aria-hidden>📚</div>
            <div>
              <p className="font-medium text-content-primary">
                {isRoot ? "No courses here yet" : "This folder is empty"}
              </p>
              <p className="mt-1 text-sm text-content-muted">
                {isRoot
                  ? "Add a folder of videos, PDFs, or notes to build your first course."
                  : "Nothing was found here during the scan."}
              </p>
            </div>
            {isRoot ? (
              <button type="button" onClick={openAddFolder} className={btnPrimary}>
                <Plus size={16} strokeWidth={2.5} aria-hidden />
                Add a folder
              </button>
            ) : (
              <button
                type="button"
                onClick={() => navigate(parentId != null ? `/courses/${parentId}` : "/courses")}
                className={btnGhost}
              >
                ← Back
              </button>
            )}
          </div>
        )}

        {boot.kind === "preview" && (
          <div className="glass grid min-h-40 place-items-center rounded-card p-card text-center text-sm text-content-muted">
            Preview mode — open inside the desktop app to browse your courses.
          </div>
        )}

        {boot.kind === "error" && (
          <div className="rounded-card border border-orange/30 bg-orange/[0.06] p-card text-sm text-orange">
            Could not load this folder: {boot.message}
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
