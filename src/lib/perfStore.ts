/**
 * perfStore — the app-wide **Performance Tier** (the keystone of the low-end-PC program).
 *
 * The premium glassmorphism finish (stacked `backdrop-filter: blur()`, ambient blur blobs,
 * animated `filter: drop-shadow()` glows) is gorgeous on capable GPUs but is the single most
 * expensive thing we hand a weak one — `backdrop-filter` is ~O(surfaces × blurred-area) per
 * composited frame, and the Courses grid alone can stack 24–48 blur surfaces.
 *
 * Rather than branch per-component, we resolve ONE tier and expose it as a `data-perf`
 * attribute on <html>. All the heavy-visual gating then lives in pure CSS (index.css), so
 * there is zero JS in the render/paint path and switching tiers is a single attribute write.
 *
 *   high      — full premium finish (blur-xl, ambient blobs, filter glows, all motion).
 *   balanced  — lighter blur, static blobs, no filter glows (default for mid hardware).
 *   lite      — NO backdrop-filter (solid tinted surfaces), no blobs, minimal motion.
 *
 * Resolution order: explicit user choice (persisted) → one-time auto-detect from
 * hardwareConcurrency + deviceMemory. The DB `settings` row is the source of truth across
 * sessions; localStorage is a fast mirror so we can apply the tier BEFORE first paint
 * (see applyPerfClassEarly, called from main.tsx) with no flash of the heavy finish.
 */

import { create } from "zustand";
import { ipc, isTauri } from "./ipc";

export type PerfTier = "high" | "balanced" | "lite";
export type PerfPreference = PerfTier | "auto";

const LS_KEY = "perf.tier"; // resolved tier mirror (for pre-paint apply)
const LS_PREF_KEY = "perf.pref"; // the user's raw preference (tier | 'auto')
const DB_KEY = "perf.pref";

const TIERS: readonly PerfTier[] = ["high", "balanced", "lite"] as const;
const isTier = (v: unknown): v is PerfTier => TIERS.includes(v as PerfTier);
const isPref = (v: unknown): v is PerfPreference => v === "auto" || isTier(v);

/**
 * Auto-detect a sensible tier from the device. `deviceMemory` (GB, coarse) and
 * `hardwareConcurrency` (logical cores) are the only broadly-available signals in a
 * WebView; both undercount in some browsers, so we bias conservative:
 *   ≤4 GB RAM  OR ≤2 cores → lite   (the 4GB target audience)
 *   ≤8 GB RAM  OR ≤4 cores → balanced
 *   otherwise              → high
 */
export function detectTier(): PerfTier {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const mem = typeof nav.deviceMemory === "number" ? nav.deviceMemory : undefined;
  const cores =
    typeof nav.hardwareConcurrency === "number" ? nav.hardwareConcurrency : undefined;

  if ((mem !== undefined && mem <= 4) || (cores !== undefined && cores <= 2)) return "lite";
  if ((mem !== undefined && mem <= 8) || (cores !== undefined && cores <= 4)) return "balanced";
  return "high";
}

function resolveTier(pref: PerfPreference): PerfTier {
  return pref === "auto" ? detectTier() : pref;
}

function writeHtmlAttr(tier: PerfTier) {
  document.documentElement.dataset.perf = tier;
}

/**
 * Apply the last-resolved tier from localStorage to <html> synchronously, before React
 * mounts, so the first paint already reflects the tier (no flash of the heavy finish on a
 * weak GPU). Called from main.tsx. Falls back to a fresh auto-detect on first ever run.
 */
export function applyPerfClassEarly(): PerfTier {
  let tier: PerfTier;
  try {
    const cached = localStorage.getItem(LS_KEY);
    tier = isTier(cached) ? cached : detectTier();
  } catch {
    tier = detectTier();
  }
  writeHtmlAttr(tier);
  return tier;
}

function readPrefFromLS(): PerfPreference {
  try {
    const v = localStorage.getItem(LS_PREF_KEY);
    if (isPref(v)) return v;
  } catch {
    /* ignore */
  }
  return "auto";
}

interface PerfState {
  /** The user's raw preference: an explicit tier, or 'auto' (detect). */
  preference: PerfPreference;
  /** The effective tier currently applied to <html>. */
  tier: PerfTier;
  /** True once the DB-backed preference has been loaded (or confirmed absent). */
  hydrated: boolean;
  /** Load the persisted preference from the DB and reconcile the applied tier. */
  hydrate: () => Promise<void>;
  /** Set the user's preference, persist it, and re-resolve/apply the tier. */
  setPreference: (pref: PerfPreference) => void;
}

export const usePerf = create<PerfState>((set, get) => ({
  preference: readPrefFromLS(),
  tier: (document.documentElement.dataset.perf as PerfTier) || detectTier(),
  hydrated: false,

  hydrate: async () => {
    if (!isTauri()) {
      set({ hydrated: true });
      return;
    }
    try {
      const stored = await ipc.getSetting(DB_KEY);
      const pref: PerfPreference = isPref(stored) ? stored : get().preference;
      const tier = resolveTier(pref);
      writeHtmlAttr(tier);
      try {
        localStorage.setItem(LS_PREF_KEY, pref);
        localStorage.setItem(LS_KEY, tier);
      } catch {
        /* ignore */
      }
      set({ preference: pref, tier, hydrated: true });
    } catch {
      set({ hydrated: true });
    }
  },

  setPreference: (pref) => {
    const tier = resolveTier(pref);
    writeHtmlAttr(tier);
    try {
      localStorage.setItem(LS_PREF_KEY, pref);
      localStorage.setItem(LS_KEY, tier);
    } catch {
      /* ignore */
    }
    set({ preference: pref, tier });
    if (isTauri()) {
      void ipc.setSetting(DB_KEY, pref).catch(() => {
        /* keep optimistic UI; setting is non-critical */
      });
    }
  },
}));
