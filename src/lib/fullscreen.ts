/**
 * fullscreen — a single shared source of truth for the Tauri OS-window fullscreen state.
 *
 * Why this exists: AppShell, PlayerPage, and MpvVideoPlayer each independently registered a
 * `getCurrentWindow().onResized(() => isFullscreen())` listener. A fullscreen transition on
 * Windows emits a *burst* of resize ticks during the DWM animation, so three un-debounced
 * `isFullscreen()` IPC calls fired on every tick — the primary cause of the fullscreen lag.
 *
 * This module registers exactly ONE `onResized` listener (lazily, shared) with a debounce, so
 * the OS-window state is polled once after the transition settles and then fanned out to all
 * subscribers. App-initiated toggles also dispatch a synchronous `app-fullscreen-changed`
 * CustomEvent (see MpvVideoPlayer.toggleFullscreen) so subscribers update instantly without
 * waiting for the resize settle.
 */

import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "./ipc";

type Sub = (fs: boolean) => void;

const subs = new Set<Sub>();
let current = false;
let started = false;
let unlistenResized: (() => void) | null = null;
let debounce: number | undefined;

function emit(fs: boolean) {
  if (fs === current) return;
  current = fs;
  subs.forEach((cb) => {
    try {
      cb(fs);
    } catch {
      /* a bad subscriber must not break the others */
    }
  });
}

async function poll() {
  try {
    emit(await getCurrentWindow().isFullscreen());
  } catch {
    /* ignore */
  }
}

function ensureStarted() {
  if (started || !isTauri()) return;
  started = true;

  // App-initiated toggles broadcast this synchronously → instant, no IPC.
  window.addEventListener("app-fullscreen-changed", (e) => {
    emit(Boolean((e as CustomEvent).detail));
  });

  // OS-initiated fullscreen (title-bar double-click, F11) only shows up as resize ticks.
  // Debounce so we read isFullscreen() ONCE after the transition settles, not per tick.
  getCurrentWindow()
    .onResized(() => {
      if (debounce !== undefined) window.clearTimeout(debounce);
      debounce = window.setTimeout(() => void poll(), 120);
    })
    .then((u) => (unlistenResized = u))
    .catch(() => {});

  void poll();
}

/**
 * Subscribe to fullscreen changes. Invokes `cb` immediately with the current state, then on
 * every change. Returns an unsubscribe function. The underlying window listener is shared
 * across all subscribers and torn down when the last one leaves.
 */
export function subscribeFullscreen(cb: Sub): () => void {
  ensureStarted();
  subs.add(cb);
  // Give the new subscriber the current value right away.
  try {
    cb(current);
  } catch {
    /* ignore */
  }
  return () => {
    subs.delete(cb);
    if (subs.size === 0) {
      unlistenResized?.();
      unlistenResized = null;
      if (debounce !== undefined) window.clearTimeout(debounce);
      started = false;
    }
  };
}
