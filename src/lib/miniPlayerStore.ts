/**
 * miniPlayerStore — tracks the globally-loaded MPV video so an in-app docked mini-player
 * can survive route changes. MPV is already a global singleton (it's never destroyed on
 * unmount), so when the user leaves the player route mid-video we keep it alive and dock a
 * small floating anchor that repositions the MPV surface to a corner.
 *
 * `rect` is the mini-player's live viewport rectangle (CSS px). AppShell reads it to punch
 * a matching transparent notch through the opaque ambient canvas, so the MPV surface shows
 * through the mini card (MPV renders behind the webview; it's only visible through
 * transparent pixels).
 */

import { create } from "zustand";

export interface MiniRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface MiniPlayerState {
  /** The material currently loaded in the global MPV engine (null = none). */
  materialId: number | null;
  fileName: string | null;
  /** True once a video has been loaded into MPV this session. */
  active: boolean;
  /** User explicitly closed the mini-player (suppresses it until a new video loads). */
  dismissed: boolean;
  /** Live rect of the docked mini card, for the ambient-canvas cutout. */
  rect: MiniRect | null;

  /** Called by the video player when it loads a file. */
  setActive: (materialId: number, fileName: string) => void;
  /** Called when playback is stopped / the video is unloaded. */
  clear: () => void;
  /** User closed the mini-player. */
  dismiss: () => void;
  setRect: (rect: MiniRect | null) => void;
}

export const useMiniPlayer = create<MiniPlayerState>((set) => ({
  materialId: null,
  fileName: null,
  active: false,
  dismissed: false,
  rect: null,

  setActive: (materialId, fileName) =>
    set({ materialId, fileName, active: true, dismissed: false }),
  clear: () => set({ materialId: null, fileName: null, active: false, rect: null }),
  dismiss: () => set({ dismissed: true, rect: null }),
  setRect: (rect) => set({ rect }),
}));
