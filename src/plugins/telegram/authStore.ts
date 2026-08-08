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
  /** QR token (base64url) to render, while a QR poll is live. */
  qrToken: string | null;
  /** Seconds until the current QR token expires (drives the "expired" restart button). */
  qrExpiresIn: number | null;
  /** Whether a QR poll is currently in flight. */
  qrPolling: boolean;
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
  /** Start the QR-code poll: fetch a token, render it, poll every ~4s. Returns false on failure. */
  startQrPoll: () => Promise<boolean>;
  /** Stop the QR poll (component unmount / login complete / user aborts). */
  stopQrPoll: () => void;
  /** Abandon an in-flight login and return to the phone step. */
  resetLogin: () => void;
  /** Disconnect + wipe the session. */
  signOut: () => Promise<void>;
  /** Dynamically update network state from window events. */
  setNetworkState: (isOnline: boolean) => void;
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

// ── QR poll lifecycle ──────────────────────────────────────────────────────────
// The timer handle lives at module scope so `stopQrPoll` can always cancel it — even after
// `startQrPoll` resolved (connect complete) or the component unmounted mid-poll.
const QR_POLL_MS = 4000;
const QR_TOTAL_MS = 120_000;
const qrPoll = { timer: null as ReturnType<typeof setInterval> | null, deadline: 0 };

/** A single poll tick. Returns true while the poll should continue. */
async function qrTick(set: (partial: Partial<TgAuthStore>) => void, get: () => TgAuthStore): Promise<boolean> {
  if (!get().qrPolling) return false;
  if (Date.now() > qrPoll.deadline) {
    // 120s of live QR is up; Telegram's token side also expires → stop and show the restart
    // button (the UI reads `qrExpiresIn === 0` as "expired").
    set({ qrPolling: false, qrToken: null, qrExpiresIn: 0, error: null });
    return false;
  }
  try {
    const res = await tg.requestQrToken();
    if (res.status === "success") {
      set({
        status: "connected",
        passwordHint: null,
        pendingPhone: null,
        qrToken: null,
        qrExpiresIn: null,
        qrPolling: false,
        error: null,
      });
      try {
        set({ user: await tg.getMe() });
      } catch {
        /* best-effort */
      }
      return false;
    }
    if (res.status === "needs_password") {
      set({
        status: "needs_password",
        passwordHint: res.password_hint ?? null,
        qrPolling: false,
        qrToken: null,
        error: null,
      });
      return false;
    }
    // Token (possibly refreshed): only re-render when it actually changed — the QR library
    // re-renders eagerly, so avoiding a no-op set keeps the rasterizer from flickering.
    const current = get();
    if (res.status === "expired") {
      // Backend cleared the dead token; stop polling and show the "expired" UI.
      set({ qrPolling: false, qrToken: null, qrExpiresIn: 0, error: null });
      return false;
    }
    if (current.qrToken !== res.base64url || current.qrExpiresIn !== res.expires_in) {
      set({ qrToken: res.base64url, qrExpiresIn: res.expires_in });
    }
    return true;
  } catch (e) {
    set({ status: "disconnected", qrPolling: false, qrToken: null, qrExpiresIn: null, error: messageOf(e) });
    return false;
  }
}

export const useAuth = create<TgAuthStore>((set, get) => ({
  status: "unknown",
  user: null,
  hasCredentials: false,
  pendingPhone: null,
  passwordHint: null,
  qrToken: null,
  qrExpiresIn: null,
  qrPolling: false,
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

  setNetworkState: (isOnline: boolean) => {
    const current = get().status;
    if (!isOnline && current === "connected") {
      set({ status: "unreachable" });
    } else if (isOnline && current === "unreachable") {
      set({ status: "connected" });
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
      qrToken: null,
      qrExpiresIn: null,
      qrPolling: false,
      error: null,
    });
  },

  // Poll timer lives at module scope so `stopQrPoll` can always cancel it, even after the
  // store's `startQrPoll` finished or the component unmounted.
  startQrPoll: async () => {
    set({ status: "connecting", error: null, qrToken: null, qrExpiresIn: null, qrPolling: true });
    qrPoll.deadline = Date.now() + QR_TOTAL_MS;
    try {
      const first = await tg.requestQrToken();
      // The first tick may already have resolved (rare) — honor it before starting the loop.
      if (first.status === "success") {
        set({
          status: "connected",
          passwordHint: null,
          pendingPhone: null,
          qrToken: null,
          qrExpiresIn: null,
          qrPolling: false,
          error: null,
        });
        try {
          set({ user: await tg.getMe() });
        } catch {
          /* best-effort */
        }
        return true;
      }
      if (first.status === "needs_password") {
        set({
          status: "needs_password",
          passwordHint: first.password_hint ?? null,
          qrPolling: false,
          qrToken: null,
          error: null,
        });
        return true;
      }
      if (first.status === "expired" || !first.base64url) {
        // Backend had a stale token; nothing to render on the very first fetch.
        set({ status: "disconnected", qrPolling: false, qrToken: null, qrExpiresIn: 0, error: null });
        return false;
      }
      set({
        status: "connecting",
        qrToken: first.base64url,
        qrExpiresIn: first.expires_in,
        qrPolling: true,
        error: null,
      });
      // Start the 4s polling loop (the first fetch already rendered a live token).
      if (qrPoll.timer) clearInterval(qrPoll.timer);
      qrPoll.timer = setInterval(() => {
        void qrTick(set, get);
      }, QR_POLL_MS);
      return true;
    } catch (e) {
      set({ status: "disconnected", qrPolling: false, error: messageOf(e) });
      return false;
    }
  },

  stopQrPoll: () => {
    if (qrPoll.timer) {
      clearInterval(qrPoll.timer);
      qrPoll.timer = null;
    }
    set({ qrPolling: false, qrToken: null, qrExpiresIn: null });
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
      qrToken: null,
      qrExpiresIn: null,
      qrPolling: false,
    });
  },
}));
