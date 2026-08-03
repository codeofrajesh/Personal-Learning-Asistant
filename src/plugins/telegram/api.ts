/**
 * Telegram plugin IPC — typed `tg_*` wrappers.
 *
 * These match the Rust command signatures exactly
 * (`src-tauri/src/plugins/telegram/auth.rs`). Every method degrades gracefully outside the
 * Tauri shell (throws `NotInTauriError` via the shared `invokeCommand` helper) so `vite`
 * preview still renders the page.
 *
 * No token crosses this boundary: the `LoginToken` / `PasswordToken` that grammers needs
 * verbatim live in Rust's `TgState`, so `signIn` sends only the code. Args are camelCase —
 * Tauri maps them onto the commands' snake_case parameters.
 */

import { invokeCommand, isTauri } from "../../lib/ipc";

/**
 * Wire status from `tg_check_auth`.
 *
 * `unreachable` means a session exists but Telegram couldn't be reached to confirm it —
 * kept distinct from `disconnected` so an offline student isn't told to sign in again.
 */
export type TgAuthStatus = "connected" | "disconnected" | "unreachable";

/** Account card data from `tg_get_me`. */
export interface TgMe {
  id: number;
  first_name: string | null;
  username: string | null;
  phone: string | null;
}

/** Confirmation that a code was sent, and to which number. */
export interface LoginHandle {
  phone: string;
}

/** Result of `tg_sign_in`. */
export interface TgSignInResult {
  ok: boolean;
  needs_password: boolean;
  hint: string | null;
}

/** Stored MTProto credentials. The hash itself is never returned by the backend. */
export interface TgCredentials {
  api_id: string;
  has_api_hash: boolean;
}

/** The `tg_*` command surface. */
export const tg = {
  /** Read the saved api_id + whether an api_hash is stored. */
  async getCredentials(): Promise<TgCredentials> {
    return invokeCommand("tg_get_api_credentials");
  },

  /** Save the user's my.telegram.org credentials (validated server-side). */
  async setCredentials(apiId: string, apiHash: string): Promise<void> {
    return invokeCommand("tg_set_api_credentials", { apiId, apiHash });
  },

  /** Is there a valid session? Hydrates the nav dot + page on boot. */
  async checkAuth(): Promise<TgAuthStatus> {
    return invokeCommand("tg_check_auth");
  },

  /** Request a login code for `phone`. The token is kept server-side. */
  async requestCode(phone: string): Promise<LoginHandle> {
    return invokeCommand("tg_request_code", { phone });
  },

  /** Complete login with the received `code`. May report `needs_password`. */
  async signIn(code: string): Promise<TgSignInResult> {
    return invokeCommand("tg_sign_in", { code });
  },

  /** Complete 2FA login with `password`. */
  async signIn2fa(password: string): Promise<void> {
    return invokeCommand("tg_sign_in_2fa", { password });
  },

  /** Revoke the session server-side and wipe it locally. */
  async signOut(): Promise<void> {
    return invokeCommand("tg_sign_out");
  },

  /** Current account info (requires an authorized session). */
  async getMe(): Promise<TgMe> {
    return invokeCommand("tg_get_me");
  },
};

/** True when the Telegram backend is reachable (i.e. inside the Tauri shell). */
export function tgAvailable(): boolean {
  return isTauri();
}
