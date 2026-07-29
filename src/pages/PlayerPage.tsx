/**
 * Player page (Section 8 Page 6) — premium 3-column layout matching the reference
 * design: minimized sidebar (handled by AppShell) + middle column (video frame +
 * description) + right column (lesson overview).
 *
 * Transparent-window constraint: the video frame is the ONLY transparent area (mpv
 * renders behind the webview). All surrounding areas use opaque borders/backgrounds
 * that are SIBLINGS of the video frame (not ancestors) so they don't block mpv.
 * "Breathing" gaps are created with opaque borders on the transparent containers,
 * not padding/margins (which would be transparent → desktop bleed-through).
 */

import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import Breadcrumb from "../components/layout/Breadcrumb";
import BackButton from "../components/layout/BackButton";
import LessonOverview from "../components/player/LessonOverview";
import NotesPanel from "../components/player/NotesPanel";
import VideoPlayer from "../components/player/VideoPlayer";
import AudioPlayer from "../components/player/AudioPlayer";
import PdfViewer from "../components/player/PdfViewer";
import ImageViewer from "../components/player/ImageViewer";
import { ipc, isTauri, NotInTauriError } from "../lib/ipc";
import { navSource, withSource } from "../lib/navigation";
import type { PlayerView } from "../lib/types";

const MpvVideoPlayer = lazy(() => import("../components/player/MpvVideoPlayer"));

type State =
  | { kind: "loading" }
  | { kind: "ready"; view: PlayerView }
  | { kind: "preview" }
  | { kind: "error"; message: string };

const TYPE_GLYPH: Record<string, string> = {
  video: "🎬",
  pdf: "📄",
  note: "📝",
  image: "🖼️",
  audio: "🎧",
};

export default function PlayerPage() {
  const { materialId } = useParams();
  const id = Number(materialId);
  const navigate = useNavigate();
  const location = useLocation();
  // Where this player was launched from ("courses" | "library") — travels in the
  // router location state; defaults to the Library tree when absent.
  const source = navSource(location);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [bookmarked, setBookmarked] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [engine, setEngine] = useState<"mpv" | "html5">("mpv");
  // Mirror the Tauri OS-window fullscreen state so the page can hide its chrome
  // (header, right panel, description) and fix the video anchor to fill the screen.
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Right-panel tab: the lesson list, or timestamped notes (video only).
  const [rightTab, setRightTab] = useState<"lessons" | "notes">("lessons");

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    // Tauri v2 has no dedicated fullscreen event; onResized fires on the size
    // change a fullscreen transition causes, so re-read isFullscreen() there.
    const onChange = async () => {
      try {
        setIsFullscreen(await getCurrentWindow().isFullscreen());
      } catch {
        /* ignore */
      }
    };
    getCurrentWindow()
      .onResized(() => void onChange())
      .then((u) => (unlisten = u))
      .catch(() => {});
      
    // Listen for the explicit toggle from the video player to bypass OS polling delays.
    const onFsEvent = (e: Event) => setIsFullscreen((e as CustomEvent).detail);
    window.addEventListener('app-fullscreen-changed', onFsEvent);
    
    return () => {
      unlisten?.();
      window.removeEventListener('app-fullscreen-changed', onFsEvent);
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    ipc.getSetting("player.engine").then((v) => {
      if (v === "mpv" || v === "html5") setEngine(v);
    }).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    if (!isTauri()) { setState({ kind: "preview" }); return; }
    setState({ kind: "loading" });
    try {
      const view = await ipc.openMaterial(id);
      setState({ kind: "ready", view });
      setBookmarked(view.material.is_bookmarked);
      setCompleted(view.material.is_completed);
    } catch (err) {
      const message = err instanceof NotInTauriError ? err.message : err instanceof Error ? err.message : String(err);
      setState({ kind: "error", message });
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  // Listen for background metadata extraction to update UI dynamically
  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen<{ material_id: number; duration_secs: number | null; thumbnail_path: string | null }>(
      "metadata://extracted",
      (event) => {
        setState((prev) => {
          if (prev.kind !== "ready") return prev;
          
          // Update siblings
          const updatedSiblings = prev.view.siblings.map((m) => {
            if (m.id === event.payload.material_id) {
              return { ...m, duration_secs: event.payload.duration_secs, thumbnail_path: event.payload.thumbnail_path };
            }
            return m;
          });
          
          // Update main material if it's the one currently open
          const updatedMaterial = prev.view.material.id === event.payload.material_id 
            ? { ...prev.view.material, duration_secs: event.payload.duration_secs, thumbnail_path: event.payload.thumbnail_path } 
            : prev.view.material;

          return { ...prev, view: { ...prev.view, siblings: updatedSiblings, material: updatedMaterial } };
        });
      }
    );
    return () => { void unlisten.then((fn) => fn()); };
  }, []);

  const toggleBookmark = async () => {
    const next = !bookmarked; setBookmarked(next);
    try { await ipc.setBookmark(id, next); } catch { setBookmarked(!next); }
  };
  const toggleComplete = async () => {
    const next = !completed; setCompleted(next);
    try { await ipc.setCompleted(id, next); } catch { setCompleted(!next); }
  };

  // M/N/P shortcuts.
  useEffect(() => {
    if (state.kind !== "ready") return;
    const siblings = state.view.siblings;
    const currentIdx = siblings.findIndex((m) => m.id === id);
    const goTo = (offset: number) => {
      const next = siblings[currentIdx + offset];
      // Re-pass the source state or the courses/library context is dropped on the jump.
      if (next) navigate(`/library/material/${next.id}`, withSource(source));
    };
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "m" || e.key === "M") { e.preventDefault(); void toggleComplete(); }
      else if (e.key === "n" || e.key === "N") { e.preventDefault(); goTo(1); }
      else if (e.key === "p" || e.key === "P") { e.preventDefault(); goTo(-1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.kind, completed, id, navigate, source]);

  const onMpvFail = useCallback(() => setEngine("html5"), []);

  const material = state.kind === "ready" ? state.view.material : null;
  const siblings = state.kind === "ready" ? state.view.siblings : [];
  const usingMpv = engine === "mpv" && state.kind === "ready" && material?.file_type === "video";
  // Breadcrumbs follow the launch surface: from Courses the trail is
  // Courses → Subject (course detail) → File; from the Library it stays the classic
  // Goal → Subject → Chapter tree. Anything without state defaults to the Library.
  const fromCourses = source === "courses";
  const crumbs = state.kind === "ready"
    ? fromCourses
      ? [
          { label: "Courses", to: "/courses" },
          { label: state.view.material.subject_name, to: `/courses/${state.view.material.subject_id}` },
          { label: state.view.material.file_name },
        ]
      : [
          { label: "Library", to: "/library" },
          { label: state.view.material.goal_name, to: `/library/goal/${state.view.material.goal_id}` },
          { label: state.view.material.subject_name, to: `/library/subject/${state.view.material.subject_id}` },
          { label: state.view.material.chapter_name, to: `/library/chapter/${state.view.material.chapter_id}` },
          { label: state.view.material.file_name },
        ]
    : [
        { label: fromCourses ? "Courses" : "Library", to: fromCourses ? "/courses" : "/library" },
        { label: "Player" },
      ];

  // Back destination = the launch surface's parent page: the course detail when
  // launched from Courses, the chapter page from the Library tree (never lesson N-1,
  // which is what raw history-back would give after N/P jumps).
  const playerParent =
    state.kind === "ready"
      ? fromCourses
        ? `/courses/${state.view.material.subject_id}`
        : `/library/chapter/${state.view.material.chapter_id}`
      : fromCourses
        ? "/courses"
        : "/library";

  return (
    <div className="flex h-full flex-col">
      {/* ── Compact top bar (opaque) — hidden when the OS window is fullscreen ── */}
      {!isFullscreen && (
        <div className="shrink-0 bg-ink-900 px-4 pb-2 pt-1.5">
          <div className="flex items-center gap-3">
            <BackButton to={playerParent} state={{ source }} />
            <Breadcrumb items={crumbs} />
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-4">
            <h1 className="truncate text-base font-bold text-content-primary" title={material?.file_name ?? ""}>
              {material?.file_name ?? "Material"}
            </h1>
            {state.kind === "ready" && (
              <div className="flex shrink-0 items-center gap-2">
                <button type="button" onClick={() => void toggleBookmark()}
                  className={"rounded-btn border px-2.5 py-1 text-xs font-medium transition-colors " + (bookmarked ? "border-lime/40 bg-lime/10 text-lime" : "border-white/10 text-content-secondary hover:bg-white/[0.05]")}
                  aria-pressed={bookmarked}>
                  {bookmarked ? "★" : "☆"}
                </button>
                <button type="button" onClick={() => void toggleComplete()}
                  className={"rounded-btn border px-2.5 py-1 text-xs font-medium transition-colors " + (completed ? "border-lime/40 bg-lime/10 text-lime" : "border-white/10 text-content-secondary hover:bg-white/[0.05]")}
                  aria-pressed={completed} title="M">
                  {completed ? "✓" : "○"}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── 3-column content (transparent; gaps via opaque borders) ────────────
          In fullscreen, collapse to JUST the video anchor (fixed inset-0, filling the
          screen) — the description + right column are hidden, the borders removed. */}
      {isFullscreen ? (
        <div className="fixed inset-0 z-20">
          {/* Video anchor — transparent for the mpv overlay to fill the screen */}
          <div className={"absolute inset-0 " + (usingMpv ? "" : "bg-black")}>
            {state.kind === "ready" && material && material.file_type === "video" && (
              usingMpv ? (
                <Suspense fallback={null}>
                  <MpvVideoPlayer path={material.file_path} materialId={material.id} startPosition={material.position_secs} onFail={onMpvFail} />
                </Suspense>
              ) : (
                <VideoPlayer path={material.file_path} materialId={material.id} startPosition={material.position_secs} />
              )
            )}
            {state.kind === "ready" && material && material.file_type === "audio" && (
              <AudioPlayer path={material.file_path} materialId={material.id} startPosition={material.position_secs} />
            )}
            {state.kind === "ready" && material && material.file_type === "pdf" && (
              <PdfViewer path={material.file_path} />
            )}
            {state.kind === "ready" && material && material.file_type === "image" && (
              <ImageViewer path={material.file_path} />
            )}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Middle column — transparent, with opaque borders for breathing gaps */}
          <div className="flex min-w-0 flex-1 flex-col border-l-4 border-t-4 border-ink-900">
            {/* Video frame — fluidly fills the space, native player handles aspect ratio natively */}
            <div className="relative flex-1 w-full min-h-[400px] overflow-hidden shadow-2xl">
              <div className={"absolute inset-0 " + (usingMpv ? "" : "bg-black")}>
                {state.kind === "loading" && (
                  <div className="grid h-full place-items-center bg-ink-900 text-sm text-content-muted">Loading…</div>
                )}
                {state.kind === "ready" && material && material.file_type === "video" && (
                  usingMpv ? (
                    <Suspense fallback={<div className="grid h-full place-items-center bg-ink-900 text-sm text-content-muted">Loading player…</div>}>
                      <MpvVideoPlayer path={material.file_path} materialId={material.id} startPosition={material.position_secs} onFail={onMpvFail} />
                    </Suspense>
                  ) : (
                    <VideoPlayer path={material.file_path} materialId={material.id} startPosition={material.position_secs} />
                  )
                )}
                {state.kind === "ready" && material && material.file_type === "audio" && (
                  <AudioPlayer path={material.file_path} materialId={material.id} startPosition={material.position_secs} />
                )}
                {state.kind === "ready" && material && material.file_type === "pdf" && (
                  <PdfViewer path={material.file_path} />
                )}
                {state.kind === "ready" && material && material.file_type === "image" && (
                  <ImageViewer path={material.file_path} />
                )}
                {state.kind === "ready" && material && material.file_type === "note" && (
                  <div className="grid h-full place-items-center bg-ink-900 p-card text-center text-sm text-content-muted">Note preview arrives in a later milestone.</div>
                )}
                {state.kind === "preview" && (
                  <div className="grid h-full place-items-center bg-ink-900 p-card text-center text-sm text-content-muted">Preview mode — open inside the desktop app.</div>
                )}
                {state.kind === "error" && (
                  <div className="grid h-full place-items-center bg-ink-900 p-card text-center text-sm text-orange">
                    {state.message}
                    <button type="button" onClick={() => void load()} className="ml-3 rounded-btn border border-orange/40 px-2.5 py-1 text-xs text-orange hover:bg-orange/10">Retry</button>
                  </div>
                )}
              </div>
            </div>

            {/* Description section (compact at the bottom) */}
            {state.kind === "ready" && material && (
              <div className="shrink-0 overflow-y-auto bg-ink-900 px-6 pb-4 pt-5 scroll-thin border-t border-glass-border">
                <div className="flex items-center gap-2 text-sm text-content-muted">
                  <span>{TYPE_GLYPH[material.file_type] ?? "📁"}</span>
                  <span className="uppercase tracking-wide">{material.file_type}</span>
                  <span>·</span>
                  <span>{material.chapter_name}</span>
                  <span>·</span>
                  <span>{material.subject_name}</span>
                </div>
                <h2 className="mt-2 text-lg font-semibold text-content-primary">{material.file_name}</h2>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={() => void toggleBookmark()}
                    className={"rounded-btn border px-3 py-1.5 text-xs font-medium transition-colors " + (bookmarked ? "border-lime/40 bg-lime/10 text-lime" : "border-white/10 text-content-secondary hover:bg-white/[0.05]")}>
                    {bookmarked ? "★ Bookmarked" : "☆ Bookmark"}
                  </button>
                  <button type="button" onClick={() => void toggleComplete()}
                    className={"rounded-btn border px-3 py-1.5 text-xs font-medium transition-colors " + (completed ? "border-lime/40 bg-lime/10 text-lime" : "border-white/10 text-content-secondary hover:bg-white/[0.05]")}
                    title="M">
                    {completed ? "✓ Completed" : "Mark complete"}
                  </button>
                  <button type="button" onClick={() => void ipc.openInSystemPlayer(material.file_path)}
                    className="rounded-btn border border-white/10 px-3 py-1.5 text-xs font-medium text-content-secondary transition-colors hover:bg-white/[0.05]">
                    ⤴ Open in system player
                  </button>
                </div>
                <p className="mt-4 text-sm leading-relaxed text-content-secondary">
                  {material.goal_name} · {material.subject_name} · {material.chapter_name}
                </p>
                <p className="mt-2 text-xs text-content-faint">
                  File: {material.file_name} · Type: {material.file_type.toUpperCase()}
                </p>
              </div>
            )}
          </div>

          {/* Right column — Lesson Overview + (video) timestamped Notes, tabbed. */}
          {state.kind === "ready" && material && (
            <div className="flex shrink-0 flex-col border-t-4 border-ink-900 bg-ink-900">
              {material.file_type === "video" ? (
                <div className="flex min-h-0 w-[480px] flex-1 flex-col px-6 pb-6 pt-6">
                  {/* Tab switch */}
                  <div className="mb-4 flex shrink-0 items-center gap-1 self-start rounded-full border border-white/[0.06] bg-white/[0.02] p-1">
                    {(["lessons", "notes"] as const).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setRightTab(t)}
                        aria-pressed={rightTab === t}
                        className={
                          "rounded-full px-4 py-1.5 text-xs font-semibold capitalize transition-colors " +
                          (rightTab === t
                            ? "bg-white/[0.08] text-content-primary shadow-[inset_0_1px_1px_rgba(255,255,255,0.1)]"
                            : "text-content-secondary hover:bg-white/[0.04]")
                        }
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                  <div className="min-h-0 flex-1">
                    {rightTab === "lessons" ? (
                      <LessonOverview siblings={siblings} currentId={material.id} source={source} embedded />
                    ) : (
                      <NotesPanel materialId={material.id} />
                    )}
                  </div>
                </div>
              ) : (
                <LessonOverview siblings={siblings} currentId={material.id} source={source} />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
