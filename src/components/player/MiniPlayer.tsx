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
 * The two surfaces are mutually exclusive: MpvVideoPlayer is unmounted whenever this docks,
 * so only one component ever calls `setVideoMarginRatio` at a time.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { command, setProperty, setVideoMarginRatio } from "tauri-plugin-libmpv-api";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Play, Pause, X, Maximize2 } from "lucide-react";
import { useMiniPlayer } from "../../lib/miniPlayerStore";
import { isTauri } from "../../lib/ipc";
import { cn } from "../../lib/utils";

export default function MiniPlayer() {
  const location = useLocation();
  const navigate = useNavigate();
  const { materialId, fileName, active, dismissed, setRect, dismiss } = useMiniPlayer();

  const isPlayerRoute = location.pathname.includes("/library/material/");
  const shouldDock = isTauri() && active && !dismissed && !isPlayerRoute && materialId != null;

  const anchorRef = useRef<HTMLDivElement>(null);
  const winMetricsRef = useRef<{ w: number; h: number } | null>(null);
  const [isPlaying, setIsPlaying] = useState(true);

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

  // Dock: align MPV into the mini card; re-align on window resize. On undock, clear the
  // rect cutout (MpvVideoPlayer, if we returned to the player route, re-aligns to full).
  // The card is fixed to the bottom-right, so it only moves once resize SETTLES — debounce
  // the re-align so a drag-resize doesn't recompute the whole-app clip-path + fire an mpv
  // IPC on every tick (that per-tick churn was a source of jank during resize).
  useEffect(() => {
    if (!shouldDock) {
      setRect(null);
      return;
    }
    void refreshWinMetrics().then(() => align());
    let t: number | undefined;
    const onResize = () => {
      if (t !== undefined) window.clearTimeout(t);
      t = window.setTimeout(() => void refreshWinMetrics().then(() => align()), 120);
    };
    window.addEventListener("resize", onResize);
    return () => {
      if (t !== undefined) window.clearTimeout(t);
      window.removeEventListener("resize", onResize);
      setRect(null);
    };
  }, [shouldDock, align, refreshWinMetrics, setRect]);

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

  if (!shouldDock) return null;

  const togglePlay = () => void setProperty("pause", isPlaying).catch(() => {});
  const expand = () => navigate(`/library/material/${materialId}`);
  const close = () => {
    void command("stop", []).catch(() => {}); // stop playback; keeps the engine alive
    void setVideoMarginRatio({ left: 0, right: 1, top: 0, bottom: 1 }).catch(() => {});
    dismiss();
  };

  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[70] w-80">
      <div className="pointer-events-auto overflow-hidden rounded-[16px] border border-white/[0.1] shadow-2xl [box-shadow:0_20px_50px_-12px_rgba(0,0,0,0.7),inset_0_1px_1px_rgba(255,255,255,0.08)]">
        {/* Transparent video anchor — MPV draws through here (16:9). */}
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
        />

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
      </div>
    </div>
  );
}
