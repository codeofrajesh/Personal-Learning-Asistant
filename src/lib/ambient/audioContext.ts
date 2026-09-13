/**
 * One shared Web Audio `AudioContext` for the whole app.
 *
 * Both the Ambient Sound Hub (procedural generators, master gain) and the HTML5 player's
 * skip-silence analyser need Web Audio. Browsers cap the number of live AudioContexts (and each
 * one costs an audio thread), so everything shares this single lazily-created instance.
 *
 * Autoplay policy: a context created before a user gesture starts `suspended`. Callers that are
 * about to make sound should `await resumeAudioContext()` (safe to call repeatedly); it resolves
 * immediately once running.
 */

let ctx: AudioContext | null = null;

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

/** The shared context, created on first use. */
export function getAudioContext(): AudioContext {
  if (!ctx) {
    const Ctor = window.AudioContext || (window as WebkitWindow).webkitAudioContext;
    ctx = new Ctor();
  }
  return ctx;
}

/** True once a context has been created (so callers can avoid spinning one up just to check). */
export function hasAudioContext(): boolean {
  return ctx !== null;
}

/** Resume the context if the autoplay policy left it suspended. No-op if already running. */
export async function resumeAudioContext(): Promise<void> {
  const c = getAudioContext();
  if (c.state === "suspended") {
    try {
      await c.resume();
    } catch {
      /* a later user gesture will resume it */
    }
  }
}
