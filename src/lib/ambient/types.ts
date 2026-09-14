/**
 * Shared types for the Ambient Sound Hub.
 *
 * Field names on the DB-backed shapes (`AmbientSearchResult`, `AmbientFavorite`) are snake_case to
 * match the Rust serde structs verbatim — Tauri only camel/snake-converts top-level command
 * argument names, never nested object fields, and the rest of the app's DTOs follow the same
 * convention (see `MaterialRow` in `lib/types.ts`).
 */

/** The six zero-KB, offline procedural generators (dual-channel true stereo). */
export type ProceduralKind = "brown" | "pink" | "rain" | "waves" | "gamma40" | "alpha10";

/** A source of ambient audio. `procedural` is offline-synthesized; the rest are online. */
export type AmbientSourceKind = "procedural" | "freesound" | "archive" | "somafm" | "youtube";

/** A normalized online search hit (mirrors Rust `AmbientResult`). */
export interface AmbientSearchResult {
  source: string;
  external_id: string;
  name: string;
  duration_secs: number | null;
  /** Remote URL a CSP-allowed `<audio>` can stream directly. */
  preview_url: string;
  attribution: string | null;
  tags: string | null;
}

/** YouTube search hit (from yt-dlp sidecar). */
export interface YouTubeSearchResult {
  video_id: string;
  title: string;
  channel: string;
  duration_secs: number | null;
  thumbnail_url: string | null;
  url: string;
}

/** Resolved direct YouTube audio stream info. */
export interface YouTubeStreamInfo {
  stream_url: string;
  video_id: string;
  title: string;
  channel: string;
  duration_secs: number | null;
  thumbnail_url: string | null;
}

/** A starred sound (mirrors Rust `AmbientFavorite` / the `ambient_favorites` row). */
export interface AmbientFavorite {
  id: number;
  source: string;
  external_id: string;
  name: string;
  stream_url: string | null;
  /** Local file once downloaded for offline use (play via `assetUrl`). */
  cached_path: string | null;
  duration_secs: number | null;
  attribution: string | null;
  created_at: string;
}

/** A 24/7 SomaFM stream (static, keyless catalog). */
export interface SomaStream {
  id: string;
  name: string;
  description: string;
  url: string;
}

/**
 * A sound the engine can play, unified across sources. For `procedural`, `id` is the
 * `ProceduralKind`; otherwise `url` is what actually plays (a remote preview/stream, or an
 * `assetUrl(cached_path)` for an offline copy). `loop` is false only for endless streams.
 */
export interface AmbientSound {
  source: AmbientSourceKind;
  id: string;
  name: string;
  url?: string;
  loop?: boolean;
  attribution?: string | null;
  thumbnail_url?: string | null;
  channel?: string | null;
  duration_secs?: number | null;
  playlist_id?: string | null;
}

/** Individual item in a user's study playlist. */
export interface AmbientPlaylistItem {
  id: string;
  sound: AmbientSound;
  added_at: string;
}

/** User-curated or starter study playlist. */
export interface AmbientPlaylist {
  id: string;
  name: string;
  emoji: string;
  gradient: string; // Tailwind gradient classes e.g. "from-blue-600 via-indigo-600 to-cyan-500"
  description?: string;
  items: AmbientPlaylistItem[];
  created_at: string;
}

/** Professional Studio EQ Tone profiles for study acoustic optimization. */
export type AudioToneProfile = "flat" | "warm" | "vocal" | "bass" | "shield";

/** Isochronic / Binaural Brainwave entrainment frequencies. */
export type BinauralBeatKind = "off" | "alpha" | "beta" | "theta" | "gamma";

