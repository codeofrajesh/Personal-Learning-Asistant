/**
 * Toast notifications — a tiny global store for the in-app glassmorphism alert system.
 *
 * Chosen over Tauri OS notifications so alerts match the app's dark-glass DNA exactly
 * and we get flawless dedupe control (no new dependency / capability). A single global
 * store (module scope) is read by the `ToastHost` mounted once in AppShell, so any part
 * of the app can raise a toast from anywhere (timer completion, task reminders).
 *
 * Dedupe: each toast may carry a `key`; pushing a toast whose `key` is already live (or
 * was shown within its cooldown) is a no-op — this is what stops the reminder engine
 * from spamming the same "due in 1h" alert on every tick.
 */

import { create } from "zustand";

export type ToastTone = "focus" | "break" | "success" | "warning" | "info";

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string;
  /** Dedupe key — a second toast with the same live key is ignored. */
  key?: string;
  /** Auto-dismiss after this many ms (0 = sticky until dismissed). */
  duration: number;
  /** Optional action button. */
  action?: { label: string; run: () => void };
}

interface ToastState {
  toasts: Toast[];
  /** Keys shown recently, with the epoch-ms they may be re-shown after (cooldown). */
  _cooldowns: Record<string, number>;
  push: (t: Omit<Toast, "id" | "duration"> & { duration?: number; cooldownMs?: number }) => void;
  dismiss: (id: number) => void;
}

let seq = 1;
const DEFAULT_DURATION = 6000;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  _cooldowns: {},

  push: (t) => {
    const now = Date.now();
    const key = t.key;
    if (key) {
      // Skip if a toast with this key is already on screen…
      if (get().toasts.some((x) => x.key === key)) return;
      // …or was shown within its cooldown window.
      const until = get()._cooldowns[key] ?? 0;
      if (now < until) return;
    }
    const toast: Toast = {
      id: seq++,
      tone: t.tone,
      title: t.title,
      body: t.body,
      key,
      duration: t.duration ?? DEFAULT_DURATION,
      action: t.action,
    };
    set((s) => ({
      toasts: [...s.toasts, toast],
      _cooldowns: key
        ? { ...s._cooldowns, [key]: now + (t.cooldownMs ?? 0) }
        : s._cooldowns,
    }));
  },

  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

/** Convenience: raise a toast from non-React code (stores, plain functions). */
export function toast(t: Parameters<ToastState["push"]>[0]) {
  useToastStore.getState().push(t);
}
