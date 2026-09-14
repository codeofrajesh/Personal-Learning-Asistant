/**
 * Skip Silence — the engine-agnostic pacing policy shared by the mpv and HTML5 video paths.
 *
 * ## What it does
 * When the audio goes quiet for longer than a threshold (an instructor writing on the board,
 * flipping a slide), playback speeds up; the moment speech resumes it snaps back to the user's
 * chosen speed. This hook owns the *policy* (settings, which speed to use, the HUD state) but NOT
 * the mechanism: each player injects `enterSkip(targetSpeed)` / `exitSkip()` that actually move
 * its engine (mpv `speed` property, or `<video>.playbackRate`) and detection differs per engine
 * (mpv's `silencedetect` filter metadata vs. a Web Audio analyser). Keeping the rules here means
 * the two engines behave identically and the delicate parts stay in one place.
 *
 * ## Why watch-time needs no special handling
 * Both players bill study time in WALL-CLOCK seconds, never content-time. Playing 9 s of silence
 * at 3× costs ~3 real seconds and bills ~3 — automatically honest. This hook never seeks, so it
 * can't skip billable time; it only changes speed.
 *
 * ## Stable identity (important)
 * The mpv player binds its property listener ONCE (empty deps) to avoid stale-closure bugs during
 * rapid video switches. So every value this hook hands back that is read from inside that listener
 * — `onSilenceStart`, `onSilenceEnd`, `resetSkip`, `toggleEnabled`, `skipActiveRef` — has a STABLE
 * identity and reads live settings through a ref. Only `settings` (for rendering the menu) and
 * `hud` (for rendering the indicator) are React state.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ipc, isTauri } from "../../lib/ipc";
import { MAX_RATE, quantizeRate } from "../../lib/playbackRate";

export type SkipSilenceMode = "smooth" | "instant";

export interface SkipSilenceSettings {
  /** Master on/off. */
  enabled: boolean;
  /** `smooth` = user-chosen skip speed (audio stays intelligible); `instant` = max speed, feels
   *  like a jump. */
  mode: SkipSilenceMode;
  /** Silence threshold in dBFS: quieter than this counts as silence. −40 (quiet room) …
   *  −25 (noisy room). */
  thresholdDb: number;
  /** How long the audio must stay quiet before skipping kicks in (seconds). */
  minSilenceSecs: number;
  /** Target speed for `smooth` mode (2.5 / 3.0 / 3.5). `instant` uses the 4× ceiling. */
  skipSpeed: number;
}

export const SKIP_DEFAULTS: SkipSilenceSettings = {
  enabled: false,
  mode: "smooth",
  thresholdDb: -35,
  minSilenceSecs: 0.5,
  skipSpeed: 3.0,
};

export const SKIP_SPEED_OPTIONS = [2.5, 3.0, 3.5] as const;
export const MIN_SILENCE_OPTIONS = [0.5, 1.0, 1.5] as const;
/** Threshold slider bounds (dBFS). */
export const THRESHOLD_MIN = -40;
export const THRESHOLD_MAX = -25;

/** Instant mode uses the hard speed ceiling so silence is traversed as fast as is safe without
 *  overshooting the start of speech (event round-trip latency × speed). */
const INSTANT_SPEED = MAX_RATE; // 4×

const LS_KEY = "ple.player.skipSilence";
const SETTING_KEYS: Record<keyof SkipSilenceSettings, string> = {
  enabled: "player.skip_silence_enabled",
  mode: "player.skip_silence_mode",
  thresholdDb: "player.skip_silence_threshold",
  minSilenceSecs: "player.skip_silence_min",
  skipSpeed: "player.skip_silence_speed",
};

function readLocal(): SkipSilenceSettings {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return SKIP_DEFAULTS;
    const parsed = JSON.parse(raw);
    return { ...SKIP_DEFAULTS, ...parsed };
  } catch {
    return SKIP_DEFAULTS;
  }
}

/** Coerce a raw setting string into the right shape, ignoring anything malformed. */
function coerce(key: keyof SkipSilenceSettings, raw: string): Partial<SkipSilenceSettings> {
  switch (key) {
    case "enabled":
      return { enabled: raw === "true" };
    case "mode":
      return raw === "instant" || raw === "smooth" ? { mode: raw } : {};
    case "thresholdDb": {
      const n = Number(raw);
      return Number.isFinite(n) ? { thresholdDb: n } : {};
    }
    case "minSilenceSecs": {
      const n = Number(raw);
      return Number.isFinite(n) ? { minSilenceSecs: n } : {};
    }
    case "skipSpeed": {
      const n = Number(raw);
      return Number.isFinite(n) ? { skipSpeed: n } : {};
    }
  }
}

export interface SkipExitMeta {
  /** Timestamp in stream seconds where speech resumed (e.g. from MPV's lavfi.silence_end). */
  speechStartTime?: number;
  /** Active skip speed that was in effect before exiting (e.g. 4.0). */
  skipSpeed: number;
}

export interface SkipController {
  /** Set the engine's live speed to `targetSpeed` (the player snapshots the user's baseline). */
  enterSkip: (targetSpeed: number) => void;
  /** Restore the engine to the user's baseline speed, with optional speech onset and skip rate metadata. */
  exitSkip: (meta?: SkipExitMeta) => void;
}

export interface UseSkipSilence {
  settings: SkipSilenceSettings;
  updateSettings: (patch: Partial<SkipSilenceSettings>) => void;
  toggleEnabled: () => void;
  /** True while a skip is currently in effect — the player's speed observer reads this to keep
   *  the control bar showing the user's baseline instead of the transient skip speed. */
  skipActiveRef: React.MutableRefObject<boolean>;
  /** Rendered indicator state. */
  hud: { active: boolean; speed: number };
  /** Called by the player when the audio has gone quiet past the threshold. */
  onSilenceStart: () => void;
  /** Called by the player when speech resumes. Optionally takes speech onset timestamp in seconds. */
  onSilenceEnd: (speechStartTime?: number | string) => void;
  /** End any active skip immediately (pause, seek, disable, unmount). */
  resetSkip: (speechStartTime?: number | string) => void;
}

/**
 * @param controller player-supplied hooks that actually move the engine.
 */
export function useSkipSilence(controller: SkipController): UseSkipSilence {
  const [settings, setSettings] = useState<SkipSilenceSettings>(readLocal);
  const [hud, setHud] = useState({ active: false, speed: 1 });

  // Live mirrors for the once-bound player listener (see file header).
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const skipActiveRef = useRef(false);
  const currentSkipSpeedRef = useRef(1);

  // Hydrate from the DB (source of truth) once, correcting the localStorage snapshot.
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        (Object.keys(SETTING_KEYS) as (keyof SkipSilenceSettings)[]).map(async (k) => {
          const v = await ipc.getSetting(SETTING_KEYS[k]).catch(() => null);
          return v == null ? {} : coerce(k, v);
        }),
      );
      if (cancelled) return;
      const merged = entries.reduce((acc, patch) => ({ ...acc, ...patch }), {} as Partial<SkipSilenceSettings>);
      setSettings((prev) => ({ ...prev, ...merged }));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback((next: SkipSilenceSettings, changed: (keyof SkipSilenceSettings)[]) => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(next));
    } catch {
      /* ignore quota */
    }
    if (!isTauri()) return;
    for (const k of changed) {
      void ipc.setSetting(SETTING_KEYS[k], String(next[k])).catch(() => {});
    }
  }, []);

  const resetSkip = useCallback((speechStartTime?: number | string) => {
    if (!skipActiveRef.current) return;
    skipActiveRef.current = false;
    const speed = currentSkipSpeedRef.current;
    setHud({ active: false, speed: 1 });
    let parsedStart: number | undefined;
    if (typeof speechStartTime === "number" && Number.isFinite(speechStartTime)) {
      parsedStart = speechStartTime;
    } else if (typeof speechStartTime === "string") {
      const n = parseFloat(speechStartTime);
      if (Number.isFinite(n)) parsedStart = n;
    }
    controllerRef.current.exitSkip({
      speechStartTime: parsedStart,
      skipSpeed: speed,
    });
  }, []);

  const updateSettings = useCallback(
    (patch: Partial<SkipSilenceSettings>) => {
      setSettings((prev) => {
        const next = { ...prev, ...patch };
        const changed = (Object.keys(patch) as (keyof SkipSilenceSettings)[]).filter(
          (k) => prev[k] !== next[k],
        );
        if (changed.length) persist(next, changed);
        return next;
      });
      // Turning the feature off (or retuning it) must not leave the engine stuck at skip speed.
      if (patch.enabled === false) resetSkip();
    },
    [persist, resetSkip],
  );

  const toggleEnabled = useCallback(() => {
    updateSettings({ enabled: !settingsRef.current.enabled });
  }, [updateSettings]);

  const onSilenceStart = useCallback(() => {
    const s = settingsRef.current;
    if (!s.enabled || skipActiveRef.current) return;
    const target = quantizeRate(s.mode === "instant" ? INSTANT_SPEED : s.skipSpeed);
    skipActiveRef.current = true; // set BEFORE the engine call so the speed echo is guarded
    currentSkipSpeedRef.current = target;
    setHud({ active: true, speed: target });
    controllerRef.current.enterSkip(target);
  }, []);

  const onSilenceEnd = useCallback((speechStartTime?: number | string) => {
    resetSkip(speechStartTime);
  }, [resetSkip]);

  return {
    settings,
    updateSettings,
    toggleEnabled,
    skipActiveRef,
    hud,
    onSilenceStart,
    onSilenceEnd,
    resetSkip,
  };
}
