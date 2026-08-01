/**
 * Playback speed — the vocabulary shared by the mpv and HTML5 video paths and the audio player.
 *
 * ## Why this is a module and not two copies
 *
 * The two video engines are wired completely differently (mpv is a native property set over IPC,
 * HTML5 is `media.playbackRate`), but the *rules* about what a speed may be are identical, and they
 * are the part that is easy to get subtly wrong in two places: the clamp bounds, the step size, and
 * how a float renders as a label. Keeping them here means `[` behaves the same on an MKV and an MP4,
 * and the speed a student sets can never be legal in one engine and rejected by the other.
 *
 * ## Why floats need this much care
 *
 * 0.1 is not representable in binary floating point, so stepping naively accumulates error:
 * `1 - 0.1 - 0.1 - 0.1` is 0.7000000000000001, which would render as "0.7000000000000001×" in the
 * UI and, worse, would never compare equal to the 0.75 preset. Every step therefore goes through
 * integer arithmetic on tenths and is snapped with [`quantizeRate`], so the value is always exactly
 * one of 0.1, 0.2, … 4.0 — a clean number to display, to compare, and to hand to mpv.
 *
 * The presets (0.75, 1.25, 1.5) are deliberately NOT on the 0.10 grid. They are kept because they
 * are the speeds people actually reach for, and `quantizeRate` preserves them: it snaps to the
 * nearest hundredth, not the nearest tenth, so a preset survives a round-trip and only *stepping*
 * moves in tenths.
 */

/** Hard floor. Below ~0.25 mpv's audio filter chain stops being intelligible. */
export const MIN_RATE = 0.25;
/** Hard ceiling. Past 4x, audio is unusable and frame dropping makes the video pointless. */
export const MAX_RATE = 4;
/** The granular step the user asked for: `[` / `]` move by exactly this much. */
export const RATE_STEP = 0.1;

/** The quick-pick speeds offered in the menu. Not on the 0.10 grid on purpose — see the header. */
export const SPEED_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/**
 * Snap a rate to a clean two-decimal value inside the legal range.
 *
 * Two decimals rather than one so the presets (0.75, 1.25) survive unchanged while accumulated
 * float error (0.7000000000000001) is removed. Non-finite input falls back to 1: a `NaN` rate would
 * silently freeze mpv's clock, which reads to the student as a frozen video.
 */
export function quantizeRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  const clamped = Math.min(MAX_RATE, Math.max(MIN_RATE, rate));
  return Math.round(clamped * 100) / 100;
}

/**
 * Step a rate by whole tenths, `dir` steps at a time (`+1` = faster, `-1` = slower).
 *
 * The arithmetic is done in integer tenths precisely so repeated presses don't drift: stepping down
 * from 1.0 gives 0.9, 0.8, 0.7 — never 0.7000000000000001. Starting from an off-grid preset the
 * first press lands on the nearest tenth (1.25 → 1.3 going up, 1.2 going down) rather than carrying
 * the odd 0.05 along forever, which is what makes repeated presses feel predictable.
 */
export function stepRate(current: number, dir: 1 | -1): number {
  const tenths = current * 10;
  // Round *away* from the current value in the direction of travel, so a press always moves and an
  // off-grid start snaps onto the grid instead of inheriting its remainder.
  const nextTenths = dir > 0 ? Math.floor(tenths + 1e-6) + 1 : Math.ceil(tenths - 1e-6) - 1;
  return quantizeRate(nextTenths / 10);
}

/**
 * Render a rate for display: `1×`, `1.5×`, `0.85×`.
 *
 * Trailing zeros are dropped so the common speeds stay short — the control bar is dense, and
 * "1.00×" costs two characters to say nothing. The `×` is the caller's to add or omit.
 */
export function formatRate(rate: number): string {
  const q = quantizeRate(rate);
  // toFixed(2) then strip: avoids both "1.1000000000000001" and a bare "1." for whole values.
  return q.toFixed(2).replace(/\.?0+$/, "");
}

/** True when two rates are the same speed, tolerant of float noise (for highlighting a preset). */
export function sameRate(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}
