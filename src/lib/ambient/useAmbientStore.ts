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
import type { AmbientFavorite, AmbientSound } from "./types";

/** Over the final stretch the volume eases to zero so the user isn't jolted awake by a hard cut. */
const FADE_SECS = 180;

const LS_VOLUME = "ple.ambient.volume";
const LS_KEEP = "ple.ambient.keepPlaying";
const SETTING_VOLUME = "ambient.volume";
const SETTING_KEEP = "ambient.keep_playing";

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
    set({ hydrated: true });
  },
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
      // If the clip ended naturally (finite clip, not looped), stop.
      if (state.activeSound && state.activeSound.loop === false) {
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
