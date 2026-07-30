/**
 * MiniPlayer — an in-app docked mini-player for the global MPV video (no second OS
 * window, cheap on the 4GB-RAM target). MPV is a global singleton that's never destroyed,
 * so when the user leaves the full player route mid-video we keep it playing and shrink
 * its native surface into a small floating card via `setVideoMarginRatio`.
 *
 * Mounted ONCE in AppShell. It docks only when: a video is active, the user isn't on the
 * player route (where the full MpvVideoPlayer owns MPV), it wasn't dismissed, and we're in
 * Tauri. It reports its live rect to `miniPlayerStore` so AppShell can cut a matching
 * transparent hole in the opaque ambient canvas (MPV renders behind the webview and is
 * only visible through transparent pixels).
 *
 * ── Drag + resize (60fps, no mpv thrash) ─────────────────────────────────────
 * The card is draggable (by its video area) and resizable (bottom-right grip). The gesture
 * is done ENTIRELY on a DOM ref inside a rAF loop — pointermove only writes the pending
 * frame to a ref; one rAF applies `transform: translate3d()` + width. There is NO React
 * state or zustand write per move, so a weak CPU never sees the "thousands of updates"
 * choke. mpv is NOT repositioned during the gesture: on drag start we drop the clip-path
 * hole (setRect(null)) and show a freeze-frame placeholder, so the decoder is never asked
 * to move mid-gesture (no lag / no rapid-IPC crash). On release we commit the frame once
 * (persisted + clamped) and fire exactly ONE setVideoMarginRatio + setRect to snap mpv to
 * the new rect. The two surfaces stay mutually exclusive: MpvVideoPlayer is unmounted
 * whenever this docks, so only one component ever calls `setVideoMarginRatio` at a time.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { command, setProperty, setVideoMarginRatio } from "tauri-plugin-libmpv-api";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Play, Pause, X, Maximize2, GripVertical } from "lucide-react";
import {
  useMiniPlayer,
  clampFrame,
  miniCardHeight,
  MINI_MIN_W,
  MINI_MAX_W,
  type MiniFrame,
} from "../../lib/miniPlayerStore";
import { isTauri } from "../../lib/ipc";
import { cn } from "../../lib/utils";

/** Pointer travel (px) before a press on the video is treated as a drag (vs. a click). */
const DRAG_THRESHOLD = 4;

type GestureKind = "drag" | "resize";
interface Gesture {
  kind: GestureKind;
  startX: number;
  startY: number;
  origin: MiniFrame;
  moved: boolean;
}

export default function MiniPlayer() {
  const location = useLocation();
  const navigate = useNavigate();
  const { materialId, fileName, active, dismissed, frame, setRect, setFrame, dismiss } =
    useMiniPlayer();

  const isPlayerRoute = location.pathname.includes("/library/material/");
  const shouldDock = isTauri() && active && !dismissed && !isPlayerRoute && materialId != null;

  const cardRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const winMetricsRef = useRef<{ w: number; h: number } | null>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  // Toggled ONCE at gesture start / end (not per move) — drives the freeze-frame overlay.
  const [gesturing, setGesturing] = useState(false);

  // Live gesture bookkeeping (refs → zero re-render during the drag).
  const gestureRef = useRef<Gesture | null>(null);
  const liveFrameRef = useRef<MiniFrame>(frame);
  const rafRef = useRef<number | null>(null);

  // Cache window metrics (only change on resize) → single async call to align MPV.
  const refreshWinMetrics = useCallback(async () => {
    try {
      const win = await getCurrentWindow().innerSize();
      const dpr = await getCurrentWindow().scaleFactor();
      const w = win.width / dpr;
      const h = win.height / dpr;
      if (w > 0 && h > 0) winMetricsRef.current = { w, h };
    } catch {
      /* keep last metrics */
    }
  }, []);

  // Write a frame straight to the DOM (transform + width) — the hot path during a gesture.
  const applyFrameToDom = useCallback((f: MiniFrame) => {
    const el = cardRef.current;
    if (!el) return;
    const c = clampFrame(f);
    el.style.transform = `translate3d(${c.x}px, ${c.y}px, 0)`;
    el.style.width = `${c.w}px`;
  }, []);

  // Align MPV's native surface to the card's current rect + report the rect for the
  // ambient-canvas cutout. Called on dock, on resize settle, and ONCE on gesture release —
  // never per move (that per-tick mpv IPC was the resize jank / decoder-lag risk).
  const align = useCallback(async () => {
    const el = anchorRef.current;
    if (!el) return;
    if (!winMetricsRef.current) await refreshWinMetrics();
    const m = winMetricsRef.current;
    if (!m) return;
    const rect = el.getBoundingClientRect();
    setRect({ x: rect.left, y: rect.top, w: rect.width, h: rect.height });
    void setVideoMarginRatio({
      left: Math.max(0, rect.left / m.w),
      right: Math.max(0, (m.w - rect.right) / m.w),
      top: Math.max(0, rect.top / m.h),
      bottom: Math.max(0, (m.h - rect.bottom) / m.h),
    }).catch(() => {});
  }, [refreshWinMetrics, setRect]);

  // Keep the live ref in sync with the committed frame whenever it changes from the store.
  useEffect(() => {
    liveFrameRef.current = frame;
  }, [frame]);

  // Place the card + align MPV whenever the committed frame changes and we're NOT mid
  // gesture (initial dock, post-gesture commit, window-resize re-clamp). During a gesture
  // the DOM is driven by the rAF loop instead, so we skip to avoid fighting it.
  useEffect(() => {
    if (!shouldDock) {
      setRect(null);
      return;
    }
    if (gesturing) return;
    applyFrameToDom(frame);
    void refreshWinMetrics().then(() => align());
  }, [shouldDock, frame, gesturing, applyFrameToDom, refreshWinMetrics, align, setRect]);

  // On undock, clear the rect cutout (MpvVideoPlayer, if we returned to the player route,
  // re-aligns to full). Re-clamp the frame on window resize so the card can't end up
  // off-screen; the debounce keeps a drag-resize from re-aligning mpv on every tick.
  useEffect(() => {
    if (!shouldDock) return;
    let t: number | undefined;
    const onResize = () => {
      if (t !== undefined) window.clearTimeout(t);
      t = window.setTimeout(() => {
        void refreshWinMetrics();
        setFrame(liveFrameRef.current); // clamp to the new viewport (triggers re-align)
      }, 120);
    };
    window.addEventListener("resize", onResize);
    return () => {
      if (t !== undefined) window.clearTimeout(t);
      window.removeEventListener("resize", onResize);
      setRect(null);
    };
  }, [shouldDock, refreshWinMetrics, setFrame, setRect]);

  // Track MPV pause state via the global mpv-event bridge (dispatched by MpvVideoPlayer's
  // observer). Cheap — a single window listener, no polling.
  useEffect(() => {
    const onEvent = (e: Event) => {
      const { name, data } = (e as CustomEvent).detail ?? {};
      if (name === "pause") setIsPlaying(!data);
    };
    window.addEventListener("mpv-event", onEvent);
    return () => window.removeEventListener("mpv-event", onEvent);
  }, []);

  // ── Gesture plumbing ────────────────────────────────────────────────────────
  const scheduleApply = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      applyFrameToDom(liveFrameRef.current);
    });
  }, [applyFrameToDom]);

  const onGestureMove = useCallback(
    (ev: PointerEvent) => {
      const g = gestureRef.current;
      if (!g) return;
      const dx = ev.clientX - g.startX;
      const dy = ev.clientY - g.startY;

      // Defer the visible gesture (freeze-frame + drop the mpv hole) until the pointer has
      // actually travelled — so a plain click on the video still expands to the full player
      // without flashing the placeholder.
      if (!g.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!g.moved) {
        g.moved = true;
        setGesturing(true);
        setRect(null); // drop the mpv cutout; the freeze-frame overlay takes over
      }

      if (g.kind === "drag") {
        liveFrameRef.current = { x: g.origin.x + dx, y: g.origin.y + dy, w: g.origin.w };
      } else {
        const w = Math.min(MINI_MAX_W, Math.max(MINI_MIN_W, g.origin.w + dx));
        liveFrameRef.current = { x: g.origin.x, y: g.origin.y, w };
      }
      scheduleApply();
    },
    [scheduleApply, setRect],
  );

  const onGestureEnd = useCallback(() => {
    const g = gestureRef.current;
    gestureRef.current = null;
    window.removeEventListener("pointermove", onGestureMove);
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (!g) return;
    if (!g.moved) {
      // No travel → it was a click on the video: expand to the full player.
      if (g.kind === "drag") navigate(`/library/material/${materialId}`);
      return;
    }
    // Commit once (clamped + persisted); the frame effect re-applies the DOM + re-aligns
    // mpv with a single setVideoMarginRatio + setRect.
    setFrame(liveFrameRef.current);
    setGesturing(false);
  }, [onGestureMove, navigate, materialId, setFrame]);

  const beginGesture = useCallback(
    (kind: GestureKind, e: React.PointerEvent) => {
      e.preventDefault();
      gestureRef.current = {
        kind,
        startX: e.clientX,
        startY: e.clientY,
        origin: { ...liveFrameRef.current },
        moved: false,
      };
      // The resize grip has no click meaning, so start the visible gesture immediately.
      if (kind === "resize") {
        gestureRef.current.moved = true;
        setGesturing(true);
        setRect(null);
      }
      window.addEventListener("pointermove", onGestureMove);
      window.addEventListener("pointerup", onGestureEnd, { once: true });
    },
    [onGestureMove, onGestureEnd, setRect],
  );

  // Tidy up any dangling gesture listeners on unmount.
  useEffect(
    () => () => {
      window.removeEventListener("pointermove", onGestureMove);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    },
    [onGestureMove],
  );

  if (!shouldDock) return null;

  const togglePlay = () => void setProperty("pause", isPlaying).catch(() => {});
  const expand = () => navigate(`/library/material/${materialId}`);
  const close = () => {
    void command("stop", []).catch(() => {}); // stop playback; keeps the engine alive
    void setVideoMarginRatio({ left: 0, right: 1, top: 0, bottom: 1 }).catch(() => {});
    dismiss();
  };

  const initialH = miniCardHeight(frame.w);

  return (
    // Positioned via transform (translate3d) for GPU-composited, state-free dragging.
    // top/left 0 + transform is cheaper to update than left/top and never triggers layout.
    <div
      ref={cardRef}
      className="fixed left-0 top-0 z-[70] will-change-transform"
      style={{
        transform: `translate3d(${frame.x}px, ${frame.y}px, 0)`,
        width: `${frame.w}px`,
        height: `${initialH}px`,
      }}
    >
      <div className="relative overflow-hidden rounded-[16px] border border-white/[0.1] shadow-2xl [box-shadow:0_20px_50px_-12px_rgba(0,0,0,0.7),inset_0_1px_1px_rgba(255,255,255,0.08)]">
        {/* Transparent video anchor — MPV draws through here (16:9). Doubles as the drag
            handle: press-and-move drags the card; a plain click (no travel) expands. */}
        <div
          ref={anchorRef}
          className={cn(
            "relative aspect-video w-full touch-none bg-transparent",
            gesturing ? "cursor-grabbing" : "cursor-grab",
          )}
          onPointerDown={(e) => beginGesture("drag", e)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              expand();
            }
          }}
          aria-label="Drag to move, or press Enter to return to full player"
        >
          {/* Freeze-frame placeholder — shown only WHILE dragging/resizing, when the mpv
              cutout is dropped so the surface isn't visible. Keeps the card looking solid
              and intentional; the video keeps playing (audio) and snaps back on release. */}
          {gesturing && (
            <div className="absolute inset-0 grid place-items-center bg-ink-850 text-content-muted">
              <span className="flex items-center gap-1.5 text-xs">
                <GripVertical size={13} strokeWidth={2} aria-hidden />
                {isPlaying ? "Playing…" : "Paused"}
              </span>
            </div>
          )}
        </div>

        {/* Control strip */}
        <div className="flex items-center gap-2 bg-ink-900/80 px-2.5 py-2 backdrop-blur-xl">
          <button
            type="button"
            onClick={togglePlay}
            aria-label={isPlaying ? "Pause" : "Play"}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-lime text-ink-900 transition-transform hover:scale-105"
          >
            {isPlaying ? (
              <Pause size={15} strokeWidth={2.5} fill="currentColor" aria-hidden />
            ) : (
              <Play size={15} strokeWidth={2.5} fill="currentColor" aria-hidden />
            )}
          </button>
          <span className="min-w-0 flex-1 truncate text-xs text-content-secondary" title={fileName ?? ""}>
            {fileName ?? "Now playing"}
          </span>
          <button
            type="button"
            onClick={expand}
            aria-label="Expand to full player"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-content-secondary transition-colors hover:bg-white/[0.08] hover:text-content-primary"
          >
            <Maximize2 size={14} strokeWidth={2} aria-hidden />
          </button>
          <button
            type="button"
            onClick={close}
            aria-label="Close mini player"
            className={cn(
              "grid h-7 w-7 shrink-0 place-items-center rounded-full text-content-secondary transition-colors hover:bg-red-400/10 hover:text-red-400",
            )}
          >
            <X size={14} strokeWidth={2} aria-hidden />
          </button>
        </div>

        {/* Resize grip — bottom-right corner. Drags the width (height follows 16:9). */}
        <div
          onPointerDown={(e) => beginGesture("resize", e)}
          className="absolute bottom-0 right-0 z-10 h-4 w-4 cursor-nwse-resize touch-none"
          role="separator"
          aria-label="Resize mini player"
          aria-orientation="horizontal"
        >
          <span
            aria-hidden
            className="pointer-events-none absolute bottom-1 right-1 h-2 w-2 border-b-2 border-r-2 border-white/40"
          />
        </div>
      </div>
    </div>
  );
}
