/**
 * AmbientPopover — Flagship Focus Audio & Ambient Hub (v13 Redesign).
 *
 * Features:
 *  - YouTube Direct Audio Streaming (via yt-dlp sidecar):
 *      160 kbps pristine stereo Opus/AAC audio extraction with zero ads or video overhead.
 *  - One-Tap Quick Vibe Chips (Lofi, Thunder Rain, Ocean Waves, Cafe, 40Hz, Deep Space).
 *  - Direct YouTube URL paste support (e.g. https://youtu.be/...).
 *  - Rich 16:9 video result cards with duration badge, channel attribution, hover play.
 *  - Offline Procedural Synthesizer: 6 dual-channel wide stereo soundscapes with zero-data usage.
 *  - 24/7 SomaFM Radio: Broadcast streams on high-speed tier-1 relays.
 *  - Favorites & Offline Storage: One-click download to local disk for 0ms offline playback.
 *  - Master Audio Bus: Routed through Haas Stereo Spatializer, Low-Shelf Warmth EQ (+3.2dB @ 100Hz),
 *    and Studio Dynamics Compressor.
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  Download,
  Heart,
  Loader2,
  Moon,
  Music2,
  Pause,
  Play,
  Radio,
  Search,
  Sparkles,
  Square,
  Trash2,
  Volume2,
  Wifi,
  WifiOff,
  X,
  Zap,
} from "lucide-react";
import { useAmbientStore } from "../../lib/ambient/useAmbientStore";
import { PROCEDURAL_PRESETS } from "../../lib/ambient/procedural";
import {
  SOMA_FM_STREAMS,
  soundFromFavorite,
  soundFromProcedural,
  soundFromSoma,
  soundFromYouTube,
  favoriteFromYouTube,
} from "../../lib/ambient/api";
import { ipc } from "../../lib/ipc";
import { formatDuration } from "../../lib/utils";
import type { YouTubeSearchResult } from "../../lib/ambient/types";

function Youtube({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
    </svg>
  );
}

type Tab = "youtube" | "procedural" | "radio" | "favorites";

const QUICK_VIBES = [
  { label: "Lofi Study Beats", icon: "🎧", query: "lofi hip hop study beats" },
  { label: "Heavy Rain & Thunder", icon: "🌧️", query: "heavy rain thunderstorm 3D binaural" },
  { label: "Deep Ocean Surf", icon: "🌊", query: "ocean waves beach binaural 4k" },
  { label: "Night Coffee Shop", icon: "☕", query: "cozy coffee shop jazz rain ambience" },
  { label: "40 Hz Gamma Focus", icon: "⚡", query: "40 hz gamma focus binaural beats deep work" },
  { label: "Tibetan Meditation", icon: "🧘", query: "tibetan singing bowl meditation deep relaxation" },
  { label: "Interstellar Drone", icon: "🪐", query: "deep space ambient drone focus" },
  { label: "Gentle Study Piano", icon: "🎹", query: "soft peaceful piano study music" },
];

const SLEEP_OPTIONS = [15, 30, 45, 60];

function fmtCountdown(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function fmtTime(secs: number): string {
  if (!secs || !Number.isFinite(secs)) return "0:00";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ── Animated Waveform Bars ─────────────────────────────────────────────────

function WaveformBars({ active, color = "#3b82f6" }: { active: boolean; color?: string }) {
  return (
    <div className="amb-waveform" aria-hidden>
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          className={`amb-waveform-bar ${active ? "amb-waveform-bar--active" : ""}`}
          style={{
            animationDelay: `${i * 0.12}s`,
            backgroundColor: color,
          }}
        />
      ))}
    </div>
  );
}

// ── Buffering Spinner ──────────────────────────────────────────────────────

function BufferingSpinner() {
  return (
    <div className="amb-buffering" aria-label="Buffering">
      <div className="amb-buffering-ring" />
      <div className="amb-buffering-ring amb-buffering-ring--delay" />
    </div>
  );
}

// ── Component ──────────────────────────────────────────────────────────────

interface Props {
  onClose: () => void;
  placement?: "top" | "bottom";
  align?: "left" | "right";
  anchorRef?: React.RefObject<HTMLElement | null>;
}

export default function AmbientPopover({
  onClose,
  placement = "bottom",
  align = "right",
  anchorRef,
}: Props) {
  const {
    activeSound,
    isPlaying,
    isBuffering,
    currentTime,
    duration,
    volume,
    keepPlayingWhileLecture,
    sleepTimerMins,
    remainingSecs,
    favorites,
    play,
    togglePlay,
    seek,
    stop,
    setVolume,
    setKeepPlaying,
    setSleepTimer,
    toggleFavorite,
    isFavorite,
    cacheFavorite,
    deleteCache,
  } = useAmbientStore();

  const [tab, setTab] = useState<Tab>("youtube");
  const [query, setQuery] = useState("");
  const [youtubeResults, setYoutubeResults] = useState<YouTubeSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Focus search input when switching to YouTube tab.
  useEffect(() => {
    if (tab === "youtube") {
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }
  }, [tab]);

  // Execute YouTube search or direct link extraction
  const executeSearch = useCallback(async (searchQuery: string) => {
    const q = searchQuery.trim();
    if (!q) return;
    setLoading(true);
    setError(null);
    try {
      const res = await ipc.youtubeSearch(q, 12);
      setYoutubeResults(res);
      if (res.length === 0) {
        setError("No audio results found on YouTube for that search.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setYoutubeResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void executeSearch(query);
  };

  const handleQuickVibe = (vibeQuery: string) => {
    setQuery(vibeQuery);
    void executeSearch(vibeQuery);
  };

  // Play YouTube track: extract high quality audio stream URL if not yet resolved
  const handlePlayYouTube = async (track: YouTubeSearchResult) => {
    if (activeSound?.source === "youtube" && activeSound.id === track.video_id) {
      togglePlay();
      return;
    }

    setResolvingId(track.video_id);
    setError(null);
    try {
      const sound = soundFromYouTube(track);
      play(sound);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResolvingId(null);
    }
  };

  // One-click download YouTube track to local disk
  const handleDownloadYouTube = async (track: YouTubeSearchResult) => {
    setDownloadingId(track.video_id);
    try {
      await ipc.cacheYoutubeAudio(track.video_id, track.title);
      // Also ensure it is starred in favorites
      await toggleFavorite(favoriteFromYouTube(track));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloadingId(null);
    }
  };

  const activeIs = (src: string, id: string) =>
    activeSound?.source === src && activeSound?.id === id;

  const [coords, setCoords] = useState<{
    top?: number;
    bottom?: number;
    left: number;
    maxHeight: number;
    ready: boolean;
  }>({
    left: 16,
    maxHeight: 560,
    ready: false,
  });

  const updatePosition = useCallback(() => {
    if (!anchorRef?.current) {
      setCoords((c) => ({ ...c, ready: true }));
      return;
    }
    const rect = anchorRef.current.getBoundingClientRect();
    const popoverWidth = Math.min(390, window.innerWidth - 24);
    const padding = 12;

    let left: number;
    if (align === "left") {
      // In player: align with left edge of button (opens to the right into the player)
      left = rect.left;
    } else {
      // In topbar: align with right edge of button (opens to the left)
      left = rect.right - popoverWidth;
    }

    // Clamp horizontally to stay within viewport and clear left sidebar
    left = Math.max(padding, Math.min(left, window.innerWidth - popoverWidth - padding));

    if (placement === "top") {
      const bottom = Math.max(padding, window.innerHeight - rect.top + 8);
      const availableHeight = rect.top - padding - 8;
      const maxHeight = Math.min(580, Math.max(260, availableHeight));
      setCoords({ bottom, left, maxHeight, ready: true });
    } else {
      const top = Math.max(padding, rect.bottom + 8);
      const availableHeight = window.innerHeight - rect.bottom - padding - 8;
      const maxHeight = Math.min(580, Math.max(260, availableHeight));
      setCoords({ top, left, maxHeight, ready: true });
    }
  }, [anchorRef, placement, align]);

  useEffect(() => {
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [updatePosition]);

  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const progressRef = useRef<HTMLDivElement>(null);
  const effectiveDuration = duration > 0 ? duration : (activeSound?.duration_secs || 0);
  const progress = effectiveDuration > 0 ? (currentTime / effectiveDuration) * 100 : 0;
  const isStream = activeSound && (activeSound.source === "somafm" || (activeSound.loop === false && effectiveDuration === 0));

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!progressRef.current || effectiveDuration <= 0) return;
    const rect = progressRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const fraction = Math.max(0, Math.min(1, clickX / rect.width));
    seek(fraction * effectiveDuration);
  };

  if (!mounted || typeof document === "undefined" || !document.body) {
    return null;
  }

  return createPortal(
    <div
      id="amb-popover-portal"
      className="amb-panel"
      style={{
        position: "fixed",
        left: `${coords.left}px`,
        ...(coords.top != null ? { top: `${coords.top}px` } : {}),
        ...(coords.bottom != null ? { bottom: `${coords.bottom}px` } : {}),
        maxHeight: `${coords.maxHeight}px`,
        width: `min(390px, calc(100vw - 24px))`,
        zIndex: 9999,
        visibility: coords.ready ? "visible" : "hidden",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* ── Top Header ── */}
      <div className="amb-header">
        <div className="amb-header-icon">
          <Zap size={13} />
        </div>
        <div className="amb-header-text">
          <span className="amb-header-title">Focus Audio</span>
          <span className="amb-header-badge">Studio Hi-Fi</span>
        </div>
        {isPlaying && (
          <div className="amb-header-active-pill">
            <span className="amb-live-dot" />
            <span>Playing</span>
          </div>
        )}
        <button
          type="button"
          onClick={onClose}
          className="amb-header-close-btn"
          aria-label="Close Focus Audio"
          title="Close (Esc)"
        >
          <X size={14} />
        </button>
      </div>

      {/* ── Hero Now Playing Card ── */}
      {activeSound && (
        <div className="amb-now-playing">
          {/* Ambient blurred backdrop glow */}
          {activeSound.thumbnail_url && (
            <div
              className="amb-now-playing-backdrop"
              style={{ backgroundImage: `url(${activeSound.thumbnail_url})` }}
            />
          )}

          <div className="amb-now-playing-content">
            <div className="amb-now-playing-top">
              {/* Media Art / Visualizer */}
              <div className="amb-now-playing-art-wrap">
                {activeSound.thumbnail_url ? (
                  <img
                    src={activeSound.thumbnail_url}
                    alt=""
                    className="amb-now-playing-thumb"
                  />
                ) : (
                  <div className="amb-now-playing-vis">
                    {isBuffering ? (
                      <BufferingSpinner />
                    ) : (
                      <WaveformBars active={isPlaying} />
                    )}
                  </div>
                )}
                {isPlaying && !isBuffering && (
                  <div className="amb-art-live-overlay">
                    <WaveformBars active={true} color="#ffffff" />
                  </div>
                )}
              </div>

              {/* Title & Channel */}
              <div className="amb-now-playing-info">
                <div className="amb-now-playing-name" title={activeSound.name}>
                  {activeSound.name}
                </div>
                <div className="amb-now-playing-meta-row">
                  {isBuffering ? (
                    <span className="amb-tag amb-tag--buffering">
                      <Loader2 size={10} className="animate-spin" /> Buffering
                    </span>
                  ) : activeSound.source === "youtube" ? (
                    <span className="amb-tag amb-tag--youtube">
                      <Youtube size={10} /> 160k Stereo Opus
                    </span>
                  ) : activeSound.source === "procedural" ? (
                    <span className="amb-tag amb-tag--offline">
                      <Sparkles size={9} /> 3D Dual-Channel
                    </span>
                  ) : isStream ? (
                    <span className="amb-tag amb-tag--live">
                      <Wifi size={9} /> SomaFM AAC
                    </span>
                  ) : (
                    <span className="amb-tag">Studio Hi-Fi</span>
                  )}
                  {activeSound.channel && (
                    <span className="amb-now-playing-channel" title={activeSound.channel}>
                      · {activeSound.channel}
                    </span>
                  )}
                </div>
              </div>

              {/* Transport Buttons */}
              <div className="amb-now-playing-controls">
                <button
                  type="button"
                  onClick={() => togglePlay()}
                  className="amb-play-btn"
                  aria-label={isPlaying ? "Pause" : "Play"}
                >
                  {isPlaying ? <Pause size={15} /> : <Play size={15} className="ml-0.5" />}
                </button>
                <button
                  type="button"
                  onClick={() => stop()}
                  className="amb-stop-btn"
                  aria-label="Stop"
                >
                  <Square size={11} />
                </button>
              </div>
            </div>

            {/* Finite clip / online audio progress scrub bar */}
            {effectiveDuration > 0 && (
              <div
                className="amb-progress-wrap"
                ref={progressRef}
                onClick={handleSeek}
                title={`Seek (${fmtTime(currentTime)} / ${fmtTime(effectiveDuration)})`}
              >
                <div className="amb-progress-track">
                  <div
                    className="amb-progress-fill"
                    style={{ width: `${Math.min(progress, 100)}%` }}
                  />
                  <div
                    className="amb-progress-thumb"
                    style={{ left: `${Math.min(progress, 100)}%` }}
                  />
                  {isBuffering && <div className="amb-progress-buffer-shimmer" />}
                </div>
                <div className="amb-progress-times">
                  <span>{fmtTime(currentTime)}</span>
                  <span>{fmtTime(effectiveDuration)}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Fluid Tab Navigation ── */}
      <div className="amb-tabs">
        <button
          type="button"
          onClick={() => setTab("youtube")}
          className={`amb-tab ${tab === "youtube" ? "amb-tab--active" : ""}`}
        >
          <Youtube size={13} className="text-red-500" />
          <span>YouTube</span>
        </button>
        <button
          type="button"
          onClick={() => setTab("procedural")}
          className={`amb-tab ${tab === "procedural" ? "amb-tab--active" : ""}`}
        >
          <Sparkles size={12} className="text-amber-400" />
          <span>Synthesizer</span>
        </button>
        <button
          type="button"
          onClick={() => setTab("radio")}
          className={`amb-tab ${tab === "radio" ? "amb-tab--active" : ""}`}
        >
          <Radio size={12} className="text-blue-400" />
          <span>Radio</span>
        </button>
        <button
          type="button"
          onClick={() => setTab("favorites")}
          className={`amb-tab ${tab === "favorites" ? "amb-tab--active" : ""}`}
        >
          <Heart size={12} className="text-pink-400" />
          <span>Saved</span>
          {favorites.length > 0 && (
            <span className="amb-tab-count">{favorites.length}</span>
          )}
        </button>
      </div>

      {/* ── Scrollable Tab Content Body ── */}
      <div className="amb-scroll-body">
        <div className="amb-content">
        {/* ── TAB 1: YouTube Search & Direct URL Stream ── */}
        {tab === "youtube" && (
          <div className="amb-youtube-view">
            {/* Quick Vibe Chips */}
            <div className="amb-vibe-chips-wrap">
              <div className="amb-vibe-chips">
                {QUICK_VIBES.map((v) => (
                  <button
                    key={v.label}
                    type="button"
                    onClick={() => handleQuickVibe(v.query)}
                    className="amb-vibe-chip"
                  >
                    <span>{v.icon}</span>
                    <span>{v.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Search / Paste Input */}
            <form onSubmit={handleSearchSubmit} className="amb-search-bar">
              <Search size={13} className="amb-search-icon" />
              <input
                ref={searchInputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search YouTube or paste URL..."
                className="amb-search-input"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="amb-search-clear"
                >
                  <X size={11} />
                </button>
              )}
              <button
                type="submit"
                disabled={loading || !query.trim()}
                className="amb-search-submit"
              >
                {loading ? <Loader2 size={12} className="animate-spin" /> : "Search"}
              </button>
            </form>

            {/* Error Message */}
            {error && <div className="amb-error-banner">{error}</div>}

            {/* Skeleton Loading */}
            {loading && (
              <div className="amb-skeleton-list">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="amb-skeleton-card" />
                ))}
              </div>
            )}

            {/* Results List */}
            {!loading && youtubeResults.length > 0 && (
              <div className="amb-yt-results">
                {youtubeResults.map((track) => {
                  const isCurrent = activeIs("youtube", track.video_id);
                  const isResolving = resolvingId === track.video_id;
                  const isDownloading = downloadingId === track.video_id;

                  return (
                    <div
                      key={track.video_id}
                      className={`amb-yt-card ${isCurrent ? "amb-yt-card--active" : ""}`}
                    >
                      {/* 16:9 Thumbnail preview with duration badge */}
                      <div
                        className="amb-yt-thumb-wrap"
                        onClick={() => handlePlayYouTube(track)}
                      >
                        {track.thumbnail_url ? (
                          <img
                            src={track.thumbnail_url}
                            alt=""
                            className="amb-yt-thumb"
                            loading="lazy"
                          />
                        ) : (
                          <div className="amb-yt-thumb-placeholder">
                            <Music2 size={20} />
                          </div>
                        )}

                        {track.duration_secs && (
                          <span className="amb-yt-dur-pill">
                            {formatDuration(track.duration_secs)}
                          </span>
                        )}

                        {/* Hover play overlay */}
                        <div className="amb-yt-play-overlay">
                          {isResolving ? (
                            <Loader2 size={18} className="animate-spin text-white" />
                          ) : isCurrent && isPlaying ? (
                            <Pause size={18} className="text-white" />
                          ) : (
                            <Play size={18} className="text-white ml-0.5" />
                          )}
                        </div>
                      </div>

                      {/* Info & Meta */}
                      <div className="amb-yt-meta" onClick={() => handlePlayYouTube(track)}>
                        <div className="amb-yt-title" title={track.title}>
                          {track.title}
                        </div>
                        <div className="amb-yt-channel">
                          <span>{track.channel}</span>
                          <span className="amb-yt-hq-badge">160k Opus</span>
                        </div>
                      </div>

                      {/* Actions: Favorite + Download */}
                      <div className="amb-yt-actions">
                        <button
                          type="button"
                          onClick={() => handleDownloadYouTube(track)}
                          disabled={isDownloading}
                          className="amb-action-btn"
                          title="Download for offline study"
                        >
                          {isDownloading ? (
                            <Loader2 size={12} className="animate-spin text-blue-400" />
                          ) : (
                            <Download size={12} />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => void toggleFavorite(favoriteFromYouTube(track))}
                          className={`amb-fav-btn ${
                            isFavorite("youtube", track.video_id) ? "amb-fav-btn--active" : ""
                          }`}
                          title="Save to favorites"
                        >
                          <Heart
                            size={13}
                            fill={isFavorite("youtube", track.video_id) ? "currentColor" : "none"}
                          />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Empty State / Suggestions */}
            {!loading && youtubeResults.length === 0 && !error && (
              <div className="amb-search-empty-hero">
                <Youtube size={28} className="text-red-500/80 mb-2" />
                <div className="amb-empty-title">Search millions of study soundscapes</div>
                <div className="amb-empty-desc">
                  Tap any vibe chip above or paste a YouTube URL to stream high-fidelity 160k stereo audio.
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── TAB 2: Zero-Data Procedural Synthesizer ── */}
        {tab === "procedural" && (
          <div className="amb-sounds-grid">
            <div className="amb-section-label">
              <WifiOff size={10} />
              <span>Offline · True Dual-Channel Stereo Synthesis</span>
            </div>
            <div className="amb-grid-2col">
              {PROCEDURAL_PRESETS.map((p) => {
                const isActive = activeIs("procedural", p.kind);
                return (
                  <button
                    key={p.kind}
                    type="button"
                    onClick={() => play(soundFromProcedural(p.kind))}
                    className={`amb-sound-card ${isActive ? "amb-sound-card--active" : ""}`}
                  >
                    <span className="amb-sound-emoji">{p.emoji}</span>
                    <div className="amb-sound-text">
                      <span className="amb-sound-label">{p.name}</span>
                      <span className="amb-sound-sub">Stereo 3D</span>
                    </div>
                    {isActive && isPlaying && (
                      <div className="ml-auto">
                        <WaveformBars active color="#fbbf24" />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ── TAB 3: SomaFM Commercial-Free Radio ── */}
        {tab === "radio" && (
          <div className="amb-stream-list">
            <div className="amb-section-label">
              <Radio size={10} />
              <span>24/7 Live Ambient Streams · Fast Relay</span>
            </div>
            {SOMA_FM_STREAMS.map((s) => {
              const isActive = activeIs("somafm", s.id);
              return (
                <div
                  key={s.id}
                  className={`amb-stream-card ${isActive ? "amb-stream-card--active" : ""}`}
                >
                  <button
                    type="button"
                    onClick={() => play(soundFromSoma(s))}
                    className="amb-stream-body"
                  >
                    <div className="amb-stream-icon">
                      {isActive && isPlaying ? (
                        <Pause size={13} />
                      ) : (
                        <Play size={13} className="ml-0.5" />
                      )}
                    </div>
                    <div className="amb-stream-meta">
                      <div className="amb-stream-name">{s.name}</div>
                      <div className="amb-stream-desc">{s.description}</div>
                    </div>
                    {isActive && isPlaying && (
                      <WaveformBars active color="#60a5fa" />
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* ── TAB 4: Favorites & Local Offline Library ── */}
        {tab === "favorites" && (
          <div className="amb-fav-list">
            {favorites.length === 0 ? (
              <div className="amb-search-empty-hero">
                <Heart size={26} className="text-pink-400/70 mb-2" />
                <div className="amb-empty-title">No saved tracks yet</div>
                <div className="amb-empty-desc">
                  Tap the ♥ on any YouTube video, preset, or radio channel to pin it here.
                </div>
              </div>
            ) : (
              favorites.map((f) => {
                const isActive = activeIs(f.source, f.external_id);
                return (
                  <div
                    key={`${f.source}:${f.external_id}`}
                    className={`amb-result-card ${isActive ? "amb-result-card--active" : ""}`}
                  >
                    <button
                      type="button"
                      onClick={() => play(soundFromFavorite(f))}
                      className="amb-result-play"
                      aria-label={`Play ${f.name}`}
                    >
                      {isActive && isPlaying ? (
                        <Pause size={13} />
                      ) : (
                        <Play size={13} className="ml-0.5" />
                      )}
                    </button>
                    <div className="amb-result-meta" onClick={() => play(soundFromFavorite(f))}>
                      <div className="amb-result-name" title={f.name}>
                        {f.name}
                      </div>
                      <div className="amb-result-detail">
                        {f.cached_path ? (
                          <span className="amb-tag amb-tag--offline">Offline Ready</span>
                        ) : (
                          <span className="amb-tag amb-tag--youtube">
                            {f.source === "youtube" ? "YouTube" : f.source}
                          </span>
                        )}
                        {f.attribution && <span> · {f.attribution}</span>}
                      </div>
                    </div>
                    {f.source !== "procedural" && !f.cached_path && (
                      <button
                        type="button"
                        onClick={() => void cacheFavorite(f)}
                        className="amb-action-btn"
                        title="Download for offline playback"
                      >
                        <Download size={12} />
                      </button>
                    )}
                    {f.cached_path && (
                      <button
                        type="button"
                        onClick={() => void deleteCache(f)}
                        className="amb-action-btn amb-action-btn--danger"
                        title="Delete local offline copy"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        void toggleFavorite({
                          source: f.source,
                          external_id: f.external_id,
                          name: f.name,
                          stream_url: f.stream_url,
                          cached_path: f.cached_path,
                          duration_secs: f.duration_secs,
                          attribution: f.attribution,
                        })
                      }
                      className="amb-fav-btn amb-fav-btn--active"
                      title="Remove from favorites"
                    >
                      <Heart size={13} fill="currentColor" />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
      </div>

      {/* ── Fixed Bottom Controls Footer ── */}
      <div className="amb-footer">
        {/* ── Volume Scrubbing Bar ── */}
        <div className="amb-volume-section">
          <Volume2 size={13} className="amb-volume-icon" />
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(volume * 100)}
            onChange={(e) => setVolume(Number(e.target.value) / 100)}
            className="amb-volume-slider"
            aria-label="Ambient volume"
          />
          <span className="amb-volume-pct">{Math.round(volume * 100)}%</span>
        </div>

        {/* ── Sleep Timer Pill Bar ── */}
        <div className="amb-sleep-section">
          <div className="amb-sleep-header">
            <Moon size={11} />
            <span>Sleep Timer</span>
            {sleepTimerMins != null && (
              <span className="amb-sleep-countdown">{fmtCountdown(remainingSecs)}</span>
            )}
          </div>
          <div className="amb-sleep-pills">
            {SLEEP_OPTIONS.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setSleepTimer(sleepTimerMins === m ? null : m)}
                className={`amb-sleep-pill ${
                  sleepTimerMins === m ? "amb-sleep-pill--active" : ""
                }`}
              >
                {m}m
              </button>
            ))}
            {sleepTimerMins != null && (
              <button
                type="button"
                onClick={() => setSleepTimer(null)}
                className="amb-sleep-pill amb-sleep-pill--off"
              >
                Off
              </button>
            )}
          </div>
        </div>

        {/* ── Keep-playing Toggle ── */}
        <button
          type="button"
          onClick={() => setKeepPlaying(!keepPlayingWhileLecture)}
          className="amb-keep-toggle"
        >
          <span className="amb-keep-label">Keep playing during lectures</span>
          <span
            className={`amb-toggle-track ${
              keepPlayingWhileLecture ? "amb-toggle-track--on" : ""
            }`}
          >
            <span className="amb-toggle-thumb" />
          </span>
        </button>
      </div>
    </div>,
    document.body
  );
}
