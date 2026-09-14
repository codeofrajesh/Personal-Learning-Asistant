/**
 * useAmbientStore — global state for the Ambient Sound Hub.
 *
 * Owns playback intent (which sound, playing, volume), the sleep timer, and the favorites list;
 * delegates the actual audio to `ambientEngine`. Playback preferences (volume, keep-playing) are
 * mirrored to the `settings` table + localStorage the same way `restDayStore` does, so they
 * survive restarts and paint instantly. Favorites live in SQLite via the ambient IPC commands.
 *
 * ## 2026-09 overhaul
 * The store now subscribes to engine events so external play/pause triggers (earbuds, OS controls)
 * correctly update `isPlaying`. New fields: `isBuffering`, `currentTime`, `duration` for a
 * progress bar and buffering spinner in the UI.
 */

import { create } from "zustand";
import { ipc, isTauri } from "../ipc";
import { ambientEngine } from "./ambientEngine";
import type {
  AmbientFavorite,
  AmbientSound,
  AmbientPlaylist,
  AmbientPlaylistItem,
  AudioToneProfile,
  BinauralBeatKind,
} from "./types";

/** Over the final stretch the volume eases to zero so the user isn't jolted awake by a hard cut. */
const FADE_SECS = 180;

const LS_VOLUME = "ple.ambient.volume";
const LS_KEEP = "ple.ambient.keepPlaying";
const LS_PLAYLISTS = "ple.ambient.playlists";
const LS_PROFILE = "ple.ambient.toneProfile";
const LS_BINAURAL_KIND = "ple.ambient.binauralKind";
const LS_BINAURAL_VOL = "ple.ambient.binauralVol";
const LS_AUTODUCK = "ple.ambient.autoDuck";

const SETTING_VOLUME = "ambient.volume";
const SETTING_KEEP = "ambient.keep_playing";

const STARTER_PLAYLISTS: AmbientPlaylist[] = [
  {
    id: "pl-deep-focus",
    name: "Deep Focus Flow",
    emoji: "⚡",
    gradient: "from-blue-600 via-indigo-600 to-cyan-500",
    description: "Lofi beats, rain acoustics, and neural alpha frequencies for unbroken deep work.",
    created_at: new Date().toISOString(),
    items: [
      {
        id: "item-df-1",
        added_at: new Date().toISOString(),
        sound: {
          source: "youtube",
          id: "jfKfPfyJRdk",
          name: "lofi hip hop radio 📚 - beats to relax/study to",
          thumbnail_url: "https://i.ytimg.com/vi/jfKfPfyJRdk/hq720.jpg",
          channel: "Lofi Girl",
          duration_secs: null,
        },
      },
      {
        id: "item-df-2",
        added_at: new Date().toISOString(),
        sound: {
          source: "procedural",
          id: "rain",
          name: "Heavy Rain & Distant Thunder",
          thumbnail_url: null,
          channel: "Synthesizer",
          duration_secs: null,
        },
      },
      {
        id: "item-df-3",
        added_at: new Date().toISOString(),
        sound: {
          source: "procedural",
          id: "alpha10",
          name: "10 Hz Alpha Wave Binaural Tone",
          thumbnail_url: null,
          channel: "Synthesizer",
          duration_secs: null,
        },
      },
    ],
  },
  {
    id: "pl-night-code",
    name: "Late Night Code",
    emoji: "🌌",
    gradient: "from-purple-600 via-violet-600 to-indigo-700",
    description: "Deep space ambient drones & hypnotic synthscapes for nighttime programming.",
    created_at: new Date().toISOString(),
    items: [
      {
        id: "item-nc-1",
        added_at: new Date().toISOString(),
        sound: {
          source: "somafm",
          id: "dronezone",
          name: "Drone Zone",
          url: "https://ice1.somafm.com/dronezone-128-mp3",
          thumbnail_url: null,
          channel: "SomaFM 24/7",
          duration_secs: null,
        },
      },
      {
        id: "item-nc-2",
        added_at: new Date().toISOString(),
        sound: {
          source: "procedural",
          id: "brown",
          name: "Deep Brown Noise",
          thumbnail_url: null,
          channel: "Synthesizer",
          duration_secs: null,
        },
      },
      {
        id: "item-nc-3",
        added_at: new Date().toISOString(),
        sound: {
          source: "somafm",
          id: "spacestation",
          name: "Space Station Soma",
          url: "https://ice1.somafm.com/spacestation-128-mp3",
          thumbnail_url: null,
          channel: "SomaFM 24/7",
          duration_secs: null,
        },
      },
    ],
  },
  {
    id: "pl-exam-sprint",
    name: "Exam Sprint",
    emoji: "🔥",
    gradient: "from-amber-600 via-orange-600 to-rose-600",
    description: "High-energy gamma waves and immersive ocean surges for maximum retention.",
    created_at: new Date().toISOString(),
    items: [
      {
        id: "item-es-1",
        added_at: new Date().toISOString(),
        sound: {
          source: "procedural",
          id: "gamma40",
          name: "40 Hz Gamma Neuro-Sync",
          thumbnail_url: null,
          channel: "Synthesizer",
          duration_secs: null,
        },
      },
      {
        id: "item-es-2",
        added_at: new Date().toISOString(),
        sound: {
          source: "procedural",
          id: "waves",
          name: "Deep Ocean Surf",
          thumbnail_url: null,
          channel: "Synthesizer",
          duration_secs: null,
        },
      },
    ],
  },
];

interface AmbientState {
  activeSound: AmbientSound | null;
  isPlaying: boolean;
  /** True while the audio element is waiting for data (stalled / seeking). */
  isBuffering: boolean;
  /** Current playback position in seconds. */
  currentTime: number;
  /** Total duration in seconds (0 for live streams). */
  duration: number;
  /** Master volume, 0..1. Default 0.1 so it layers gently under a lecture. */
  volume: number;
  /** When true, ambient keeps playing regardless of lecture playback (the default). */
  keepPlayingWhileLecture: boolean;
  /** Selected sleep-timer length in minutes (null = off). */
  sleepTimerMins: number | null;
  /** Absolute end time (ms epoch) or null. */
  sleepEndsAt: number | null;
  /** Seconds left on the sleep timer, for display. */
  remainingSecs: number;
  fadeStarted: boolean;
  favorites: AmbientFavorite[];
  hydrated: boolean;

  // ── Study Playlists & Queue ──
  playlists: AmbientPlaylist[];
  activePlaylistId: string | null;
  activePlaylistIndex: number;

  createPlaylist: (name: string, emoji?: string, gradient?: string, description?: string) => string;
  deletePlaylist: (id: string) => void;
  addToPlaylist: (playlistId: string, sound: AmbientSound) => void;
  removeFromPlaylist: (playlistId: string, itemId: string) => void;
  playPlaylist: (playlistId: string, startIndex?: number) => void;
  playNextInPlaylist: () => void;
  playPreviousInPlaylist: () => void;

  // ── Studio Sound Profiles & Brainwave Entrainment ──
  toneProfile: AudioToneProfile;
  binauralKind: BinauralBeatKind;
  binauralVolume: number;
  autoDuckOnLecture: boolean;

  setToneProfile: (profile: AudioToneProfile) => void;
  setBinauralBeat: (kind: BinauralBeatKind, volume?: number) => void;
  setBinauralVolume: (vol: number) => void;
  setAutoDuck: (enabled: boolean) => void;

  play: (sound: AmbientSound) => void;
  togglePlay: () => void;
  seek: (secs: number) => void;
  stop: () => void;
  setVolume: (v: number) => void;
  setKeepPlaying: (b: boolean) => void;
  setSleepTimer: (mins: number | null) => void;
  tickSleep: () => void;

  loadFavorites: () => Promise<void>;
  toggleFavorite: (payload: Omit<AmbientFavorite, "id" | "created_at">) => Promise<void>;
  isFavorite: (source: string, externalId: string) => boolean;
  cacheFavorite: (fav: AmbientFavorite) => Promise<void>;
  deleteCache: (fav: AmbientFavorite) => Promise<void>;
  initSync: () => Promise<void>;

  isDrawerOpen: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
  toggleDrawer: () => void;

  pillExpanded: boolean;
  setPillExpanded: (expanded: boolean) => void;
  togglePillExpanded: () => void;
}

function readNumber(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function readBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : raw === "true";
  } catch {
    return fallback;
  }
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, val: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch { /* ignore */ }
}

export const useAmbientStore = create<AmbientState>((set, get) => ({
  activeSound: null,
  isPlaying: false,
  isBuffering: false,
  currentTime: 0,
  duration: 0,
  volume: readNumber(LS_VOLUME, 0.1),
  keepPlayingWhileLecture: readBool(LS_KEEP, true),
  sleepTimerMins: null,
  sleepEndsAt: null,
  remainingSecs: 0,
  fadeStarted: false,
  favorites: [],
  hydrated: false,

  // ── Study Playlists & Queue ──
  playlists: readJson<AmbientPlaylist[]>(LS_PLAYLISTS, STARTER_PLAYLISTS),
  activePlaylistId: null,
  activePlaylistIndex: 0,

  createPlaylist: (name, emoji = "🎵", gradient = "from-blue-600 via-indigo-600 to-cyan-500", description = "") => {
    const newPl: AmbientPlaylist = {
      id: `pl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: name.trim() || "Untitled Playlist",
      emoji,
      gradient,
      description,
      items: [],
      created_at: new Date().toISOString(),
    };
    const updated = [newPl, ...get().playlists];
    writeJson(LS_PLAYLISTS, updated);
    set({ playlists: updated });
    return newPl.id;
  },

  deletePlaylist: (id) => {
    const updated = get().playlists.filter((p) => p.id !== id);
    writeJson(LS_PLAYLISTS, updated);
    const patch: Partial<AmbientState> = { playlists: updated };
    if (get().activePlaylistId === id) {
      patch.activePlaylistId = null;
      patch.activePlaylistIndex = 0;
    }
    set(patch);
  },

  addToPlaylist: (playlistId, sound) => {
    const playlists = get().playlists.map((pl) => {
      if (pl.id !== playlistId) return pl;
      if (pl.items.some((item) => item.sound.id === sound.id)) return pl;
      const newItem: AmbientPlaylistItem = {
        id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
        sound,
        added_at: new Date().toISOString(),
      };
      return { ...pl, items: [...pl.items, newItem] };
    });
    writeJson(LS_PLAYLISTS, playlists);
    set({ playlists });
  },

  removeFromPlaylist: (playlistId, itemId) => {
    const playlists = get().playlists.map((pl) => {
      if (pl.id !== playlistId) return pl;
      return { ...pl, items: pl.items.filter((it) => it.id !== itemId) };
    });
    writeJson(LS_PLAYLISTS, playlists);
    set({ playlists });
  },

  playPlaylist: (playlistId, startIndex = 0) => {
    const pl = get().playlists.find((p) => p.id === playlistId);
    if (!pl || pl.items.length === 0) return;
    const safeIdx = Math.max(0, Math.min(pl.items.length - 1, startIndex));
    const targetItem = pl.items[safeIdx];
    if (!targetItem) return;

    set({ activePlaylistId: playlistId, activePlaylistIndex: safeIdx });
    get().play({
      ...targetItem.sound,
      playlist_id: playlistId,
    });
  },

  playNextInPlaylist: () => {
    const { activePlaylistId, activePlaylistIndex, playlists } = get();
    if (!activePlaylistId) return;
    const pl = playlists.find((p) => p.id === activePlaylistId);
    if (!pl || pl.items.length === 0) return;

    const nextIdx = (activePlaylistIndex + 1) % pl.items.length;
    const nextItem = pl.items[nextIdx];
    if (!nextItem) return;

    set({ activePlaylistIndex: nextIdx });
    get().play({
      ...nextItem.sound,
      playlist_id: activePlaylistId,
    });
  },

  playPreviousInPlaylist: () => {
    const { activePlaylistId, activePlaylistIndex, playlists } = get();
    if (!activePlaylistId) return;
    const pl = playlists.find((p) => p.id === activePlaylistId);
    if (!pl || pl.items.length === 0) return;

    const prevIdx = (activePlaylistIndex - 1 + pl.items.length) % pl.items.length;
    const prevItem = pl.items[prevIdx];
    if (!prevItem) return;

    set({ activePlaylistIndex: prevIdx });
    get().play({
      ...prevItem.sound,
      playlist_id: activePlaylistId,
    });
  },

  // ── Studio Sound Profiles & Brainwave Entrainment ──
  toneProfile: (localStorage.getItem(LS_PROFILE) as AudioToneProfile) || "flat",
  binauralKind: (localStorage.getItem(LS_BINAURAL_KIND) as BinauralBeatKind) || "off",
  binauralVolume: readNumber(LS_BINAURAL_VOL, 0.35),
  autoDuckOnLecture: readBool(LS_AUTODUCK, true),

  setToneProfile: (profile) => {
    localStorage.setItem(LS_PROFILE, profile);
    ambientEngine.setToneProfile(profile);
    set({ toneProfile: profile });
  },

  setBinauralBeat: (kind, volume) => {
    const vol = volume != null ? volume : get().binauralVolume;
    localStorage.setItem(LS_BINAURAL_KIND, kind);
    ambientEngine.setBinauralBeat(kind, vol);
    set({ binauralKind: kind, binauralVolume: vol });
  },

  setBinauralVolume: (vol) => {
    const clamped = Math.max(0, Math.min(1, vol));
    localStorage.setItem(LS_BINAURAL_VOL, String(clamped));
    ambientEngine.setBinauralVolume(clamped);
    set({ binauralVolume: clamped });
  },

  setAutoDuck: (enabled) => {
    localStorage.setItem(LS_AUTODUCK, String(enabled));
    set({ autoDuckOnLecture: enabled });
  },

  play: async (sound) => {
    ambientEngine.setVolume(get().volume);
    set({ activeSound: sound, isPlaying: true, isBuffering: sound.source !== "procedural" });

    if (sound.source === "youtube" && !sound.url) {
      try {
        const info = await ipc.getYoutubeAudioUrl(sound.id);
        const resolvedSound: AmbientSound = {
          ...sound,
          url: info.stream_url,
          name: info.title || sound.name,
          thumbnail_url: info.thumbnail_url || sound.thumbnail_url,
          attribution: info.channel || sound.attribution,
          duration_secs: info.duration_secs || sound.duration_secs,
        };
        ambientEngine.play(resolvedSound);
        set({ activeSound: resolvedSound });
      } catch (err) {
        console.error("Failed to stream YouTube audio:", err);
        set({ isPlaying: false, isBuffering: false });
      }
      return;
    }

    ambientEngine.play(sound);
  },

  togglePlay: () => {
    const { isPlaying, activeSound } = get();
    if (!activeSound) return;
    if (isPlaying) {
      ambientEngine.pause();
      set({ isPlaying: false });
    } else {
      ambientEngine.resume();
      set({ isPlaying: true });
    }
  },

  seek: (secs: number) => {
    const target = Math.max(0, secs);
    ambientEngine.seek(target);
    set({ currentTime: target });
  },

  stop: () => {
    ambientEngine.stop();
    set({
      activeSound: null,
      isPlaying: false,
      isBuffering: false,
      currentTime: 0,
      duration: 0,
      sleepTimerMins: null,
      sleepEndsAt: null,
      remainingSecs: 0,
      fadeStarted: false,
    });
  },

  setVolume: (v) => {
    const volume = Math.max(0, Math.min(1, v));
    ambientEngine.setVolume(volume);
    set({ volume });
    try {
      localStorage.setItem(LS_VOLUME, String(volume));
    } catch {
      /* ignore quota */
    }
    if (isTauri()) void ipc.setSetting(SETTING_VOLUME, String(volume)).catch(() => {});
  },

  setKeepPlaying: (b) => {
    set({ keepPlayingWhileLecture: b });
    try {
      localStorage.setItem(LS_KEEP, String(b));
    } catch {
      /* ignore */
    }
    if (isTauri()) void ipc.setSetting(SETTING_KEEP, String(b)).catch(() => {});
  },

  setSleepTimer: (mins) => {
    // Cancel any in-progress fade by restoring full volume.
    ambientEngine.setVolume(get().volume);
    if (mins == null) {
      set({ sleepTimerMins: null, sleepEndsAt: null, remainingSecs: 0, fadeStarted: false });
      return;
    }
    set({
      sleepTimerMins: mins,
      sleepEndsAt: Date.now() + mins * 60_000,
      remainingSecs: mins * 60,
      fadeStarted: false,
    });
  },

  tickSleep: () => {
    const { sleepEndsAt, fadeStarted } = get();
    if (sleepEndsAt == null) return;
    const remaining = (sleepEndsAt - Date.now()) / 1000;
    if (remaining <= 0) {
      get().stop();
      return;
    }
    set({ remainingSecs: Math.ceil(remaining) });
    if (remaining <= FADE_SECS && !fadeStarted) {
      ambientEngine.fadeTo(0, remaining);
      set({ fadeStarted: true });
    }
  },

  loadFavorites: async () => {
    if (!isTauri()) return;
    try {
      const favorites = await ipc.listAmbientFavorites();
      set({ favorites });
    } catch {
      /* leave prior list */
    }
  },

  toggleFavorite: async (payload) => {
    if (!isTauri()) return;
    const exists = get().isFavorite(payload.source, payload.external_id);
    try {
      if (exists) await ipc.removeAmbientFavorite(payload.source, payload.external_id);
      else await ipc.addAmbientFavorite(payload);
      await get().loadFavorites();
    } catch {
      /* best-effort */
    }
  },

  isFavorite: (source, externalId) =>
    get().favorites.some((f) => f.source === source && f.external_id === externalId),

  cacheFavorite: async (fav) => {
    if (!isTauri()) return;
    try {
      if (fav.source === "youtube") {
        await ipc.cacheYoutubeAudio(fav.external_id, fav.name);
      } else if (fav.stream_url) {
        await ipc.cacheAmbientAudio(fav.stream_url, fav.name, fav.source, fav.external_id);
      }
      await get().loadFavorites();
    } catch {
      /* surfaced by the caller if needed */
    }
  },

  deleteCache: async (fav) => {
    if (!isTauri() || !fav.cached_path) return;
    try {
      await ipc.deleteCachedAmbient(fav.source, fav.external_id, fav.cached_path);
      await get().loadFavorites();
    } catch {
      /* best-effort */
    }
  },

  initSync: async () => {
    if (get().hydrated) return;
    if (isTauri()) {
      try {
        const [vol, keep] = await Promise.all([
          ipc.getSetting(SETTING_VOLUME),
          ipc.getSetting(SETTING_KEEP),
        ]);
        const patch: Partial<AmbientState> = {};
        if (vol != null && Number.isFinite(Number(vol))) patch.volume = Number(vol);
        if (keep != null) patch.keepPlayingWhileLecture = keep === "true";
        if (Object.keys(patch).length) set(patch);
      } catch {
        /* fall back to localStorage values already in state */
      }
      await get().loadFavorites();
    }

    // Apply studio audio tone profile & binaural beats if active
    ambientEngine.setToneProfile(get().toneProfile);
    if (get().binauralKind !== "off") {
      ambientEngine.setBinauralBeat(get().binauralKind, get().binauralVolume);
    }

    set({ hydrated: true });
  },

  isDrawerOpen: false,
  openDrawer: () => set({ isDrawerOpen: true }),
  closeDrawer: () => set({ isDrawerOpen: false }),
  toggleDrawer: () => set((s) => ({ isDrawerOpen: !s.isDrawerOpen })),

  pillExpanded: false,
  setPillExpanded: (expanded: boolean) => set({ pillExpanded: expanded }),
  togglePillExpanded: () => set((s) => ({ pillExpanded: !s.pillExpanded })),
}));

// ── Engine → store event bridge ─────────────────────────────────────────────
// This runs once at module init. It syncs native audio element events
// (earbuds, OS controls, buffering) back into the Zustand store.

ambientEngine.subscribe((event) => {
  const state = useAmbientStore.getState();

  switch (event.type) {
    case "play":
      // Only set isPlaying if we have an active sound (prevents ghost plays).
      if (state.activeSound) {
        useAmbientStore.setState({ isPlaying: true });
      }
      break;

    case "pause":
      if (state.activeSound) {
        useAmbientStore.setState({ isPlaying: false });
      }
      break;

    case "buffering":
      useAmbientStore.setState({ isBuffering: true });
      break;

    case "ready":
      useAmbientStore.setState({ isBuffering: false });
      break;

    case "progress":
      useAmbientStore.setState({
        currentTime: event.currentTime ?? 0,
        duration: event.duration ?? 0,
      });
      break;

    case "ended":
      // If we are currently in an active playlist, advance to the next track!
      if (state.activePlaylistId) {
        state.playNextInPlaylist();
      } else if (state.activeSound && state.activeSound.loop === false) {
        state.stop();
      }
      break;

    case "error":
      useAmbientStore.setState({ isBuffering: false });
      break;
  }
});

// Kick off hydration once (mirrors restDayStore).
if (typeof window !== "undefined") {
  void useAmbientStore.getState().initSync();
}
