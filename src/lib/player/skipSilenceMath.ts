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
