/**
 * MiniPlayer — an in-app docked mini-player for the global MPV video (no second OS
 * window, cheap on the 4GB-RAM target). MPV is a global singleton that's never destroyed,
 * so when the user leaves the full player route mid-video we keep it playing and shrink
 * its native surface into a small floating card via `setVideoMarginRatio`.
 *
 * Mounted ONCE in AppShell. It docks only when: a video is active, the user isn't on the
 * player route (where the full MpvVideoPlayer owns MPV), it wasn't dismissed, and we're in
 * Tauri. It reports its VIDEO rect to `miniPlayerStore` so AppShell can cut a matching
 * transparent hole in the opaque ambient canvas (MPV renders behind the webview and is
 * only visible through transparent pixels).
 *
 * ── Why the layout is the way it is (hard-won) ───────────────────────────────
 * The card is NOT a normal floating panel: the video you see is the OS-level MPV surface
 * showing through a clip-path hole punched in the whole app. That imposes strict rules the
 * previous drag attempt violated (causing a phantom frame at 0,0, a flickering hole seam,
 * and dead buttons):
 *   1. The VIDEO area is only ever a clean transparent hole + click-to-expand. It is NEVER
 *      a drag handle — dragging the surface fought the hole and produced the flicker.
 *   2. Dragging is done by the CONTROL STRIP (grab cursor); resizing by a corner grip only.
 *      Buttons inside the strip bail out of the gesture so they still click normally.
 *   3. The strip is OPAQUE (no backdrop-blur): a blurred surface adjacent to the transparent
 *      hole makes the compositor flicker the seam on every hover repaint.
 *   4. MPV is NEVER repositioned mid-gesture. During a drag/resize we drop the hole
 *      (setRect(null)) and show an opaque freeze placeholder, move only the webview card via
 *      translate3d on a ref inside a rAF (zero React/store writes per move), and re-sync MPV
 *      exactly ONCE on release — measuring the video rect INSIDE a rAF (after the transform
 *      has committed) and skipping the call if the rect is degenerate (the 0,0 phantom-frame
 *      guard).
 * The two surfaces stay mutually exclusive: MpvVideoPlayer is unmounted whenever this docks.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { command, setProperty, setVideoMarginRatio } from "tauri-plugin-libmpv-api";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Play, Pause, X, Maximize2, GripHorizontal } from "lucide-react";
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

type GestureKind = "drag" | "resize";
interface Gesture {
  kind: GestureKind;
  startX: number;
  startY: number;
  origin: MiniFrame;
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
    el.style.height = `${miniCardHeight(c.w)}px`;
  }, []);

  // Align MPV's native surface to the VIDEO rect + report the rect for the ambient-canvas
  // cutout. Runs inside a rAF so it measures AFTER any transform/width change has committed
  // to layout (the previous synchronous measure could read a stale 0,0 rect → MPV painted a
  // phantom frame in the top-left). Skips the IPC on a degenerate rect for the same reason.
  const align = useCallback(async () => {
    if (!winMetricsRef.current) await refreshWinMetrics();
    const m = winMetricsRef.current;
    if (!m) return;
    requestAnimationFrame(() => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // Degenerate-rect guard: never send 0-size / off-screen coords to MPV (that's what
      // painted the stray frame at the corner). Bail and leave the last good alignment.
      if (rect.width < 20 || rect.height < 20) return;
      setRect({ x: rect.left, y: rect.top, w: rect.width, h: rect.height });
      void setVideoMarginRatio({
        left: Math.max(0, rect.left / m.w),
        right: Math.max(0, (m.w - rect.right) / m.w),
        top: Math.max(0, rect.top / m.h),
        bottom: Math.max(0, (m.h - rect.bottom) / m.h),
      }).catch(() => {});
    });
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
      if (g.kind === "drag") {
        liveFrameRef.current = { x: g.origin.x + dx, y: g.origin.y + dy, w: g.origin.w };
      } else {
        const w = Math.min(MINI_MAX_W, Math.max(MINI_MIN_W, g.origin.w + dx));
        liveFrameRef.current = { x: g.origin.x, y: g.origin.y, w };
      }
      scheduleApply();
    },
    [scheduleApply],
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
    // Commit once (clamped + persisted); the frame effect re-applies the DOM + re-aligns
    // mpv with a single setVideoMarginRatio + setRect (measured in a rAF).
    setFrame(liveFrameRef.current);
    setGesturing(false);
  }, [onGestureMove, setFrame]);

  const beginGesture = useCallback(
    (kind: GestureKind, e: React.PointerEvent) => {
      // Never start a gesture from an interactive control (play/expand/close) — let the
      // click through. Only empty drag-handle / grip pixels start a move/resize.
      if ((e.target as HTMLElement).closest("button")) return;
      e.preventDefault();
      gestureRef.current = {
        kind,
        startX: e.clientX,
        startY: e.clientY,
        origin: { ...liveFrameRef.current },
      };
      // Enter gesture mode immediately: drop the mpv hole + show the freeze placeholder so
      // there is no transparent surface to misalign while the card moves.
      setGesturing(true);
      setRect(null);
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
      <div className="relative flex h-full flex-col overflow-hidden rounded-[16px] border border-white/[0.1] shadow-2xl [box-shadow:0_20px_50px_-12px_rgba(0,0,0,0.7),inset_0_1px_1px_rgba(255,255,255,0.08)]">
        {/* Transparent video anchor — MPV draws through here (16:9). Click to expand; it is
            NOT a drag handle (dragging the surface fights the hole). */}
        <div
          ref={anchorRef}
          className="relative aspect-video w-full cursor-pointer bg-transparent"
          onClick={expand}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              expand();
            }
          }}
          aria-label="Return to full player"
        >
          {/* Freeze-frame placeholder — shown only WHILE dragging/resizing, when the mpv
              cutout is dropped so the surface isn't visible. Opaque, so there's nothing to
              misalign; the video keeps playing (audio) and snaps back on release. */}
          {gesturing && (
            <div className="absolute inset-0 grid place-items-center bg-ink-850 text-content-muted">
              <span className="flex items-center gap-1.5 text-xs">
                <GripHorizontal size={14} strokeWidth={2} aria-hidden />
                {isPlaying ? "Playing…" : "Paused"}
              </span>
            </div>
          )}
        </div>

        {/* Control strip — ALSO the drag handle (grab cursor on empty areas). OPAQUE (no
            backdrop-blur) so it can't flicker against the transparent hole above it. Buttons
            bail out of the gesture (beginGesture ignores presses that land on a button). */}
        <div
          onPointerDown={(e) => beginGesture("drag", e)}
          className={cn(
            "flex select-none items-center gap-2 bg-ink-900 px-2.5 py-2",
            gesturing ? "cursor-grabbing" : "cursor-grab",
          )}
        >
          <button
            type="button"
            onClick={togglePlay}
            aria-label={isPlaying ? "Pause" : "Play"}
            className="grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-full bg-lime text-ink-900 transition-transform hover:scale-105"
          >
            {isPlaying ? (
              <Pause size={15} strokeWidth={2.5} fill="currentColor" aria-hidden />
            ) : (
              <Play size={15} strokeWidth={2.5} fill="currentColor" aria-hidden />
            )}
          </button>
          <span
            className="min-w-0 flex-1 truncate text-xs text-content-secondary"
            title={fileName ?? ""}
          >
            {fileName ?? "Now playing"}
          </span>
          <button
            type="button"
            onClick={expand}
            aria-label="Expand to full player"
            className="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-full text-content-secondary transition-colors hover:bg-white/[0.08] hover:text-content-primary"
          >
            <Maximize2 size={14} strokeWidth={2} aria-hidden />
          </button>
          <button
            type="button"
            onClick={close}
            aria-label="Close mini player"
            className="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-full text-content-secondary transition-colors hover:bg-red-400/10 hover:text-red-400"
          >
            <X size={14} strokeWidth={2} aria-hidden />
          </button>
        </div>

        {/* Resize grip — bottom-right corner. Drags the width (height follows 16:9). */}
        <div
          onPointerDown={(e) => beginGesture("resize", e)}
          className="absolute bottom-0 right-0 z-10 h-5 w-5 cursor-nwse-resize touch-none"
          role="separator"
          aria-label="Resize mini player"
          aria-orientation="horizontal"
        >
          <span
            aria-hidden
            className="pointer-events-none absolute bottom-1 right-1 h-2.5 w-2.5 border-b-2 border-r-2 border-white/50"
          />
        </div>
      </div>
    </div>
  );
}
