/**
 * Native libmpv video player (replaces HTML5 `<video>` for MKV/HEVC).
 *
 * Render model: the Tauri window is `transparent: true`; mpv renders to the OS window
 * *behind* the webview. This component's root `<div>` is the transparent viewport —
 * mpv shows through it. `setVideoMarginRatio` tells mpv exactly which fraction of the
 * window to draw to, computed from the viewport's bounding rect.
 *
 * Perf (§15): the seek-bar fill + current-time label are written to DOM refs from the
 * mpv `time-pos` property callback — NOT React state — so continuous position updates
 * don't re-render. Only discrete state (play/pause, duration, volume, speed) is React
 * state.
 *
 * Safety: if `init()` throws OR no playback starts within 6 s of loading, `onFail` is
 * called so PlayerPage falls back to the HTML5 `VideoPlayer`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  command,
  init,
  observeProperties,
  setProperty,
  getProperty,
  setVideoMarginRatio,
  type MpvObservableProperty,
} from "tauri-plugin-libmpv-api";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { gsap } from "gsap";
import { useGSAP } from "@gsap/react";
import { ipc, isTauri } from "../../lib/ipc";
import { playerBridge } from "../../lib/playerBridge";
import { useMiniPlayer } from "../../lib/miniPlayerStore";
import { formatDuration } from "../../lib/utils";
import {
  PlayIcon,
  PauseIcon,
  VolumeIcon,
  MuteIcon,
  SkipBackIcon,
  SkipForwardIcon,
  FullscreenIcon,
  ExitFullscreenIcon,
  SpeedIcon,
  ExternalLinkIcon,
} from "./PremiumIcons";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

// Global singleton for MPV. MPV is a heavy C-library and should only be 
// initialized and observed ONCE per application lifecycle to avoid Tauri IPC 
// race conditions ("Couldn't find callback id") when React rapidly unmounts.
let globalInitPromise: Promise<void> | null = null;

// Global cache of MPV state to sync new components instantly.
const globalMpvState = {
  pause: true,
  "time-pos": 0,
  duration: 0,
  volume: 100,
  speed: 1,
};

let globalLoadedPath: string | null = null;

const OBSERVED_PROPERTIES = [
  ["pause", "flag"],
  ["time-pos", "double", "none"],
  ["duration", "double", "none"],
  ["volume", "int64"],
  ["speed", "double"],
  ["eof-reached", "flag"],
] as const satisfies MpvObservableProperty[];

interface Props {
  path: string;
  materialId: number;
  startPosition: number;
  /** File name shown by the docked mini-player when the user navigates away mid-video. */
  fileName?: string;
  /** Called if mpv fails to initialize or playback doesn't start — PlayerPage falls
   *  back to the HTML5 player. */
  onFail?: () => void;
}

export default function MpvVideoPlayer({ path, materialId, startPosition, fileName, onFail }: Props) {
  const setMiniActive = useMiniPlayer((s) => s.setActive);
  // The transparent "anchor" div — mpv renders to the OS window behind the webview,
  // showing through this hole. ResizeObserver keeps mpv's bounding box pinned to it.
  const videoAnchorRef = useRef<HTMLDivElement>(null);
  const seekFillRef = useRef<HTMLDivElement>(null);
  const seekTrackRef = useRef<HTMLDivElement>(null);
  const currentLabelRef = useRef<HTMLSpanElement>(null);
  const durationLabelRef = useRef<HTMLSpanElement>(null);
  const timePosRef = useRef(0);
  const durationRef = useRef(0);
  const lastTimePosRef = useRef(0);
  const watchedSecondsRef = useRef(0);
  const draggingRef = useRef(false);
  const initedRef = useRef(false);
  
  // Tracks if THIS component instance actually loaded the file, or if it just
  // connected to an already-running global engine (e.g., during fullscreen toggle).
  const didLoadFileRef = useRef(false);
  const disposedRef = useRef(false);
  // Debounce timer for alignViewport (Bug 2 fix: let the OS window
  // layout settle for ~80 ms before measuring + sending coordinates).
  const alignDebounceRef = useRef<number | undefined>(undefined);
  
  // Ref to hold the cleanup function for this specific component instance's event listener
  const cleanupMpvListenerRef = useRef<(() => void) | null>(null);

  const playbackStartedRef = useRef(false);
  const failCalledRef = useRef(false);
  const isPausedRef = useRef(globalMpvState.pause);
  // Mirror of the backend `pause` property — the source of truth for
  // isPlaying. togglePlay reads this ref (not the React state, which can
  // be stale/desynced during rapid switches) so Space always toggles
  // the REAL backend state.
  const isPlayingRef = useRef(!globalMpvState.pause);

  const [ready, setReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(!globalMpvState.pause);
  const [duration, setDuration] = useState(globalMpvState.duration);
  const [volume, setVolume] = useState(globalMpvState.volume);
  const [rate, setRate] = useState(globalMpvState.speed);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const callOnFail = useCallback(
    (reason: string) => {
      if (failCalledRef.current) return;
      failCalledRef.current = true;
      // eslint-disable-next-line no-console
      console.error("[MpvVideoPlayer] falling back to HTML5:", reason);
      onFail?.();
    },
    [onFail],
  );

  // Last position (secs) actually persisted to the DB — used to coalesce writes so we
  // don't hammer a cheap SSD with near-identical rows on rapid pause/seek/flush.
  const lastSavedPosRef = useRef(-1);
  const SAVE_COALESCE_SECS = 5;

  /** Save current watch progress to the DB.
   *  Coalesced by default (skips if the position moved < 5s since the last write);
   *  pass `force` on pause / seek / EOF / unmount so those always persist exactly. */
  const saveProgress = useCallback(
    (force = false) => {
      const pos = timePosRef.current;
      const dur = durationRef.current;
      if (dur <= 0 || pos <= 0) return;
      if (!force && Math.abs(pos - lastSavedPosRef.current) < SAVE_COALESCE_SECS) return;
      lastSavedPosRef.current = pos;
      void ipc.saveProgress(materialId, pos, dur).catch(() => {});
    },
    [materialId],
  );

  // ── Init mpv once (init FIRST, then observe) ───────────────────────────────
  useEffect(() => {
    if (!isTauri()) {
      callOnFail("not running in Tauri");
      return;
    }
    // Shared isMounted flag across the init + fullscreen effects.
    // (false = mounted; true = disposed/unmounted.)
    disposedRef.current = false;

    (async () => {
      try {
        if (!globalInitPromise) {
          // eslint-disable-next-line no-console
          console.log("[MpvVideoPlayer] global init mpv…");
          globalInitPromise = (async () => {
            await init({
              initialOptions: {
                vo: "gpu-next",
                hwdec: "auto-safe",
                "keep-open": "yes",
                "force-window": "yes",
                volume: "100",
              },
              observedProperties: OBSERVED_PROPERTIES,
            });
            
            // Globally observe properties ONCE. Never unobserve.
            // Dispatch standard DOM events so the React component can listen safely.
            await observeProperties(OBSERVED_PROPERTIES, ({ name, data }) => {
              if (name in globalMpvState) {
                (globalMpvState as any)[name] = data;
              }
              window.dispatchEvent(new CustomEvent('mpv-event', { detail: { name, data } }));
            });
          })();
        }
        await globalInitPromise;
        if (disposedRef.current) return;
        initedRef.current = true;
        // eslint-disable-next-line no-console
        console.log("[MpvVideoPlayer] mpv init OK");

        // React listens to the global CustomEvent instead of calling Tauri IPC.
        const handleMpvEvent = (e: Event) => {
          if (disposedRef.current) return;
          const { name, data } = (e as CustomEvent).detail;
          switch (name) {
            case "pause":
              // Force React state to match the true backend state (Bug 4 fix).
              isPlayingRef.current = !data;
              setIsPlaying(!data);
              isPausedRef.current = !!data;
              if (data) saveProgress(true); // save on pause (forced)
              break;
            case "time-pos": {
              const t = (data as number | null) ?? 0;
              // Accumulate genuinely-watched time (delta from last time-pos, only while
              // playing and time moved forward).
              if (!isPausedRef.current && t > lastTimePosRef.current) {
                watchedSecondsRef.current += t - lastTimePosRef.current;
              }
              lastTimePosRef.current = t;
              timePosRef.current = t;
              playbackStartedRef.current = true; // we received a position → playback live
              const d = durationRef.current;
              if (!draggingRef.current && seekFillRef.current && d > 0) {
                seekFillRef.current.style.width = `${(t / d) * 100}%`;
              }
              if (currentLabelRef.current) currentLabelRef.current.textContent = formatDuration(t);
              break;
            }
            case "duration": {
              const d = (data as number | null) ?? 0;
              durationRef.current = d;
              setDuration(d);
              if (durationLabelRef.current) durationLabelRef.current.textContent = formatDuration(d);
              break;
            }
            case "volume":
              setVolume(data as number);
              break;
            case "speed":
              setRate(data as number);
              break;
            case "eof-reached":
              if (data) saveProgress(true); // save on end (forced)
              break;
          }
        };

        window.addEventListener('mpv-event', handleMpvEvent);
        // Store cleanup in a React ref bound strictly to this component instance,
        // avoiding Strict Mode race conditions where multiple mounts overwrite a DOM node property.
        cleanupMpvListenerRef.current = () => {
          window.removeEventListener('mpv-event', handleMpvEvent);
        };

        setReady(true);
        alignViewport(); // initial alignment
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[MpvVideoPlayer] init failed:", e);
        if (!disposedRef.current) {
          setError(e instanceof Error ? e.message : String(e));
          callOnFail("init threw: " + (e instanceof Error ? e.message : String(e)));
        }
      }
    })();

    return () => {
      disposedRef.current = true;
      // Final progress save + session log on unmount (forced — always persist exactly).
      saveProgress(true);
      if (watchedSecondsRef.current > 0) {
        void ipc.logSession(materialId, watchedSecondsRef.current).catch(() => {});
      }
      
      // Clean up the event listener specifically for this component instance
      if (cleanupMpvListenerRef.current) {
        cleanupMpvListenerRef.current();
        cleanupMpvListenerRef.current = null;
      }

      if (initedRef.current) {
        initedRef.current = false;
        // CRITICAL: We NEVER destroy() the global MPV instance. 
        // It stays alive in the background to serve the next video instantly.
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Load the file (re-runs when init completes via `ready` AND on path change) ─
  // CRITICAL: deps include `ready` so this fires AFTER init completes. Without it,
  // the effect runs on mount when initedRef is still false → skips → dead player.
  useEffect(() => {
    if (!ready || !path) return;
    
    if (globalLoadedPath === path) {
      // The video is ALREADY loaded in the global MPV engine! 
      // (This happens when the component unmounts/remounts quickly, e.g. toggling fullscreen layout).
      // DO NOT reload the file. Just sync the visual DOM refs to the engine's current state.
      const d = globalMpvState.duration;
      const t = globalMpvState["time-pos"];
      durationRef.current = d;
      timePosRef.current = t;
      lastTimePosRef.current = t;
      
      if (seekFillRef.current && d > 0) {
        seekFillRef.current.style.width = `${(t / d) * 100}%`;
      }
      if (currentLabelRef.current) currentLabelRef.current.textContent = formatDuration(t);
      if (durationLabelRef.current) durationLabelRef.current.textContent = formatDuration(d);
      
      return;
    }

    globalLoadedPath = path;
    didLoadFileRef.current = true;

    // Reset state for the (new) file.
    setDuration(0);
    durationRef.current = 0;
    timePosRef.current = 0;
    lastTimePosRef.current = 0;
    watchedSecondsRef.current = 0;
    playbackStartedRef.current = false;
    if (seekFillRef.current) seekFillRef.current.style.width = "0%";
    if (currentLabelRef.current) currentLabelRef.current.textContent = "0:00";
    if (durationLabelRef.current) durationLabelRef.current.textContent = "—";
    // eslint-disable-next-line no-console
    console.log("[MpvVideoPlayer] loadfile:", path);
    void (async () => {
      try {
        await command("loadfile", [path]);
        // Mark this video as the globally-active one so the docked mini-player can take
        // over if the user navigates away mid-playback.
        setMiniActive(materialId, fileName ?? path.split(/[\\/]/).pop() ?? "Now playing");
        // After loading a file, MPV auto-plays WITHOUT emitting a pause event.
        // We MUST manually sync the true pause state to fix the initial freeze.
        const actualPause = await getProperty("pause", "flag");
        if (actualPause !== null && actualPause !== undefined) {
           globalMpvState.pause = actualPause;
           setIsPlaying(!actualPause);
           isPlayingRef.current = !actualPause;
           isPausedRef.current = actualPause;
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("[MpvVideoPlayer] loadfile rejected (likely a rapid-switch race):", e);
      }
    })();

    // NOTE: The 6-second timeout fallback that was here has been removed — it was
    // falsely killing working playback because the time-pos observer wasn't registered
    // (fixed above by passing observedProperties to init). If we need a fallback later,
    // it should only trigger on an actual init/loadfile ERROR, not a timer.
  }, [path, ready]);

  // ── Resume from saved position once duration is known ──────────────────────
  const resumeAppliedRef = useRef(false);
  useEffect(() => {
    resumeAppliedRef.current = false;
  }, [path]);
  useEffect(() => {
    if (!resumeAppliedRef.current && ready && startPosition > 0 && duration > 0) {
      if (didLoadFileRef.current) {
        // Only seek to the DB startPosition if WE just loaded the file!
        // If we just reconnected to the global engine (fullscreen toggle),
        // we DO NOT want to seek backwards to the old DB position.
        void command("seek", [Math.min(startPosition, Math.max(0, duration - 1)), "absolute"]).catch(
          () => {},
        );
      }
      resumeAppliedRef.current = true;
    }
  }, [ready, startPosition, duration, path]);

  // ── Video anchor ↔ mpv alignment via setVideoMarginRatio ───────────────────────
  // Pixel bounding: get the anchor's exact CSS-pixel rect (getBoundingClientRect)
  // and the Tauri window's AUTHORITATIVE CSS size (innerSize / scaleFactor — not
  // window.inner*, which can mismatch on resize/fullscreen due to DPR/decoration).
  // Convert exact pixels → ratios and send to the Rust plugin so mpv renders
  // precisely in the anchor's pixel bounding box.
  //
  // Bug 2 fix: a fullscreen transition resizes the OS window asynchronously,
  // so the ResizeObserver can fire mid-animation and measure stale
  // dimensions (→ black border around the video). Debounce ~80 ms so the
  // OS window layout settles before we measure + send the final coordinates.
  // Cached window metrics (CSS px). innerSize/scaleFactor only change on resize, so we
  // read them once and refresh on `resize` — alignViewport then makes a SINGLE async call
  // (setVideoMarginRatio) instead of awaiting innerSize + scaleFactor every time.
  const winMetricsRef = useRef<{ w: number; h: number } | null>(null);
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

  const alignViewport = useCallback(() => {
    const el = videoAnchorRef.current;
    if (!el || !initedRef.current) return;
    window.clearTimeout(alignDebounceRef.current);
    // Debounce lets an async OS-window layout change (fullscreen/resize) settle before
    // we measure. Scroll no longer triggers this at all (the anchor is fixed in a strict
    // full-height player layout), so there's no per-scroll-frame IPC cost anymore.
    alignDebounceRef.current = window.setTimeout(() => {
      void (async () => {
        if (!winMetricsRef.current) await refreshWinMetrics();
        const m = winMetricsRef.current;
        if (!m) return;
        const rect = el.getBoundingClientRect();
        void setVideoMarginRatio({
          left: Math.max(0, rect.left / m.w),
          right: Math.max(0, (m.w - rect.right) / m.w),
          top: Math.max(0, rect.top / m.h),
          bottom: Math.max(0, (m.h - rect.bottom) / m.h),
        }).catch(() => {});
      })();
    }, 80);
  }, [refreshWinMetrics]);

  useEffect(() => {
    if (!ready) return;
    // Geometry changes come from: the anchor resizing (sidebar toggle, layout) and window
    // resize/fullscreen. NOT scroll — the player layout is fixed-height, so the anchor
    // never moves on scroll. On window resize we refresh the cached metrics, then re-align.
    const ro = new ResizeObserver(() => void alignViewport());
    if (videoAnchorRef.current) ro.observe(videoAnchorRef.current);
    const onResize = () => {
      void refreshWinMetrics().then(() => alignViewport());
    };
    window.addEventListener("resize", onResize);
    void refreshWinMetrics().then(() => alignViewport());
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
      window.clearTimeout(alignDebounceRef.current); // cancel pending align
    };
  }, [ready, alignViewport, refreshWinMetrics]);

  // ── Control bar fade in/out on mouse move (GSAP, Phase 3) ──────────────────
  // The bar fades in when the pointer moves over the video and fades out after
  // ~2.5 s of inactivity; always visible while playing (so the user can see
  // the progress), auto-hides when paused. Honors prefers-reduced-motion (no
  // fade, just toggles opacity). Per gsap-react: useGSAP with a scope and
  // contextSafe for the move handler so it cleans up on unmount.
  const controlsRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<number | undefined>(undefined);
  const [controlsVisible, setControlsVisible] = useState(true);

  useGSAP(
    (_context, contextSafe) => {
      if (!ready || !contextSafe) return;
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      const el = controlsRef.current;
      if (!el) return;

      const reveal = contextSafe(() => {
        if (reduced) {
          gsap.set(el, { opacity: 1 });
          return;
        }
        gsap.killTweensOf(el);
        gsap.to(el, { opacity: 1, duration: 0.25, ease: "power2.out" });
      });
      const conceal = contextSafe(() => {
        if (reduced) {
          gsap.set(el, { opacity: 0 });
          return;
        }
        gsap.killTweensOf(el);
        gsap.to(el, { opacity: 0, duration: 0.4, ease: "power2.in" });
      });

      // Reveal on pointer move over the video; schedule a hide after idle.
      const anchor = videoAnchorRef.current;
      const onMove = () => {
        window.clearTimeout(hideTimerRef.current);
        reveal();
        hideTimerRef.current = window.setTimeout(() => {
          // Keep the bar visible while playing (the progress is moving);
          // hide when paused.
          if (!isPausedRef.current) conceal();
          setControlsVisible(false);
        }, 2500);
        setControlsVisible(true);
      };
      anchor?.addEventListener("pointermove", onMove);
      // Toggle immediately on enter/leave for snappy feedback.
      anchor?.addEventListener("pointerleave", () => {
        if (!isPausedRef.current) conceal();
        setControlsVisible(false);
      });
      anchor?.addEventListener("pointerenter", () => {
        reveal();
        setControlsVisible(true);
      });

      return () => {
        anchor?.removeEventListener("pointermove", onMove);
        anchor?.removeEventListener("pointerleave", () => {});
        anchor?.removeEventListener("pointerenter", () => {});
        window.clearTimeout(hideTimerRef.current);
      };
    },
    { scope: videoAnchorRef, dependencies: [ready] },
  );

  // ── Fullscreen (Tauri OS-window fullscreen, NOT the browser Fullscreen API) ──
  // The browser `requestFullscreen()` on the video div causes a black screen — it
  // covers the native mpv layer behind the webview. Instead, maximize the OS Tauri
  // window; React state (in AppShell + PlayerPage) hides the sidebar, top bar, and
  // right panel so the transparent video anchor expands to fill the screen. Esc is
  // handled by the OS. The ResizeObserver re-aligns mpv to the new full-screen rect.
  const toggleFullscreen = useCallback(async () => {
    try {
      const w = getCurrentWindow();
      const fs = await w.isFullscreen();
      const target = !fs;
      await w.setFullscreen(target);
      // setFullscreen doesn't emit a dedicated event; poll the state right after
      // and again on the next resize (fullscreen triggers a resize event).
      setIsFullscreen(target);
      window.dispatchEvent(new CustomEvent('app-fullscreen-changed', { detail: target }));
      setTimeout(() => void alignViewport(), 120);
    } catch {
      /* ignore — user can still use the OS controls */
    }
  }, []);

  useEffect(() => {
    let active = true;
    const onChange = async () => {
      if (disposedRef.current || !active) return; 
      try {
        const fs = await getCurrentWindow().isFullscreen();
        if (!active) return;
        setIsFullscreen(fs);
        setTimeout(() => void alignViewport(), 120);
      } catch {
        /* ignore */
      }
    };
    
    let unlisten: (() => void) | null = null;
    getCurrentWindow().onResized(() => void onChange()).then(u => {
      unlisten = u;
    }).catch(() => {});
    
    return () => {
      active = false;
      if (unlisten) unlisten();
    };
  }, [alignViewport]);

  // ── Controls ───────────────────────────────────────────────────────────────
  // Bug 4 fix: togglePlay reads isPlayingRef (the ref-mirrored backend pause
  // state, the source of truth) instead of the React isPlaying state, which
  // can be stale/desynced during rapid switches. Space always toggles the
  // REAL backend state.
  const togglePlay = () =>
    void setProperty("pause", isPlayingRef.current).catch(() => {});
  const seekTo = (frac: number) => {
    const d = durationRef.current;
    if (d <= 0) return;
    const t = Math.max(0, Math.min(d, frac * d));
    if (seekFillRef.current) seekFillRef.current.style.width = `${(t / d) * 100}%`;
    void command("seek", [t, "absolute"]).catch(() => {});
    timePosRef.current = t; // reflect the new position so the save persists where we sought
    saveProgress(true);
  };
  const onTrackPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    const track = seekTrackRef.current;
    if (!track) return;
    const seekFromX = (clientX: number) => {
      const r = track.getBoundingClientRect();
      seekTo(Math.max(0, Math.min(1, (clientX - r.left) / r.width)));
    };
    seekFromX(e.clientX);
    const onMove = (ev: PointerEvent) => seekFromX(ev.clientX);
    const onUp = () => {
      draggingRef.current = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  };
  const changeVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    setVolume(v);
    void setProperty("volume", v).catch(() => {});
  };
  const changeRate = (r: number) => {
    setRate(r);
    void setProperty("speed", r).catch(() => {});
    setSpeedOpen(false);
  };
  const skip = (secs: number) => {
    const t = Math.max(0, Math.min(durationRef.current, timePosRef.current + secs));
    void command("seek", [t, "absolute"]).catch(() => {});
    timePosRef.current = t; // reflect the new position so the save persists where we sought
    saveProgress(true);
  };
  const openInSystemPlayer = () => void ipc.openInSystemPlayer(path);

  // ── Keyboard shortcuts (window-level, bound ONCE) ─────────────────────────
  // Bug 3 fix: bind the listener a single time (empty deps) so it never re-binds
  // with a stale closure during rapid video switches. The handlers all read
  // refs (isPlayingRef / timePosRef / durationRef) which always reflect
  // the latest backend state, so the closure stays correct for the life of
  // the component. Cleanup removes the listener on unmount.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      switch (e.key) {
        case " ":
          e.preventDefault(); // prevent page scroll
          togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          skip(-10);
          break;
        case "ArrowRight":
          e.preventDefault();
          skip(10);
          break;
        case "f":
        case "F":
          e.preventDefault();
          toggleFullscreen();
          break;
        case "Escape":
          // The browser natively handles Esc for HTML5 Fullscreen API, but since we are
          // using Tauri's OS-level fullscreen, we must manually handle Esc to exit it.
          void getCurrentWindow().isFullscreen().then((fs) => {
            if (fs) toggleFullscreen();
          });
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Forced flush when the window is hidden/closed (minimize, tab-switch, quit) so we never
  // lose the resume point on a hard close that skips React unmount.
  useEffect(() => {
    if (!ready) return;
    const onHide = () => saveProgress(true);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") saveProgress(true);
    };
    window.addEventListener("beforeunload", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("beforeunload", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [ready, saveProgress]);

  // Expose current time + seek to player-adjacent UI (timestamped Notes) via the bridge.
  useEffect(() => {
    playerBridge.register(
      materialId,
      () => timePosRef.current,
      (secs: number) => {
        const d = durationRef.current;
        const t = Math.max(0, d > 0 ? Math.min(d, secs) : secs);
        void command("seek", [t, "absolute"]).catch(() => {});
        timePosRef.current = t;
        if (seekFillRef.current && d > 0) seekFillRef.current.style.width = `${(t / d) * 100}%`;
      },
    );
    return () => playerBridge.unregister(materialId);
  }, [materialId]);

  // Periodic safety flush of progress (every 15 s while watching). Coalesced: only writes
  // if the position actually advanced ≥ 5s since the last save (no redundant SSD writes).
  useEffect(() => {
    if (!ready) return;
    const id = window.setInterval(() => saveProgress(false), 15000);
    return () => window.clearInterval(id);
  }, [ready, saveProgress]);

  if (error) {
    return (
      <div className="grid h-full place-items-center bg-ink-900 p-card text-center text-sm text-orange">
        Native player error: {error}
        <span className="mt-1 block text-xs text-content-faint">Falling back to the built-in player…</span>
      </div>
    );
  }

  return (
    <div ref={videoAnchorRef} id="video-anchor" className="relative h-full w-full bg-transparent outline-none" tabIndex={0}>
      {!ready && (
        <div className="grid h-full place-items-center text-sm text-content-muted">Starting native player…</div>
      )}

      {/* The rounded-corner SVG overlay was removed per user request as it cut off video content. */}

      {/* ── Premium control bar (Phase 3) — YouTube-style, GSAP fade-in/out ─
          The bar fades in on pointer move and auto-hides after ~2.5s of idle
          (kept visible while playing). pointer-events are disabled when hidden so
          the seek bar doesn't steal clicks from the video. */}
      <div
        ref={controlsRef}
        className={
          "absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/90 via-black/55 to-transparent px-4 pb-3 pt-10 transition-opacity duration-300 " +
          (controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none")
        }
      >
        {/* Seek bar — premium gradient track with lime fill */}
        <div className="group/seek mb-2">
          <div
            ref={seekTrackRef}
            onPointerDown={onTrackPointerDown}
            className="relative h-1.5 w-full cursor-pointer touch-none rounded-full bg-white/[0.15] transition-all group-hover/seek:h-2"
            role="slider"
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={0}
          >
            <div ref={seekFillRef} className="absolute left-0 top-0 h-full rounded-full bg-lime shadow-glow-lime transition-[width] duration-150" style={{ width: "0%" }} />
          </div>
        </div>

        {/* Control buttons row */}
        <div className="flex items-center gap-3">
          {/* Play/Pause — large, prominent; icon swaps with a GSAP pop */}
          <button
            type="button"
            onClick={togglePlay}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-lime text-ink-900 shadow-glow-lime transition-transform hover:scale-110 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/50"
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? <PauseIcon className="text-ink-900" /> : <PlayIcon className="text-ink-900" />}
          </button>

          {/* Skip back 10s */}
          <button
            type="button"
            onClick={() => skip(-10)}
            className="shrink-0 rounded-full p-2 text-content-secondary transition-colors hover:bg-white/[0.1] hover:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
            aria-label="Back 10 seconds"
            title="← 10s"
          >
            <SkipBackIcon />
          </button>

          {/* Skip forward 10s */}
          <button
            type="button"
            onClick={() => skip(10)}
            className="shrink-0 rounded-full p-2 text-content-secondary transition-colors hover:bg-white/[0.1] hover:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
            aria-label="Forward 10 seconds"
            title="10s →"
          >
            <SkipForwardIcon />
          </button>

          {/* Volume */}
          <div className="group/vol flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void setProperty("mute", volume > 0).catch(() => {})}
              className="shrink-0 rounded-full p-2 text-content-secondary transition-colors hover:bg-white/[0.1] hover:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
              aria-label="Mute"
            >
              {volume === 0 ? <MuteIcon /> : <VolumeIcon />}
            </button>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={volume}
              onChange={changeVolume}
              className="h-1 w-0 cursor-pointer appearance-none rounded-full bg-white/[0.15] opacity-0 transition-all duration-200 group-hover/vol:w-20 group-hover/vol:opacity-100"
              aria-label="Volume"
            />
          </div>

          {/* Time display */}
          <span ref={currentLabelRef} className="shrink-0 text-xs font-medium tabular-nums text-content-secondary">0:00</span>
          <span className="shrink-0 text-xs text-content-faint">/</span>
          <span ref={durationLabelRef} className="shrink-0 text-xs tabular-nums text-content-muted">—</span>

          {/* Spacer */}
          <div className="flex-1" />

          {/* Speed selector */}
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => setSpeedOpen((o) => !o)}
              className="flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium text-content-secondary transition-colors hover:bg-white/[0.1] hover:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
              aria-label="Playback speed"
              aria-expanded={speedOpen}
            >
              <SpeedIcon size={14} />
              <span>{rate}×</span>
            </button>
            {speedOpen && (
              <div className="absolute bottom-11 right-0 z-20 flex flex-col rounded-btn border border-white/10 bg-ink-850 py-1 shadow-card">
                {SPEEDS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => changeRate(s)}
                    className={"flex items-center gap-1.5 px-4 py-1.5 text-left text-xs transition-colors hover:bg-white/[0.06] " + (s === rate ? "font-bold text-lime" : "text-content-secondary")}
                  >
                    <SpeedIcon size={12} className={s === rate ? "text-lime" : "text-content-faint"} />
                    {s}×
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Fullscreen */}
          <button
            type="button"
            onClick={toggleFullscreen}
            className={"shrink-0 rounded-full p-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20 " + (isFullscreen ? "text-lime" : "text-content-secondary hover:bg-white/[0.1] hover:text-content-primary")}
            aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            title="Fullscreen (F)"
          >
            {isFullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
          </button>

          {/* Open in system player */}
          <button
            type="button"
            onClick={openInSystemPlayer}
            className="shrink-0 rounded-full p-2 text-content-secondary transition-colors hover:bg-white/[0.1] hover:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
            aria-label="Open in system player"
            title="Open in system player"
          >
            <ExternalLinkIcon size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
