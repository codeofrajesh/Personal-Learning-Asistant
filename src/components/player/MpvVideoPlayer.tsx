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
import { useNavigate } from "react-router-dom";
import { AlertCircle, PictureInPicture2, WifiOff, RefreshCw } from "lucide-react";
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
import { ipc, isTauri, invokeCommand } from "../../lib/ipc";
import { subscribeFullscreen } from "../../lib/fullscreen";
import {
  SPEED_PRESETS,
  formatRate,
  quantizeRate,
  sameRate,
  stepRate,
} from "../../lib/playbackRate";
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

/** Backend fatal event shape — must match `StreamFatalEvent` in reader.rs. */
export interface TgStreamFatal {
  type: "flood_wait_exhausted" | "io_exhausted" | "auth_expired_unrecoverable" | "not_found" | "dc_migration_failed" | "connection_timeout";
  chat_id: number;
  message_id: number;
  // Variant-specific fields (optional to keep the union flat for TS).
  total_waited_secs?: number;
  attempts?: number;
}

/** Call the backend to reset error state for a Telegram stream (chat_id + message_id). */
async function retryTelegramStream(chat_id: number, message_id: number): Promise<void> {
  if (!isTauri()) return;
  try {
    await invokeCommand("tg_retry_stream", { chat_id, message_id });
  } catch (e) {
    // Non-fatal: log and continue — the player will fall back to its own retry timer if needed.
    console.error("[MpvVideoPlayer] tg_retry_stream failed:", e);
  }
}

/**
 * Fatal events that reprresent a permanent/Terminal condition for this stream — no amount of
 * retrying on the same file will help, so they should surface immediately rather than be held
 * waiting out a 60s buffering window.
 */
function isTerminalFatal(type: TgStreamFatal["type"]): boolean {
  return type === "not_found" || type === "auth_expired_unrecoverable";
}

/** Configurable timeouts — exported for testability, not for tuning in prod. */
const ENGINE_STALL_SECS = 8;      // No position advance, NOT buffering → engine crash
const NETWORK_TIMEOUT_SECS = 60;  // paused-for-cache with no cached data → network timeout

/** Shared error overlay chrome (used by both engine + network fatal states). */
function WatchdogOverlay({
  icon,
  title,
  message,
  actionLabel,
  onAction,
}: {
  icon: React.ReactNode;
  title: string;
  message: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/90 p-6 text-center text-white backdrop-blur-md">
      <div className="mb-4 rounded-full bg-orange-500/20 p-4">{icon}</div>
      <p className="mb-2 text-xl font-medium tracking-tight">{title}</p>
      <p className="mb-6 max-w-md text-sm text-neutral-400">{message}</p>
      <button
        type="button"
        onClick={onAction}
        className="rounded-full bg-white/10 px-6 py-2 text-sm font-medium text-white transition-colors hover:bg-white/20"
      >
        {actionLabel}
      </button>
    </div>
  );
}

/** Buffering spinner overlay — shown while paused-for-cache with no cached data.
 *  A self-contained SMIL spinner (native `<animateTransform>`), so it spins smoothly
 *  regardless of whether Tailwind's `animate-spin` utility (or any @keyframes)
 *  actually ships in the build. No CSS, no external animation classes, no Lucide
 *  icon — it cannot lose its rotation. */
function BufferingOverlay() {
  return (
    <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-black/70 p-6 text-center text-white backdrop-blur-sm">
      <div className="mb-3">
        <svg className="h-8 w-8 text-lime" viewBox="0 0 48 48" aria-hidden="true">
          <circle cx="24" cy="24" r="18" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="4" />
          <path d="M 24 6 A 18 18 0 0 1 41.3 17" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round">
            <animateTransform attributeName="transform" type="rotate" from="0 24 24" to="360 24 24" dur="0.8s" repeatCount="indefinite" />
          </path>
        </svg>
      </div>
      <p className="text-sm text-neutral-300">Buffering…</p>
    </div>
  );
}

/** Overlay for a backend `tg://stream-fatal` event — distinct copy per failure mode. */
function BackendFatalOverlay({ event, onRetry }: { event: TgStreamFatal; onRetry: () => void }) {
  const { type } = event;
  let title = "Stream Failed";
  let message = "The Telegram stream stopped unexpectedly.";
  let showRetry = true;

  switch (type) {
    case "flood_wait_exhausted":
      title = "Telegram Rate Limited";
      message = `Telegram asked us to slow down and the wait exceeded our budget (${event.total_waited_secs ?? 0}s). Please wait a few minutes and try again.`;
      break;
    case "io_exhausted":
      title = "Connection Failed";
      message = `Lost the connection to Telegram after ${event.attempts ?? 3} tries. This can be a temporary network blip.`;
      break;
    case "auth_expired_unrecoverable":
      title = "Session Expired";
      message = "Your Telegram session expired and could not be refreshed. Re-import this lesson to continue.";
      break;
    case "not_found":
      title = "File Unavailable";
      message = "This Telegram message was deleted or is no longer accessible. Re-import or remove it from your Library.";
      showRetry = false;
      break;
    case "dc_migration_failed":
      title = "Storage Moved";
      message = "Telegram relocated this file and auto-rediscovery failed. Please retry, or re-import the lesson.";
      break;
    default: // connection_timeout
      title = "Connection Timed Out";
      message = "Telegram did not respond in time. Check your connection and try again.";
  }

  return (
    <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/90 p-6 text-center text-white backdrop-blur-md">
      <div className="mb-4 rounded-full bg-orange-500/20 p-4">
        <WifiOff className="h-8 w-8 text-orange-500" />
      </div>
      <p className="mb-2 text-xl font-medium tracking-tight">{title}</p>
      <p className="mb-6 max-w-md text-sm text-neutral-400">{message}</p>
      {showRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-2 rounded-full bg-white/10 px-6 py-2 text-sm font-medium text-white transition-colors hover:bg-white/20"
        >
          <RefreshCw className="h-4 w-4" /> Retry
        </button>
      )}
    </div>
  );
}

/** Quick-pick speeds. Granular values come from `[`/`]` — see `lib/playbackRate`. */
const SPEEDS = SPEED_PRESETS;

// Global singleton for MPV. MPV is a heavy C-library and should only be 
// initialized and observed ONCE per application lifecycle to avoid Tauri IPC 
// race conditions ("Couldn't find callback id") when React rapidly unmounts.
let globalInitPromise: Promise<void> | null = null;

// Global cache of MPV state to sync new components instantly.
const globalMpvState = {
  pause: true,
  "time-pos": 0,
  duration: 0,
  volume: Number(localStorage.getItem("mpv-volume") ?? "100"),
  speed: 1,
  mute: localStorage.getItem("mpv-mute") === "true",
};

let globalLoadedPath: string | null = null;

const OBSERVED_PROPERTIES = [
  ["pause", "flag"],
  ["time-pos", "double", "none"],
  ["duration", "double", "none"],
  ["volume", "int64"],
  ["mute", "flag"],
  ["speed", "double"],
  ["eof-reached", "flag"],
  // ── Smart Watchdog (2026) — buffering detection ──
  // MPV sets `paused-for-cache = true` when it pauses BECAUSE the network cache is empty —
  // the core signal that separates "engine crashed / stalled" from "video is buffering".
  // A stalled engine keeps playing-paused with the cache full; a starving stream sets this.
  ["paused-for-cache", "flag", "none"],
  // Seconds of playable content buffered ahead. ~0 while waiting on a slow Telegram stream;
  // a healthy value while the engine is merely stalled after OS sleep. Lets the watchdog
  // distinguish "waiting for bytes" from "engine died" even when paused-for-cache is stale.
  ["demuxer-cache-duration", "double", "none"],
  // Full cache metadata ({fw, bw, file-cache-bytes…}). Reserved for future buffering UX.
  ["demuxer-cache-state", "node", "none"],
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
  /** Custom navigation handler for PiP button, to avoid getting stuck in player history. */
  onPip?: () => void;
  /** Telegram chat id when this is a streamed lesson (else null). Lets the Smart Watchdog
   *  match backend `tg://stream-fatal` events for THIS file only. */
  telegramChatId?: number | null;
  /** Telegram message id — pairs with `telegramChatId` for fatal-event matching. */
  telegramMessageId?: number | null;
}

export default function MpvVideoPlayer({ path, materialId, startPosition, fileName, onFail, onPip, telegramChatId, telegramMessageId }: Props) {
  const navigate = useNavigate();
  const setMiniActive = useMiniPlayer((s) => s.setActive);
  // The transparent "anchor" div — mpv renders to the OS window behind the webview,
  // showing through this hole. ResizeObserver keeps mpv's bounding box pinned to it.
  const videoAnchorRef = useRef<HTMLDivElement>(null);
  const seekFillRef = useRef<HTMLDivElement>(null);
  const seekTrackRef = useRef<HTMLDivElement>(null);
  const bufferFillRef = useRef<HTMLDivElement>(null);
  const currentLabelRef = useRef<HTMLSpanElement>(null);
  const durationLabelRef = useRef<HTMLSpanElement>(null);
  const timePosRef = useRef(0);
  const durationRef = useRef(0);
  const showRemainingTimeRef = useRef(localStorage.getItem("mpv-time-mode") === "remaining");
  const lastTimePosRef = useRef(0);
  const watchedSecondsRef = useRef(0);
  // Wall-clock baseline (performance.now) of the last processed `time-pos` event. Watch-time is
  // accumulated as REAL elapsed time between position events — never as `time-pos` deltas, which
  // advance at playbackRate content-seconds per real second (see the time-pos handler). Zeroed on
  // every discontinuity (pause / drag / seek / file change / window hide) so a gap in position
  // events can never bill skipped wall time.
  const lastWallTsRef = useRef(0);
  const draggingRef = useRef(false);
  const initedRef = useRef(false);
  
  /**
   * Resume point still owed to the current file, in seconds; 0 when nothing is pending.
   *
   * This is the belt to `start=`'s braces. `start=` is the primary mechanism and the only one that
   * avoids showing a frame from 0:00, but it is a per-file option on a command whose argument order
   * changed across mpv versions — so if it is ever ignored, this ref lets the FIRST observed
   * `time-pos` notice playback began at the wrong place and correct it once. Cleared as soon as it
   * is satisfied or superseded, so it can never fight a user seek.
   */
  const pendingResumeRef = useRef(0);
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
  // NOTE: there is deliberately no `duration` React state. It used to exist only to gate the old
  // resume effect (the source of the resume bug — see the load effect); the duration LABEL has
  // always been written straight to a DOM ref from the property observer, per the §15 perf rule.
  // Keeping the state would mean a re-render on every file load for a value nothing renders.
  const [volume, setVolume] = useState(globalMpvState.volume);
  const [isMuted, setIsMuted] = useState(globalMpvState.mute);
  const [rate, setRate] = useState(globalMpvState.speed);
  // Ref mirror of `rate`, for the same reason `isPlayingRef` exists: the keyboard listener is bound
  // once with empty deps, so a closure over the state would be frozen at its initial value and
  // every `[`/`]` press would compute from 1x. Written by both `changeRate` and the mpv `speed`
  // observer, so it always reflects the real engine speed.
  const rateRef = useRef(globalMpvState.speed);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Smart Watchdog (2026) — engine crash vs. network buffering ─────────────
  //
  // The old watchdog checked only "did `time-pos` move in 8s". That is blind to the network:
  // a slow Telegram stream fills up quietly, `/politely` pauses for cache, and the playhead
  // stops — exactly what the timer mistook for an engine crash after OS sleep. So this one
  // listens to MPV's OWN buffering signal (`paused-for-cache`) and the engine's cached
  // duration, and only runs the 8s engine-crash timer when the engine is NOT buffering.
  //
  //   playing    --(paused-for-cache=true)--> buffering     --(60s no data)--> network_timeout
  //   buffering  --(paused-for-cache=false)--> playing      (timer cancelled)
  //   playing    --(8s no progress, NOT buffering)--> engine_crash
  //   [any]      --(tg://stream-fatal matching this file)--> backend_fatal
  //
  // Buffering may legitimately last longer than 8s (slow connection); that must NEVER fire
  // the crash path. But it must not hang forever either — hence the separate 60s cap. The
  // backend also pushes `tg://stream-fatal` the moment IT gives up (FloodWait / IO budgets
  // exhausted), so genuine failures skip the timers entirely.
  type WatchdogState =
    | { kind: "idle" }
    | { kind: "playing"; baseline: { wall: number; pos: number } }
    | { kind: "buffering"; since: number }
    | { kind: "engine_crash" }
    | { kind: "network_timeout" }
    | { kind: "backend_fatal"; event: TgStreamFatal };
  const [watchdog, setWatchdogState] = useState<WatchdogState>({ kind: "idle" });
  const watchdogRef = useRef<WatchdogState>({ kind: "idle" });
  // Refs mirroring the mpv buffering signals (written by the observer; read on the 1s tick).
  const pausedForCacheRef = useRef(false);
  const demuxCacheDurationRef = useRef(0);
  // Seconds of forward-buffered content (from demuxer-cache-state.fw), for the buffer bar.
  const demuxCacheForwardRef = useRef(0);
  // True the instant a fatal state is entered, so the interval breaks out of the tick loop.
  const watchdogFatalRef = useRef(false);
  // A fatal event that arrived while the engine still had cached content to play. We hold it
  // (rather than committing an overlay immediately) so the video keeps playing out its buffer —
  // Issue 1 fix — and only surface it once the cache is genuinely exhausted.
  const pendingFatalRef = useRef<TgStreamFatal | null>(null);
  // True from the moment an explicit Retry is issued until either data arrives or the 60s
  // network clock expires. While set, a fresh backend fatal is HELD (still pending) but NOT
  // surfaced — the user asked for a full 60s retry window, so a backend "gave up" during that
  // window should not yank them straight back to an error overlay (Issue 4).
  const retryInProgressRef = useRef(false);

  // Single write-point for the watchdog: keeps the ref (read by the 1s tick) and the React
  // state (rendered) in lockstep, and flips the fatal flag so the tick stops polling.
  const setWatchDog = useCallback((next: WatchdogState) => {
    watchdogRef.current = next;
    setWatchdogState(next);
    watchdogFatalRef.current =
      next.kind === "engine_crash" || next.kind === "network_timeout" || next.kind === "backend_fatal";
  }, []);

  // Check if the stream has genuinely exhausted its cache: paused-for-cache AND zero buffered duration.
  // This is the guard for Issue 1: suppress all fatal overlays while cached video still plays.
  const cacheExhausted = useCallback((): boolean => {
    // If the backend drops the stream, libmpv hits an unexpected EOF and pauses 
    // WITHOUT setting paused-for-cache. So we just check if there is basically no cache left.
    return demuxCacheDurationRef.current <= 0.2;
  }, []);

  // Update the YouTube-style buffer bar (Issue 2).
  // Buffer = (current_position + forward_buffered_seconds) / total_duration.
  // Updates on every `time-pos` (playhead moves) AND `demuxer-cache-state` (fw changes).
  const updateBufferBar = useCallback(() => {
    if (!bufferFillRef.current || durationRef.current <= 0) return;
    const pos = timePosRef.current;
    const fwSecs = demuxCacheDurationRef.current;
    const pct = Math.min(100, ((pos + fwSecs) / durationRef.current) * 100);
    bufferFillRef.current.style.width = `${pct}%`;
  }, []);

  // One interval drives both timers. Health = the position moves while (not buffering) OR the
  // buffer refills while buffering. On pause/drag/seek the machine returns to idle.
  useEffect(() => {
    if (!ready || !path) return;
    let lastTick = performance.now();
    const interval = window.setInterval(() => {
      if (disposedRef.current || watchdogFatalRef.current) return;

      const now = performance.now();
      const deltaTick = now - lastTick;
      lastTick = now;

      const pos = timePosRef.current;

      // ── OS SLEEP / SUSPEND DETECTION ──
      // If the tick took an unusually long time (e.g. laptop closed), the wall clock advanced
      // artificially without giving the player/network a chance to actually work. We simply 
      // roll the baseline forward to prevent instant timeouts.
      if (deltaTick > 3000) {
        const cur = watchdogRef.current;
        if (cur.kind === "playing" && cur.baseline) {
          setWatchDog({ kind: "playing", baseline: { wall: now, pos } });
        } else if (cur.kind === "buffering") {
          setWatchDog({ kind: "buffering", since: now });
        }
        return;
      }
      const buffering = pausedForCacheRef.current;
      const atEof = pos > 0 && durationRef.current > 0 && (durationRef.current - pos) < 1;

      // ── OFFLINE CHECK ──
      // If the OS reports no internet connection, and the cache is exhausted, we don't
      // need to wait for the backend to timeout. It's a guaranteed failure.
      if (!navigator.onLine && cacheExhausted() && !atEof) {
        setWatchDog({ 
          kind: "backend_fatal", 
          event: { type: "io_exhausted", attempts: 1, chat_id: 0, message_id: 0 } 
        });
        return;
      }

      // ── RETRY HOLD (Issue 4) ──────────────────────────────────────────────
      // If the user explicitly clicked Retry, we must KEEP the buffering state
      // and the 60s network clock running — even if mpv hasn't flipped
      // paused-for-cache back to true yet. This prevents the tick from
      // immediately popping out to "idle" or "playing" before data arrives.
      if (retryInProgressRef.current) {
        const cur = watchdogRef.current;
        
        // If the engine has successfully fetched new data, the retry was a success!
        // We drop the forced hold and let the normal tick manage state.
        if (demuxCacheDurationRef.current > 0.1) {
          retryInProgressRef.current = false;
        } else {
          if (cur.kind !== "buffering") {
            // Force into buffering with a fresh clock so the full 60s window applies.
            setWatchDog({ kind: "buffering", since: now });
          } else {
            // Already buffering — just check the 60s cap.
            const bufferedFor = (now - cur.since) / 1000;
            if (bufferedFor >= NETWORK_TIMEOUT_SECS) {
              console.error("[MpvVideoPlayer] Smart Watchdog: retry buffered without data for", bufferedFor, "s");
              retryInProgressRef.current = false;
              setWatchDog({ kind: "network_timeout" });
            }
          }
          return;
        }
      }

      // ── PENDING FATAL CHECK (Issue 1) ─────────────────────────────────────
      // A backend `tg://stream-fatal` may arrive while cached video still plays.
      // We hold it in `pendingFatalRef` and ONLY surface it once the cache is
      // genuinely exhausted (paused-for-cache=true AND demuxer-cache-duration=0).
      // This check runs FIRST, in ANY state (playing, buffering, idle), so a
      // fatal that arrived during playback is never silently dropped.
      // Guard: do not surface if at clean EOF (video naturally ended).
      const pending = pendingFatalRef.current;
      if (pending && cacheExhausted() && !atEof) {
        pendingFatalRef.current = null;
        console.error("[MpvVideoPlayer] Cache exhausted — surfacing backend fatal:", pending);
        setWatchDog({ kind: "backend_fatal", event: pending });
        return;
      }

      // Genuinely paused / user dragging: not engine failure, not buffering — idle.
      // (If we are paused-for-cache or retrying, the engine might be "paused", but it's not a user idle state).
      if ((isPausedRef.current && !buffering && !retryInProgressRef.current) || draggingRef.current) {
        const cur = watchdogRef.current;
        if (cur.kind === "playing" || cur.kind === "buffering") setWatchDog({ kind: "idle" });
        // Do NOT clear pendingFatalRef here — the user explicitly paused, but a
        // fatal for this file may still be pending and should surface when they
        // resume and the cache drains (Issue 1).
        return;
      }

      // ── Buffering branch ─────────────────────────────────────────────────
      if (buffering) {
        const cur = watchdogRef.current;
        if (cur.kind !== "buffering") {
          // Left playing → entered buffering. Start the network clock. The engine-crash
          // baseline is implicitly abandoned (we only act on "playing"). 
          setWatchDog({ kind: "buffering", since: now });
          return;
        }
        if (demuxCacheDurationRef.current > 0) {
          // Some playable content is cached again. mpv will flip paused-for-cache off once it
          // has enough; a slow-but-alive stream must not be falsely timed out, so restart the
          // buffering clock rather than counting against the cap.
          setWatchDog({ kind: "buffering", since: now });
          return;
        }
        // Cache exhausted while buffering (paused-for-cache=true AND demuxer-cache-duration=0).
        // If there's a pending backend fatal, surface it NOW (Issue 1) instead of waiting
        // for the 60s network timeout — the backend has already told us it's dead.
        const bufferedFor = (now - cur.since) / 1000;
        if (bufferedFor >= NETWORK_TIMEOUT_SECS) {
          // eslint-disable-next-line no-console
          console.error("[MpvVideoPlayer] Smart Watchdog: buffered without data for", bufferedFor, "s");
          setWatchDog({ kind: "network_timeout" });
        }
        return;
      }

      // ── Not buffering ──
      const cur = watchdogRef.current;
      const baseline = cur.kind === "playing" ? cur.baseline : null;
      if (!baseline) {
        setWatchDog({ kind: "playing", baseline: { wall: now, pos } });
        return;
      }

      const elapsedWall = (now - baseline.wall) / 1000;
      // If we are at 0:00 (just starting), give the network more grace period (e.g., 30s)
      // to establish the connection before calling it a hard engine crash.
      const timeoutLimit = pos === 0 ? 30 : ENGINE_STALL_SECS;
      if (elapsedWall < timeoutLimit) return;

      if (pos === baseline.pos) {
        // Position hasn't moved and MPV says it isn't buffering — the engine (hwdec/audio)
        // truly stalled (e.g. after OS sleep). paused-for-cache already ruled out a network
        // stall, so this is the real crash path.
        // eslint-disable-next-line no-console
        console.error("[MpvVideoPlayer] Smart Watchdog: engine stall after", elapsedWall, "s; pos:", pos);
        setWatchDog({ kind: "engine_crash" });
      } else {
        // Healthy — position moved. Roll the baseline forward.
        setWatchDog({ kind: "playing", baseline: { wall: now, pos } });
        // Playback is flowing again after a buffering window — a retry window, if one was
        // active, has served its purpose, so clear it. A PENDING fatal is deliberately NOT
        // touched here: the backend never rescues a stream on its own (only an explicit
        // `tg_reTry_stream` resets it), so a recorded "give up" stays truthful until the cache
        // finishes draining — Issue 1 — at which point the buffering branch surfaces it.
        retryInProgressRef.current = false;
      }
    }, 1000);

    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, path, setWatchDog, cacheExhausted]);

  // Backend-driven fatal: `tg://stream-fatal` from reader.rs. Matches by chat+message id so
  // events for OTHER lessons still playing in a background engine are ignored.
  const isTelegramStream = telegramChatId != null && telegramMessageId != null;
  useEffect(() => {
    if (!isTauri() || !isTelegramStream) return;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) => {
      listen<TgStreamFatal>("tg://stream-fatal", (event) => {
        if (disposedRef.current || watchdogFatalRef.current) return;
        const p = event.payload;
        if (p.chat_id !== telegramChatId || p.message_id !== telegramMessageId) return;
        // eslint-disable-next-line no-console
        console.error("[MpvVideoPlayer] backend stream-fatal:", p);
        // Terminal failures (not_found / auth) are hopeless on retry — show immediately.
        if (isTerminalFatal(p.type)) {
          pendingFatalRef.current = null;
          setWatchDog({ kind: "backend_fatal", event: p });
          return;
        }
        // Recoverable failures (io / timeout / flood / dc): hold them.
        // (a) If there is still cached content, keep playing it out (Issue 1) and surface
        //     only when the buffer runs dry.
        // (b) If the user initiated a retry window, respect the full 60s attempt (Issue 4).
        // Either way we commit to `pendingFatalRef` and let the watchdog tick decide when (if
        // ever) to surface it — so a fresh fatal never yanks the player into an overlay the
        // moment the backend gives up while the user is asking for a retry.
        pendingFatalRef.current = p;
      }).then((u) => { unlisten = u; });
    });
    return () => { unlisten?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTelegramStream, telegramChatId, telegramMessageId]);

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

  // Issue 4 fix — a real retry, not just "reset the overlay".
  //
  // When the user clicks "Retry" on a Network Timeout or Backend Fatal overlay:
  //   1. Ask the backend to reset the reader's per-file error state (new `tg_retry_stream`
  //      command) so it will attempt fresh chunk fetches.
  //   2. Clear any stale fatal + reset the watchdog to the "buffering" state — showing the
  //      spinner instantly and starting the 60s network clock.
  //   3. Tell mpv to resume playing (set pause=false), so once bytes arrive it plays on.
  //
  // The 60s cap already lives in the buffering branch of the watchdog tick, so if the retry
  // gets no data it lands in `network_timeout` again and the overlay reappears.
  const handleRetry = useCallback(() => {
    // eslint-disable-next-line no-console
    console.log("[MpvVideoPlayer] retry requested");
    pendingFatalRef.current = null;
    retryInProgressRef.current = true;
    const wasTelegram = telegramChatId != null && telegramMessageId != null;
    if (wasTelegram && isTauri()) {
      void retryTelegramStream(telegramChatId!, telegramMessageId!);
    }
    // Dismiss the fatal flag + overlay NOW (so the buffering state can take over), then
    // re-enter `buffering` synchronously. The tick will keep it honest from here.
    setWatchDog({ kind: "buffering", since: performance.now() });
    
    // Force libmpv to re-open the HTTP connection.
    // If the file never loaded successfully initially (duration is 0), `seek` will fail 
    // silently, so we MUST use `loadfile`. Otherwise, `seek` to clear the EOF flag.
    if (durationRef.current > 0) {
      void command("seek", [timePosRef.current, "absolute"]).catch(() => {});
    } else {
      const resumeAt = startPositionRef.current;
      const shouldResume = Number.isFinite(resumeAt) && resumeAt > 1;
      if (shouldResume) {
        void command("loadfile", [path, "replace", -1, `start=${resumeAt.toFixed(3)}`]).catch(() => {});
      } else {
        void command("loadfile", [path]).catch(() => {});
      }
    }
    
    // If mpv is (still) paused waiting for data, ask it to resume so playback continues once
    // chunks arrive. Safe: if the engine already self-resumed this is a no-op.
    void setProperty("pause", false).catch(() => {});
  }, [telegramChatId, telegramMessageId, setWatchDog, setProperty]);

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

  /**
   * Drain genuinely-watched seconds into `log_session`.
   *
   * Matches `useMediaProgress.flush`: any positive seconds are logged (no 1s threshold)
   * so a final <1s tail at EOF isn't lost — the "ended leak". Draining is a MOVE, not a copy:
   * the counter is zeroed before the await so a concurrent flush can't bill the same seconds twice.
   */
  const drainSession = useCallback(() => {
    const secs = watchedSecondsRef.current;
    if (secs <= 0) return;
    watchedSecondsRef.current = 0;
    void ipc.logSession(materialId, secs).catch(() => {
      watchedSecondsRef.current += secs;
    });
  }, [materialId]);

  // ── Periodic Save & Drain (every 15s) ───────────────────────────────────────
  // A safety net to flush watched seconds and position to the backend during long
  // uninterrupted playback. Without this, a student watching a 45m lecture without
  // pausing wouldn't see their Study Meter update until the video ended.
  useEffect(() => {
    if (!ready || !path) return;
    const id = window.setInterval(() => {
      if (disposedRef.current) return;
      saveProgress(false); // coalesced save
      drainSession();
    }, 15000);
    return () => window.clearInterval(id);
  }, [ready, path, saveProgress, drainSession]);

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
              if (data) {
                saveProgress(true); // save on pause (forced)
                // Pausing is a natural boundary: bank the watched time now rather than
                // holding it in memory while the student walks away.
                drainSession();
                // No `time-pos` events flow while paused, so the baseline would otherwise stay
                // at its pre-pause value and the first post-resume event would bill the whole
                // pause as watched time. Zero it: the next event after resume seeds fresh.
                lastWallTsRef.current = 0;
              }
              break;
            case "time-pos": {
              const t = (data as number | null) ?? 0;
              // Monotonic wall clock at this event's processing time. Watch-time accrues as
              // `nowWall - lastWallTsRef` (real elapsed seconds), never `t - lastTimePosRef`.
              const nowWall = performance.now();

              // ── Resume safety net ──
              // `start=` on loadfile is the primary mechanism and normally means the first position
              // we ever see IS the resume point. If it was ignored (a version whose argument order
              // differs, or a container that can't seek precisely on open), playback begins near 0
              // instead — so correct it on the first observed position and disarm.
              //
              // Only fires when the gap is real (> 2s): a successful `start=` lands within a
              // keyframe of the target, and re-seeking that would be a pointless second jump.
              // Disarmed unconditionally either way, so this can run at most once per load and can
              // never fight a deliberate seek by the student.
              const owed = pendingResumeRef.current;
              if (owed > 0) {
                pendingResumeRef.current = 0;
                if (owed - t > 2) {
                  // eslint-disable-next-line no-console
                  console.log("[MpvVideoPlayer] start= did not take; seeking to", owed);
                  void command("seek", [owed, "absolute"]).catch(() => {});
                  // Treat the target as the current position so the delta below can't bill the
                  // skipped span as watched time.
                  lastTimePosRef.current = owed;
                  timePosRef.current = owed;
                  // A corrective seek is a discontinuity — seed the wall-clock baseline fresh on
                  // the next event so the seek + settle gap isn't billed either.
                  lastWallTsRef.current = 0;
                  break;
                }
              }

              // Accumulate genuinely-watched time in WALL-CLOCK seconds.
              //
              // `time-pos` advances at playbackRate content-seconds per real second — at 2x the
              // position moves 2 content-seconds per real second — so a position delta would bill
              // 2 study-seconds per real second (the fake-time bug this must not regress). Real
              // elapsed time between position events sums to exactly the time the player was live,
              // at ANY speed. This is the same invariant the HTML5 path enforces with rAF
              // timestamps instead of `currentTime` deltas.
              //
              // `draggingRef` mirrors the HTML5 path's `!v.seeking` guard: while the user is
              // dragging the seek bar, position jumps are the user's hand, not playback.
              // `t > lastTimePosRef.current` is the "the video actually moved" test — a stalled
              // player with the position frozen is not study time. When the player is NOT live the
              // baseline is zeroed, so the next genuine playback seeds fresh instead of billing the
              // gap.
              const isLive = !isPausedRef.current && !draggingRef.current && t > lastTimePosRef.current;
              if (isLive && lastWallTsRef.current > 0) {
                watchedSecondsRef.current += (nowWall - lastWallTsRef.current) / 1000;
              }
              lastWallTsRef.current = isLive ? nowWall : 0;
              lastTimePosRef.current = t;
              timePosRef.current = t;
              playbackStartedRef.current = true; // we received a position → playback live
              const d = durationRef.current;
              if (!draggingRef.current && seekFillRef.current && d > 0) {
                seekFillRef.current.style.width = `${(t / d) * 100}%`;
              }
              // The playhead advanced → the buffered portion of the bar must advance too
              // (buffer = pos + fw). Refresh on every position event so the buffer bar tracks
              // the moving playhead, not just cache updates (Issue 2).
              if (!draggingRef.current) updateBufferBar();
              if (currentLabelRef.current) {
                const d = durationRef.current;
                if (showRemainingTimeRef.current && d > 0) {
                  currentLabelRef.current.textContent = "-" + formatDuration(Math.max(0, d - t));
                } else {
                  currentLabelRef.current.textContent = formatDuration(t);
                }
              }
              break;
            }
            case "duration": {
              const d = (data as number | null) ?? 0;
              durationRef.current = d;
              // Ref + DOM write only, no React state: nothing renders `duration` as state, and the
              // label is a direct textContent write per the §15 perf rule.
              if (durationLabelRef.current) durationLabelRef.current.textContent = formatDuration(d);
              // Duration changed → refresh the buffer percentage (fw / total may have changed)
              updateBufferBar();
              break;
            }
            case "volume":
              localStorage.setItem("mpv-volume", String(data));
              setVolume(data as number);
              break;
            case "mute":
              localStorage.setItem("mpv-mute", String(data));
              setIsMuted(!!data);
              break;
            case "speed": {
              // Quantized on the way in as well as out: mpv echoes back the double it holds, and a
              // value that arrived from anywhere other than `changeRate` (a config default, a
              // future script binding) must still render as a clean "1.2×" rather than a float
              // artefact. Keeps the ref and the state in lockstep for the keyboard path.
              const s = quantizeRate(data as number);
              rateRef.current = s;
              setRate(s);
              break;
            }
            case "eof-reached":
              if (data) {
                saveProgress(true); // save on end (forced)
                // Order matters: the forced save is what crosses the completion threshold and
                // credits the item, and the last watched seconds belong to this block too.
                drainSession();
              }
              break;
            case "paused-for-cache": {
              // MPV sets this to true when playback pauses BECAUSE the network cache is empty.
              // This is the authoritative signal separating "engine stall" from "buffering".
              pausedForCacheRef.current = !!data;
              break;
            }
            case "demuxer-cache-duration": {
              // Seconds of playable content currently buffered ahead. ~0 while waiting on a slow
              // stream; a healthy value while the engine is merely stalled after OS sleep.
              // The watchdog tick reads this to distinguish "waiting for bytes" from dead engine.
              demuxCacheDurationRef.current = (data as number | null) ?? 0;
              updateBufferBar();
              break;
            }
            case "demuxer-cache-state": {
              // We ignore demuxer-cache-state now because demuxer-cache-duration is much more
              // reliable for drawing the buffer bar.
              break;
            }
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
      // Final progress save + session log on unmount (forced — always persist exactly). This is
      // now the LAST resort rather than the only one: pause, EOF, hide and the 15s flush have
      // already banked most of it.
      saveProgress(true);
      drainSession();
      
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

  // Mirror of `startPosition` so the load effect can read the resume point WITHOUT taking it as a
  // dependency. This is deliberate: adding it to the deps below would make a prop change re-run
  // `loadfile` and restart the video mid-playback. Assigned during render so it is always current
  // before any effect runs; never read during render, so it can't affect output.
  const startPositionRef = useRef(startPosition);
  startPositionRef.current = startPosition;

  // ── Load the file (re-runs when init completes via `ready` AND on path change) ─
  // CRITICAL: deps include `ready` so this fires AFTER init completes. Without it,
  // the effect runs on mount when initedRef is still false → skips → dead player.
  useEffect(() => {
    if (!ready || !path) return;
    
    if (globalLoadedPath === path) {
      // The video is ALREADY loaded in the global MPV engine! 
      // (This happens when the component unmounts/remounts quickly, e.g. toggling fullscreen layout).
      // DO NOT reload the file. Just sync the visual DOM refs to the engine's current state.
      //
      // Resume must stay disarmed on this path. The engine is mid-playback and its position is
      // ahead of whatever the DB held when this component mounted, so applying a resume here would
      // yank the video backwards on every fullscreen toggle — which is exactly what the old
      // "did this instance load the file?" guard existed to prevent.
      pendingResumeRef.current = 0;
      const d = globalMpvState.duration;
      const t = globalMpvState["time-pos"];
      durationRef.current = d;
      timePosRef.current = t;
      lastTimePosRef.current = t;
      
      if (seekFillRef.current && d > 0) {
        seekFillRef.current.style.width = `${(t / d) * 100}%`;
      }
      if (currentLabelRef.current) {
        if (showRemainingTimeRef.current && d > 0) {
          currentLabelRef.current.textContent = "-" + formatDuration(Math.max(0, d - t));
        } else {
          currentLabelRef.current.textContent = formatDuration(t);
        }
      }
      if (durationLabelRef.current) durationLabelRef.current.textContent = formatDuration(d);
      
      return;
    }

    globalLoadedPath = path;

    // Reset state for the (new) file. Refs and DOM only — no React state write here, which is
    // also what removes the race the old resume effect depended on.
    durationRef.current = 0;
    timePosRef.current = 0;
    lastTimePosRef.current = 0;
    watchedSecondsRef.current = 0;
    lastWallTsRef.current = 0;
    playbackStartedRef.current = false;
    if (seekFillRef.current) seekFillRef.current.style.width = "0%";
    if (currentLabelRef.current) currentLabelRef.current.textContent = "0:00";
    if (durationLabelRef.current) durationLabelRef.current.textContent = "—";
    // eslint-disable-next-line no-console
    console.log("[MpvVideoPlayer] loadfile:", path);
    void (async () => {
      let attempts = 0;
      const resumeAt = startPositionRef.current;
      const shouldResume = Number.isFinite(resumeAt) && resumeAt > 1;
      pendingResumeRef.current = shouldResume ? resumeAt : 0;

      while (attempts < 3) {
        try {
          if (disposedRef.current || globalLoadedPath !== path) return; // Navigated away

          if (shouldResume) {
            // eslint-disable-next-line no-console
            console.log("[MpvVideoPlayer] resuming at", resumeAt, "s (attempt", attempts + 1, ")");
            timePosRef.current = resumeAt;
            lastTimePosRef.current = resumeAt;
            await command("loadfile", [path, "replace", -1, `start=${resumeAt.toFixed(3)}`]);
          } else {
            await command("loadfile", [path]);
          }
          
          if (disposedRef.current || globalLoadedPath !== path) return;

          setMiniActive(materialId, fileName ?? path.split(/[\\/]/).pop() ?? "Now playing");
          const actualPause = await getProperty("pause", "flag");
          if (actualPause !== null && actualPause !== undefined) {
             globalMpvState.pause = actualPause;
             setIsPlaying(!actualPause);
             isPlayingRef.current = !actualPause;
             isPausedRef.current = actualPause;
          }
          return; // Success
        } catch (e) {
          attempts++;
          // eslint-disable-next-line no-console
          console.error(`[MpvVideoPlayer] loadfile rejected (attempt ${attempts}):`, e);
          if (attempts >= 3) {
            // eslint-disable-next-line no-console
            console.error("[MpvVideoPlayer] loadfile failed completely after 3 attempts.");
            return;
          }
          // Wait 300ms before retry
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    })();

    // NOTE: The 6-second timeout fallback that was here has been removed — it was
    // falsely killing working playback because the time-pos observer wasn't registered
    // (fixed above by passing observedProperties to init). If we need a fallback later,
    // it should only trigger on an actual init/loadfile ERROR, not a timer.
  }, [path, ready]);

  // ── Resume: applied by the LOAD, not by a follow-up seek ───────────────────
  //
  // There is deliberately no resume effect here any more. Position is handed to mpv as a
  // `start=` option on `loadfile` (see the load effect above), which fixes the reported bug at
  // its root:
  //
  //   * the old effect gated on `duration > 0` read from React STATE, which the load effect had
  //     just reset to 0 — if mpv's async duration event beat React's commit, the gate saw 0,
  //     skipped, and latched `resumeAppliedRef` so it never retried. The DB held 29% and the
  //     video sat at 0:00, exactly as reported;
  //   * and even on success it seeked AFTER playback had begun, so frames from 0:00 were decoded
  //     and shown before the jump.
  //
  // The "only if this instance loaded the file" guard it carried is preserved by construction
  // rather than by a flag: the `start=` option only exists on the `loadfile` call, and that call is
  // already skipped when the component reconnects to an engine that has this path loaded (the
  // `globalLoadedPath === path` early return, which also disarms `pendingResumeRef`). So a
  // fullscreen remount still cannot yank playback back to the old DB position.

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
        // Always refresh metrics before measuring. The old code only refreshed when the
        // cache was empty, so an anchor-only layout change (fullscreen frame swap, sidebar
        // toggle) aligned mpv against STALE window dimensions → a black band around the
        // video. The 80 ms debounce keeps this from storming during a resize animation.
        await refreshWinMetrics();
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

  // ── Callbacks ──────────────────────────────────────────────────────────────
  const toggleRemainingTime = useCallback(() => {
    const next = !showRemainingTimeRef.current;
    showRemainingTimeRef.current = next;
    localStorage.setItem("mpv-time-mode", next ? "remaining" : "elapsed");
    if (currentLabelRef.current) {
      const t = timePosRef.current;
      const d = durationRef.current;
      if (next && d > 0) {
        currentLabelRef.current.textContent = "-" + formatDuration(Math.max(0, d - t));
      } else {
        currentLabelRef.current.textContent = formatDuration(t);
      }
    }
  }, []);

  // Mirror fullscreen via the shared, debounced source (one app-wide window listener) rather
  // than this component's own onResized→isFullscreen poll — that per-tick IPC across three
  // components was the fullscreen-lag storm. On each change, refresh the cached window
  // metrics and re-align mpv to the new (full-screen or windowed) anchor rect.
  useEffect(() => {
    return subscribeFullscreen((fs) => {
      if (disposedRef.current) return;
      setIsFullscreen(fs);
      void refreshWinMetrics().then(() => alignViewport());
    });
  }, [alignViewport, refreshWinMetrics]);

  // ── Controls ───────────────────────────────────────────────────────────────
  // Bug 4 fix: togglePlay reads isPlayingRef (the ref-mirrored backend pause
  // state, the source of truth) instead of the React isPlaying state, which
  // can be stale/desynced during rapid switches. Space always toggles the
  // REAL backend state.
  const togglePlay = () =>
    void setProperty("pause", isPlayingRef.current).catch(() => {});
  /**
   * Seek to an absolute position, WITHOUT crediting the skipped span as watched time.
   *
   * The `time-pos` observer accumulates `t - lastTimePosRef.current` as watched seconds. If a
   * seek only updated `timePosRef`, the first observed position after the jump would be far ahead
   * of `lastTimePosRef` and the whole skipped span (e.g. scrubbing 10s → 9801s in a 2h45m video)
   * would be billed as study time. Seeding `lastTimePosRef` to the target BEFORE the command means
   * the next `time-pos` delta is ~0, so a seek grants nothing. This is the same invariant the
   * resume safety net already relied on.
   */
  const seekAbsolute = (t: number) => {
    const d = durationRef.current;
    const target = Math.max(0, d > 0 ? Math.min(d, t) : t);
    timePosRef.current = target;
    lastTimePosRef.current = target; // the skipped span must not be billed as watched
    // Same rule for the wall-clock baseline: a seek (keyboard skip, notes jump, skip buttons) is
    // a discontinuity, so the first post-seek `time-pos` event seeds fresh rather than billing
    // the seek + settle gap as watched time.
    lastWallTsRef.current = 0;
    
    // Invalidate the frontend's cache memory immediately on seek. If the user seeks while offline, 
    // the backend will fail instantly, and we need the watchdog to know the cache is empty (Bug 2 fix).
    demuxCacheDurationRef.current = 0;
    demuxCacheForwardRef.current = 0;
    updateBufferBar();
    
    void command("seek", [target, "absolute"]).catch(() => {});
    if (seekFillRef.current && d > 0) seekFillRef.current.style.width = `${(target / d) * 100}%`;
    saveProgress(true);
  };
  const seekTo = (frac: number) => {
    const d = durationRef.current;
    if (d <= 0) return;
    seekAbsolute(frac * d);
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
    if (isMuted && v > 0) {
      void setProperty("mute", false).catch(() => {});
    }
  };
  /**
   * Set an absolute speed (preset menu, or the target of a nudge).
   *
   * Quantized before it leaves: mpv accepts any double, so an unsnapped 0.7000000000000001 would be
   * accepted, echoed back by the `speed` observer, and rendered in the control bar verbatim.
   *
   * `closeMenu` is false for keyboard nudges — `[`/`]` shouldn't require the menu to be open, and
   * shouldn't close it if it is.
   */
  const changeRate = (r: number, closeMenu = true) => {
    const q = quantizeRate(r);
    // Optimistic local update so the label moves on the same frame as the keypress. The `speed`
    // observer will confirm the same value; because both sides quantize, it can't disagree.
    setRate(q);
    rateRef.current = q;
    void setProperty("speed", q).catch(() => {});
    if (closeMenu) setSpeedOpen(false);
  };

  /**
   * Step the speed by one 0.10x increment (`]` faster, `[` slower).
   *
   * Reads `rateRef`, never the `rate` state: the keyboard listener below is bound ONCE with empty
   * deps (deliberately — see its comment) so a closure over state would be frozen at 1x forever and
   * every press would produce the same value. The ref is updated by both this path and the mpv
   * `speed` observer, so it reflects the real engine speed even if it was changed elsewhere.
   */
  const nudgeRate = (dir: 1 | -1) => changeRate(stepRate(rateRef.current, dir), false);
  const skip = (secs: number) => seekAbsolute(timePosRef.current + secs);
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
        // Granular speed, 0.10x per press. Bracket keys match mpv's own defaults, so the shortcut
        // a student already knows from mpv/VLC works here too. Reads `rateRef` via `nudgeRate`
        // (see there) because this listener is intentionally bound once.
        case "[":
          e.preventDefault();
          nudgeRate(-1);
          break;
        case "]":
          e.preventDefault();
          nudgeRate(1);
          break;
        // Back to 1x. mpv binds BACKSPACE for this; `\` is offered alongside because BACKSPACE is
        // ambiguous in a webview (it can mean "navigate back" depending on focus).
        case "Backspace":
        case "\\":
          e.preventDefault();
          changeRate(1, false);
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
    const onHide = () => {
      saveProgress(true);
      drainSession();
      // If playback continued while the window was hidden, the next `time-pos` event would arrive
      // with a large wall-clock gap and bill the hidden time. Zero the baseline so it seeds fresh
      // on return — hidden playback is not watched time.
      lastWallTsRef.current = 0;
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onHide();
    };
    window.addEventListener("beforeunload", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("beforeunload", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [ready, saveProgress, drainSession]);

  // Expose current time + seek to player-adjacent UI (timestamped Notes) via the bridge.
  useEffect(() => {
    playerBridge.register(
      materialId,
      () => timePosRef.current,
      (secs: number) => {
        const d = durationRef.current;
        seekAbsolute(d > 0 ? Math.min(d, secs) : secs);
      },
    );
    return () => playerBridge.unregister(materialId);
  }, [materialId]);

  // Periodic safety flush of progress (every 15 s while watching). Coalesced: only writes
  // if the position actually advanced ≥ 5s since the last save (no redundant SSD writes).
  //
  // The session drain rides the SAME interval, which is what makes an active block's progress
  // bar move while the student is still watching (matching `useMediaProgress` on the HTML5
  // path). 15s is also the resolution of the "time on a course" target: a 25-minute block ticks
  // over ~100 times, which is smooth enough to read as live and cheap enough to ignore.
  useEffect(() => {
    if (!ready) return;
    const id = window.setInterval(() => {
      saveProgress(false);
      drainSession();
    }, 15000);
    return () => window.clearInterval(id);
  }, [ready, saveProgress, drainSession]);

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
      {/* ── Smart Watchdog Overlays ─────────────────────────────────────────── */}
      {/* Engine crash is not network-related — show immediately (Issue 1 guard not needed). */}
      {watchdog.kind === "engine_crash" && (
        <WatchdogOverlay
          icon={<AlertCircle className="h-8 w-8 text-orange-500" />}
          title="Video Engine Stalled"
          message="The media engine lost its hardware connection (usually after sleep/hibernate)."
          actionLabel="Restart Player"
          onAction={() => { saveProgress(true); drainSession(); window.location.reload(); }}
        />
      )}
      {/* Buffering spinner — Issue 3. Shown while paused-for-cache with no data. */}
      {watchdog.kind === "buffering" && <BufferingOverlay />}
      {/* Network/Backend fatal overlays — Issue 1 fix: ONLY show when cache is exhausted, OR
          when the failure is terminal (404 / auth — hopeless on retry, so surface instantly). */}
      {watchdog.kind === "network_timeout" && cacheExhausted() && (
        <WatchdogOverlay
          icon={<WifiOff className="h-8 w-8 text-orange-500" />}
          title="Stream Timed Out"
          message="The video buffered for 60 seconds without receiving any data. Your connection may be too slow."
          actionLabel="Retry"
          onAction={handleRetry}
        />
      )}
      {watchdog.kind === "backend_fatal" && (cacheExhausted() || isTerminalFatal(watchdog.event.type)) && (
        <BackendFatalOverlay event={watchdog.event} onRetry={handleRetry} />
      )}

      {/* ── Loading ── */}
      {!ready && watchdog.kind === "idle" && (
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
            {/* Buffered (downloaded) bar — Issue 2. Rendered UNDER the playhead fill,
                ahead of it, YouTube-style. Updated via DOM ref from demuxer-cache-state.fw. */}
            <div ref={bufferFillRef} className="absolute left-0 top-0 h-full rounded-full bg-white/25" style={{ width: "0%" }} />
            {/* Playhead fill — sits on top of the buffer bar. */}
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
              onClick={() => void setProperty("mute", !isMuted).catch(() => {})}
              className="shrink-0 rounded-full p-2 text-content-secondary transition-colors hover:bg-white/[0.1] hover:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
              aria-label="Mute"
            >
              {isMuted || volume === 0 ? <MuteIcon /> : <VolumeIcon />}
            </button>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={isMuted ? 0 : volume}
              onChange={changeVolume}
              className="h-1 w-0 cursor-pointer appearance-none rounded-full bg-white/[0.15] opacity-0 transition-all duration-200 group-hover/vol:w-20 group-hover/vol:opacity-100"
              aria-label="Volume"
            />
          </div>

          {/* Time display */}
          <button
            type="button"
            onClick={toggleRemainingTime}
            className="group/time -mx-1 flex items-center gap-1 rounded px-1 hover:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
            aria-label="Toggle time display mode"
          >
            <span ref={currentLabelRef} className="shrink-0 text-xs font-medium tabular-nums text-content-secondary transition-colors group-hover/time:text-content-primary">0:00</span>
            <span className="shrink-0 text-xs text-content-faint">/</span>
            <span ref={durationLabelRef} className="shrink-0 text-xs tabular-nums text-content-muted">—</span>
          </button>

          {/* Spacer */}
          <div className="flex-1" />

          {/* Speed selector — presets plus a granular 0.10× stepper.
              `formatRate` is what makes granular values presentable: the raw double would render
              as "1.2000000000000002×" in a bar this dense. A non-preset speed is highlighted on the
              trigger so the student can see they're off the presets without opening the menu. */}
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => setSpeedOpen((o) => !o)}
              className={
                "flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors hover:bg-white/[0.1] hover:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20 " +
                (sameRate(rate, 1) ? "text-content-secondary" : "text-lime")
              }
              aria-label={`Playback speed, currently ${formatRate(rate)}x`}
              aria-expanded={speedOpen}
              title="Playback speed ( [ slower · ] faster )"
            >
              <SpeedIcon size={14} />
              <span className="tabular-nums">{formatRate(rate)}×</span>
            </button>
            {speedOpen && (
              <div className="absolute bottom-11 right-0 z-20 flex w-40 flex-col rounded-btn border border-white/10 bg-ink-850 py-1 shadow-card">
                {/* Granular stepper. Mirrors the [ / ] shortcuts for anyone on a mouse, and names
                    those keys so the shortcut is discoverable rather than hidden in a manual. */}
                <div className="flex items-center justify-between gap-1 px-2 pb-1.5 pt-1">
                  <button
                    type="button"
                    onClick={() => nudgeRate(-1)}
                    className="grid h-6 w-7 place-items-center rounded-btn border border-white/10 text-xs text-content-secondary transition-colors hover:bg-white/[0.08] hover:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/40"
                    aria-label="Slower by 0.1x"
                    title="Slower ( [ )"
                  >
                    −
                  </button>
                  <span className="flex-1 text-center text-xs font-semibold tabular-nums text-content-primary">
                    {formatRate(rate)}×
                  </span>
                  <button
                    type="button"
                    onClick={() => nudgeRate(1)}
                    className="grid h-6 w-7 place-items-center rounded-btn border border-white/10 text-xs text-content-secondary transition-colors hover:bg-white/[0.08] hover:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/40"
                    aria-label="Faster by 0.1x"
                    title="Faster ( ] )"
                  >
                    +
                  </button>
                </div>
                <div className="mx-2 mb-1 border-t border-white/[0.08]" aria-hidden />
                {SPEEDS.map((s) => {
                  const active = sameRate(s, rate);
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() => changeRate(s)}
                      className={"flex items-center gap-1.5 px-4 py-1.5 text-left text-xs transition-colors hover:bg-white/[0.06] " + (active ? "font-bold text-lime" : "text-content-secondary")}
                    >
                      <SpeedIcon size={12} className={active ? "text-lime" : "text-content-faint"} />
                      {formatRate(s)}×
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Picture in Picture (Mini Player) */}
          <button
            type="button"
            onClick={onPip || (() => navigate(-1))}
            className="shrink-0 rounded-full p-2 text-content-secondary transition-colors hover:bg-white/[0.1] hover:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
            aria-label="Enter mini player"
            title="Mini Player"
          >
            <PictureInPicture2 size={18} />
          </button>

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
