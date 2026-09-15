/**
 * Skip Silence Mathematical & DSP Helper Functions
 *
 * Provides mathematically exact backtrack calculations, dual-threshold hysteresis,
 * and micro-ramp values to eliminate clipped syllables and audio crackle/pops
 * when transitioning from high skip speeds (e.g. 4.0x) to baseline speeds (e.g. 1.5x).
 */

/**
 * Calculates the exact backtrack delta (in seconds) required when transitioning
 * from skip speed back to baseline speed, compensating for detection pipeline latency
 * and speech onset (attack/breath intake).
 *
 * Formula:
 *   ΔT = τ_latency × max(0, R_skip - R_base) + δ_attack
 *
 * Where:
 *   τ_latency ≈ 0.045s (audio frame buffer + FFT window + IPC/rAF loop delay)
 *   δ_attack  ≈ 0.040s (speech onset breath intake & vocal tract opening margin)
 *
 * @param skipRate Live skip playback rate (e.g. 4.0)
 * @param baselineRate User's baseline playback rate (e.g. 1.5)
 * @param detectorLatencySecs Detection + audio pipeline latency (default: 0.045s)
 * @param speechAttackMarginSecs Speech onset breath/consonant lead-in margin (default: 0.040s)
 * @returns Clamped backtrack delta in seconds [0.0, 0.35s]
 */
export function calculateBacktrackDelta(
  skipRate: number,
  baselineRate: number,
  detectorLatencySecs = 0.045,
  speechAttackMarginSecs = 0.040,
): number {
  const safeSkip = Number.isFinite(skipRate) && skipRate > 0 ? skipRate : 1.0;
  const safeBase = Number.isFinite(baselineRate) && baselineRate > 0 ? baselineRate : 1.0;
  
  // Rate disparity (how much faster we were going than baseline)
  const rateDisparity = Math.max(0, safeSkip - safeBase);
  
  // Content overrun during the detection latency window
  const overrun = detectorLatencySecs * rateDisparity;
  
  // Total backtrack includes the overrun plus the speech onset margin
  const total = overrun + speechAttackMarginSecs;
  
  // Safety clamp: never backtrack less than 0 or more than 350ms
  return Math.min(0.35, Math.max(0, total));
}

/**
 * Calculates the dynamic detection threshold using dual-threshold hysteresis.
 * When skipping at high speed, the threshold is lowered by 7 dB to catch
 * the teacher's breath intake or mouth opening before loud voiced vowels occur.
 *
 * @param baseThresholdDb Configured threshold in dBFS (e.g. -35)
 * @param isSkipping Whether silence skipping is currently active
 * @param hysteresisMarginDb Sensitivity boost when skipping (default: 7 dB)
 * @returns Effective threshold in dBFS
 */
export function calculateHysteresisThreshold(
  baseThresholdDb: number,
  isSkipping: boolean,
  hysteresisMarginDb = 7,
): number {
  return isSkipping ? baseThresholdDb - hysteresisMarginDb : baseThresholdDb;
}

/**
 * Generates an array of intermediate playback rates for a smooth micro-ramp
 * deceleration, preventing time-stretching pitch filters (WSOLA / scaletempo2)
 * from crashing phase buffers and producing static/radio crackles.
 *
 * @param fromRate Starting high speed (e.g. 4.0)
 * @param toRate Target baseline speed (e.g. 1.5)
 * @returns Array of intermediate rates (e.g. [2.75, 1.5])
 */
export function calculateDecelMicroSteps(
  fromRate: number,
  toRate: number,
): number[] {
  const diff = fromRate - toRate;
  if (diff <= 0.5) {
    return [toRate];
  }
  const mid = Math.round(((fromRate + toRate) / 2) * 100) / 100;
  return [mid, toRate];
}

/**
 * Progressive acceleration curve for Skip Silence:
 * When silence begins, playback does not instantly jolt into 4.0x.
 * Short natural speech pauses (0.5s - 0.8s) accelerate gently (1.35x - 1.85x of baseline)
 * so when speech resumes, the pitch filter delta is tiny (<0.5x), preventing needle
 * scratches, radio pop artifacts, clipped syllables, or player stutter.
 * Extended silences (>1.0s) smoothly scale up to full skip speed (3.5x - 4.0x).
 *
 * @param baselineRate Student's listening rate (e.g. 1.5)
 * @param targetSkipRate Configured target skip rate (e.g. 3.0, 3.5, 4.0)
 * @param elapsedSilenceSecs Elapsed duration of the current silence in seconds
 * @returns Playback rate for the current stage of silence
 */
export function calculateProgressiveSkipRate(
  baselineRate: number,
  targetSkipRate: number,
  elapsedSilenceSecs: number,
): number {
  const safeBase = Number.isFinite(baselineRate) && baselineRate > 0 ? baselineRate : 1.0;
  const safeTarget = Number.isFinite(targetSkipRate) && targetSkipRate > 0 ? targetSkipRate : 3.0;

  if (elapsedSilenceSecs <= 0) return safeBase;

  // Phase 1 (0ms - 220ms into skipping): Gentle step (baseline * 1.35, max 2.2x)
  if (elapsedSilenceSecs < 0.22) {
    const stage1 = Math.min(safeTarget, Math.max(safeBase, safeBase * 1.35));
    return Math.round(stage1 * 100) / 100;
  }

  // Phase 2 (220ms - 550ms into skipping): Moderate step (baseline * 1.85, max 2.85x)
  if (elapsedSilenceSecs < 0.55) {
    const stage2 = Math.min(safeTarget, Math.max(safeBase, safeBase * 1.85));
    return Math.round(stage2 * 100) / 100;
  }

  // Phase 3 (550ms+ of sustained silence): Full configured skip speed (e.g. 3.5x - 4.0x)
  return safeTarget;
}

// ── Turbo Skip (Stage 4) — Long Silence Sprint ─────────────────────────────
// When silence extends past 3 full seconds, the system enters "turbo" mode:
// speed jumps to 8× with audio ducked to 10% (faint chalk/ambient sounds).
// When speech resumes, MPV's `lavfi.silence_end` gives the exact stream
// position, and we perform a precision seek-back landing to avoid swallowing
// the first syllable. This seek is tiny (<0.5s), already cached in the demuxer,
// and only fires 5–12 times per hour-long lecture — invisible.

/** Turbo skip speed for long silences (>3s). MPV-only; HTML5 caps at 4×. */
export const TURBO_SKIP_RATE = 8;

/** Delay (ms) after silence starts before turbo engages. Stages 1–3 run first. */
export const TURBO_THRESHOLD_MS = 3000;

/** MPV volume during turbo (0–100 scale). 10% keeps faint chalk/ambient. */
export const TURBO_VOLUME = 10;

/**
 * Determine the seek-back target for precision landing after turbo sprint.
 *
 * At 8× with ~45ms detection latency, the playhead overruns ~330ms past the
 * speech onset before the `silence_end` event arrives. If that overrun exceeds
 * `minOverrunForSeek` (40ms), we compute an exact landing position:
 *
 *   T_target = speechStartPos - attackMarginSecs
 *
 * The 240ms attack margin guarantees the playhead lands safely in pure room silence
 * prior to vocal onset. Soft voiced/unvoiced fricatives ('v', 'th', 'f') have subtle
 * acoustic energy (-35dB to -45dB) that may lag silencedetect triggering by 40-80ms.
 * Landing 240ms before the detected onset captures the full vocal fold opening,
 * breath, and initial consonant without syllable clipping or decoder crackle, while
 * providing MPV's scaletempo2 filter buffer space to align phase before speech begins.
 *
 * Returns `null` when no seek is needed (overrun is negligible).
 *
 * @param currentPos Current stream position in seconds (timePosRef.current)
 * @param speechStartPos Exact position where speech began (lavfi.silence_end)
 * @param attackMarginSecs Breath/consonant lead-in margin before speech (default: 0.24s)
 * @param minOverrunForSeek Minimum overrun (seconds) that justifies a seek (default: 0.04s)
 */
export function calculateTurboLandingTarget(
  currentPos: number,
  speechStartPos: number,
  attackMarginSecs = 0.24,
  minOverrunForSeek = 0.04,
): number | null {
  if (!Number.isFinite(currentPos) || !Number.isFinite(speechStartPos)) return null;
  const overrun = currentPos - speechStartPos;
  if (overrun <= minOverrunForSeek) return null;
  // Land cleanly before speech onset in pure room silence, clamped to 0
  return Math.max(0, speechStartPos - attackMarginSecs);
}


