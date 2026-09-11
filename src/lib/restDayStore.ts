/**
 * restDayStore — persistent store for student Rest Days (Path B relaxation engine).
 *
 * Allows students to pause their study streak during fever, illness, busy schedules,
 * or planned rest. Rest days preserve the streak by bridging the day gap without
 * faking study hours.
 *
 * Storage:
 *   - LocalStorage key: `ple.study.restDays` (instant synchronous UI rendering)
 *   - SQLite settings table: `study.rest_days` (cross-device/persistent local-first backup)
 */

import { create } from "zustand";
import { ipc, isTauri } from "./ipc";

export interface RestDayRecord {
  date: string; // YYYY-MM-DD
  reason?: string;
  markedAt: string; // ISO string
}

interface RestDayStoreState {
  restDays: Record<string, RestDayRecord>;
  hydrated: boolean;
  toggleRestDay: (date: string, reason?: string) => boolean;
  setRestDay: (date: string, isRest: boolean, reason?: string) => void;
  isRestDay: (date: string) => boolean;
  getRestDaySet: () => Set<string>;
  initSync: () => Promise<void>;
}

const STORAGE_KEY = "ple.study.restDays";
const SETTING_KEY = "study.rest_days";

function loadFromStorage(): Record<string, RestDayRecord> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function saveToStorage(data: Record<string, RestDayRecord>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* ignore storage quota errors */
  }
  if (isTauri()) {
    void ipc.setSetting(SETTING_KEY, JSON.stringify(data)).catch(() => {});
  }
}

export const useRestDayStore = create<RestDayStoreState>((set, get) => ({
  restDays: loadFromStorage(),
  hydrated: false,

  toggleRestDay: (date: string, reason?: string) => {
    const current = get().restDays;
    const exists = Boolean(current[date]);
    const updated = { ...current };

    if (exists) {
      delete updated[date];
    } else {
      updated[date] = {
        date,
        reason: reason || "Rest / Illness / Busy",
        markedAt: new Date().toISOString(),
      };
    }

    saveToStorage(updated);
    set({ restDays: updated });
    return !exists;
  },

  setRestDay: (date: string, isRest: boolean, reason?: string) => {
    const current = get().restDays;
    const updated = { ...current };

    if (!isRest) {
      delete updated[date];
    } else {
      updated[date] = {
        date,
        reason: reason || "Rest / Illness / Busy",
        markedAt: new Date().toISOString(),
      };
    }

    saveToStorage(updated);
    set({ restDays: updated });
  },

  isRestDay: (date: string) => {
    return Boolean(get().restDays[date]);
  },

  getRestDaySet: () => {
    return new Set(Object.keys(get().restDays));
  },

  initSync: async () => {
    if (get().hydrated) return;
    if (isTauri()) {
      try {
        const raw = await ipc.getSetting(SETTING_KEY);
        if (raw) {
          const dbData = JSON.parse(raw);
          if (typeof dbData === "object" && dbData !== null) {
            const localData = get().restDays;
            const merged = { ...dbData, ...localData };
            saveToStorage(merged);
            set({ restDays: merged, hydrated: true });
            return;
          }
        }
      } catch {
        /* fallback to local data */
      }
    }
    set({ hydrated: true });
  },
}));

// Initialize sync automatically in browser/Tauri context
if (typeof window !== "undefined") {
  void useRestDayStore.getState().initSync();
}
