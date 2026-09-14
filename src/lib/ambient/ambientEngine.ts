/**
 * Ambient audio engine — module-level singleton so ambient sound survives route changes.
 *
 * Two independent output paths, both governed by one master volume:
 *  - Procedural generators → Web Audio `masterGain` → speakers.
 *  - Online/cached sounds → detached `<audio>` element (plain no-cors, NOT through Web Audio
 *    graph to avoid cross-origin tainting).
 *
 * ## Event system (2026-09 overhaul)
 *
 * The engine now emits state-change callbacks so the Zustand store can react to:
 *  - Native media controls (earbuds double-tap, OS media overlay) that toggle play/pause
 *    without going through our React UI.
 *  - Buffering events (`waiting` / `canplay` / `stalled`) so the UI can show a spinner.
 *  - Progress updates (`timeupdate`) so the UI can render a seek bar for finite clips.
 *
 * The store subscribes once via `ambientEngine.subscribe(...)`.
 */

import { assetUrl, ipc, isTauri } from "../ipc";
import { getAudioContext, resumeAudioContext } from "./audioContext";
import { startProcedural, type ProceduralHandle } from "./procedural";
import type { AmbientSound, ProceduralKind, AudioToneProfile, BinauralBeatKind } from "./types";

// ── State change events ────────────────────────────────────────────────────

export interface AmbientEngineEvent {
  /** The native audio element started playing (including via earbuds / OS controls). */
  type:
    | "play"
    | "pause"
    | "buffering"
    | "ready"       // buffering finished, audio can play
    | "progress"    // currentTime / duration changed
    | "ended"
    | "error";
  currentTime?: number;
  duration?: number;
  /** True while the audio element is waiting for data (stalled / seeking). */
  isBuffering?: boolean;
}

type Listener = (event: AmbientEngineEvent) => void;

let masterGain: GainNode | null = null;
let warmthFilter: BiquadFilterNode | null = null;
let presenceFilter: BiquadFilterNode | null = null;
let masterCompressor: DynamicsCompressorNode | null = null;
let rawAudioEl: HTMLAudioElement | null = null;
let filteredAudioEl: HTMLAudioElement | null = null;
let activeEl: HTMLAudioElement | null = null;
let proceduralHandle: ProceduralHandle | null = null;
let current: AmbientSound | null = null;
let volume = 0.1;
let elFadeTimer: number | null = null;
let bufferingTimeout: number | null = null;
let isCurrentlyBuffering = false;
const listeners: Set<Listener> = new Set();

// ── Internal helpers ───────────────────────────────────────────────────────

function emit(event: AmbientEngineEvent) {
  if (event.type === "buffering") {
    isCurrentlyBuffering = true;
  } else if (event.type === "ready" || event.type === "play") {
    isCurrentlyBuffering = false;
  }
  for (const fn of listeners) {
    try { fn(event); } catch { /* swallow listener errors */ }
  }
}

function clearBufferingTimer() {
  if (bufferingTimeout != null) {
    window.clearTimeout(bufferingTimeout);
    bufferingTimeout = null;
  }
}

function ensureGraph(): GainNode {
  const ctx = getAudioContext();
  if (!masterGain) {
    masterGain = ctx.createGain();
    masterGain.gain.value = volume;

    // 1. Warmth filter: Low-shelf +3.2 dB @ 100 Hz gives Spotify-grade deep, full body
    warmthFilter = ctx.createBiquadFilter();
    warmthFilter.type = "lowshelf";
    warmthFilter.frequency.value = 100;
    warmthFilter.gain.value = 3.2;

    // 2. High-shelf softening: -1.8 dB @ 8500 Hz tames digital harshness for long study sessions
    presenceFilter = ctx.createBiquadFilter();
    presenceFilter.type = "highshelf";
    presenceFilter.frequency.value = 8500;
    presenceFilter.gain.value = -1.8;

    // 3. Transparent studio compressor: keeps audio full, balanced, and clip-free
    masterCompressor = ctx.createDynamicsCompressor();
    masterCompressor.threshold.value = -16;
    masterCompressor.knee.value = 10;
    masterCompressor.ratio.value = 2.5;
    masterCompressor.attack.value = 0.01;
    masterCompressor.release.value = 0.25;

    // Chain: masterGain -> warmthFilter -> presenceFilter -> masterCompressor -> destination
    masterGain.connect(warmthFilter);
    warmthFilter.connect(presenceFilter);
    presenceFilter.connect(masterCompressor);
    masterCompressor.connect(ctx.destination);
  }
  return masterGain;
}

/** Wire native HTMLAudioElement events to our event system. */
function attachElListeners(el: HTMLAudioElement) {
  // Play/pause from ANY source (our code, earbuds, OS media controls).
  el.addEventListener("play", () => {
    clearBufferingTimer();
    emit({ type: "play" });
    emit({ type: "ready", isBuffering: false });
  });
  el.addEventListener("pause", () => {
    clearBufferingTimer();
    emit({ type: "pause" });
  });

  // Buffering detection:
  // ONLY trigger buffering if playback is actively stalled for >250ms.
  // Note: We deliberately do NOT listen to "stalled" because Chromium fires "stalled"
  // whenever its internal buffer is full and pauses network socket reads!
  el.addEventListener("waiting", () => {
    clearBufferingTimer();
    bufferingTimeout = window.setTimeout(() => {
      if (!el.paused && el.readyState < 3) {
        emit({ type: "buffering", isBuffering: true });
      }
    }, 250);
  });

  el.addEventListener("canplay", () => {
    clearBufferingTimer();
    emit({ type: "ready", isBuffering: false });
  });

  el.addEventListener("playing", () => {
    clearBufferingTimer();
    emit({ type: "ready", isBuffering: false });
  });

  // Progress for the seek bar.
  el.addEventListener("timeupdate", () => {
    if (isCurrentlyBuffering && el.readyState >= 3) {
      clearBufferingTimer();
      emit({ type: "ready", isBuffering: false });
    }
    const dur = Number.isFinite(el.duration) ? el.duration : 0;
    emit({ type: "progress", currentTime: el.currentTime, duration: dur });
  });

  el.addEventListener("ended", () => {
    clearBufferingTimer();
    emit({ type: "ended" });
  });
  el.addEventListener("error", () => {
    clearBufferingTimer();
    emit({ type: "error" });
  });
}

let mediaSource: MediaElementAudioSourceNode | null = null;
let spatializerMerger: ChannelMergerNode | null = null;

function ensureElementGraph(el: HTMLAudioElement) {
  const ctx = getAudioContext();
  if (!mediaSource) {
    try {
      el.crossOrigin = "anonymous";
      mediaSource = ctx.createMediaElementSource(el);

      // Stereo Widening & Spatializing Network:
      // Converts thin mono audio (common in field recordings) into an expansive, wide 3D stereo room
      const splitter = ctx.createChannelSplitter(2);
      const delayL = ctx.createDelay();
      const delayR = ctx.createDelay();
      delayL.delayTime.value = 0.014;
      delayR.delayTime.value = 0.018;

      const crossGainL = ctx.createGain();
      const crossGainR = ctx.createGain();
      crossGainL.gain.value = -0.32;
      crossGainR.gain.value = 0.32;

      spatializerMerger = ctx.createChannelMerger(2);

      mediaSource.connect(splitter);

      // Direct L/R paths
      splitter.connect(spatializerMerger, 0, 0);
      splitter.connect(spatializerMerger, 1, 1);

      // Crossfeed spatialization paths
      splitter.connect(delayL, 0);
      delayL.connect(crossGainL);
      crossGainL.connect(spatializerMerger, 0, 1);

      splitter.connect(delayR, 1);
      delayR.connect(crossGainR);
      crossGainR.connect(spatializerMerger, 0, 0);

      const gain = ensureGraph();
      spatializerMerger.connect(gain);
    } catch {
      // Graceful fallback if CORS prevents Web Audio tap
    }
  }
}

function setupMediaSession() {
  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("play", () => {
      if (activeEl && activeEl.paused) void activeEl.play().catch(() => {});
    });
    navigator.mediaSession.setActionHandler("pause", () => {
      activeEl?.pause();
    });
  }
}

/** Pure raw HTMLAudioElement: Direct stereo stream with NO Web Audio filters or artificial spatializers */
function ensureRawAudioEl(): HTMLAudioElement {
  if (!rawAudioEl) {
    rawAudioEl = new Audio();
    (rawAudioEl as unknown as { referrerPolicy: string }).referrerPolicy = "no-referrer";
    rawAudioEl.setAttribute("referrerpolicy", "no-referrer");
    rawAudioEl.preload = "auto";
    rawAudioEl.volume = volume;
    attachElListeners(rawAudioEl);
    setupMediaSession();
  }
  return rawAudioEl;
}

/** Filtered HTMLAudioElement: Connected to Haas stereo spatializer and warmth EQ for mono/field sounds */
function ensureFilteredAudioEl(): HTMLAudioElement {
  if (!filteredAudioEl) {
    filteredAudioEl = new Audio();
    filteredAudioEl.crossOrigin = "anonymous";
    (filteredAudioEl as unknown as { referrerPolicy: string }).referrerPolicy = "no-referrer";
    filteredAudioEl.setAttribute("referrerpolicy", "no-referrer");
    filteredAudioEl.preload = "auto";
    filteredAudioEl.volume = volume;
    attachElListeners(filteredAudioEl);
    ensureElementGraph(filteredAudioEl);
    setupMediaSession();
  }
  return filteredAudioEl;
}

function stopProcedural() {
  if (proceduralHandle) {
    proceduralHandle.stop();
    proceduralHandle = null;
  }
}

function stopElements() {
  if (rawAudioEl) {
    rawAudioEl.pause();
    rawAudioEl.removeAttribute("src");
    rawAudioEl.load();
  }
  if (filteredAudioEl) {
    filteredAudioEl.pause();
    filteredAudioEl.removeAttribute("src");
    filteredAudioEl.load();
  }
}

function clearElFade() {
  if (elFadeTimer != null) {
    clearInterval(elFadeTimer);
    elFadeTimer = null;
  }
}

/** JS volume ramp for the `<audio>` element (its volume isn't an AudioParam). */
function rampElementVolume(target: number, seconds: number) {
  clearElFade();
  const el = activeEl;
  if (!el) return;
  const start = el.volume;
  const steps = Math.max(1, Math.round(seconds * 20));
  let i = 0;
  elFadeTimer = window.setInterval(() => {
    i++;
    const t = i / steps;
    el.volume = Math.max(0, Math.min(1, start + (target - start) * t));
    if (i >= steps) clearElFade();
  }, (seconds * 1000) / steps);
}

// ── Public API ─────────────────────────────────────────────────────────────

export const ambientEngine = {
  /** Subscribe to engine state changes. Returns an unsubscribe function. */
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },

  /** Play a sound, replacing whatever is currently playing. */
  play(sound: AmbientSound) {
    void resumeAudioContext();
    const gain = ensureGraph();
    const ctx = getAudioContext();

    if (sound.source === "procedural") {
      stopElements();
      stopProcedural();
      activeEl = null;
      clearElFade();
      gain.gain.cancelScheduledValues(ctx.currentTime);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(volume, ctx.currentTime + 0.3);
      proceduralHandle = startProcedural(ctx, sound.id as ProceduralKind, gain);
      // Procedural never buffers.
      clearBufferingTimer();
      emit({ type: "play" });
      emit({ type: "ready", isBuffering: false });
    } else {
      stopProcedural();
      clearElFade();

      // YouTube provides studio-mastered stereo — bypass filters & spatializers to preserve 100% raw fidelity
      const isRaw = sound.source === "youtube";
      const el = isRaw ? ensureRawAudioEl() : ensureFilteredAudioEl();

      // Pause the other element if active
      if (isRaw && filteredAudioEl) {
        filteredAudioEl.pause();
      } else if (!isRaw && rawAudioEl) {
        rawAudioEl.pause();
      }
      activeEl = el;

      el.loop = sound.loop !== false;
      el.volume = volume;

      if (sound.url) {
        // Only set buffering state if we actually need to load a new URL or don't have enough data yet
        if (el.src === sound.url && el.readyState >= 3) {
          void el.play().catch(() => emit({ type: "error" }));
        } else {
          emit({ type: "buffering", isBuffering: true });
          el.src = sound.url;
          void el.play().catch(() => emit({ type: "error" }));
        }

        // Automatic background pre-caching for online clips (FreeSound / Archive.org)
        // Downloads the file into local storage so future loops have 0ms latency and never buffer mid-audio!
        if (
          isTauri() &&
          (sound.source === "freesound" || sound.source === "archive") &&
          sound.url.startsWith("http")
        ) {
          const currentId = sound.id;
          ipc.cacheAmbientAudio(sound.url, sound.name, sound.source, sound.id)
            .then((localPath) => {
              if (current && current.id === currentId && localPath) {
                sound.url = assetUrl(localPath);
              }
            })
            .catch(() => {});
        }
      }

      // Update Media Session metadata for OS controls / earbuds.
      if ("mediaSession" in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: sound.name,
          artist: sound.attribution || "Ambient Sound",
          album: "Focus Audio",
        });
      }
    }
    current = sound;
  },

  pause() {
    stopProcedural();
    if (activeEl) activeEl.pause();
    clearElFade();
  },

  resume() {
    if (current) this.play(current);
  },

  stop() {
    stopProcedural();
    stopElements();
    clearElFade();
    current = null;
    activeEl = null;
    emit({ type: "ended" });
  },

  setVolume(v: number) {
    volume = Math.max(0, Math.min(1, v));
    if (masterGain) {
      const ctx = getAudioContext();
      masterGain.gain.cancelScheduledValues(ctx.currentTime);
      masterGain.gain.setValueAtTime(volume, ctx.currentTime);
    }
    clearElFade();
    if (rawAudioEl) rawAudioEl.volume = volume;
    if (filteredAudioEl) filteredAudioEl.volume = volume;
  },

  fadeTo(target: number, seconds: number) {
    const t = Math.max(0, Math.min(1, target));
    if (masterGain) {
      const ctx = getAudioContext();
      const now = ctx.currentTime;
      masterGain.gain.cancelScheduledValues(now);
      masterGain.gain.setValueAtTime(masterGain.gain.value, now);
      masterGain.gain.linearRampToValueAtTime(Math.max(0.0001, t), now + seconds);
    }
    rampElementVolume(t, seconds);
  },

  currentSound(): AmbientSound | null {
    return current;
  },

  seek(seconds: number) {
    if (activeEl && Number.isFinite(seconds)) {
      try {
        activeEl.currentTime = Math.max(0, seconds);
      } catch (err) {
        console.warn("[ambientEngine] seek failed:", err);
      }
    }
  },

  /** Get current audio element time info (for initial state on mount). */
  getTimeInfo(): { currentTime: number; duration: number } {
    if (!activeEl) return { currentTime: 0, duration: 0 };
    return {
      currentTime: activeEl.currentTime || 0,
      duration: Number.isFinite(activeEl.duration) ? activeEl.duration : 0,
    };
  },

  /** Apply Studio EQ Tone Profiles (flat, warm, vocal, bass, shield). */
  setToneProfile(profile: AudioToneProfile) {
    applyToneProfile(profile);
  },

  /** Control real-time Binaural Beats Brainwave Generator (off, alpha, beta, theta, gamma). */
  setBinauralBeat(kind: BinauralBeatKind, vol?: number) {
    startBinaural(kind, vol);
  },

  /** Set Binaural Beats volume. */
  setBinauralVolume(vol: number) {
    setBinauralVol(vol);
  },

  /** Smoothly duck or restore ambient audio volume during lectures. */
  setDucked(duck: boolean) {
    setDucking(duck);
  },

  getToneProfile(): AudioToneProfile {
    return currentProfile;
  },

  getIsDucked(): boolean {
    return isDucked;
  },

  getBinauralKind(): BinauralBeatKind {
    return currentBinauralKind;
  },
};

// ── Studio EQ Tone Profiles & Brainwave Entrainment Nodes ─────────────────

let currentProfile: AudioToneProfile = "flat";
let isDucked = false;

function applyToneProfile(profile: AudioToneProfile) {
  currentProfile = profile;
  ensureGraph();
  if (!warmthFilter || !presenceFilter) return;
  const ctx = getAudioContext();
  const now = ctx.currentTime;

  warmthFilter.gain.cancelScheduledValues(now);
  presenceFilter.gain.cancelScheduledValues(now);

  switch (profile) {
    case "flat":
      warmthFilter.gain.linearRampToValueAtTime(0, now + 0.15);
      presenceFilter.gain.linearRampToValueAtTime(0, now + 0.15);
      break;
    case "warm":
      warmthFilter.gain.linearRampToValueAtTime(3.8, now + 0.15);
      presenceFilter.gain.linearRampToValueAtTime(-2.4, now + 0.15);
      break;
    case "vocal":
      warmthFilter.gain.linearRampToValueAtTime(-2.2, now + 0.15);
      presenceFilter.gain.linearRampToValueAtTime(3.2, now + 0.15);
      break;
    case "bass":
      warmthFilter.gain.linearRampToValueAtTime(6.2, now + 0.15);
      presenceFilter.gain.linearRampToValueAtTime(-1.0, now + 0.15);
      break;
    case "shield":
      warmthFilter.gain.linearRampToValueAtTime(-3.5, now + 0.15);
      presenceFilter.gain.linearRampToValueAtTime(-4.2, now + 0.15);
      break;
  }
}

function setDucking(duck: boolean) {
  isDucked = duck;
  const effectiveVol = duck ? volume * 0.3 : volume;
  if (masterGain) {
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    masterGain.gain.cancelScheduledValues(now);
    masterGain.gain.linearRampToValueAtTime(effectiveVol, now + 0.3);
  }
  if (rawAudioEl) rampElementVolume(effectiveVol, 0.3);
  if (filteredAudioEl) rampElementVolume(effectiveVol, 0.3);
}

// ── Pure Binaural Beats Stereo Carrier Oscillators ─────────────────────────

let binauralGain: GainNode | null = null;
let binauralOscL: OscillatorNode | null = null;
let binauralOscR: OscillatorNode | null = null;
let currentBinauralKind: BinauralBeatKind = "off";
let binauralVolume = 0.3;

function stopBinaural() {
  if (binauralOscL) {
    try {
      binauralOscL.stop();
      binauralOscL.disconnect();
    } catch { /* ignore */ }
    binauralOscL = null;
  }
  if (binauralOscR) {
    try {
      binauralOscR.stop();
      binauralOscR.disconnect();
    } catch { /* ignore */ }
    binauralOscR = null;
  }
}

function setBinauralVol(vol: number) {
  binauralVolume = Math.max(0, Math.min(1, vol));
  if (binauralGain) {
    const ctx = getAudioContext();
    binauralGain.gain.cancelScheduledValues(ctx.currentTime);
    binauralGain.gain.setValueAtTime(binauralVolume * 0.15, ctx.currentTime);
  }
}

function startBinaural(kind: BinauralBeatKind, vol?: number) {
  stopBinaural();
  currentBinauralKind = kind;
  if (vol != null) binauralVolume = Math.max(0, Math.min(1, vol));

  if (kind === "off" || binauralVolume <= 0) return;

  const ctx = getAudioContext();
  resumeAudioContext();

  const baseFreq = 216; // Harmonic Pythagorean pitch
  let beatHz = 10;
  if (kind === "alpha") beatHz = 10; // 10Hz: Deep calm study & recall
  else if (kind === "beta") beatHz = 18; // 18Hz: Active problem solving, math/code
  else if (kind === "theta") beatHz = 6; // 6Hz: Creative flow & deep insight
  else if (kind === "gamma") beatHz = 40; // 40Hz: Hyper-focus & maximum memory

  const merger = ctx.createChannelMerger(2);
  if (!binauralGain) {
    binauralGain = ctx.createGain();
    binauralGain.connect(ctx.destination);
  }
  binauralGain.gain.setValueAtTime(binauralVolume * 0.15, ctx.currentTime);

  binauralOscL = ctx.createOscillator();
  binauralOscL.type = "sine";
  binauralOscL.frequency.setValueAtTime(baseFreq - beatHz / 2, ctx.currentTime);
  binauralOscL.connect(merger, 0, 0);

  binauralOscR = ctx.createOscillator();
  binauralOscR.type = "sine";
  binauralOscR.frequency.setValueAtTime(baseFreq + beatHz / 2, ctx.currentTime);
  binauralOscR.connect(merger, 0, 1);

  merger.connect(binauralGain);

  binauralOscL.start();
  binauralOscR.start();
}

