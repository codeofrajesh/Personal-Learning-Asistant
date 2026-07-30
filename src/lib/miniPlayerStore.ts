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

/** The docked card's persisted geometry: top-left corner (CSS px) + width. Height is
 *  derived from the width (16:9 video + control strip), so we only persist the width. */
export interface MiniFrame {
  x: number;
  y: number;
  w: number;
}

/** Size + placement bounds for the draggable/resizable card. */
export const MINI_MIN_W = 240;
export const MINI_MAX_W = 640;
export const MINI_DEFAULT_W = 320;
/** Height of the control strip below the 16:9 video (used to derive total card height). */
export const MINI_STRIP_H = 48;
/** Viewport margin used when clamping / placing the default bottom-right position. */
export const MINI_MARGIN = 20;

const FRAME_LS_KEY = "miniPlayer.frame";

/** Total card height for a given width: 16:9 video anchor + the control strip. */
export function miniCardHeight(w: number): number {
  return Math.round((w * 9) / 16) + MINI_STRIP_H;
}

/** Clamp a frame so the whole card stays fully inside the current viewport. */
export function clampFrame(f: MiniFrame): MiniFrame {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 720;
  const w = Math.min(MINI_MAX_W, Math.max(MINI_MIN_W, f.w));
  const h = miniCardHeight(w);
  const x = Math.min(Math.max(MINI_MARGIN, f.x), Math.max(MINI_MARGIN, vw - w - MINI_MARGIN));
  const y = Math.min(Math.max(MINI_MARGIN, f.y), Math.max(MINI_MARGIN, vh - h - MINI_MARGIN));
  return { x, y, w };
}

/** Default bottom-right placement for the current viewport. */
function defaultFrame(): MiniFrame {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 720;
  const w = MINI_DEFAULT_W;
  return {
    x: vw - w - MINI_MARGIN,
    y: vh - miniCardHeight(w) - MINI_MARGIN,
    w,
  };
}

/** Load the persisted frame (clamped to the current viewport), or the default placement. */
function loadFrame(): MiniFrame {
  try {
    const raw = localStorage.getItem(FRAME_LS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<MiniFrame>;
      if (
        typeof p.x === "number" &&
        typeof p.y === "number" &&
        typeof p.w === "number"
      ) {
        return clampFrame({ x: p.x, y: p.y, w: p.w });
      }
    }
  } catch {
    /* ignore malformed / unavailable storage */
  }
  return defaultFrame();
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
  /** The card's persisted position + width (drag/resize target). */
  frame: MiniFrame;

  /** Called by the video player when it loads a file. */
  setActive: (materialId: number, fileName: string) => void;
  /** Called when playback is stopped / the video is unloaded. */
  clear: () => void;
  /** User closed the mini-player. */
  dismiss: () => void;
  setRect: (rect: MiniRect | null) => void;
  /** Commit a new frame after a drag/resize gesture (clamped + persisted). */
  setFrame: (frame: MiniFrame) => void;
}

export const useMiniPlayer = create<MiniPlayerState>((set) => ({
  materialId: null,
  fileName: null,
  active: false,
  dismissed: false,
  rect: null,
  frame: loadFrame(),

  setActive: (materialId, fileName) =>
    set({ materialId, fileName, active: true, dismissed: false }),
  clear: () => set({ materialId: null, fileName: null, active: false, rect: null }),
  dismiss: () => set({ dismissed: true, rect: null }),
  setRect: (rect) => set({ rect }),
  setFrame: (frame) => {
    const clamped = clampFrame(frame);
    try {
      localStorage.setItem(FRAME_LS_KEY, JSON.stringify(clamped));
    } catch {
      /* ignore */
    }
    set({ frame: clamped });
  },
}));
