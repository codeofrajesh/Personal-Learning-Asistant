/**
 * Audio player (Section 8 Page 6 — audio materials). Shares `useMediaProgress` with
 * VideoPlayer for resume + persistence; the seek bar is DOM-ref driven by rAF just
 * like the video player (Section 15 perf rule — no React state on timeupdate).
 *
 * A centered "vinyl" stage keeps the audio file from feeling like a bare control bar.
 */

import { useEffect, useRef, useState } from "react";
import { assetUrl } from "../../lib/ipc";
import { formatDuration } from "../../lib/utils";
import { useMediaProgress } from "./useMediaProgress";

interface Props {
  path: string;
  materialId: number;
  startPosition: number;
}

export default function AudioPlayer({ path, materialId, startPosition }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const currentLabelRef = useRef<HTMLSpanElement>(null);
  const durationLabelRef = useRef<HTMLSpanElement>(null);
  const resumeAppliedRef = useRef(false);
  const draggingRef = useRef(false);

  const [isPlaying, setIsPlaying] = useState(false);

  // Asset URL is a pure sync transform (`convertFileSrc`); compute inline per path.
  const src = assetUrl(path);

  const { accumulatedRef, flush } = useMediaProgress(materialId, () => audioRef.current);

  useEffect(() => {
    let raf = 0;
    let lastTs = 0;
    const tick = (ts: number) => {
      const a = audioRef.current;
      if (a) {
        const dur = a.duration;
        const pos = a.currentTime;
        if (Number.isFinite(dur) && dur > 0) {
          if (!draggingRef.current && fillRef.current) {
            fillRef.current.style.width = `${(pos / dur) * 100}%`;
          }
          if (currentLabelRef.current) currentLabelRef.current.textContent = formatDuration(pos);
          if (durationLabelRef.current) durationLabelRef.current.textContent = formatDuration(dur);
        }
        if (lastTs && !a.paused && !a.seeking && a.readyState >= 2) {
          accumulatedRef.current += ((ts - lastTs) / 1000) * (a.playbackRate || 1);
        }
      }
      lastTs = ts;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [accumulatedRef]);

  const onLoadedMetadata = () => {
    const a = audioRef.current;
    if (a && !resumeAppliedRef.current && startPosition > 0) {
      a.currentTime = Math.min(startPosition, Math.max(0, (a.duration || 0) - 1));
      resumeAppliedRef.current = true;
    }
  };

  const togglePlay = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play();
    else a.pause();
  };

  const seekFromClientX = (clientX: number) => {
    const a = audioRef.current;
    const track = trackRef.current;
    if (!a || !track) return;
    const rect = track.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const dur = a.duration;
    if (Number.isFinite(dur) && dur > 0) {
      a.currentTime = frac * dur;
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

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 rounded-card bg-black p-card">
      <div
        className={
          "grid h-32 w-32 place-items-center rounded-full bg-gradient-to-br from-lime/30 to-orange/20 text-5xl " +
          (isPlaying ? "animate-spin [animation-duration:6s]" : "")
        }
        aria-hidden="true"
      >
        🎧
      </div>

      {src ? (
        <audio
          ref={audioRef}
          src={src}
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
        <div className="text-sm text-content-muted">Loading audio…</div>
      )}

      <div className="flex w-full max-w-md items-center gap-3">
        <button
          type="button"
          onClick={togglePlay}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-lime text-ink-900 transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/40"
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? "❚❚" : "▶"}
        </button>
        <span ref={currentLabelRef} className="w-12 shrink-0 text-center text-xs tabular-nums text-content-secondary">
          0:00
        </span>
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
          <div ref={fillRef} className="absolute left-0 top-0 h-full rounded-full bg-lime" style={{ width: "0%" }} />
        </div>
        <span ref={durationLabelRef} className="w-12 shrink-0 text-center text-xs tabular-nums text-content-muted">
          —
        </span>
      </div>
    </div>
  );
}
