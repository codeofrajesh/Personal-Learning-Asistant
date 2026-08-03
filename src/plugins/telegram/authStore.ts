/**
 * authStore — Telegram auth state, global to the app.
 *
 * Mirrors the app's `perfStore`/`timerStore` patterns: a single Zustand store that hydrates
 * on boot (one `tg_check_auth` call) and is read by the nav status dot, the plugin page and
 * the settings section. Rust owns the session file and the in-flight login tokens; this
 * store holds only what the UI has to render.
 *
 * Hydration runs from `AppShell` via the registry's `init` contribution, not from the plugin
 * page — a status dot that only becomes accurate once you visit the page it describes isn't
 * a status dot.
 */

import { create } from "zustand";
import { tg } from "./api";
import type { TgMe } from "./api";

/**
 * `unknown` is the pre-hydration state, kept distinct from `disconnected` so the UI can say
 * "checking…" instead of flashing "not connected" and correcting itself on every boot.
 * `unreachable` means a session exists but couldn't be confirmed (offline).
 */
export type TgAuthState =
  | "unknown"
  | "disconnected"
  | "connected"
  | "unreachable"
  | "connecting"
  | "needs_password";

interface TgAuthStore {
  /** Derived auth state for UI (nav dot, page hero). */
  status: TgAuthState;
  /** The connected account, when known. */
  user: TgMe | null;
  /** Whether api_id/api_hash are saved. Until they are, Connect cannot work at all. */
  hasCredentials: boolean;
  /** The phone the current code was sent to (shown on the code step). */
  pendingPhone: string | null;
  /** 2FA password hint surfaced after `tg_sign_in` reports `needs_password`. */
  passwordHint: string | null;
  /** Last error message (cleared at the start of the next action). */
  error: string | null;
  /** Hydrate once on boot: read credentials + ask the backend for the session state. */
  hydrate: () => Promise<void>;
  /** Save API credentials. Returns false (and sets `error`) if the backend rejected them. */
  saveCredentials: (apiId: string, apiHash: string) => Promise<boolean>;
  /** Request a code for a phone. Returns false if the request failed. */
  requestCode: (phone: string) => Promise<boolean>;
  /** Submit the received code. Handles the 2FA hand-off internally. */
  submitCode: (code: string) => Promise<boolean>;
  /** Submit the 2FA password. */
  submitPassword: (password: string) => Promise<boolean>;
  /** Abandon an in-flight login and return to the phone step. */
  resetLogin: () => void;
  /** Disconnect + wipe the session. */
  signOut: () => Promise<void>;
}

/**
 * Unwrap an IPC rejection into the backend's own message.
 *
 * `AppError` serializes to a plain string, so the thrown value is usually already the
 * sentence to show. `String(e)` would render an Error as "Error: …"; this normalizes both
 * shapes without leaking a stack trace into the UI.
 */
function messageOf(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "Something went wrong. Please try again.";
}

export const useAuth = create<TgAuthStore>((set, get) => ({
  status: "unknown",
  user: null,
  hasCredentials: false,
  pendingPhone: null,
  passwordHint: null,
  error: null,

  hydrate: async () => {
    try {
      const creds = await tg.getCredentials();
      set({ hasCredentials: creds.has_api_hash && creds.api_id !== "" });
    } catch {
      // Outside Tauri (or the command is unavailable): treat credentials as unset.
      set({ hasCredentials: false });
    }

    try {
      const state = await tg.checkAuth();
      if (state === "connected") {
        set({ status: "connected", error: null });
        // Best-effort: the session is authorized whether or not this call lands.
        try {
          set({ user: await tg.getMe() });
        } catch {
          /* the account card falls back to a generic label */
        }
      } else if (state === "unreachable") {
        set({ status: "unreachable", error: null });
      } else {
        set({ status: "disconnected", user: null, error: null });
      }
    } catch {
      // Not in Tauri / backend unreachable: stay "unknown" so the dot reads idle rather than
      // claiming the user is signed out.
      set({ status: "unknown", user: null });
    }
  },

  saveCredentials: async (apiId, apiHash) => {
    set({ error: null });
    try {
      await tg.setCredentials(apiId, apiHash);
      set({ hasCredentials: true });
      return true;
    } catch (e) {
      set({ error: messageOf(e) });
      return false;
    }
  },

  requestCode: async (phone) => {
    set({ status: "connecting", error: null });
    try {
      const handle = await tg.requestCode(phone);
      set({ status: "connecting", pendingPhone: handle.phone });
      return true;
    } catch (e) {
      // Back to disconnected: no code is in flight, so the phone step is the honest place to
      // land.
      set({ status: "disconnected", pendingPhone: null, error: messageOf(e) });
      return false;
    }
  },

  submitCode: async (code) => {
    set({ error: null });
    try {
      const result = await tg.signIn(code);
      if (result.ok) {
        set({
          status: "connected",
          passwordHint: null,
          pendingPhone: null,
          error: null,
        });
        try {
          set({ user: await tg.getMe() });
        } catch {
          /* getMe is best-effort; the session is already authorized */
        }
        return true;
      }
      if (result.needs_password) {
        set({ status: "needs_password", passwordHint: result.hint ?? null });
        return true; // advanced to the 2FA step
      }
      set({ status: "connecting", error: "Login failed. Try again." });
      return false;
    } catch (e) {
      // Stay on the code step: the backend keeps the login token alive through a bad code, so
      // the user can retype it instead of requesting a new one.
      set({ status: "connecting", error: messageOf(e) });
      return false;
    }
  },

  submitPassword: async (password) => {
    set({ error: null });
    try {
      await tg.signIn2fa(password);
      set({
        status: "connected",
        passwordHint: null,
        pendingPhone: null,
        error: null,
      });
      try {
        set({ user: await tg.getMe() });
      } catch {
        /* best-effort */
      }
      return true;
    } catch (e) {
      set({ status: "needs_password", error: messageOf(e) });
      return false;
    }
  },

  resetLogin: () => {
    set({
      status: get().status === "connected" ? "connected" : "disconnected",
      pendingPhone: null,
      passwordHint: null,
      error: null,
    });
  },

  signOut: async () => {
    try {
      await tg.signOut();
    } catch (e) {
      // The backend wipes locally even when Telegram is unreachable; surface the reason but
      // still drop to disconnected so the user isn't stuck on a dead session.
      set({ error: messageOf(e) });
    }
    set({
      status: "disconnected",
      user: null,
      pendingPhone: null,
      passwordHint: null,
    });
  },
}));
