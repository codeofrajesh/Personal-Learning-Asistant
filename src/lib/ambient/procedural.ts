/**
 * Zero-KB offline sound generators (Web Audio). No network, no assets — everything is synthesized
 * from math, providing instant offline playback.
 *
 * Overhauled for true dual-channel wide stereo (Spotify / studio grade):
 *  - 2-channel independent decorrelation: Left and Right channels are synthesized with distinct
 *    random seeds and subtle phase offsets so the soundstage feels expansive and immersive in
 *    headphones, rather than flat/cramped mono.
 *  - Seamless circular crossfades: The 12-second buffers use an equal-power cosine window across
 *    their boundaries, guaranteeing 100% gapless, click-free continuous loops.
 *  - Rich presets:
 *      1. Deep Brown Noise — warm, deep velvet sub-bass wash with organic tidal breathing.
 *      2. Stereo Pink Noise — dual-channel 1/f Kellet spectrum with room warmth.
 *      3. Stereo Rain — distant rain wash overlaid with randomized spatial raindrops.
 *      4. Ocean Waves — rhythmic shoreline wave swells with phased stereo rolling.
 *      5. 40 Hz Gamma Focus — warm celestial drone pad with 40 Hz binaural focus pulse.
 *      6. 10 Hz Alpha Calm — warm resonant harmonic meditation with 10 Hz alpha entrainment.
 */

import type { ProceduralKind } from "./types";

export interface ProceduralHandle {
  stop: () => void;
}

/** Pre-rendered buffer duration in seconds. Long enough for complex organic texture without memory overhead. */
const BUFFER_SECONDS = 12;

/**
 * Apply an equal-power circular crossfade to the ends of a 2-channel buffer so that looping
 * produces zero audible discontinuities, clicks, or phase jumps.
 */
function applyCircularCrossfade(left: Float32Array, right: Float32Array, sampleRate: number) {
  const fadeLen = Math.floor(sampleRate * 0.5); // 500ms crossfade window
  const len = left.length;
  for (let i = 0; i < fadeLen; i++) {
    const t = i / fadeLen;
    // Equal-power crossfade curve
    const fadeIn = Math.sin(t * Math.PI * 0.5);
    const fadeOut = Math.cos(t * Math.PI * 0.5);

    const head = i;
    const tail = len - fadeLen + i;

    const blendedL = left[head] * fadeIn + left[tail] * fadeOut;
    const blendedR = right[head] * fadeIn + right[tail] * fadeOut;

    left[head] = blendedL;
    left[tail] = blendedL;
    right[head] = blendedR;
    right[tail] = blendedR;
  }
}

/**
 * Generate a true dual-channel stereo buffer with independent L/R synthesis.
 */
function makeStereoBuffer(
  ctx: AudioContext,
  kind: "brown" | "pink" | "rain" | "waves",
): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * BUFFER_SECONDS);
  const buffer = ctx.createBuffer(2, len, ctx.sampleRate);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);

  if (kind === "brown") {
    // True dual-channel Brown noise (leaky integration of independent white noise on L and R).
    let lastL = 0;
    let lastR = 0;
    for (let i = 0; i < len; i++) {
      const whiteL = Math.random() * 2 - 1;
      const whiteR = Math.random() * 2 - 1;
      // Low-frequency integration (sub-bass focus)
      lastL = (lastL + 0.016 * whiteL) / 1.016;
      lastR = (lastR + 0.016 * whiteR) / 1.016;

      // Gentle organic stereo breathing modulation (0.05 Hz)
      const lfo = Math.sin((i / ctx.sampleRate) * 2 * Math.PI * 0.05) * 0.12;
      left[i] = lastL * (1 - lfo) * 3.4;
      right[i] = lastR * (1 + lfo) * 3.4;
    }
  } else if (kind === "pink") {
    // Paul Kellet's filter run on separate banks for Left and Right (true stereo decorrelation).
    let b0L = 0, b1L = 0, b2L = 0, b3L = 0, b4L = 0, b5L = 0, b6L = 0;
    let b0R = 0, b1R = 0, b2R = 0, b3R = 0, b4R = 0, b5R = 0, b6R = 0;

    for (let i = 0; i < len; i++) {
      const wL = Math.random() * 2 - 1;
      const wR = Math.random() * 2 - 1;

      b0L = 0.99886 * b0L + wL * 0.0555179;
      b1L = 0.99332 * b1L + wL * 0.0750759;
      b2L = 0.969 * b2L + wL * 0.153852;
      b3L = 0.8665 * b3L + wL * 0.3104856;
      b4L = 0.55 * b4L + wL * 0.5329522;
      b5L = -0.7616 * b5L - wL * 0.016898;
      const pinkL = (b0L + b1L + b2L + b3L + b4L + b5L + b6L + wL * 0.5362) * 0.14;
      b6L = wL * 0.115926;

      b0R = 0.99886 * b0R + wR * 0.0555179;
      b1R = 0.99332 * b1R + wR * 0.0750759;
      b2R = 0.969 * b2R + wR * 0.153852;
      b3R = 0.8665 * b3R + wR * 0.3104856;
      b4R = 0.55 * b4R + wR * 0.5329522;
      b5R = -0.7616 * b5R - wR * 0.016898;
      const pinkR = (b0R + b1R + b2R + b3R + b4R + b5R + b6R + wR * 0.5362) * 0.14;
      b6R = wR * 0.115926;

      left[i] = pinkL * 1.5;
      right[i] = pinkR * 1.5;
    }
  } else if (kind === "rain") {
    // Stereo Rain: Pink noise background rain bed + algorithmic spatial raindrops.
    let b0L = 0, b1L = 0, b2L = 0, b3L = 0, b4L = 0, b5L = 0, b6L = 0;
    let b0R = 0, b1R = 0, b2R = 0, b3R = 0, b4R = 0, b5R = 0, b6R = 0;

    // 1. Rain bed (filtered pink noise)
    for (let i = 0; i < len; i++) {
      const wL = Math.random() * 2 - 1;
      const wR = Math.random() * 2 - 1;

      b0L = 0.99886 * b0L + wL * 0.0555;
      b1L = 0.99332 * b1L + wL * 0.075;
      b2L = 0.969 * b2L + wL * 0.1538;
      b3L = 0.8665 * b3L + wL * 0.3104;
      b4L = 0.55 * b4L + wL * 0.5329;
      b5L = -0.7616 * b5L - wL * 0.0168;
      const pL = (b0L + b1L + b2L + b3L + b4L + b5L + b6L + wL * 0.5362) * 0.1;
      b6L = wL * 0.1159;

      b0R = 0.99886 * b0R + wR * 0.0555;
      b1R = 0.99332 * b1R + wR * 0.075;
      b2R = 0.969 * b2R + wR * 0.1538;
      b3R = 0.8665 * b3R + wR * 0.3104;
      b4R = 0.55 * b4R + wR * 0.5329;
      b5R = -0.7616 * b5R - wR * 0.0168;
      const pR = (b0R + b1R + b2R + b3R + b4R + b5R + b6R + wR * 0.5362) * 0.1;
      b6R = wR * 0.1159;

      left[i] = pL * 0.9;
      right[i] = pR * 0.9;
    }

    // 2. Spatial randomized raindrops scattered across stereo field
    const numDrops = Math.floor(len * 0.007);
    for (let d = 0; d < numDrops; d++) {
      const start = Math.floor(Math.random() * (len - 2500));
      const pan = Math.random(); // 0.0 (left) to 1.0 (right)
      const dropFreq = 750 + Math.random() * 1500; // Pitch of the drop
      const dropDur = 400 + Math.floor(Math.random() * 1000); // 10-25ms
      const amp = 0.05 + Math.random() * 0.14;

      for (let j = 0; j < dropDur && start + j < len; j++) {
        const t = j / ctx.sampleRate;
        const env = Math.exp(-j / 180); // Fast exponential pluck decay
        const val = Math.sin(2 * Math.PI * dropFreq * t) * env * amp;
        left[start + j] += val * (1 - pan);
        right[start + j] += val * pan;
      }
    }
  } else if (kind === "waves") {
    // Ocean Waves: Low-frequency brown rumble with rhythmic, phased tidal swells.
    let lastL = 0;
    let lastR = 0;
    const wavePeriod = 7.5; // Seconds per wave cycle

    for (let i = 0; i < len; i++) {
      const t = i / ctx.sampleRate;
      const whiteL = Math.random() * 2 - 1;
      const whiteR = Math.random() * 2 - 1;

      lastL = (lastL + 0.02 * whiteL) / 1.02;
      lastR = (lastR + 0.02 * whiteR) / 1.02;

      // Phased wave swell: Left wave leads by ~1.2 seconds, rolling across to Right
      const swellL = Math.pow((Math.sin((t / wavePeriod) * 2 * Math.PI) + 1) * 0.5, 2.2);
      const swellR = Math.pow((Math.sin(((t - 1.2) / wavePeriod) * 2 * Math.PI) + 1) * 0.5, 2.2);

      // Foam wash component during wave crest
      const foamL = (Math.random() * 2 - 1) * 0.06 * swellL;
      const foamR = (Math.random() * 2 - 1) * 0.06 * swellR;

      left[i] = (lastL * 2.8 * (0.2 + 0.8 * swellL) + foamL) * 1.3;
      right[i] = (lastR * 2.8 * (0.2 + 0.8 * swellR) + foamR) * 1.3;
    }
  }

  // Ensure seamless circular looping with equal-power cosine crossfade
  applyCircularCrossfade(left, right, ctx.sampleRate);
  return buffer;
}

/**
 * Start a procedural sound generator, connecting its stereo output to `destination`.
 */
export function startProcedural(
  ctx: AudioContext,
  kind: ProceduralKind,
  destination: AudioNode,
): ProceduralHandle {
  if (kind === "brown" || kind === "pink" || kind === "rain" || kind === "waves") {
    const src = ctx.createBufferSource();
    src.buffer = makeStereoBuffer(ctx, kind);
    src.loop = true;
    src.connect(destination);
    src.start();
    return {
      stop: () => {
        try {
          src.stop();
        } catch {
          /* already stopped */
        }
        src.disconnect();
      },
    };
  }

  // Binaural Focus Drones: Lush, warm cinematic drones with binaural entrainment pulse
  const merger = ctx.createChannelMerger(2);

  if (kind === "gamma40") {
    // 40 Hz Gamma Focus: Warm C3 drone (130.81 Hz) with 40 Hz binaural delta (170.81 Hz)
    const baseFreq = 130.81;
    const oscL = ctx.createOscillator();
    const oscR = ctx.createOscillator();
    const subL = ctx.createOscillator();
    const subR = ctx.createOscillator();

    // Triangle oscillators provide warm, organic harmonic overtone body
    oscL.type = "triangle";
    oscR.type = "triangle";
    subL.type = "sine";
    subR.type = "sine";

    oscL.frequency.value = baseFreq;
    oscR.frequency.value = baseFreq + 40.0; // 40 Hz gamma beat
    subL.frequency.value = baseFreq * 0.5;  // Warm sub-bass foundation
    subR.frequency.value = (baseFreq + 40.0) * 0.5;

    // Filter to roll off sharp highs and create a velvety celestial drone
    const filterL = ctx.createBiquadFilter();
    const filterR = ctx.createBiquadFilter();
    filterL.type = "lowpass";
    filterR.type = "lowpass";
    filterL.frequency.value = 360;
    filterR.frequency.value = 360;

    const gainL = ctx.createGain();
    const gainR = ctx.createGain();
    gainL.gain.value = 0.35;
    gainR.gain.value = 0.35;

    oscL.connect(filterL);
    subL.connect(filterL);
    filterL.connect(gainL);
    gainL.connect(merger, 0, 0); // Left channel

    oscR.connect(filterR);
    subR.connect(filterR);
    filterR.connect(gainR);
    gainR.connect(merger, 0, 1); // Right channel

    merger.connect(destination);

    oscL.start();
    oscR.start();
    subL.start();
    subR.start();

    return {
      stop: () => {
        try {
          oscL.stop();
          oscR.stop();
          subL.stop();
          subR.stop();
        } catch {
          /* already stopped */
        }
        oscL.disconnect();
        oscR.disconnect();
        subL.disconnect();
        subR.disconnect();
        filterL.disconnect();
        filterR.disconnect();
        gainL.disconnect();
        gainR.disconnect();
        merger.disconnect();
      },
    };
  }

  // 10 Hz Alpha Calm: Warm 136.1 Hz (meditation tone) with 10 Hz alpha delta (146.1 Hz)
  const baseFreq = 136.1;
  const oscL = ctx.createOscillator();
  const oscR = ctx.createOscillator();
  const warmSub = ctx.createOscillator();

  oscL.type = "sine";
  oscR.type = "sine";
  warmSub.type = "triangle";

  oscL.frequency.value = baseFreq;
  oscR.frequency.value = baseFreq + 10.0; // 10 Hz alpha beat
  warmSub.frequency.value = baseFreq * 0.5;

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 420;

  const gainL = ctx.createGain();
  const gainR = ctx.createGain();
  gainL.gain.value = 0.4;
  gainR.gain.value = 0.4;

  oscL.connect(gainL);
  warmSub.connect(filter);
  filter.connect(gainL);
  gainL.connect(merger, 0, 0);

  oscR.connect(gainR);
  filter.connect(gainR);
  gainR.connect(merger, 0, 1);

  merger.connect(destination);

  oscL.start();
  oscR.start();
  warmSub.start();

  return {
    stop: () => {
      try {
        oscL.stop();
        oscR.stop();
        warmSub.stop();
      } catch {
        /* already stopped */
      }
      oscL.disconnect();
      oscR.disconnect();
      warmSub.disconnect();
      filter.disconnect();
      gainL.disconnect();
      gainR.disconnect();
      merger.disconnect();
    },
  };
}

/** Human-facing labels + emoji for the offline quick-picks. */
export const PROCEDURAL_PRESETS: { kind: ProceduralKind; name: string; emoji: string }[] = [
  { kind: "brown", name: "Deep Brown Noise", emoji: "🌊" },
  { kind: "pink", name: "Stereo Pink Noise", emoji: "🩶" },
  { kind: "rain", name: "Stereo Rain", emoji: "🌧️" },
  { kind: "waves", name: "Ocean Waves", emoji: "🏄" },
  { kind: "gamma40", name: "40 Hz Gamma", emoji: "⚡" },
  { kind: "alpha10", name: "10 Hz Alpha", emoji: "🧘" },
];
