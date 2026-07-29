/**
 * Watch-progress persistence for media playback (Section 10, Section 15 perf rule).
 *
 * The seek bar + time display are driven by `requestAnimationFrame` in the component
 * (writing to the DOM directly) — never React state on `timeupdate` — so this hook
 * owns only the *persistence* layer shared by VideoPlayer and AudioPlayer:
 *
 *   - a periodic 15 s safety flush of position/duration to `save_progress`;
 *   - logging of genuinely-watched seconds to `log_session` (the Dashboard activity
 *     chart + streak read `study_sessions`, so this is what makes them show real data);
 *   - a final flush on unmount (covers route change / material switch) and a
 *     best-effort flush on `beforeunload` (window close).
 *
 * The component increments `accumulatedRef.current` from its rAF loop (delta × rate,
 * only while actually playing) so session logging reflects real watch time, not wall
 * time spent paused on the page.
 */

import { useCallback, useEffect, useRef } from "react";
import { ipc } from "../../lib/ipc";

/** Periodic save interval (ms). The design calls for save on pause/seek/finish; this
 *  is a backstop so a long uninterrupted watch still persists. */
const FLUSH_INTERVAL_MS = 15_000;

export interface UseMediaProgress {
  /** Seconds genuinely played since the last session log. The component's rAF loop
   *  adds to this; the hook drains it into `log_session` on each flush. */
  accumulatedRef: React.MutableRefObject<number>;
  /** Force a flush now (e.g. on an explicit pause/seek/ended event). */
  flush: () => void;
}

/**
 * @param materialId  The material whose progress to persist.
 * @param getMedia    Accessor returning the current `<video>`/`<audio>` element (or
 *                    null while it's unmounted/switching). Ref-based to avoid re-renders.
 */
export function useMediaProgress(
  materialId: number,
  getMedia: () => HTMLMediaElement | null,
): UseMediaProgress {
  const accumulatedRef = useRef(0);
  // Last position (secs) actually persisted — coalesces periodic writes so we don't
  // hammer a cheap SSD with near-identical rows. `force` (pause/seek/ended/unmount)
  // bypasses the coalesce so those always persist exactly.
  const lastSavedPosRef = useRef(-1);
  const COALESCE_SECS = 5;

  const flush = useCallback(
    (force = false) => {
      const media = getMedia();
      if (!media) return;
      const duration = media.duration;
      const position = media.currentTime;
      const hasDur = Number.isFinite(duration) && duration > 0;
      // Coalesce position writes; always drain accumulated session seconds regardless.
      const shouldSaveP =
        hasDur && (force || Math.abs(position - lastSavedPosRef.current) >= COALESCE_SECS);
      if (shouldSaveP) lastSavedPosRef.current = position;
      const saveP = shouldSaveP ? ipc.saveProgress(materialId, position, duration) : Promise.resolve();
      const acc = accumulatedRef.current;
      const logP = acc > 0 ? ipc.logSession(materialId, acc) : Promise.resolve();
      if (acc > 0) accumulatedRef.current = 0;
      void Promise.all([saveP, logP]).catch(() => {
        /* best-effort persistence; swallow IPC errors so playback never breaks */
      });
    },
    [materialId, getMedia],
  );

  // Periodic (coalesced) flush + final forced flush on unmount / material switch.
  useEffect(() => {
    const id = window.setInterval(() => flush(false), FLUSH_INTERVAL_MS);
    return () => {
      window.clearInterval(id);
      flush(true);
    };
  }, [flush]);

  // Best-effort forced flush when the window closes or is hidden (design: "save on
  // window close"). visibilitychange catches minimize / tab-switch on desktop WebView2.
  useEffect(() => {
    const handler = () => flush(true);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush(true);
    };
    window.addEventListener("beforeunload", handler);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("beforeunload", handler);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [flush]);

  return { accumulatedRef, flush };
}
