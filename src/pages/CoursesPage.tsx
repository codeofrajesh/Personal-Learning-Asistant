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

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { gsap } from "gsap";
import { motion, AnimatePresence } from "framer-motion";
import { Play, Plus, Bookmark, Check, ChevronRight, FileVideo, FileText, FileAudio, FileImage, File as FileLucide, Pin, Activity, Sparkles, LibraryBig, Trash2 } from "lucide-react";
import Breadcrumb from "../components/layout/Breadcrumb";
import BackButton from "../components/layout/BackButton";
import FolderCard from "../components/courses/FolderCard";
import CourseHubSection from "../components/courses/CourseHubSection";
import ConfirmDeleteModal from "../components/ui/ConfirmDeleteModal";

import ProgressRing from "../components/courses/ProgressRing";
import CoverArt from "../components/ui/CoverArt";
import { DEPTH_CAP } from "../components/wizard/FolderPreview";
import { useMaterialManager } from "../lib/materialManagerStore";
import { motionAllowed } from "../lib/perfStore";
import { ipc, isTauri, NotInTauriError, onLibraryChanged } from "../lib/ipc";
import { useToastStore } from "../lib/toastStore";
import { cn } from "../lib/utils";
import { withSource } from "../lib/navigation";
import type {
  MaterialRow as MaterialRowData,
  NodeCard,
  NodeCrumb,
  RecentMaterial,
  RemoveOutcome,
} from "../lib/types";

type Boot =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "preview" }
  | { kind: "error"; message: string };

/** Data backing the root hub's sections (fetched only at `/courses`). */
interface HubData {
  all: NodeCard[];
  pinned: NodeCard[];
  inProgress: NodeCard[];
  recent: NodeCard[];
  continueLearning: RecentMaterial[];
}

/** What the delete-confirm modal is about to remove. */
type DeleteTarget =
  | { kind: "folder"; node: NodeCard }
  | { kind: "material"; material: MaterialRowData };

const TYPE_GLYPH: Record<string, string> = {
  video: "🎬",
  pdf: "📄",
  note: "📝",
  image: "🖼️",
  audio: "🎧",
};

const FILE_ICON: Record<string, typeof FileLucide> = {
  video: FileVideo,
  pdf: FileText,
  note: FileText,
  image: FileImage,
  audio: FileAudio,
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
  const [activeTab, setActiveTab] = useState<"all" | "lectures" | "notes">("all");
  const [activeFilter, setActiveFilter] = useState<"all" | "cloud" | "offline">("all");
  const [isFilterOpen, setIsFilterOpen] = useState(false);

  const [crumbs, setCrumbs] = useState<NodeCrumb[]>([]);
  const [hub, setHub] = useState<HubData | null>(null);
  // Ids optimistically pinned/unpinned this session (overrides node.is_pinned in cards
  // so a toggle doesn't need a hub refetch + GSAP re-stagger).
  const [pinnedIds, setPinnedIds] = useState<Set<number>>(new Set());
  const openAddFolder = useMaterialManager((s) => s.openAddFolder);
  const importNonce = useMaterialManager((s) => s.importNonce);
  const rootRef = useRef<HTMLDivElement>(null);

  // ── Unified deletion (ConfirmDeleteModal) ───────────────────────────────────
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const pushToast = useToastStore((s) => s.push);

  const closeDelete = useCallback(() => {
    if (deleteBusy) return; // never close mid-flight
    setDeleteTarget(null);
    setDeleteError(null);
  }, [deleteBusy]);

  // Filter logic
  const filteredMaterials = useMemo(() => {
    if (!materials) return [];
    return materials.filter(m => {
      // 1. Tab filtering
      const videoExtensions = ["mkv", "mp4", "mov", "avi", "webm", "flv", "m4v", "wmv", "mpg", "mpeg", "3gp", "ts"];
      const isVideo = m.file_type === "VIDEO" || videoExtensions.includes(m.file_extension?.toLowerCase() || "");
      if (activeTab === "lectures" && !isVideo) return false;
      if (activeTab === "notes" && isVideo) return false;

      // 2. Cloud/Offline filtering
      if (activeFilter === "cloud" && m.source !== "telegram") return false;
      if (activeFilter === "offline" && m.source === "telegram") return false;

      return true;
    });
  }, [materials, activeTab, activeFilter]);

  const errMsg = (err: unknown) =>
    err instanceof NotInTauriError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);

  // ── load: at the root we build the multi-section HUB (Continue Learning, Pinned,
  // In Progress, Recently Added, All Courses); inside a node we're the tree EXPLORER
  // (child folders + files + breadcrumb). Two disjoint fetch sets keyed on isRoot. ──
  const load = useCallback(async () => {
    if (!isTauri()) {
      setBoot({ kind: "preview" });
      return;
    }
    setBoot({ kind: "loading" });
    setChildren(null);
    setMaterials(null);
    try {
      if (isRoot) {
        const [all, pinned, inProgress, recent, dash] = await Promise.all([
          ipc.nodeChildren(null),
          ipc.pinnedNodes(),
          ipc.nodesInProgress(),
          ipc.recentNodes(),
          ipc.dashboardData(),
        ]);
        setHub({
          all,
          pinned,
          inProgress,
          recent,
          continueLearning: dash.continue_learning ?? [],
        });
        // Seed optimistic pin state from the server truth on every (re)load.
        setPinnedIds(new Set(pinned.map((n) => n.id)));
      } else {
        const [kids, files, ancestry] = await Promise.all([
          ipc.nodeChildren(nodeId),
          ipc.nodeMaterials(nodeId),
          ipc.nodeAncestors(nodeId),
        ]);
        setChildren(kids);
        setMaterials(files);
        setCrumbs(ancestry);
      }
      setBoot({ kind: "ready" });
    } catch (err) {
      setBoot({ kind: "error", message: errMsg(err) });
    }
  }, [nodeId, isRoot]);

  // Pin/unpin a node from the hub. Optimistically flip local state (no refetch → no GSAP
  // re-stagger), then persist; roll back on error. Mirrors the bookmark toggle pattern.
  const togglePin = useCallback(async (node: NodeCard) => {
    const next = !(pinnedIds.has(node.id));
    setPinnedIds((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(node.id);
      else copy.delete(node.id);
      return copy;
    });
    try {
      await ipc.setNodePinned(node.id, next);
      // Keep the Pinned section's membership in sync without a full reload: add/remove
      // this card from hub.pinned so it appears/disappears there immediately.
      setHub((prev) => {
        if (!prev) return prev;
        const pinned = next
          ? prev.pinned.some((n) => n.id === node.id)
            ? prev.pinned
            : [...prev.pinned, { ...node, is_pinned: true }]
          : prev.pinned.filter((n) => n.id !== node.id);
        return { ...prev, pinned };
      });
    } catch {
      // Roll back the optimistic flip.
      setPinnedIds((prev) => {
        const copy = new Set(prev);
        if (next) copy.delete(node.id);
        else copy.add(node.id);
        return copy;
      });
    }
  }, [pinnedIds]);

  useEffect(() => {
    void load();
  }, [load]);

  // Optimistic bookmark: flip the single row's state in place instead of refetching the
  // whole node (the old `load()` replaced children/materials → full re-render + GSAP
  // re-stagger + re-blur of every card just to toggle one star). Roll back on error.
  const toggleBookmark = useCallback(async (materialId: number) => {
    let nextValue = false;
    setMaterials((prev) => {
      if (!prev) return prev;
      return prev.map((m) => {
        if (m.id !== materialId) return m;
        nextValue = !m.is_bookmarked;
        return { ...m, is_bookmarked: nextValue };
      });
    });
    try {
      await ipc.setBookmark(materialId, nextValue);
    } catch {
      // Roll back the optimistic flip.
      setMaterials((prev) =>
        prev
          ? prev.map((m) => (m.id === materialId ? { ...m, is_bookmarked: !nextValue } : m))
          : prev,
      );
    }
  }, []);

  /** Run the delete, surface a toast with the real counts, then refetch. The backend
   *  emits `library://changed` on success, but we refresh immediately (no race). */
  const confirmDelete = useCallback(async () => {
    const target = deleteTarget;
    if (!target) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const outcome: RemoveOutcome =
        target.kind === "folder"
          ? await ipc.removeNode(target.node.id)
          : await ipc.removeMaterial(target.material.id);

      if (target.kind === "folder") {
        pushToast({
          tone: "success",
          title: "Folder deleted",
          body:
            outcome.materials_deleted > 0
              ? `Removed ${outcome.materials_deleted} file${outcome.materials_deleted === 1 ? "" : "s"}`
              : undefined,
          duration: 4000,
        });
        // If we were viewing the deleted folder, navigate up to its parent so we never
        // land on a now-empty/invalid page (the card would show "folder is empty").
        if (nodeId === target.node.id) {
          const up = crumbs.length >= 2 ? crumbs[crumbs.length - 2].id : null;
          navigate(up != null ? `/courses/${up}` : "/courses");
        }
      } else {
        pushToast({
          tone: "success",
          title: "Lesson deleted",
          body: outcome.files_deleted > 0 ? "File removed from disk" : undefined,
          duration: 4000,
        });
      }
      setDeleteTarget(null);
      void load();
    } catch (err) {
      setDeleteError(errMsg(err));
    } finally {
      setDeleteBusy(false);
    }
  }, [deleteTarget, load, pushToast]);

  const openDeleteFolder = useCallback((node: NodeCard) => {
    setDeleteError(null);
    setDeleteTarget({ kind: "folder", node });
  }, []);

  const openDeleteMaterial = useCallback((m: MaterialRowData) => {
    setDeleteError(null);
    setDeleteTarget({ kind: "material", material: m });
  }, []);

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

  // ── GSAP entrances — gated on the performance tier (motionAllowed), not just
  // reduced-motion. On `lite` this early-returns so folder cards + file rows appear
  // instantly (no stagger tween on navigation/drill — the source of the drill lag on
  // weak hardware). High/balanced keep the staggered entrance. ──
  useLayoutEffect(() => {
    if (boot.kind !== "ready" || !motionAllowed()) return;
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ defaults: { ease: "power3.out", duration: 0.45 } });
      if (document.querySelector(".continue-card")) {
        tl.from(".continue-card", { y: 24, opacity: 0 });
      }
      // Hub: sections rise in sequence; the cards inside share a light per-section
      // stagger. Inside a node: the folder cards / file rows stagger as before.
      if (document.querySelector(".hub-section")) {
        tl.fromTo(
          ".hub-section",
          { y: 20, opacity: 0 },
          { y: 0, opacity: 1, stagger: 0.08 },
          "-=0.15",
        );
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
  }, [boot.kind, nodeId]);

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

  const childCount = children?.length ?? 0;
  const fileCount = materials?.length ?? 0;
  const nodeEmpty =
    !isRoot && boot.kind === "ready" && childCount === 0 && fileCount === 0;
  const recent = hub?.continueLearning[0] ?? null;
  const recentPct = recent ? Math.max(0, Math.min(100, recent.progress_pct)) : 0;
  const hubEmpty =
    isRoot && boot.kind === "ready" && (hub?.all.length ?? 0) === 0;

  return (
    <div className="relative min-h-full p-6 lg:p-10 xl:p-14">
      <div ref={rootRef} className="mx-auto max-w-[100rem]">
        {/* Breadcrumb (scrolls when deep) + optional back button — explorer only */}
        {!isRoot && (
          <div className="flex items-center gap-3">
            <BackButton to={parentId != null ? `/courses/${parentId}` : "/courses"} />
            <div className="min-w-0 flex-1 overflow-x-auto">
              <Breadcrumb items={breadcrumbItems} />
            </div>
          </div>
        )}

        <header className={cn("mb-8 flex items-end justify-between gap-4", !isRoot && "mt-3")}>
          <div className="min-w-0">
            <h1 className="font-display truncate text-3xl font-bold text-content-primary">
              {currentName}
            </h1>
            <p className="mt-1.5 text-sm text-content-muted">
              {isRoot
                ? "Your learning hub — pick up where you left off, or explore your library."
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

        {/* Depth-cap cue (non-blocking) — explorer only */}
        {!isRoot && boot.kind === "ready" && maxCrumbDepth > DEPTH_CAP && (
          <div className="mb-6 rounded-card border border-orange/25 bg-orange/[0.05] px-3.5 py-2 text-xs text-orange/90">
            You're {maxCrumbDepth} levels deep. Very deep trees are harder to browse —
            consider flattening some folders.
          </div>
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

        {/* ── ROOT: the multi-section EdTech hub ── */}
        {isRoot && boot.kind === "ready" && !hubEmpty && (
          <div className="space-y-12">
            {/* Continue Learning — featured resume card */}
            {recent && (
              <section className="continue-card overflow-hidden rounded-panel border border-white/[0.05] bg-white/[0.02] shadow-2xl backdrop-blur-md">
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

            {/* Pinned — hidden entirely when nothing is pinned */}
            {hub && hub.pinned.length > 0 && (
              <CourseHubSection
                title="Pinned"
                icon={Pin}
                nodes={hub.pinned}
                exploreTo="/explore/pinned"
                pinnedIds={pinnedIds}
                onTogglePin={togglePin}
                onDelete={openDeleteFolder}
              />
            )}

            {/* In Progress */}
            {hub && hub.inProgress.length > 0 && (
              <CourseHubSection
                title="In Progress"
                icon={Activity}
                nodes={hub.inProgress}
                exploreTo="/explore/in-progress"
                accent="#22d3ee"
                pinnedIds={pinnedIds}
                onTogglePin={togglePin}
                onDelete={openDeleteFolder}
              />
            )}

            {/* Recently Added */}
            {hub && hub.recent.length > 0 && (
              <CourseHubSection
                title="Recently Added"
                icon={Sparkles}
                nodes={hub.recent}
                exploreTo="/explore/recent"
                accent="#f59e0b"
                pinnedIds={pinnedIds}
                onTogglePin={togglePin}
                onDelete={openDeleteFolder}
              />
            )}

            {/* All Courses — the root goals */}
            {hub && hub.all.length > 0 && (
              <CourseHubSection
                title="All Courses"
                icon={LibraryBig}
                nodes={hub.all}
                exploreTo="/explore/all"
                pinnedIds={pinnedIds}
                onTogglePin={togglePin}
                onDelete={openDeleteFolder}
              />
            )}
          </div>
        )}

        {/* ── EXPLORER: folders + files inside a node ── */}
        {!isRoot && boot.kind === "ready" && childCount > 0 && (
          <section className="mb-10">
            <h2 className="font-display mb-4 text-sm font-semibold uppercase tracking-wide text-content-secondary">
              Folders <span className="ml-1 text-xs font-normal text-content-faint">{childCount}</span>
            </h2>
            <div className="grid grid-cols-2 gap-gutter lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
              {children!.map((node) => (
                <FolderCard
                  key={node.id}
                  node={node}
                  onDelete={() => openDeleteFolder(node)}
                />
              ))}
            </div>
          </section>
        )}

        {!isRoot && boot.kind === "ready" && (materials?.length ? materials.length > 0 : false) && (
          <section>
            {/* Header / Control Bar */}
            <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              
              {/* Animated Tab Bar */}
              <div className="relative flex w-full sm:w-auto items-center p-1 bg-white/5 border border-white/10 rounded-full backdrop-blur-md shadow-[0_0_15px_rgba(0,0,0,0.2)]">
                {(["all", "lectures", "notes"] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`relative flex-1 sm:flex-none px-6 py-2 text-sm font-medium tracking-wide capitalize transition-colors duration-200 z-10 outline-none ${
                      activeTab === tab ? "text-white" : "text-content-muted hover:text-content-secondary"
                    }`}
                  >
                    {activeTab === tab && (
                      <motion.div
                        layoutId="activeTabIndicator"
                        className="absolute inset-0 bg-gradient-to-br from-blue-600/90 to-blue-400/90 rounded-full shadow-[inset_0_1px_0_rgba(255,255,255,0.3),_0_0_15px_rgba(59,130,246,0.5)] border border-blue-400/30"
                        initial={false}
                        transition={{ type: "spring", stiffness: 400, damping: 30 }}
                      />
                    )}
                    <span className="relative z-10 flex items-center justify-center gap-2 drop-shadow-sm">
                      {tab === "all" ? (
                        <LibraryBig className="w-4 h-4 drop-shadow-md" />
                      ) : tab === "lectures" ? (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="drop-shadow-md"><polygon points="6 3 20 12 6 21 6 3"/></svg>
                      ) : (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="drop-shadow-md"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
                      )}
                      {tab}
                    </span>
                  </button>
                ))}
              </div>

              {/* Filter Dropdown */}
              <div className="relative z-20">
                <button
                  onClick={() => setIsFilterOpen(!isFilterOpen)}
                  className={`flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-medium transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 ${
                    activeFilter !== "all" 
                      ? "bg-gradient-to-r from-emerald-500/20 to-teal-500/20 text-emerald-400 border border-emerald-500/30 shadow-[0_0_15px_rgba(16,185,129,0.15)] hover:from-emerald-500/30 hover:to-teal-500/30" 
                      : "bg-gradient-to-r from-white/10 to-white/5 hover:from-white/15 hover:to-white/10 text-white border border-white/10 shadow-[0_0_10px_rgba(0,0,0,0.2)]"
                  }`}
                >
                  <Activity className="w-4 h-4" />
                  {activeFilter === "all" ? "All Sources" : activeFilter === "cloud" ? "Cloud Only" : "Offline Only"}
                  <ChevronRight className={`w-4 h-4 transition-transform duration-200 ${isFilterOpen ? "rotate-90" : ""}`} />
                </button>

                <AnimatePresence>
                  {isFilterOpen && (
                    <motion.div
                      initial={{ opacity: 0, y: -10, scale: 0.95 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -10, scale: 0.95 }}
                      transition={{ duration: 0.15, ease: "easeOut" }}
                      className="absolute right-0 mt-2 w-48 bg-[#1a1b1e]/95 backdrop-blur-xl border border-white/10 rounded-xl shadow-[0_10px_40px_rgba(0,0,0,0.5)] overflow-hidden z-50"
                    >
                      {(["all", "cloud", "offline"] as const).map((filter) => (
                        <button
                          key={filter}
                          onClick={() => {
                            setActiveFilter(filter);
                            setIsFilterOpen(false);
                          }}
                          className={`w-full text-left px-4 py-3 text-sm flex items-center justify-between transition-colors outline-none focus-visible:bg-white/10 ${
                            activeFilter === filter ? "bg-white/10 text-white" : "text-content-muted hover:bg-white/5 hover:text-content-secondary"
                          }`}
                        >
                          <span className={activeFilter === filter ? "capitalize font-['Outfit'] font-bold tracking-wide text-emerald-300 drop-shadow-[0_0_8px_rgba(52,211,153,0.8)]" : "capitalize font-['Outfit'] font-medium tracking-wide"}>
                            {filter === "all" ? "All Sources" : filter}
                          </span>
                          {activeFilter === filter && <Check className="w-4 h-4 text-emerald-300 drop-shadow-[0_0_8px_rgba(52,211,153,0.8)]" />}
                        </button>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>

            <div className="flex flex-col gap-2.5 min-h-[200px]">
              {filteredMaterials.length > 0 ? (
                filteredMaterials.map((m, i) => (
                  <div key={m.id} className="cv-row">
                    <LessonRow
                      lesson={m}
                      idxLabel={String(i + 1).padStart(2, "0")}
                      missing={m.status === "missing"}
                      onOpen={() => navigate(`/library/material/${m.id}`, withSource("courses"))}
                      onToggleBookmark={() => void toggleBookmark(m.id)}
                      onDelete={() => openDeleteMaterial(m)}
                    />
                  </div>
                ))
              ) : (
                <motion.div 
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="glass flex h-32 flex-col items-center justify-center gap-2 rounded-xl border border-white/5 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]"
                >
                  <p className="text-sm font-medium text-content-secondary">No {activeTab} found for this filter.</p>
                  <p className="text-xs text-content-faint">Try changing your source filter.</p>
                </motion.div>
              )}
            </div>
          </section>
        )}

        {/* Empty states */}
        {(nodeEmpty || hubEmpty) && (
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

      {/* Unified deletion confirm — folder subtree vs single lesson */}
      <ConfirmDeleteModal
        open={deleteTarget != null}
        kind={deleteTarget?.kind ?? "material"}
        name={
          deleteTarget?.kind === "folder"
            ? deleteTarget.node.name
            : deleteTarget?.kind === "material"
              ? deleteTarget.material.file_name
              : ""
        }
        detail={
          deleteTarget?.kind === "folder"
            ? `${deleteTarget.node.material_count} file${
                deleteTarget.node.material_count === 1 ? "" : "s"
              }${deleteTarget.node.child_count > 0 ? ` · ${deleteTarget.node.child_count} subfolder${deleteTarget.node.child_count === 1 ? "" : "s"}` : ""}`
            : undefined
        }
        isBusy={deleteBusy}
        error={deleteError}
        onCancel={closeDelete}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}

/**
 * One lesson row: 3D numbered circle · title + muted metadata · bookmark · status.
 * Transparent background, faint bottom separator + 3D hover glow, no neon.
 *
 * Memoized: on a large folder, bookmarking one row previously re-rendered every row (the
 * page refetched + replaced the whole list). With the optimistic in-place update + memo,
 * only the toggled row re-renders. `onOpen`/`onToggleBookmark` are cheap inline closures;
 * `lesson` is a stable object reference except for the row that actually changed.
 */
const LessonRow = memo(function LessonRow({
  lesson,
  idxLabel,
  missing,
  onOpen,
  onToggleBookmark,
  onDelete,
}: {
  lesson: MaterialRowData;
  idxLabel: string;
  missing: boolean;
  onOpen: () => void;
  onToggleBookmark: () => void;
  onDelete?: () => void;
}) {
  const done = lesson.is_completed;
  const dur = lesson.duration_secs;
  const durLabel = dur != null && dur > 0 ? formatShortDuration(dur) : null;
  const inLabel =
    lesson.progress_pct > 0 && !done ? `${lesson.progress_pct}% in` : null;
  const FileIcon = FILE_ICON[lesson.file_type] ?? FileLucide;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      aria-label={`Play lesson: ${lesson.file_name}`}
      className={cn(
        "lesson-row group flex cursor-pointer items-center gap-4 bg-transparent px-3 py-4 outline-none border-b border-white/[0.04] transition-all duration-300 hover:bg-gradient-to-r hover:from-white/[0.06] hover:to-transparent hover:border-white/[0.05] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] focus-visible:ring-1 focus-visible:ring-white/30",
        missing && "opacity-60",
      )}
    >
      {/* Numbered circle — 3D tactile, identical for every row; cyan accent on hover */}
      <span
        aria-hidden
        className="w-9 h-9 rounded-full flex items-center justify-center bg-gradient-to-b from-white/[0.12] to-white/[0.02] border border-white/[0.15] shadow-[inset_0_1px_2px_rgba(255,255,255,0.2)] text-white/70 font-medium transition-all duration-300 group-hover:border-cyan-400/40 group-hover:text-cyan-400 group-hover:shadow-[inset_0_1px_3px_rgba(34,211,238,0.35)]"
      >
        {idxLabel}
      </span>

      {/* Title + muted metadata */}
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "truncate text-sm font-medium",
            missing ? "text-content-muted" : "text-content-primary",
          )}
        >
          {lesson.file_name}
          {missing && (
            <span className="ml-1.5 text-xs text-orange-400/80">· file missing</span>
          )}
        </p>
        <p className="mt-1 flex items-center gap-1.5 truncate text-xs text-content-muted">
          <FileIcon
            size={12}
            strokeWidth={2}
            aria-hidden
            className="shrink-0 text-content-muted"
          />
          {durLabel && <span>{durLabel}</span>}
          {durLabel && inLabel && (
            <span aria-hidden className="text-white/20">
              ·
            </span>
          )}
          {inLabel && (
            <span className="text-content-secondary">{inLabel}</span>
          )}
        </p>
      </div>

      {/* Bookmark — faint gray default, solid lime only when active */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleBookmark();
        }}
        aria-label={lesson.is_bookmarked ? "Remove bookmark" : "Bookmark lesson"}
        aria-pressed={lesson.is_bookmarked}
        className={cn(
          "grid h-8 w-8 shrink-0 place-items-center rounded-btn transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30",
          lesson.is_bookmarked
            ? "text-lime hover:bg-lime/10"
            : "text-white/30 hover:bg-white/[0.05] hover:text-white/50",
        )}
      >
        <Bookmark
          size={16}
          strokeWidth={2}
          fill={lesson.is_bookmarked ? "currentColor" : "none"}
          aria-hidden
        />
      </button>

      {/* Delete — hover-revealed trash, so it never gets in the way of the row's
          play/bookmark actions. Stops propagation so it never opens the lesson. */}
      {onDelete && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          aria-label={`Delete lesson: ${lesson.file_name}`}
          title="Delete lesson"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-btn text-white/25 opacity-0 transition-all duration-200 hover:bg-orange/15 hover:text-orange focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-orange/40 group-hover:opacity-100"
        >
          <Trash2 size={16} strokeWidth={2} aria-hidden />
        </button>
      )}

      {/* Status: subtle-green ✔ Done, or muted-orange Start › */}
      {done ? (
        <span className="flex shrink-0 items-center gap-1 text-xs font-semibold text-lime/70">
          <Check size={14} strokeWidth={3} aria-hidden />
          Done
        </span>
      ) : (
        <span className="flex shrink-0 items-center gap-1 text-xs font-semibold text-cyan-400/90">
          Start
          <ChevronRight size={13} strokeWidth={2.5} aria-hidden />
        </span>
      )}
    </div>
  );
});

/** Seconds → `H:MM:SS` / `M:SS`. */
function formatShortDuration(secs: number): string {
  const total = Math.floor(secs);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
