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
import { quantizeRate } from "../../lib/playbackRate";
import {
  calculateProgressiveSkipRate,
  TURBO_SKIP_RATE,
  TURBO_THRESHOLD_MS,
} from "../../lib/player/skipSilenceMath";

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

export const SKIP_SPEED_OPTIONS = [2.5, 3.0, 3.5, 4.0, 5.0, 6.0] as const;
export const MIN_SILENCE_OPTIONS = [0.3, 0.5, 1.0, 1.5] as const;
/** Threshold slider bounds (dBFS). */
export const THRESHOLD_MIN = -40;
export const THRESHOLD_MAX = -25;

/** Instant mode uses the 4× speed ceiling so silence is traversed quickly without overshooting. */
const INSTANT_SPEED = 4;

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
  /** True when exiting from turbo sprint (Stage 4). The player uses this to trigger
   *  seek-back + volume restore instead of the normal micro-ramp decel. */
  wasTurbo?: boolean;
}

export interface SkipController {
  /** Set the engine's live speed to `targetSpeed` (the player snapshots the user's baseline). */
  enterSkip: (targetSpeed: number) => void;
  /** Engage turbo sprint: speed 8× + volume to 10%. MPV-only; HTML5 should not provide this. */
  enterTurbo?: (turboSpeed: number) => void;
  /** Restore the engine to the user's baseline speed, with optional speech onset and skip rate metadata. */
  exitSkip: (meta?: SkipExitMeta) => void;
  /** Returns the player's current baseline listening rate (e.g. 1.5). */
  getBaselineRate?: () => number;
}

export interface SkipHud {
  /** Whether any skip (normal or turbo) is currently active. */
  active: boolean;
  /** Current skip speed being applied. */
  speed: number;
  /** Whether turbo sprint (Stage 4) is active. */
  turbo: boolean;
  /** Wall-clock seconds elapsed since this silence began (updated every 1s during turbo). */
  elapsedSilenceSecs: number;
}

export interface UseSkipSilence {
  settings: SkipSilenceSettings;
  updateSettings: (patch: Partial<SkipSilenceSettings>) => void;
  toggleEnabled: () => void;
  /** True while a skip is currently in effect — the player's speed observer reads this to keep
   *  the control bar showing the user's baseline instead of the transient skip speed. */
  skipActiveRef: React.MutableRefObject<boolean>;
  /** Rendered indicator state. */
  hud: SkipHud;
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
  const [hud, setHud] = useState<SkipHud>({ active: false, speed: 1, turbo: false, elapsedSilenceSecs: 0 });

  // Live mirrors for the once-bound player listener (see file header).
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const skipActiveRef = useRef(false);
  const exitingRef = useRef(false); // Guards against re-entry during 30ms decel window
  const currentSkipSpeedRef = useRef(1);
  const rampTimersRef = useRef<number[]>([]);
  /** True while turbo sprint (Stage 4) is active — read by resetSkip to pass wasTurbo to exitSkip. */
  const turboActiveRef = useRef(false);
  /** Wall-clock timestamp (performance.now) when the current silence began. For elapsed counter. */
  const silenceWallStartRef = useRef(0);
  /** Interval ID for the elapsed silence counter during turbo. */
  const elapsedIntervalRef = useRef<number | null>(null);

  // Cleanup pending ramp timers + elapsed interval on unmount
  useEffect(() => {
    return () => {
      rampTimersRef.current.forEach((id) => window.clearTimeout(id));
      rampTimersRef.current = [];
      if (elapsedIntervalRef.current != null) {
        window.clearInterval(elapsedIntervalRef.current);
        elapsedIntervalRef.current = null;
      }
    };
  }, []);

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

  /** Stop the turbo elapsed-time counter interval. */
  const stopElapsedCounter = useCallback(() => {
    if (elapsedIntervalRef.current != null) {
      window.clearInterval(elapsedIntervalRef.current);
      elapsedIntervalRef.current = null;
    }
  }, []);

  /** Start a 1-second interval that updates the HUD's elapsed silence counter during turbo. */
  const startElapsedCounter = useCallback(() => {
    stopElapsedCounter();
    elapsedIntervalRef.current = window.setInterval(() => {
      if (!turboActiveRef.current || !skipActiveRef.current) {
        stopElapsedCounter();
        return;
      }
      const elapsed = Math.floor((performance.now() - silenceWallStartRef.current) / 1000);
      setHud((prev) => ({ ...prev, elapsedSilenceSecs: elapsed }));
    }, 1000);
  }, [stopElapsedCounter]);

  const resetSkip = useCallback((speechStartTime?: number | string) => {
    rampTimersRef.current.forEach((id) => window.clearTimeout(id));
    rampTimersRef.current = [];
    stopElapsedCounter();

    if (!skipActiveRef.current || exitingRef.current) return;
    // Mark as exiting to prevent re-entry during the decel window.
    // The rAF loop (HTML5) or MPV metadata handler may call onSilenceEnd again while
    // skipActiveRef is still true during the 30ms decel — this flag blocks that.
    exitingRef.current = true;
    const speed = currentSkipSpeedRef.current;
    const wasTurbo = turboActiveRef.current;
    turboActiveRef.current = false;
    setHud({ active: false, speed: 1, turbo: false, elapsedSilenceSecs: 0 });
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
      wasTurbo,
    });
    // Clear both flags AFTER the decel micro-ramp has fully completed (~22ms).
    // Turbo exits use seek instead of micro-ramp, but 30ms is safe for both paths.
    // This ensures the MPV speed property handler ignores ALL transient decel values.
    window.setTimeout(() => {
      skipActiveRef.current = false;
      exitingRef.current = false;
    }, 30);
  }, [stopElapsedCounter]);

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
    rampTimersRef.current.forEach((id) => window.clearTimeout(id));
    rampTimersRef.current = [];

    const s = settingsRef.current;
    if (!s.enabled || skipActiveRef.current) return;
    skipActiveRef.current = true;
    silenceWallStartRef.current = performance.now();

    const baseRate = controllerRef.current.getBaselineRate?.() ?? 1.0;
    const finalTarget = quantizeRate(s.mode === "instant" ? INSTANT_SPEED : s.skipSpeed);

    if (s.mode === "instant") {
      // ── Instant Mode: Jump straight to 4× without progressive ramp-up delay ──
      currentSkipSpeedRef.current = finalTarget;
      setHud({ active: true, speed: finalTarget, turbo: false, elapsedSilenceSecs: 0 });
      controllerRef.current.enterSkip(finalTarget);
    } else {
      // ── Smooth Mode: Progressive Acceleration Curve (Stages 1 → 2 → 3) ──
      // Instead of violently jumping from 1.5x to 4.0x on a brief 0.5s pause, we accelerate
      // progressively across 3 smooth stages:
      // Stage 1 (0ms - 220ms): Gentle acceleration (e.g. 1.35x baseline, max 2.2x).
      //   If the teacher speaks quickly, disparity is tiny, eliminating stutter and clipped words.
      // Stage 2 (+220ms): Moderate acceleration (e.g. 1.85x baseline, max 2.85x).
      // Stage 3 (+550ms): Full configured skip rate (e.g. 3.5x - 4.0x) for extended silences.
      const stage1 = quantizeRate(calculateProgressiveSkipRate(baseRate, finalTarget, 0.05));
      currentSkipSpeedRef.current = stage1;
      setHud({ active: true, speed: stage1, turbo: false, elapsedSilenceSecs: 0 });
      controllerRef.current.enterSkip(stage1);

      const t1 = window.setTimeout(() => {
        if (!skipActiveRef.current) return;
        const stage2 = quantizeRate(calculateProgressiveSkipRate(baseRate, finalTarget, 0.35));
        currentSkipSpeedRef.current = stage2;
        setHud({ active: true, speed: stage2, turbo: false, elapsedSilenceSecs: 0 });
        controllerRef.current.enterSkip(stage2);
      }, 220);

      const t2 = window.setTimeout(() => {
        if (!skipActiveRef.current) return;
        currentSkipSpeedRef.current = finalTarget;
        setHud({ active: true, speed: finalTarget, turbo: false, elapsedSilenceSecs: 0 });
        controllerRef.current.enterSkip(finalTarget);
      }, 550);

      rampTimersRef.current.push(t1, t2);
    }

    // ── Stage 4: Turbo Sprint (MPV only) ──
    // After 3 full seconds of sustained silence, this is a blackboard/slide/water break.
    // Jump to 8× with audio ducked to 10% (faint chalk sounds). When speech resumes,
    // the exitSkip path performs a precision seek-back landing using lavfi.silence_end.
    // Only fires if the controller provides `enterTurbo` (MPV path); HTML5 skips this.
    const t3 = window.setTimeout(() => {
      if (!skipActiveRef.current || turboActiveRef.current) return;
      const ctrl = controllerRef.current;
      if (!ctrl.enterTurbo) return; // HTML5 path — no turbo support

      turboActiveRef.current = true;
      currentSkipSpeedRef.current = TURBO_SKIP_RATE;
      const elapsed = Math.floor((performance.now() - silenceWallStartRef.current) / 1000);
      setHud({ active: true, speed: TURBO_SKIP_RATE, turbo: true, elapsedSilenceSecs: elapsed });
      ctrl.enterTurbo(TURBO_SKIP_RATE);
      // Start the elapsed counter so the HUD ticks every second
      startElapsedCounter();
    }, TURBO_THRESHOLD_MS);

    rampTimersRef.current.push(t3);
  }, [startElapsedCounter]);

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
