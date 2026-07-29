/**
 * HTML5 video player with custom controls (Section 8 Page 6, Section 15 perf rule).
 *
 * Streams the local file via the Tauri asset protocol (`convertFileSrc`) — no HTTP
 * server, range requests handled natively, so seeking is smooth.
 *
 * Perf rule (HARD): the seek-bar fill + the current-time label are updated by a
 * `requestAnimationFrame` loop writing **directly to the DOM** — never React state on
 * `timeupdate` (that re-renders ~4×/s and jank-seeks). Only *discrete* control state
 * (play/paused icon, volume, speed menu) uses React state.
 *
 * Seek bar: a div track + fill + thumb, all DOM-ref driven. Pointer drag scrubs live
 * (a `dragging` ref gates the rAF fill writes so the loop never fights the user's hand).
 *
 * Resume: on `loadedmetadata`, set `currentTime` to the saved position. Progress is
 * persisted via `useMediaProgress` (pause / seek / finish + periodic + unmount flush).
 */

import { useEffect, useRef, useState } from "react";
import { assetUrl, ipc } from "../../lib/ipc";
import { formatDuration } from "../../lib/utils";
import { useMediaProgress } from "./useMediaProgress";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** Containers/codecs the Chromium media engine (WebView2) can't decode, so the
 *  integrated `<video>` shows black (audio may still play). Hand these to the OS player. */
const UNSUPPORTED_VIDEO_EXT = [".mkv", ".avi", ".mov", ".wmv", ".flv", ".rm", ".rmvb"];

interface Props {
  path: string;
  materialId: number;
  startPosition: number;
}

export default function VideoPlayer({ path, materialId, startPosition }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const currentLabelRef = useRef<HTMLSpanElement>(null);
  const durationLabelRef = useRef<HTMLSpanElement>(null);
  const resumeAppliedRef = useRef(false);
  const draggingRef = useRef(false);

  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [speedOpen, setSpeedOpen] = useState(false);

  // True when the file's container is one Chromium/WebView2 can't decode (MKV, AVI, …)
  // → the integrated player will show black; offer "Open in system player" instead.
  const lowerPath = path.toLowerCase();
  const unsupported = UNSUPPORTED_VIDEO_EXT.some((ext) => lowerPath.endsWith(ext));

  const openInSystemPlayer = () => {
    void ipc.openInSystemPlayer(path);
  };

  // Asset URL is a pure sync transform (`convertFileSrc`); compute inline per path.
  const src = assetUrl(path);

  const { accumulatedRef, flush } = useMediaProgress(materialId, () => videoRef.current);

  // The rAF loop: drive seek-bar fill + time labels from the DOM, accumulate watched
  // seconds. No React state writes here. While the user drags the seek bar we leave
  // the fill alone so the loop doesn't fight their hand.
  useEffect(() => {
    let raf = 0;
    let lastTs = 0;
    const tick = (ts: number) => {
      const v = videoRef.current;
      if (v) {
        const dur = v.duration;
        const pos = v.currentTime;
        if (Number.isFinite(dur) && dur > 0) {
          const pct = (pos / dur) * 100;
          if (!draggingRef.current && fillRef.current) {
            fillRef.current.style.width = `${pct}%`;
          }
          if (currentLabelRef.current) currentLabelRef.current.textContent = formatDuration(pos);
          if (durationLabelRef.current) durationLabelRef.current.textContent = formatDuration(dur);
        }
        // Accumulate genuinely-watched time (skip while paused/seeking/buffering).
        if (lastTs && !v.paused && !v.seeking && v.readyState >= 2) {
          const delta = (ts - lastTs) / 1000;
          accumulatedRef.current += delta * (v.playbackRate || 1);
        }
      }
      lastTs = ts;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [accumulatedRef]);

  // Resume from saved position once metadata is available.
  const onLoadedMetadata = () => {
    const v = videoRef.current;
    if (v && !resumeAppliedRef.current && startPosition > 0) {
      v.currentTime = Math.min(startPosition, Math.max(0, (v.duration || 0) - 1));
      resumeAppliedRef.current = true;
    }
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  };

  const skip = (secs: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + secs));
    flush();
  };

  // Seek-bar scrubbing: compute a fraction from the pointer position within the track.
  const seekFromClientX = (clientX: number) => {
    const v = videoRef.current;
    const track = trackRef.current;
    if (!v || !track) return;
    const rect = track.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const dur = v.duration;
    if (Number.isFinite(dur) && dur > 0) {
      v.currentTime = frac * dur;
      if (fillRef.current) fillRef.current.style.width = `${frac * 100}%`;
    }
  };

  const onTrackPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    seekFromClientX(e.clientX);
    window.addEventListener("pointermove", onWindowPointerMove);
    window.addEventListener("pointerup", onWindowPointerUp, { once: true });
  };
  const onWindowPointerMove = (e: PointerEvent) => seekFromClientX(e.clientX);
  const onWindowPointerUp = () => {
    draggingRef.current = false;
    window.removeEventListener("pointermove", onWindowPointerMove);
    flush();
  };

  const changeVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current;
    const value = Number(e.target.value);
    setVolume(value);
    setMuted(value === 0);
    if (v) {
      v.volume = value;
      v.muted = value === 0;
    }
  };

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    const next = !v.muted;
    v.muted = next;
    setMuted(next);
  };

  const changeRate = (r: number) => {
    const v = videoRef.current;
    if (v) v.playbackRate = r;
    setRate(r);
    setSpeedOpen(false);
  };

  const toggleFullscreen = () => {
    const v = videoRef.current;
    if (!v) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void v.requestFullscreen();
  };

  // Keyboard shortcuts scoped to the player (Space, ←/→, ↑/↓, F).
  useEffect(() => {
    const stage = videoRef.current?.parentElement;
    if (!stage) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      switch (e.key) {
        case " ":
          e.preventDefault();
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
        case "ArrowUp": {
          e.preventDefault();
          const v = videoRef.current;
          if (v) {
            const next = Math.min(1, (v.volume || 0) + 0.1);
            v.volume = next;
            setVolume(next);
            setMuted(next === 0);
          }
          break;
        }
        case "ArrowDown": {
          e.preventDefault();
          const v = videoRef.current;
          if (v) {
            const next = Math.max(0, (v.volume || 0) - 0.1);
            v.volume = next;
            setVolume(next);
            setMuted(next === 0);
          }
          break;
        }
        case "f":
        case "F":
          e.preventDefault();
          toggleFullscreen();
          break;
      }
    };
    stage.addEventListener("keydown", onKey);
    if (!stage.hasAttribute("tabindex")) stage.setAttribute("tabindex", "0");
    return () => stage.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div
        className="group relative flex flex-1 cursor-pointer items-center justify-center overflow-hidden rounded-card bg-black focus:outline-none"
        onClick={togglePlay}
      >
        {src ? (
          <video
            ref={videoRef}
            src={src}
            className="h-full w-full"
            onClick={(e) => {
              e.stopPropagation();
              togglePlay();
            }}
            onPlay={() => setIsPlaying(true)}
            onPause={() => {
              setIsPlaying(false);
              flush();
            }}
            onEnded={() => {
              setIsPlaying(false);
              flush();
            }}
            onLoadedMetadata={onLoadedMetadata}
          />
        ) : (
          <div className="text-sm text-content-muted">Loading video…</div>
        )}

        {/* Unsupported-format banner: the integrated player can't decode MKV/HEVC, so
            the video is black (audio may play). Offer the system player instead. */}
        {unsupported && (
          <div
            className="pointer-events-auto absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-3 bg-black/70 px-4 py-2 text-xs text-content-secondary backdrop-blur-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <span>
              This format ({path.slice(path.lastIndexOf(".") + 1).toUpperCase()}) isn't
              supported by the built-in player — video will be black. Open it in your
              system player (VLC / mpv / Windows Media) instead.
            </span>
            <button
              type="button"
              onClick={openInSystemPlayer}
              className="shrink-0 rounded-btn bg-lime px-3 py-1 text-xs font-semibold text-ink-900 transition-transform hover:scale-105"
            >
              Open in system player ⤴
            </button>
          </div>
        )}
      </div>

      {/* Custom controls — discrete state only; seek bar fill is DOM-driven. */}
      <div className="mt-3 flex items-center gap-3 rounded-card bg-white/[0.04] px-3 py-2">
        <button
          type="button"
          onClick={togglePlay}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-lime text-ink-900 transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/40"
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? "❚❚" : "▶"}
        </button>

        <span
          ref={currentLabelRef}
          className="w-12 shrink-0 text-center text-xs tabular-nums text-content-secondary"
        >
          0:00
        </span>

        {/* Seek bar: div track + DOM-driven fill, pointer-scrubbable. */}
        <div
          ref={trackRef}
          onPointerDown={onTrackPointerDown}
          className="relative h-1.5 flex-1 cursor-pointer touch-none rounded-full bg-white/[0.08]"
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={0}
        >
          <div
            ref={fillRef}
            className="absolute left-0 top-0 h-full rounded-full bg-lime"
            style={{ width: "0%" }}
          />
        </div>

        <span
          ref={durationLabelRef}
          className="w-12 shrink-0 text-center text-xs tabular-nums text-content-muted"
        >
          —
        </span>

        <button
          type="button"
          onClick={toggleMute}
          className="shrink-0 text-sm text-content-secondary hover:text-content-primary"
          aria-label={muted ? "Unmute" : "Mute"}
        >
          {muted || volume === 0 ? "🔇" : "🔊"}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          onChange={changeVolume}
          className="hidden h-1.5 w-20 cursor-pointer appearance-none rounded-full bg-white/[0.08] sm:block"
          aria-label="Volume"
        />

        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setSpeedOpen((o) => !o)}
            className="rounded-btn px-2 py-1 text-xs text-content-secondary hover:text-content-primary"
            aria-label="Playback speed"
            aria-expanded={speedOpen}
          >
            {rate}×
          </button>
          {speedOpen && (
            <div className="absolute bottom-9 right-0 z-10 flex flex-col rounded-btn border border-white/10 bg-ink-850 py-1 shadow-card">
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => changeRate(s)}
                  className={
                    "px-3 py-1 text-left text-xs hover:bg-white/[0.06] " +
                    (s === rate ? "text-lime" : "text-content-secondary")
                  }
                >
                  {s}×
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={toggleFullscreen}
          className="shrink-0 text-sm text-content-secondary hover:text-content-primary"
          aria-label="Fullscreen"
          title="Fullscreen (F)"
        >
          ⛶
        </button>
        <button
          type="button"
          onClick={openInSystemPlayer}
          className="shrink-0 rounded-btn px-2 py-1 text-xs text-content-secondary hover:bg-white/[0.06] hover:text-content-primary"
          aria-label="Open in system player"
          title="Open in system player (for formats the built-in player can't decode)"
        >
          ⤴ External
        </button>
      </div>
    </div>
  );
}
