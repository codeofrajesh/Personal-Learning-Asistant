/**
 * AmbientDrawer — Universal Floating Slide-Over Focus Audio & Ambient Hub.
 *
 * Designed with Samsung One UI Edge Panel / Realme Smart Sidebar aesthetics:
 *  - Floating card with inset margins (`top-3 bottom-3 right-3`) and large rounded corners (`rounded-[28px]`).
 *  - Deep obsidian frosted glass background matching the consistency calendar in Analytics:
 *    `radial-gradient(ellipse at 50% -15%, rgba(37, 99, 235, 0.12) 0%, transparent 65%), #0c0d14`
 *  - Tactile grab-handle pill accent on the left border.
 *  - Study Playlists System: Create, manage, add tracks from YouTube, Procedural, Radio, or Favorites.
 *  - Continuous Queue: Auto-advance, Play All, Shuffle, Skip Previous/Next.
 *  - Studio Audio Configurations:
 *      * Studio EQ Tone Profiles (Flat, Warm Lofi, Vocal Lift, Deep Bass, Rain Shield).
 *      * Real-time Isochronic / Binaural Brainwave Entrainment (Alpha 10Hz, Beta 18Hz, Theta 6Hz, Gamma 40Hz).
 *      * Smart Lecture Auto-Duck (smooth 30% volume attenuation during video courses).
 *  - Curated Trending Discovery: Instant 1-click study music without empty search screens.
 *  - Fixed, non-broken layout for Volume slider, Sleep Timer, and Keep-Playing controls.
 *  - GSAP spring slide-in and fade animations.
 *  - Closes on Esc, backdrop click, or close button.
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import gsap from "gsap";
import {
  Activity,
  Check,
  ChevronLeft,
  Download,
  FolderPlus,
  Headphones,
  Heart,
  ListMusic,
  Moon,
  Music2,
  Pause,
  Play,
  Plus,
  Radio,
  Search,
  Shuffle,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { SmoothSpinner } from "./SmoothSpinner";
import { YouTubeSkeletonList } from "./YouTubeSkeletonList";
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
import { usePerf } from "../../lib/perfStore";
import type {
  AmbientSound,
  AudioToneProfile,
  BinauralBeatKind,
  YouTubeSearchResult,
} from "../../lib/ambient/types";

function YouTubeIcon({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
    </svg>
  );
}

type Tab = "youtube" | "procedural" | "radio" | "playlists" | "favorites";

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

const CURATED_STREAMS = [
  {
    id: "cur-lofi",
    title: "Lofi Hip Hop Radio — Beats to Relax/Study to",
    channel: "Lofi Girl",
    query: "lofi hip hop radio beats to relax study to",
    tag: "MOST POPULAR",
    emoji: "🎧",
    badgeColor: "bg-amber-500/15 border-amber-500/30 text-amber-300",
  },
  {
    id: "cur-synth",
    title: "Synthwave / Chillwave Radio for Coding & Flow",
    channel: "Lofi Girl / Synthwave Boy",
    query: "synthwave radio beats to chill game to",
    tag: "CODING FLOW",
    emoji: "⚡",
    badgeColor: "bg-cyan-500/15 border-cyan-500/30 text-cyan-300",
  },
  {
    id: "cur-coffee",
    title: "Rainy Night Coffee Shop Jazz with Soft Thunder",
    channel: "Calmed by Nature",
    query: "rainy night coffee shop jazz ambience thunder 4k",
    tag: "COZY STUDY",
    emoji: "☕",
    badgeColor: "bg-emerald-500/15 border-emerald-500/30 text-emerald-300",
  },
  {
    id: "cur-gamma",
    title: "40 Hz Gamma Neuro-Sync Focus Beats",
    channel: "Mindful Brain",
    query: "40 hz gamma binaural beats study memory cognition",
    tag: "BRAIN BOOST",
    emoji: "🧠",
    badgeColor: "bg-indigo-500/15 border-indigo-500/30 text-indigo-300",
  },
  {
    id: "cur-piano",
    title: "Gentle Peaceful Piano & Strings for Deep Reading",
    channel: "Instrumental Calm",
    query: "peaceful piano study music instrumental reading calm",
    tag: "READING",
    emoji: "🎹",
    badgeColor: "bg-rose-500/15 border-rose-500/30 text-rose-300",
  },
  {
    id: "cur-space",
    title: "Interstellar Ambient Drone for Extreme Immersion",
    channel: "Space Ambient",
    query: "deep space ambient drone focus study 8 hours",
    tag: "IMMERSION",
    emoji: "🪐",
    badgeColor: "bg-violet-500/15 border-violet-500/30 text-violet-300",
  },
];

const SLEEP_OPTIONS = [
  { label: "Off", value: null },
  { label: "15m", value: 15 },
  { label: "30m", value: 30 },
  { label: "45m", value: 45 },
  { label: "60m", value: 60 },
];

const TONE_PROFILES: { id: AudioToneProfile; name: string; tag: string; desc: string; icon: string }[] = [
  { id: "flat", name: "Studio Flat", tag: "Reference", desc: "Uncolored studio neutral response", icon: "⚖️" },
  { id: "warm", name: "Warm Lofi", tag: "+3.8dB Warmth", desc: "Low-shelf boost & rolled-off highs for zero ear fatigue", icon: "☕" },
  { id: "vocal", name: "Vocal Lift", tag: "+3.2dB Speech", desc: "Accentuates tutor dialogue during lecture playback", icon: "🎙️" },
  { id: "bass", name: "Deep Bass", tag: "+6.2dB Punch", desc: "Sub-frequency extension for electronic & lofi beats", icon: "🔊" },
  { id: "shield", name: "Rain Shield", tag: "Dampened Highs", desc: "Tames harsh rain and splash frequencies", icon: "🛡️" },
];

const BINAURAL_BEATS: { id: BinauralBeatKind; name: string; hz: string; state: string }[] = [
  { id: "off", name: "Off", hz: "—", state: "Pure audio only" },
  { id: "alpha", name: "Alpha", hz: "10 Hz", state: "Calm flow & reading" },
  { id: "beta", name: "Beta", hz: "18 Hz", state: "Active alertness & math" },
  { id: "theta", name: "Theta", hz: "6 Hz", state: "Memory consolidation" },
  { id: "gamma", name: "Gamma", hz: "40 Hz", state: "Peak cognitive speed" },
];

const PLAYLIST_GRADIENTS = [
  { label: "Ocean Blue", val: "from-blue-600 via-indigo-600 to-cyan-500" },
  { label: "Cyber Violet", val: "from-purple-600 via-violet-600 to-indigo-700" },
  { label: "Emerald Focus", val: "from-emerald-600 via-teal-600 to-cyan-600" },
  { label: "Sunset Amber", val: "from-amber-600 via-orange-600 to-rose-600" },
  { label: "Neon Rose", val: "from-rose-600 via-pink-600 to-purple-600" },
];

const PLAYLIST_EMOJIS = ["⚡", "🎧", "📚", "☕", "🌧️", "🌌", "🪐", "🎹", "🧠", "🔥", "🌊", "🎯"];

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

const PROCEDURAL_DESCS: Record<string, string> = {
  brown: "Deep velvet sub-bass wash",
  pink: "Balanced 1/f soothing warmth",
  rain: "Gentle spatial raindrops",
  waves: "Shoreline rolling wave swells",
  gamma40: "40 Hz binaural focus pulse",
  alpha10: "10 Hz calm harmonic meditation",
};

function WaveformBars({ active, color = "#3b82f6" }: { active: boolean; color?: string }) {
  return (
    <div className="flex items-end gap-0.5 h-3 px-1" aria-hidden="true">
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          className={`w-0.5 rounded-full transition-all duration-300 ${
            active ? "animate-pulse h-full" : "h-1 opacity-40"
          }`}
          style={{
            animationDelay: `${i * 0.14}s`,
            animationDuration: "0.8s",
            backgroundColor: color,
          }}
        />
      ))}
    </div>
  );
}

export default function AmbientDrawer() {
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
    playlists,
    activePlaylistId,
    activePlaylistIndex,
    toneProfile,
    binauralKind,
    binauralVolume,
    autoDuckOnLecture,
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
    createPlaylist,
    deletePlaylist,
    addToPlaylist,
    removeFromPlaylist,
    playPlaylist,
    playNextInPlaylist,
    playPreviousInPlaylist,
    setToneProfile,
    setBinauralBeat,
    setBinauralVolume,
    setAutoDuck,
    isDrawerOpen,
    closeDrawer,
  } = useAmbientStore();

  const tier = usePerf((s) => s.tier);

  const [mounted, setMounted] = useState(false);
  const [rendered, setRendered] = useState(false);
  const [tab, setTab] = useState<Tab>("youtube");
  const [query, setQuery] = useState("");
  const [youtubeResults, setYoutubeResults] = useState<YouTubeSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Studio Audio panel expansion
  const [isStudioOpen, setIsStudioOpen] = useState(false);

  // Playlists local navigation
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null);
  const [soundToAddToPlaylist, setSoundToAddToPlaylist] = useState<AmbientSound | null>(null);
  const [addedFeedbackId, setAddedFeedbackId] = useState<string | null>(null);

  // Create Playlist dialog
  const [isCreatingPlaylist, setIsCreatingPlaylist] = useState(false);
  const [newPlName, setNewPlName] = useState("");
  const [newPlEmoji, setNewPlEmoji] = useState("⚡");
  const [newPlGradient, setNewPlGradient] = useState(PLAYLIST_GRADIENTS[0].val);

  const drawerRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const studioPanelRef = useRef<HTMLDivElement>(null);
  const resultsListRef = useRef<HTMLDivElement>(null);

  // Staggered reveal animation when search results arrive
  useEffect(() => {
    if (loading || youtubeResults.length === 0 || !resultsListRef.current) return;
    const cards = resultsListRef.current.querySelectorAll(".amb-result-card");
    if (cards.length > 0) {
      gsap.fromTo(
        cards,
        { opacity: 0, y: 7 },
        { opacity: 1, y: 0, duration: 0.28, stagger: 0.035, ease: "power2.out", overwrite: "auto" }
      );
    }
  }, [youtubeResults, loading]);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Mount/unmount drawer DOM with GSAP slide animation
  useEffect(() => {
    if (isDrawerOpen) {
      setRendered(true);
    }
  }, [isDrawerOpen]);

  useEffect(() => {
    if (!rendered || !drawerRef.current) return;

    if (isDrawerOpen) {
      const dur = tier === "lite" ? 0.15 : 0.35;
      const easeType = tier === "high" ? "power3.out" : "power2.out";

      gsap.fromTo(
        drawerRef.current,
        { x: "105%", opacity: 0.8, scale: 0.98 },
        { x: "0%", opacity: 1, scale: 1, duration: dur, ease: easeType, overwrite: "auto" }
      );
      if (backdropRef.current) {
        gsap.fromTo(
          backdropRef.current,
          { opacity: 0 },
          { opacity: 1, duration: dur * 0.8, overwrite: "auto" }
        );
      }
    } else {
      const dur = tier === "lite" ? 0.12 : 0.24;
      gsap.to(drawerRef.current, {
        x: "105%",
        opacity: 0.7,
        scale: 0.98,
        duration: dur,
        ease: "power2.in",
        overwrite: "auto",
        onComplete: () => setRendered(false),
      });
      if (backdropRef.current) {
        gsap.to(backdropRef.current, {
          opacity: 0,
          duration: dur,
          overwrite: "auto",
        });
      }
    }
  }, [isDrawerOpen, rendered, tier]);

  // Close on Escape key
  useEffect(() => {
    if (!isDrawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (soundToAddToPlaylist) {
          setSoundToAddToPlaylist(null);
          return;
        }
        if (isCreatingPlaylist) {
          setIsCreatingPlaylist(false);
          return;
        }
        if (selectedPlaylistId) {
          setSelectedPlaylistId(null);
          return;
        }
        if (isStudioOpen) {
          setIsStudioOpen(false);
          return;
        }
        e.preventDefault();
        closeDrawer();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isDrawerOpen, closeDrawer, soundToAddToPlaylist, isCreatingPlaylist, selectedPlaylistId, isStudioOpen]);

  // Focus search input when switching to YouTube tab
  useEffect(() => {
    if (tab === "youtube" && isDrawerOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 100);
    }
  }, [tab, isDrawerOpen]);

  const executeSearch = useCallback(async (searchQuery: string) => {
    const q = searchQuery.trim();
    if (!q) return;
    setLoading(true);
    setError(null);
    try {
      const res = await ipc.youtubeSearch(q, 12);
      setYoutubeResults(res);
      if (res.length === 0) {
        setError("No audio results found on YouTube for that query.");
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

  const handlePlayCurated = async (stream: typeof CURATED_STREAMS[0]) => {
    setQuery(stream.query);
    setLoading(true);
    setError(null);
    try {
      const res = await ipc.youtubeSearch(stream.query, 12);
      setYoutubeResults(res);
      if (res.length > 0) {
        await handlePlayYouTube(res[0]);
      }
    } catch (e) {
      setError(`Failed to load stream: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  const handlePlayYouTube = async (track: YouTubeSearchResult) => {
    if (activeSound?.source === "youtube" && activeSound.id === track.video_id) {
      togglePlay();
      return;
    }
    setResolvingId(track.video_id);
    setError(null);
    try {
      const sound = await soundFromYouTube(track);
      play(sound);
    } catch (e) {
      setError(`Failed to stream: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setResolvingId(null);
    }
  };

  const handleDownloadYouTube = async (track: YouTubeSearchResult) => {
    setDownloadingId(track.video_id);
    setError(null);
    try {
      const favPayload = favoriteFromYouTube(track);
      await toggleFavorite(favPayload);
      const match = favorites.find((f) => f.source === "youtube" && f.external_id === track.video_id);
      if (match) {
        await cacheFavorite(match);
      }
    } catch (e) {
      setError(`Download failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDownloadingId(null);
    }
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!progressRef.current || !effectiveDuration) return;
    const rect = progressRef.current.getBoundingClientRect();
    const clickX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const pct = clickX / rect.width;
    seek(pct * effectiveDuration);
  };

  const handleConfirmAddToPlaylist = (playlistId: string) => {
    if (!soundToAddToPlaylist) return;
    addToPlaylist(playlistId, soundToAddToPlaylist);
    setAddedFeedbackId(playlistId);
    setTimeout(() => {
      setAddedFeedbackId(null);
      setSoundToAddToPlaylist(null);
    }, 500);
  };

  const handleCreatePlaylistSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPlName.trim()) return;
    const id = createPlaylist(newPlName.trim(), newPlEmoji, newPlGradient);
    if (soundToAddToPlaylist) {
      addToPlaylist(id, soundToAddToPlaylist);
      setSoundToAddToPlaylist(null);
    }
    setNewPlName("");
    setIsCreatingPlaylist(false);
    setSelectedPlaylistId(id);
    setTab("playlists");
  };

  if (!mounted || !rendered) return null;

  const effectiveDuration = duration || activeSound?.duration_secs || 0;
  const progressPct = effectiveDuration > 0 ? (currentTime / effectiveDuration) * 100 : 0;
  const activePlaylist = playlists.find((p) => p.id === activePlaylistId);
  const selectedPlaylist = playlists.find((p) => p.id === selectedPlaylistId);

  return createPortal(
    <div id="amb-drawer-root" className="fixed inset-0 z-[85] pointer-events-none">
      {/* Dimmed backdrop overlay */}
      <div
        ref={backdropRef}
        className="amb-drawer-backdrop pointer-events-auto fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
        onClick={closeDrawer}
        aria-hidden="true"
      />

      {/* Floating Slide-over Right Panel (Samsung One UI / Realme Smart Sidebar style) */}
      <div
        ref={drawerRef}
        id="amb-drawer-panel"
        className="amb-drawer-panel pointer-events-auto fixed top-3 bottom-3 right-3 w-[440px] max-w-[calc(100vw-24px)] flex flex-col rounded-[28px] overflow-hidden border border-white/[0.08] shadow-2xl z-[86]"
        style={{
          background:
            "radial-gradient(ellipse at 50% -15%, rgba(37, 99, 235, 0.12) 0%, transparent 65%), #0c0d14",
          boxShadow:
            "inset 0 1px 0 rgba(255,255,255,0.08), 0 25px 60px -15px rgba(0,0,0,0.8), 0 0 35px rgba(37, 99, 235, 0.12)",
          backdropFilter: tier === "lite" ? "none" : "blur(28px)",
          WebkitBackdropFilter: tier === "lite" ? "none" : "blur(28px)",
        }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Focus Audio Hub"
      >
        {/* Tactile Samsung Edge grab-handle pill indicator on left edge */}
        <div
          className="absolute left-1.5 top-1/2 -translate-y-1/2 w-1 h-12 rounded-full bg-white/15 pointer-events-none"
          aria-hidden="true"
        />

        {/* ── Top Header ── */}
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-white/[0.06] flex-shrink-0 gap-3">
          {/* Left: Branding & Status */}
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-full bg-blue-500/10 border border-blue-500/25 flex items-center justify-center text-blue-400 shadow-sm flex-shrink-0">
              <Headphones size={15} />
            </div>
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-semibold text-white tracking-tight whitespace-nowrap">Focus Audio</span>
              {isPlaying ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-[10px] font-medium text-emerald-400 whitespace-nowrap flex-shrink-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  LIVE
                </span>
              ) : (
                <span className="px-2 py-0.5 rounded-full bg-blue-500/15 border border-blue-500/30 text-[10px] font-mono font-medium text-blue-300 whitespace-nowrap flex-shrink-0">
                  HI-FI
                </span>
              )}
            </div>
          </div>

          {/* Right: Actions */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Studio FX Toggle Button */}
            <button
              type="button"
              onClick={() => setIsStudioOpen((v) => !v)}
              className={`px-3 py-1.5 rounded-full border text-[11px] font-medium flex items-center gap-1.5 transition-all whitespace-nowrap active:scale-95 ${
                isStudioOpen
                  ? "bg-blue-500/20 border-blue-500/40 text-blue-300 shadow-sm"
                  : toneProfile !== "flat" || binauralKind !== "off"
                  ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-300"
                  : "bg-white/[0.04] hover:bg-white/[0.08] border-white/[0.06] text-white/70 hover:text-white"
              }`}
              title="Studio Tone Profiles & Brainwave Entrainment"
            >
              <SlidersHorizontal size={12} className={isStudioOpen ? "text-blue-400" : "text-white/60"} />
              <span>Studio FX</span>
              {(toneProfile !== "flat" || binauralKind !== "off") && (
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              )}
            </button>

            {/* Close Button */}
            <button
              type="button"
              onClick={closeDrawer}
              className="w-8 h-8 rounded-full bg-white/[0.04] hover:bg-white/[0.1] border border-white/[0.06] flex items-center justify-center text-white/60 hover:text-white transition-all active:scale-95 flex-shrink-0"
              aria-label="Close"
              title="Close (Esc)"
            >
              <X size={15} />
            </button>
          </div>
        </div>

        {/* ── Studio FX Configuration Panel (Expandable) ── */}
        {isStudioOpen && (
          <div
            ref={studioPanelRef}
            className="mx-4 mt-2.5 p-3.5 rounded-[22px] bg-white/[0.04] border border-blue-500/25 shadow-xl backdrop-blur-md space-y-3.5 animate-in fade-in slide-in-from-top-2 duration-200 flex-shrink-0"
          >
            {/* 1. Studio EQ Tone Profiles */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-white">
                  <Activity size={12} className="text-blue-400" />
                  <span>Studio Tone Profile</span>
                </div>
                <span className="text-[10px] text-white/40 font-mono">Biquad Hardware EQ</span>
              </div>
              <div className="grid grid-cols-5 gap-1">
                {TONE_PROFILES.map((p) => {
                  const isSel = toneProfile === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setToneProfile(p.id)}
                      className={`p-1.5 rounded-[12px] border text-center transition-all ${
                        isSel
                          ? "bg-blue-600/30 border-blue-500/60 text-white font-semibold shadow-sm"
                          : "bg-white/[0.02] border-white/[0.05] text-white/60 hover:text-white hover:bg-white/[0.05]"
                      }`}
                      title={`${p.name}: ${p.desc}`}
                    >
                      <div className="text-xs">{p.icon}</div>
                      <div className="text-[10.5px] truncate font-medium mt-0.5">{p.name}</div>
                    </button>
                  );
                })}
              </div>
              <div className="text-[10px] text-blue-300/80 mt-1.5 px-1 truncate">
                ✦ {TONE_PROFILES.find((p) => p.id === toneProfile)?.desc}
              </div>
            </div>

            {/* 2. Brainwave Entrainment (Binaural Beats) */}
            <div className="pt-2 border-t border-white/[0.06]">
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-white">
                  <Sparkles size={12} className="text-amber-400" />
                  <span>Binaural Brainwave Pulse</span>
                </div>
                <span className="text-[10px] text-amber-300/80 font-mono">
                  {binauralKind !== "off" ? `${BINAURAL_BEATS.find((b) => b.id === binauralKind)?.hz} Active` : "Disabled"}
                </span>
              </div>
              <div className="grid grid-cols-5 gap-1">
                {BINAURAL_BEATS.map((b) => {
                  const isSel = binauralKind === b.id;
                  return (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() => setBinauralBeat(b.id)}
                      className={`p-1.5 rounded-[12px] border text-center transition-all ${
                        isSel
                          ? "bg-amber-500/25 border-amber-500/50 text-amber-200 font-semibold shadow-sm"
                          : "bg-white/[0.02] border-white/[0.05] text-white/60 hover:text-white hover:bg-white/[0.05]"
                      }`}
                      title={`${b.name} (${b.hz}): ${b.state}`}
                    >
                      <div className="text-[11px] font-bold">{b.name}</div>
                      <div className="text-[9px] font-mono opacity-70">{b.hz}</div>
                    </button>
                  );
                })}
              </div>

              {binauralKind !== "off" && (
                <div className="mt-2 flex items-center gap-2.5 px-1">
                  <span className="text-[10px] text-white/50 flex-shrink-0">Pulse Volume</span>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={binauralVolume}
                    onChange={(e) => setBinauralVolume(parseFloat(e.target.value))}
                    className="flex-1 h-1 bg-white/[0.1] rounded-full appearance-none accent-amber-400 cursor-pointer"
                  />
                  <span className="text-[10px] font-mono text-amber-300 min-w-[28px] text-right">
                    {Math.round(binauralVolume * 100)}%
                  </span>
                </div>
              )}
            </div>

            {/* 3. Smart Lecture Auto-Duck Switch */}
            <div
              onClick={() => setAutoDuck(!autoDuckOnLecture)}
              className="pt-2 border-t border-white/[0.06] flex items-center justify-between cursor-pointer select-none"
            >
              <div>
                <div className="text-xs font-medium text-white/90">Smart Lecture Auto-Duck</div>
                <div className="text-[10px] text-white/40">Smoothly ducks ambient to 30% when lecture video plays</div>
              </div>
              <div
                className={`w-9 h-5 rounded-full p-0.5 transition-colors relative flex items-center ${
                  autoDuckOnLecture ? "bg-blue-600" : "bg-white/20"
                }`}
              >
                <div
                  className={`w-4 h-4 rounded-full bg-white shadow-md transition-transform ${
                    autoDuckOnLecture ? "translate-x-4" : "translate-x-0"
                  }`}
                />
              </div>
            </div>
          </div>
        )}

        {/* ── Hero Now Playing Card ── */}
        {activeSound && (
          <div className="mx-4 mt-3 p-3.5 rounded-[22px] bg-white/[0.03] border border-white/[0.08] shadow-lg backdrop-blur-md flex-shrink-0">
            {/* Playlist Queue indicator if playing from playlist */}
            {activePlaylist && (
              <div className="flex items-center justify-between pb-2 mb-2 border-b border-white/[0.06]">
                <div className="flex items-center gap-1.5 text-[11px] text-blue-300 font-medium truncate">
                  <span>{activePlaylist.emoji}</span>
                  <span className="truncate">{activePlaylist.name}</span>
                  <span className="text-white/40 font-mono text-[10px]">
                    ({activePlaylistIndex + 1}/{activePlaylist.items.length})
                  </span>
                </div>
                <span className="text-[9.5px] font-mono text-white/40 uppercase tracking-wider">Queue Auto-Play</span>
              </div>
            )}

            <div className="flex items-center gap-3">
              {/* Artwork / Vinyl */}
              <div className="w-14 h-14 rounded-[14px] overflow-hidden bg-black/40 border border-white/[0.08] relative flex-shrink-0 shadow-md flex items-center justify-center">
                {activeSound.thumbnail_url ? (
                  <img
                    src={activeSound.thumbnail_url}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="text-2xl">
                    {activeSound.source === "procedural" ? "🌊" : <Music2 size={22} className="text-blue-400" />}
                  </div>
                )}
                {isPlaying && (
                  <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                    <WaveformBars active={true} color="#ffffff" />
                  </div>
                )}
              </div>

              {/* Title & Channel */}
              <div className="flex-1 min-w-0 pr-1">
                <div className="text-xs font-semibold text-white truncate" title={activeSound.name}>
                  {activeSound.name}
                </div>
                <div className="flex items-center gap-1.5 mt-1">
                  {isBuffering ? (
                    <span className="px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 text-[10px] font-medium flex items-center gap-1.5">
                      <SmoothSpinner size={10} className="text-amber-300" /> Buffering
                    </span>
                  ) : activeSound.source === "youtube" ? (
                    <span className="px-1.5 py-0.2 rounded bg-red-500/15 border border-red-500/25 text-red-300 text-[9.5px] font-mono font-medium flex items-center gap-1">
                      <YouTubeIcon size={9} /> 160K STEREO
                    </span>
                  ) : activeSound.source === "procedural" ? (
                    <span className="px-1.5 py-0.2 rounded bg-amber-500/15 border border-amber-500/25 text-amber-300 text-[9.5px] font-mono font-medium flex items-center gap-1">
                      <Sparkles size={9} /> 3D BINAURAL
                    </span>
                  ) : (
                    <span className="px-1.5 py-0.2 rounded bg-blue-500/15 border border-blue-500/25 text-blue-300 text-[9.5px] font-mono font-medium flex items-center gap-1">
                      <Wifi size={9} /> SOMAFM AAC
                    </span>
                  )}
                  {activeSound.channel && (
                    <span className="text-[11px] text-white/40 truncate" title={activeSound.channel}>
                      · {activeSound.channel}
                    </span>
                  )}
                </div>
              </div>

              {/* Quick Controls & Playlist Nav */}
              <div className="flex items-center gap-1 flex-shrink-0">
                {activePlaylist && (
                  <button
                    type="button"
                    onClick={playPreviousInPlaylist}
                    className="w-7 h-7 rounded-full bg-white/[0.04] hover:bg-white/[0.1] text-white/70 hover:text-white flex items-center justify-center transition-all"
                    title="Previous track"
                  >
                    <SkipBack size={12} />
                  </button>
                )}

                <button
                  type="button"
                  onClick={togglePlay}
                  className="w-10 h-10 rounded-full bg-blue-600 hover:bg-blue-500 text-white flex items-center justify-center shadow-lg shadow-blue-600/30 transition-all active:scale-95"
                  aria-label={isPlaying ? "Pause" : "Play"}
                >
                  {isPlaying ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
                </button>

                {activePlaylist && (
                  <button
                    type="button"
                    onClick={playNextInPlaylist}
                    className="w-7 h-7 rounded-full bg-white/[0.04] hover:bg-white/[0.1] text-white/70 hover:text-white flex items-center justify-center transition-all"
                    title="Next track"
                  >
                    <SkipForward size={12} />
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => setSoundToAddToPlaylist(activeSound)}
                  className="w-7 h-7 rounded-full bg-white/[0.04] hover:bg-white/[0.1] text-white/60 hover:text-white flex items-center justify-center transition-all"
                  title="Add to Playlist"
                >
                  <FolderPlus size={12} />
                </button>

                <button
                  type="button"
                  onClick={stop}
                  className="w-7 h-7 rounded-full bg-white/[0.04] hover:bg-white/[0.1] text-white/60 hover:text-white flex items-center justify-center transition-all"
                  aria-label="Stop"
                  title="Stop playback"
                >
                  <Square size={11} />
                </button>
              </div>
            </div>

            {/* Scrubber Seek Track */}
            {effectiveDuration > 0 && (
              <div className="mt-3 pt-2 border-t border-white/[0.04]">
                <div
                  ref={progressRef}
                  onClick={handleSeek}
                  className="h-1.5 rounded-full bg-white/[0.08] relative cursor-pointer group hover:h-2 transition-all"
                  title={`Seek: ${fmtTime(currentTime)} / ${fmtTime(effectiveDuration)}`}
                >
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-blue-500 to-indigo-400 transition-all duration-75"
                    style={{ width: `${Math.min(progressPct, 100)}%` }}
                  />
                  <div
                    className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-white shadow-md shadow-blue-500/50 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
                    style={{ left: `${Math.min(progressPct, 100)}%`, transform: "translate(-50%, -50%)" }}
                  />
                </div>
                <div className="flex items-center justify-between text-[10px] font-mono text-white/40 mt-1">
                  <span>{fmtTime(currentTime)}</span>
                  <span>{fmtTime(effectiveDuration)}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Segmented Navigation Tabs ── */}
        <div className="mx-4 my-2.5 p-1 rounded-full bg-white/[0.03] border border-white/[0.06] flex items-center gap-1 flex-shrink-0">
          <button
            type="button"
            onClick={() => setTab("youtube")}
            className={`flex-1 py-1.5 px-1.5 rounded-full text-[11px] font-medium flex items-center justify-center gap-1 transition-all ${
              tab === "youtube"
                ? "bg-white/[0.1] text-white font-semibold shadow-sm border border-white/[0.08]"
                : "text-white/50 hover:text-white/80 hover:bg-white/[0.03]"
            }`}
          >
            <YouTubeIcon size={12} className={tab === "youtube" ? "text-red-400" : "text-white/40"} />
            <span>YouTube</span>
          </button>

          <button
            type="button"
            onClick={() => setTab("procedural")}
            className={`flex-1 py-1.5 px-1.5 rounded-full text-[11px] font-medium flex items-center justify-center gap-1 transition-all ${
              tab === "procedural"
                ? "bg-white/[0.1] text-white font-semibold shadow-sm border border-white/[0.08]"
                : "text-white/50 hover:text-white/80 hover:bg-white/[0.03]"
            }`}
          >
            <Sparkles size={11} className={tab === "procedural" ? "text-amber-400" : "text-white/40"} />
            <span>Synth</span>
          </button>

          <button
            type="button"
            onClick={() => setTab("radio")}
            className={`flex-1 py-1.5 px-1.5 rounded-full text-[11px] font-medium flex items-center justify-center gap-1 transition-all ${
              tab === "radio"
                ? "bg-white/[0.1] text-white font-semibold shadow-sm border border-white/[0.08]"
                : "text-white/50 hover:text-white/80 hover:bg-white/[0.03]"
            }`}
          >
            <Radio size={11} className={tab === "radio" ? "text-blue-400" : "text-white/40"} />
            <span>Radio</span>
          </button>

          <button
            type="button"
            onClick={() => setTab("playlists")}
            className={`flex-1 py-1.5 px-1.5 rounded-full text-[11px] font-medium flex items-center justify-center gap-1 transition-all ${
              tab === "playlists"
                ? "bg-white/[0.1] text-white font-semibold shadow-sm border border-white/[0.08]"
                : "text-white/50 hover:text-white/80 hover:bg-white/[0.03]"
            }`}
          >
            <ListMusic size={11} className={tab === "playlists" ? "text-indigo-400" : "text-white/40"} />
            <span>Playlists</span>
            {playlists.length > 0 && (
              <span className="px-1 rounded-full bg-white/[0.1] text-[9px] font-mono text-white/70">
                {playlists.length}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setTab("favorites")}
            className={`flex-1 py-1.5 px-1.5 rounded-full text-[11px] font-medium flex items-center justify-center gap-1 transition-all ${
              tab === "favorites"
                ? "bg-white/[0.1] text-white font-semibold shadow-sm border border-white/[0.08]"
                : "text-white/50 hover:text-white/80 hover:bg-white/[0.03]"
            }`}
          >
            <Heart size={11} className={tab === "favorites" ? "text-pink-400" : "text-white/40"} />
            <span>Saved</span>
            {favorites.length > 0 && (
              <span className="px-1 rounded-full bg-white/[0.1] text-[9px] font-mono text-white/70">
                {favorites.length}
              </span>
            )}
          </button>
        </div>

        {/* ── Scrollable Body Content ── */}
        <div className="flex-1 overflow-y-auto px-4 pb-3 space-y-3 custom-scrollbar">
          {/* ── TAB 1: YouTube Search & Discovery ── */}
          {tab === "youtube" && (
            <div className="space-y-3">
              {/* Quick Vibe Chips Carousel */}
              <div className="flex items-center gap-1.5 overflow-x-auto pb-1 no-scrollbar">
                {QUICK_VIBES.map((v) => (
                  <button
                    key={v.label}
                    type="button"
                    onClick={() => handleQuickVibe(v.query)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/[0.03] hover:bg-white/[0.08] border border-white/[0.06] text-[11px] text-white/80 hover:text-white flex-shrink-0 transition-all active:scale-95"
                  >
                    <span>{v.icon}</span>
                    <span>{v.label}</span>
                  </button>
                ))}
              </div>

              {/* Search Bar */}
              <form onSubmit={handleSearchSubmit} className="flex items-center gap-2">
                <div className="flex-1 h-10 rounded-full bg-white/[0.04] border border-white/[0.08] focus-within:border-blue-500/50 focus-within:ring-2 focus-within:ring-blue-500/20 px-3.5 flex items-center gap-2.5 transition-all">
                  <Search size={14} className="text-white/40 flex-shrink-0" />
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search beats, lofi, rain or paste YouTube URL…"
                    className="flex-1 bg-transparent border-none text-xs text-white placeholder-white/30 focus:outline-none min-w-0"
                  />
                  {query && (
                    <button
                      type="button"
                      onClick={() => {
                        setQuery("");
                        searchInputRef.current?.focus();
                      }}
                      className="w-5 h-5 rounded-full bg-white/[0.08] hover:bg-white/[0.15] text-white/60 hover:text-white flex items-center justify-center flex-shrink-0"
                      aria-label="Clear"
                    >
                      <X size={11} />
                    </button>
                  )}
                </div>
                <button
                  type="submit"
                  disabled={loading || !query.trim()}
                  className="h-10 px-4 rounded-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:hover:bg-blue-600 text-white text-xs font-semibold shadow-md shadow-blue-600/25 transition-all flex items-center justify-center active:scale-95 flex-shrink-0"
                  aria-label={loading ? "Searching" : "Search"}
                >
                  {loading ? <SmoothSpinner size={14} className="text-white" /> : "Search"}
                </button>
              </form>

              {/* 1. Loading State: Industry-Grade YouTube Skeleton Loading UI */}
              {loading ? (
                <YouTubeSkeletonList query={query} />
              ) : error ? (
                <div className="p-3 rounded-[16px] bg-red-500/10 border border-red-500/20 text-xs text-red-300 animate-in fade-in duration-150">
                  {error}
                </div>
              ) : youtubeResults.length > 0 ? (
                /* 2. YouTube Search Results with GSAP Staggered Reveal */
                <div ref={resultsListRef} className="space-y-2">
                  {youtubeResults.map((t) => {
                    const isCurrent = activeSound?.source === "youtube" && activeSound.id === t.video_id;
                    const isResolving = resolvingId === t.video_id;
                    const isDownloading = downloadingId === t.video_id;
                    const isFav = isFavorite("youtube", t.video_id);

                    return (
                      <div
                        key={t.video_id}
                        onClick={() => void handlePlayYouTube(t)}
                        className={`amb-result-card group p-2.5 rounded-[18px] border transition-all flex items-center gap-3 cursor-pointer select-none active:scale-[0.99] ${
                          isCurrent
                            ? "bg-blue-500/10 border-blue-500/30 shadow-md shadow-blue-500/10"
                            : "bg-white/[0.02] hover:bg-white/[0.05] border-white/[0.05] hover:border-white/[0.1]"
                        }`}
                      >
                        {/* Thumbnail */}
                        <div className="w-16 h-11 rounded-[10px] overflow-hidden bg-black/40 relative flex-shrink-0 border border-white/[0.06]">
                          {t.thumbnail_url ? (
                            <img src={t.thumbnail_url} alt="" className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <Music2 size={18} className="text-white/40" />
                            </div>
                          )}
                          {t.duration_secs ? (
                            <span className="absolute bottom-1 right-1 px-1 py-0.2 rounded bg-black/80 text-[9px] font-mono text-white/90">
                              {formatDuration(t.duration_secs)}
                            </span>
                          ) : null}
                          <div
                            className={`absolute inset-0 bg-black/50 flex items-center justify-center transition-opacity ${
                              isCurrent ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                            }`}
                          >
                            {isResolving ? (
                              <SmoothSpinner size={16} className="text-white" />
                            ) : isCurrent && isPlaying ? (
                              <Pause size={16} className="text-white" />
                            ) : (
                              <Play size={16} className="text-white ml-0.5" />
                            )}
                          </div>
                        </div>

                        {/* Info */}
                        <div className="flex-1 min-w-0 pr-1">
                          <div className="text-xs font-medium text-white/90 truncate" title={t.title}>
                            {t.title}
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-[11px] text-white/40 truncate" title={t.channel}>
                              {t.channel}
                            </span>
                            <span className="px-1.5 py-0.2 rounded bg-white/[0.05] text-[9px] font-mono text-white/60">
                              160k Opus
                            </span>
                          </div>
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            onClick={() => setSoundToAddToPlaylist(soundFromYouTube(t))}
                            className="w-7 h-7 rounded-full bg-white/[0.04] hover:bg-white/[0.1] text-white/50 hover:text-white flex items-center justify-center transition-all"
                            title="Add to Playlist"
                            aria-label="Add to Playlist"
                          >
                            <FolderPlus size={12} />
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDownloadYouTube(t)}
                            disabled={isDownloading}
                            className="w-7 h-7 rounded-full bg-white/[0.04] hover:bg-white/[0.1] text-white/50 hover:text-white flex items-center justify-center transition-all"
                            title="Save for offline playback"
                            aria-label="Save for offline playback"
                          >
                            {isDownloading ? (
                              <SmoothSpinner size={12} className="text-blue-400" />
                            ) : (
                              <Download size={12} />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => void toggleFavorite(favoriteFromYouTube(t))}
                            className={`w-7 h-7 rounded-full bg-white/[0.04] hover:bg-white/[0.1] flex items-center justify-center transition-all ${
                              isFav ? "text-pink-400" : "text-white/50 hover:text-white"
                            }`}
                            title={isFav ? "Remove from saved" : "Add to saved"}
                            aria-label="Toggle favorite"
                          >
                            <Heart size={12} fill={isFav ? "currentColor" : "none"} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : !query.trim() ? (
                /* 3. Discovery: Curated Mixes when no search query has been entered */
                <div className="space-y-2 pt-1">
                  <div className="flex items-center justify-between px-1">
                    <span className="text-xs font-semibold text-white/80">Curated Study Mixes</span>
                    <span className="text-[10px] text-white/40 font-mono">1-TAP STREAM</span>
                  </div>
                  <div className="grid grid-cols-1 gap-2">
                    {CURATED_STREAMS.map((s) => (
                      <div
                        key={s.id}
                        onClick={() => void handlePlayCurated(s)}
                        className="group p-2.5 rounded-[18px] bg-white/[0.02] hover:bg-white/[0.06] border border-white/[0.05] hover:border-white/[0.1] transition-all flex items-center justify-between cursor-pointer active:scale-[0.99]"
                      >
                        <div className="flex items-center gap-3 min-w-0 pr-2">
                          <div className="w-10 h-10 rounded-[12px] bg-black/40 border border-white/[0.06] flex items-center justify-center text-xl flex-shrink-0">
                            {s.emoji}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className={`px-1.5 py-0.2 rounded border text-[9px] font-mono font-medium ${s.badgeColor}`}>
                                {s.tag}
                              </span>
                              <span className="text-[10.5px] text-white/40 truncate">{s.channel}</span>
                            </div>
                            <div className="text-xs font-medium text-white/90 truncate mt-0.5" title={s.title}>
                              {s.title}
                            </div>
                          </div>
                        </div>
                        <div className="w-8 h-8 rounded-full bg-blue-600/80 group-hover:bg-blue-500 text-white flex items-center justify-center flex-shrink-0 shadow-md shadow-blue-600/25 transition-all">
                          <Play size={12} className="ml-0.5" />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                /* 4. No Results Fallback */
                <div className="py-12 px-4 text-center rounded-[20px] bg-white/[0.02] border border-white/[0.04]">
                  <Music2 size={28} className="text-white/20 mx-auto mb-2" />
                  <p className="text-xs text-white/70 font-medium">No audio results found</p>
                  <p className="text-[11px] text-white/40 mt-1">Try another search term or pick from Quick Vibes.</p>
                </div>
              )}
            </div>
          )}

          {/* ── TAB 2: Offline Synthesizer ── */}
          {tab === "procedural" && (
            <div className="grid grid-cols-2 gap-2.5">
              {PROCEDURAL_PRESETS.map((p) => {
                const isCurrent = activeSound?.source === "procedural" && activeSound.id === p.kind;
                return (
                  <div
                    key={p.kind}
                    onClick={() => {
                      if (isCurrent) togglePlay();
                      else play(soundFromProcedural(p.kind));
                    }}
                    className={`p-3 rounded-[18px] border text-left flex flex-col justify-between transition-all cursor-pointer active:scale-[0.98] ${
                      isCurrent
                        ? "bg-amber-500/10 border-amber-500/30 shadow-md shadow-amber-500/10"
                        : "bg-white/[0.02] hover:bg-white/[0.05] border-white/[0.05] hover:border-white/[0.1]"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-2xl">{p.emoji}</span>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSoundToAddToPlaylist(soundFromProcedural(p.kind));
                          }}
                          className="w-6 h-6 rounded-full bg-white/[0.04] hover:bg-white/[0.1] text-white/50 hover:text-white flex items-center justify-center"
                          title="Add to Playlist"
                        >
                          <FolderPlus size={11} />
                        </button>
                        <div
                          className={`w-7 h-7 rounded-full flex items-center justify-center ${
                            isCurrent
                              ? "bg-amber-500 text-black font-bold"
                              : "bg-white/[0.06] text-white/60"
                          }`}
                        >
                          {isCurrent && isPlaying ? <Pause size={12} /> : <Play size={12} className="ml-0.5" />}
                        </div>
                      </div>
                    </div>
                    <div className="mt-3">
                      <div className="text-xs font-semibold text-white">{p.name}</div>
                      <div className="text-[10px] text-white/40 mt-0.5">
                        {PROCEDURAL_DESCS[p.kind] || "3D Dual-Channel"}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* ── TAB 3: SomaFM Radio ── */}
          {tab === "radio" && (
            <div className="space-y-2">
              {SOMA_FM_STREAMS.map((s) => {
                const isCurrent = activeSound?.source === "somafm" && activeSound.id === s.id;
                return (
                  <div
                    key={s.id}
                    onClick={() => {
                      if (isCurrent) togglePlay();
                      else play(soundFromSoma(s));
                    }}
                    className={`w-full p-3 rounded-[18px] border text-left flex items-center justify-between transition-all cursor-pointer active:scale-[0.99] ${
                      isCurrent
                        ? "bg-blue-500/10 border-blue-500/30 shadow-md shadow-blue-500/10"
                        : "bg-white/[0.02] hover:bg-white/[0.05] border-white/[0.05] hover:border-white/[0.1]"
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0 pr-2">
                      <div className="w-10 h-10 rounded-[12px] bg-blue-500/15 border border-blue-500/25 flex items-center justify-center flex-shrink-0 text-blue-400">
                        <Radio size={16} />
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-white truncate">{s.name}</div>
                        <div className="text-[10px] text-white/40 truncate mt-0.5">{s.description}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        onClick={() => setSoundToAddToPlaylist(soundFromSoma(s))}
                        className="w-7 h-7 rounded-full bg-white/[0.04] hover:bg-white/[0.1] text-white/50 hover:text-white flex items-center justify-center"
                        title="Add to Playlist"
                      >
                        <FolderPlus size={12} />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (isCurrent) togglePlay();
                          else play(soundFromSoma(s));
                        }}
                        className={`w-8 h-8 rounded-full flex items-center justify-center ${
                          isCurrent
                            ? "bg-blue-600 text-white shadow-md shadow-blue-600/30"
                            : "bg-white/[0.05] text-white/60"
                        }`}
                      >
                        {isCurrent && isPlaying ? <Pause size={13} /> : <Play size={13} className="ml-0.5" />}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* ── TAB 4: Study Playlists System ── */}
          {tab === "playlists" && (
            <div className="space-y-3">
              {/* If viewing a specific playlist */}
              {selectedPlaylist ? (
                <div className="space-y-3 animate-in fade-in duration-200">
                  {/* Playlist Header & Nav */}
                  <div className="flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => setSelectedPlaylistId(null)}
                      className="flex items-center gap-1 text-xs text-white/60 hover:text-white transition-colors"
                    >
                      <ChevronLeft size={14} />
                      <span>All Playlists</span>
                    </button>
                    {/* Delete playlist if user custom */}
                    <button
                      type="button"
                      onClick={() => {
                        deletePlaylist(selectedPlaylist.id);
                        setSelectedPlaylistId(null);
                      }}
                      className="text-red-400/60 hover:text-red-400 text-xs p-1"
                      title="Delete Playlist"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>

                  {/* Playlist Banner Card */}
                  <div
                    className={`p-4 rounded-[22px] bg-gradient-to-tr ${selectedPlaylist.gradient} border border-white/20 shadow-xl text-white relative overflow-hidden`}
                  >
                    <div className="absolute right-3 -bottom-2 text-7xl opacity-20 select-none pointer-events-none">
                      {selectedPlaylist.emoji}
                    </div>
                    <div className="relative z-10">
                      <div className="text-2xl mb-1">{selectedPlaylist.emoji}</div>
                      <h3 className="text-base font-bold tracking-tight">{selectedPlaylist.name}</h3>
                      {selectedPlaylist.description && (
                        <p className="text-xs text-white/80 mt-1 max-w-[280px] line-clamp-2">
                          {selectedPlaylist.description}
                        </p>
                      )}
                      <div className="flex items-center gap-3 mt-3 text-[11px] text-white/90">
                        <span className="font-mono">{selectedPlaylist.items.length} tracks</span>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            disabled={selectedPlaylist.items.length === 0}
                            onClick={() => playPlaylist(selectedPlaylist.id, 0)}
                            className="px-3 py-1 rounded-full bg-white text-black font-semibold text-xs flex items-center gap-1.5 shadow-md hover:bg-white/90 active:scale-95 disabled:opacity-50"
                          >
                            <Play size={11} className="fill-current" />
                            <span>Play All</span>
                          </button>
                          <button
                            type="button"
                            disabled={selectedPlaylist.items.length === 0}
                            onClick={() => {
                              const randIdx = Math.floor(Math.random() * selectedPlaylist.items.length);
                              playPlaylist(selectedPlaylist.id, randIdx);
                            }}
                            className="p-1.5 rounded-full bg-white/20 hover:bg-white/30 text-white flex items-center justify-center transition-all"
                            title="Shuffle Playlist"
                          >
                            <Shuffle size={12} />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Track Listing */}
                  <div className="space-y-1.5">
                    {selectedPlaylist.items.length === 0 ? (
                      <div className="py-8 px-4 text-center rounded-[18px] bg-white/[0.02] border border-white/[0.04]">
                        <Music2 size={24} className="text-white/20 mx-auto mb-1.5" />
                        <p className="text-xs text-white/70 font-medium">This playlist is empty</p>
                        <p className="text-[11px] text-white/40 mt-1">
                          Click "+" on any YouTube track, Synthesizer preset, or Radio station to add it here.
                        </p>
                      </div>
                    ) : (
                      selectedPlaylist.items.map((item, idx) => {
                        const isCurrentTrack =
                          activePlaylistId === selectedPlaylist.id &&
                          activeSound?.id === item.sound.id;

                        return (
                          <div
                            key={item.id}
                            onClick={() => playPlaylist(selectedPlaylist.id, idx)}
                            className={`p-2.5 rounded-[16px] border transition-all flex items-center gap-2.5 cursor-pointer select-none group active:scale-[0.99] ${
                              isCurrentTrack
                                ? "bg-blue-500/15 border-blue-500/35 text-white"
                                : "bg-white/[0.02] hover:bg-white/[0.05] border-white/[0.04] text-white/80"
                            }`}
                          >
                            {/* Track Index or Playing Bars */}
                            <div className="w-5 text-center text-xs font-mono text-white/40 flex items-center justify-center flex-shrink-0">
                              {isCurrentTrack && isPlaying ? (
                                <WaveformBars active={true} color="#3b82f6" />
                              ) : (
                                <span>{idx + 1}</span>
                              )}
                            </div>

                            {/* Artwork / Icon */}
                            <div className="w-9 h-9 rounded-[10px] overflow-hidden bg-black/40 border border-white/[0.06] flex items-center justify-center flex-shrink-0">
                              {item.sound.thumbnail_url ? (
                                <img src={item.sound.thumbnail_url} alt="" className="w-full h-full object-cover" />
                              ) : item.sound.source === "youtube" ? (
                                <YouTubeIcon size={12} className="text-red-400" />
                              ) : item.sound.source === "procedural" ? (
                                <Sparkles size={12} className="text-amber-400" />
                              ) : (
                                <Radio size={12} className="text-blue-400" />
                              )}
                            </div>

                            {/* Title & Channel */}
                            <div className="flex-1 min-w-0 pr-1">
                              <div className="text-xs font-medium text-white truncate" title={item.sound.name}>
                                {item.sound.name}
                              </div>
                              <div className="text-[10px] text-white/40 truncate mt-0.5">
                                {item.sound.channel || item.sound.source}
                              </div>
                            </div>

                            {/* Actions */}
                            <div className="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                              <button
                                type="button"
                                onClick={() => removeFromPlaylist(selectedPlaylist.id, item.id)}
                                className="w-6 h-6 rounded-full text-white/30 hover:text-red-400 flex items-center justify-center transition-colors"
                                title="Remove from playlist"
                              >
                                <Trash2 size={11} />
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              ) : (
                /* All Playlists Grid */
                <div className="space-y-3">
                  {/* Top Bar: Title & + New Playlist Button */}
                  <div className="flex items-center justify-between px-1">
                    <span className="text-xs font-semibold text-white/80">Study Playlists</span>
                    <button
                      type="button"
                      onClick={() => setIsCreatingPlaylist(true)}
                      className="px-2.5 py-1 rounded-full bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-semibold flex items-center gap-1 shadow-sm transition-all active:scale-95"
                    >
                      <Plus size={12} />
                      <span>New Playlist</span>
                    </button>
                  </div>

                  {/* Playlists Cards */}
                  <div className="grid grid-cols-1 gap-2.5">
                    {playlists.map((pl) => {
                      const isCurrentPlaylist = activePlaylistId === pl.id;

                      return (
                        <div
                          key={pl.id}
                          onClick={() => setSelectedPlaylistId(pl.id)}
                          className={`group p-3.5 rounded-[20px] border transition-all cursor-pointer relative overflow-hidden active:scale-[0.99] ${
                            isCurrentPlaylist
                              ? "bg-blue-500/10 border-blue-500/40 shadow-lg shadow-blue-500/10"
                              : "bg-white/[0.02] hover:bg-white/[0.06] border-white/[0.06]"
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3 min-w-0 pr-2">
                              <div
                                className={`w-11 h-11 rounded-[14px] bg-gradient-to-tr ${pl.gradient} flex items-center justify-center text-xl flex-shrink-0 shadow-md`}
                              >
                                {pl.emoji}
                              </div>
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-xs font-semibold text-white truncate">{pl.name}</span>
                                  {isCurrentPlaylist && (
                                    <span className="px-1.5 py-0.2 rounded-full bg-emerald-500/20 text-emerald-300 text-[9px] font-mono font-medium">
                                      ACTIVE
                                    </span>
                                  )}
                                </div>
                                <div className="text-[10.5px] text-white/40 truncate mt-0.5">
                                  {pl.items.length} tracks · {pl.description || "Custom study mix"}
                                </div>
                              </div>
                            </div>

                            <div className="flex items-center gap-1.5 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                              <button
                                type="button"
                                onClick={() => playPlaylist(pl.id, 0)}
                                disabled={pl.items.length === 0}
                                className="w-8 h-8 rounded-full bg-blue-600/80 hover:bg-blue-500 text-white flex items-center justify-center shadow-md shadow-blue-600/25 transition-all disabled:opacity-40"
                                title="Play Playlist"
                              >
                                <Play size={12} className="ml-0.5" />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── TAB 5: Saved & Offline Tracks ── */}
          {tab === "favorites" && (
            <div className="space-y-2">
              {favorites.length === 0 ? (
                <div className="py-12 px-4 text-center rounded-[20px] bg-white/[0.02] border border-white/[0.04]">
                  <Heart size={32} className="text-white/20 mx-auto mb-2" />
                  <p className="text-xs text-white/70 font-medium">No saved tracks yet</p>
                  <p className="text-[11px] text-white/40 mt-1 max-w-[260px] mx-auto">
                    Click the heart icon on any YouTube stream or procedural audio to keep it for quick focus sessions.
                  </p>
                </div>
              ) : (
                favorites.map((f) => {
                  const isCurrent = activeSound?.id === f.external_id;
                  return (
                    <div
                      key={f.id}
                      onClick={() => {
                        if (isCurrent) togglePlay();
                        else play(soundFromFavorite(f));
                      }}
                      className={`p-2.5 rounded-[18px] border transition-all flex items-center gap-3 cursor-pointer select-none ${
                        isCurrent
                          ? "bg-blue-500/10 border-blue-500/30"
                          : "bg-white/[0.02] hover:bg-white/[0.05] border-white/[0.05] hover:border-white/[0.1]"
                      }`}
                    >
                      <div className="w-10 h-10 rounded-[12px] bg-white/[0.04] border border-white/[0.06] flex items-center justify-center flex-shrink-0">
                        {f.source === "youtube" ? (
                          <YouTubeIcon size={14} className="text-red-400" />
                        ) : (
                          <Sparkles size={14} className="text-amber-400" />
                        )}
                      </div>

                      <div className="flex-1 min-w-0 pr-1">
                        <div className="text-xs font-medium text-white/90 truncate">{f.name}</div>
                        <div className="text-[10px] text-white/40 mt-0.5">
                          {f.cached_path ? (
                            <span className="text-emerald-400 flex items-center gap-1 font-mono">
                              <WifiOff size={9} /> Offline Ready
                            </span>
                          ) : (
                            <span className="text-white/40">Online Stream</span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          onClick={() => setSoundToAddToPlaylist(soundFromFavorite(f))}
                          className="w-7 h-7 rounded-full bg-white/[0.04] hover:bg-white/[0.1] text-white/50 hover:text-white flex items-center justify-center"
                          title="Add to Playlist"
                        >
                          <FolderPlus size={12} />
                        </button>
                        {f.cached_path ? (
                          <button
                            type="button"
                            onClick={() => void deleteCache(f)}
                            className="w-7 h-7 rounded-full bg-white/[0.04] hover:bg-white/[0.1] text-emerald-400 flex items-center justify-center"
                            title="Delete cached offline file"
                          >
                            <WifiOff size={12} />
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void cacheFavorite(f)}
                            className="w-7 h-7 rounded-full bg-white/[0.04] hover:bg-white/[0.1] text-white/50 hover:text-white flex items-center justify-center"
                            title="Download for offline playback"
                          >
                            <Download size={12} />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void toggleFavorite(f)}
                          className="w-7 h-7 rounded-full bg-white/[0.04] hover:bg-white/[0.1] text-red-400/60 hover:text-red-400 flex items-center justify-center"
                          title="Remove from saved"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>

        {/* ── Fixed Bottom Footer (Volume, Sleep Timer, Keep-Playing Toggle) ── */}
        <div className="p-4 rounded-b-[28px] bg-[#0c0d14]/95 backdrop-blur-2xl border-t border-white/[0.08] space-y-3.5 flex-shrink-0">
          {/* 1. Volume Control */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setVolume(volume > 0 ? 0 : 0.4)}
              className="text-white/60 hover:text-white transition-colors"
              title={volume > 0 ? "Mute" : "Unmute"}
            >
              {volume === 0 ? <VolumeX size={15} /> : <Volume2 size={15} />}
            </button>

            <div className="flex-1 flex items-center">
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={volume}
                onChange={(e) => setVolume(parseFloat(e.target.value))}
                className="w-full h-1.5 bg-white/[0.08] rounded-full appearance-none cursor-pointer accent-blue-500 focus:outline-none"
                aria-label="Volume Slider"
              />
            </div>

            <span className="px-2.5 py-0.5 rounded-full bg-white/[0.05] border border-white/[0.08] text-[11px] font-mono font-medium text-white/80 min-w-[42px] text-center">
              {Math.round(volume * 100)}%
            </span>
          </div>

          {/* 2. Sleep Timer (Segmented Chips - Fixed & Beautiful) */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between px-0.5">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-white/60">
                <Moon size={11} className="text-amber-400" />
                <span>Sleep Timer</span>
              </div>
              {remainingSecs > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-[10px] font-mono font-bold text-amber-300 animate-pulse">
                  {Math.ceil(remainingSecs / 60)}m remaining
                </span>
              )}
            </div>

            <div className="grid grid-cols-5 gap-1.5 p-1 rounded-[14px] bg-white/[0.03] border border-white/[0.06]">
              {SLEEP_OPTIONS.map((opt) => {
                const isActive = sleepTimerMins === opt.value;
                return (
                  <button
                    key={opt.label}
                    type="button"
                    onClick={() => setSleepTimer(opt.value)}
                    className={`py-1 rounded-[10px] text-[11px] font-medium text-center transition-all ${
                      isActive
                        ? "bg-blue-500/25 border border-blue-500/40 text-blue-300 font-semibold shadow-sm"
                        : "text-white/50 hover:text-white/90 hover:bg-white/[0.05] border border-transparent"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 3. Keep Playing During Lectures Switch */}
          <div
            onClick={() => setKeepPlaying(!keepPlayingWhileLecture)}
            className="flex items-center justify-between p-2.5 rounded-[14px] bg-white/[0.02] border border-white/[0.05] hover:bg-white/[0.04] transition-colors cursor-pointer select-none"
          >
            <div>
              <div className="text-xs font-medium text-white/80">Keep playing during lectures</div>
              <div className="text-[10px] text-white/40">Audio layers softly under video courses</div>
            </div>
            <div
              className={`w-9 h-5 rounded-full p-0.5 transition-colors relative flex items-center ${
                keepPlayingWhileLecture ? "bg-blue-600" : "bg-white/20"
              }`}
            >
              <div
                className={`w-4 h-4 rounded-full bg-white shadow-md transition-transform ${
                  keepPlayingWhileLecture ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </div>
          </div>
        </div>

        {/* ── MODAL 1: Add to Playlist Dialog ── */}
        {soundToAddToPlaylist && (
          <div className="absolute inset-0 z-50 bg-black/75 backdrop-blur-md flex items-center justify-center p-5 animate-in fade-in duration-150">
            <div className="w-full max-w-sm rounded-[24px] bg-[#12141f] border border-white/[0.1] shadow-2xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FolderPlus size={16} className="text-blue-400" />
                  <span className="text-sm font-semibold text-white">Add to Playlist</span>
                </div>
                <button
                  type="button"
                  onClick={() => setSoundToAddToPlaylist(null)}
                  className="w-7 h-7 rounded-full bg-white/[0.05] hover:bg-white/[0.1] text-white/60 flex items-center justify-center"
                >
                  <X size={13} />
                </button>
              </div>

              {/* Sound Target Preview */}
              <div className="p-2.5 rounded-[14px] bg-white/[0.03] border border-white/[0.06] flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-[8px] bg-black/40 border border-white/[0.06] flex items-center justify-center flex-shrink-0">
                  <Music2 size={13} className="text-blue-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium text-white truncate">{soundToAddToPlaylist.name}</div>
                  <div className="text-[10px] text-white/40 truncate">{soundToAddToPlaylist.channel || soundToAddToPlaylist.source}</div>
                </div>
              </div>

              {/* Playlists List to pick from */}
              <div className="space-y-1.5 max-h-48 overflow-y-auto custom-scrollbar">
                {playlists.map((pl) => {
                  const isAdded = addedFeedbackId === pl.id;
                  return (
                    <button
                      key={pl.id}
                      type="button"
                      onClick={() => handleConfirmAddToPlaylist(pl.id)}
                      className="w-full p-2.5 rounded-[14px] bg-white/[0.02] hover:bg-white/[0.06] border border-white/[0.05] flex items-center justify-between text-left transition-all active:scale-[0.99]"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="text-base">{pl.emoji}</span>
                        <div className="min-w-0">
                          <div className="text-xs font-medium text-white truncate">{pl.name}</div>
                          <div className="text-[10px] text-white/40">{pl.items.length} tracks</div>
                        </div>
                      </div>
                      {isAdded ? (
                        <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 text-[10px] font-mono font-medium flex items-center gap-1">
                          <Check size={11} /> Added!
                        </span>
                      ) : (
                        <Plus size={13} className="text-white/40" />
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Quick shortcut to create a new playlist instead */}
              <button
                type="button"
                onClick={() => {
                  setIsCreatingPlaylist(true);
                }}
                className="w-full py-2 rounded-[14px] bg-blue-600/20 hover:bg-blue-600/30 border border-blue-500/30 text-xs font-medium text-blue-300 flex items-center justify-center gap-1.5 transition-all"
              >
                <Plus size={12} />
                <span>Create New Playlist for this Track</span>
              </button>
            </div>
          </div>
        )}

        {/* ── MODAL 2: Create Playlist Dialog ── */}
        {isCreatingPlaylist && (
          <div className="absolute inset-0 z-50 bg-black/75 backdrop-blur-md flex items-center justify-center p-5 animate-in fade-in duration-150">
            <form
              onSubmit={handleCreatePlaylistSubmit}
              className="w-full max-w-sm rounded-[24px] bg-[#12141f] border border-white/[0.1] shadow-2xl p-5 space-y-4"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ListMusic size={16} className="text-blue-400" />
                  <span className="text-sm font-semibold text-white">Create Study Playlist</span>
                </div>
                <button
                  type="button"
                  onClick={() => setIsCreatingPlaylist(false)}
                  className="w-7 h-7 rounded-full bg-white/[0.05] hover:bg-white/[0.1] text-white/60 flex items-center justify-center"
                >
                  <X size={13} />
                </button>
              </div>

              {/* Playlist Name Input */}
              <div className="space-y-1">
                <label className="text-[11px] font-medium text-white/70">Playlist Name</label>
                <input
                  type="text"
                  required
                  autoFocus
                  placeholder="e.g. Calculus Grind, Late Night Coffee..."
                  value={newPlName}
                  onChange={(e) => setNewPlName(e.target.value)}
                  className="w-full h-10 px-3.5 rounded-[14px] bg-white/[0.05] border border-white/[0.1] focus:border-blue-500 text-xs text-white placeholder-white/30 focus:outline-none"
                />
              </div>

              {/* Emoji Selector */}
              <div className="space-y-1">
                <label className="text-[11px] font-medium text-white/70">Icon Emoji</label>
                <div className="flex flex-wrap gap-1.5">
                  {PLAYLIST_EMOJIS.map((em) => (
                    <button
                      key={em}
                      type="button"
                      onClick={() => setNewPlEmoji(em)}
                      className={`w-8 h-8 rounded-[10px] text-base flex items-center justify-center border transition-all ${
                        newPlEmoji === em
                          ? "bg-blue-600/30 border-blue-500 text-white scale-110 shadow-sm"
                          : "bg-white/[0.03] border-white/[0.06] text-white/70 hover:bg-white/[0.08]"
                      }`}
                    >
                      {em}
                    </button>
                  ))}
                </div>
              </div>

              {/* Gradient Palette Selector */}
              <div className="space-y-1">
                <label className="text-[11px] font-medium text-white/70">Cover Gradient</label>
                <div className="grid grid-cols-5 gap-1.5">
                  {PLAYLIST_GRADIENTS.map((g) => (
                    <button
                      key={g.label}
                      type="button"
                      onClick={() => setNewPlGradient(g.val)}
                      className={`h-7 rounded-[10px] bg-gradient-to-tr ${g.val} border transition-all ${
                        newPlGradient === g.val
                          ? "border-white scale-105 shadow-md shadow-black/40 ring-2 ring-blue-500/40"
                          : "border-transparent opacity-70 hover:opacity-100"
                      }`}
                      title={g.label}
                    />
                  ))}
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsCreatingPlaylist(false)}
                  className="flex-1 py-2 rounded-[14px] bg-white/[0.05] hover:bg-white/[0.1] text-xs font-medium text-white/70 transition-all"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!newPlName.trim()}
                  className="flex-1 py-2 rounded-[14px] bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-xs font-semibold text-white shadow-md shadow-blue-600/30 transition-all"
                >
                  Create
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
