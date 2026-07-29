/**
 * playerBridge — a tiny module-level bridge so player-adjacent UI (the timestamped Notes
 * panel, the mini-player) can read the active video's current time and ask it to seek,
 * without prop-drilling through PlayerPage or coupling to MpvVideoPlayer internals.
 *
 * The active video component registers a getter (`getTime`) + a `seek(secs)` callback on
 * mount and clears them on unmount. Consumers call `playerBridge.now()` /
 * `playerBridge.seek(secs)`. Kept intentionally minimal (no React state) — reading the
 * current time must be cheap and must never trigger re-renders on the 1 Hz tick.
 */

interface PlayerBridge {
  getTime: (() => number) | null;
  seekTo: ((secs: number) => void) | null;
  /** The material currently bound to the bridge (guards stale seeks across switches). */
  materialId: number | null;
}

const bridge: PlayerBridge = { getTime: null, seekTo: null, materialId: null };

export const playerBridge = {
  /** Called by the active player to expose its time getter + seek. */
  register(materialId: number, getTime: () => number, seekTo: (secs: number) => void) {
    bridge.materialId = materialId;
    bridge.getTime = getTime;
    bridge.seekTo = seekTo;
  },
  /** Called on player unmount to clear the binding (only if it still owns it). */
  unregister(materialId: number) {
    if (bridge.materialId === materialId) {
      bridge.materialId = null;
      bridge.getTime = null;
      bridge.seekTo = null;
    }
  },
  /** Current playback position in seconds (0 if no player is bound). */
  now(): number {
    return bridge.getTime ? bridge.getTime() : 0;
  },
  /** Seek the active player, if one is bound. */
  seek(secs: number) {
    bridge.seekTo?.(secs);
  },
  /** Whether a player is currently bound. */
  isBound(): boolean {
    return bridge.getTime != null;
  },
};
