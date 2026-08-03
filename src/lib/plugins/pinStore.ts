/**
 * pinStore — persisted plugin pin/enable state.
 *
 * A plugin's presence in the PRIMARY sidebar nav is a preference, not a constant.
 * This store reads/writes the DB `settings` table via `ipc.getSetting`/`setSetting`
 * (keys `plugins.<id>.pinned`), mirrors perfStore's optimistic-write pattern, and hydrates
 * once on boot. Until hydrated, `isPinned` falls back to `defaultPinned`.
 *
 * Convention: `pinned === true` means "show in the primary nav". "Enabled" is a separate
 * future concept (Phase 3+); Phase 1 only surfaces pinning, since a plugin cannot harm
 * anything just by being listed (all its real capabilities are backend-gated later).
 */

import { create } from "zustand";
import { ipc, isTauri } from "../ipc";
import type { PluginManifest } from "./types";
import { getPlugins } from "./registry";

/** `plugins.<id>.pinned` setting key. */
export function pinKey(id: string): string {
  return `plugins.${id}.pinned`;
}

interface PinState {
  /** Map of plugin id → pinned flag, hydrated from the DB settings table. */
  pins: Record<string, boolean>;
  /** Whether the persisted pins have been loaded. */
  hydrated: boolean;
  /** Load all plugin pin settings from the DB. */
  hydrate: () => Promise<void>;
  /** Optimistically set a plugin's pinned value and persist it. */
  setPinned: (id: string, pinned: boolean) => void;
  /** Read the effective pinned value (persisted pin, else the manifest default). */
  isPinned: (m: PluginManifest) => boolean;
  /** Whether a plugin is instantly useful once it appears; mirrors `isTauri()`-safety. */
}

export const usePins = create<PinState>((set, get) => ({
  pins: {},
  hydrated: false,

  hydrate: async () => {
    const defaultPinned = getPinnableDefaults();
    // If not in Tauri, nothing to read — mark hydrated with defaults.
    if (!isTauri()) {
      set({ pins: defaultPinned, hydrated: true });
      return;
    }

    const next: Record<string, boolean> = { ...defaultPinned };
    try {
      const ids = Object.keys(defaultPinned);
      // Read each plugin's pin in sequence (the settings table has no bulk read).
      for (const id of ids) {
        const stored = await ipc.getSetting(pinKey(id));
        // A stored "true"/"false" wins; absent/non-boolean falls back to default.
        if (stored === "true") next[id] = true;
        else if (stored === "false") next[id] = false;
      }
      set({ pins: next, hydrated: true });
    } catch {
      // Non-fatal (e.g. NotInTauri / DB hiccup): keep defaults.
      set({ pins: next, hydrated: true });
    }
  },

  setPinned: (id, pinned) => {
    const prev = get().pins;
    const next = { ...prev, [id]: pinned };
    set({ pins: next });

    if (isTauri()) {
      void ipc
        .setSetting(pinKey(id), pinned ? "true" : "false")
        .catch(() => {
          /* keep the optimistic UI; setting is non-critical */
        });
    }
  },

  isPinned: (m) => {
    const value = get().pins[m.id];
    return value ?? m.nav?.defaultPinned ?? false;
  },
}));

/**
 * Materialize the default pin map from the registry's defaultPinned values, so hydrate
 * can seed "everything as the author declared" before reading overrides.
 */
function getPinnableDefaults(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const p of getPlugins()) {
    if (!p.core && p.nav) out[p.id] = p.nav.defaultPinned;
  }
  return out;
}