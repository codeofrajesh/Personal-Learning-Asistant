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

/** One importable media message from a channel (`tg_channel_media`). */
export interface TgMediaItem {
  chat_id: number;
  message_id: number;
  file_name: string;
  /** PLE's own classification: video | audio | pdf | image | note. */
  file_type: string;
  file_extension: string;
  size_bytes: number;
  duration_secs: number | null;
  mime_type: string | null;
  caption: string | null;
  /** True when a material row for this (chat, message) already exists. */
  already_imported: boolean;
}

/** Result of importing one link (`tg_import_link`). */
export interface TgImportResult {
  material_id: number;
  file_name: string;
  /** False when the row already existed and was refreshed rather than created. */
  created: boolean;
  node_id: number;
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

  /** Import one `t.me` message link into `nodeId`. */
  async importLink(url: string, nodeId: number): Promise<TgImportResult> {
    return invokeCommand("tg_import_link", { url, nodeId });
  },

  /**
   * List recent media in a channel. `url` accepts any message link from the channel, a
   * channel link, or a bare `@username` — finding a numeric channel id is not something a
   * student should have to do.
   */
  async channelMedia(url: string, limit?: number): Promise<TgMediaItem[]> {
    return invokeCommand("tg_channel_media", { url, limit: limit ?? null });
  },
};

/** True when the Telegram backend is reachable (i.e. inside the Tauri shell). */
export function tgAvailable(): boolean {
  return isTauri();
}
