/**
 * Ambient Hub catalog + adapters.
 *
 * Holds the static, keyless SomaFM stream list and the small pure functions that turn a search
 * result / favorite / SomaFM stream / procedural pick into the `AmbientSound` the engine plays or
 * the favorite payload the backend stores. Online search + caching themselves live on `ipc`.
 */

import { assetUrl } from "../ipc";
import { PROCEDURAL_PRESETS } from "./procedural";
import type {
  AmbientFavorite,
  AmbientSearchResult,
  AmbientSound,
  ProceduralKind,
  SomaStream,
  YouTubeSearchResult,
} from "./types";

/** 24/7 commercial-free ambient streams (keyless, endless, rock-solid international relay). */
export const SOMA_FM_STREAMS: SomaStream[] = [
  {
    id: "dronezone",
    name: "Drone Zone",
    description: "Atmospheric ambient for deep focus",
    url: "https://ice6.somafm.com/dronezone-128-aac",
  },
  {
    id: "groovesalad",
    name: "Groove Salad",
    description: "Chilled ambient beats & downtempo grooves",
    url: "https://ice6.somafm.com/groovesalad-128-aac",
  },
  {
    id: "deepspaceone",
    name: "Deep Space One",
    description: "Deep ambient electronic for meditation / sleep",
    url: "https://ice6.somafm.com/deepspaceone-128-aac",
  },
  {
    id: "lush",
    name: "Lush",
    description: "Mellow, mostly-vocal chill",
    url: "https://ice6.somafm.com/lush-128-aac",
  },
  {
    id: "defcon",
    name: "DEF CON Radio",
    description: "Year-round music for deep coding & hacking",
    url: "https://ice6.somafm.com/defcon-128-mp3",
  },
];

const PROCEDURAL_NAMES: Record<ProceduralKind, string> = Object.fromEntries(
  PROCEDURAL_PRESETS.map((p) => [p.kind, p.name]),
) as Record<ProceduralKind, string>;

// ── source → AmbientSound (what the engine plays) ────────────────────────────

export function soundFromProcedural(kind: ProceduralKind): AmbientSound {
  return { source: "procedural", id: kind, name: PROCEDURAL_NAMES[kind] };
}

export function soundFromSoma(s: SomaStream): AmbientSound {
  return { source: "somafm", id: s.id, name: s.name, url: s.url, loop: false };
}

export function soundFromSearchResult(r: AmbientSearchResult): AmbientSound {
  return {
    source: (r.source as AmbientSound["source"]) ?? "freesound",
    id: r.external_id,
    name: r.name,
    url: r.preview_url,
    loop: true,
    attribution: r.attribution,
    duration_secs: r.duration_secs,
  };
}

export function soundFromYouTube(
  track: YouTubeSearchResult,
  streamUrl?: string,
): AmbientSound {
  return {
    source: "youtube",
    id: track.video_id,
    name: track.title,
    url: streamUrl,
    loop: true,
    attribution: track.channel,
    thumbnail_url: track.thumbnail_url,
    channel: track.channel,
    duration_secs: track.duration_secs,
  };
}

/** A favorite prefers its offline cache; otherwise streams. Procedural favorites regenerate. */
export function soundFromFavorite(f: AmbientFavorite): AmbientSound {
  if (f.source === "procedural") {
    return { source: "procedural", id: f.external_id, name: f.name };
  }
  const url = f.cached_path ? assetUrl(f.cached_path) : f.stream_url ?? undefined;
  return {
    source: f.source as AmbientSound["source"],
    id: f.external_id,
    name: f.name,
    url,
    loop: f.source !== "somafm",
    attribution: f.attribution,
    thumbnail_url: f.source === "youtube" ? `https://i.ytimg.com/vi/${f.external_id}/hqdefault.jpg` : undefined,
    duration_secs: f.duration_secs,
  };
}

// ── source → favorite payload (what the backend stores) ──────────────────────

export function favoriteFromYouTube(
  track: YouTubeSearchResult,
  streamUrl?: string,
): Omit<AmbientFavorite, "id" | "created_at"> {
  return {
    source: "youtube",
    external_id: track.video_id,
    name: track.title,
    stream_url: streamUrl ?? null,
    cached_path: null,
    duration_secs: track.duration_secs,
    attribution: track.channel,
  };
}

export function favoriteFromResult(
  r: AmbientSearchResult,
): Omit<AmbientFavorite, "id" | "created_at"> {
  return {
    source: r.source,
    external_id: r.external_id,
    name: r.name,
    stream_url: r.preview_url,
    cached_path: null,
    duration_secs: r.duration_secs,
    attribution: r.attribution,
  };
}

export function favoriteFromSoma(s: SomaStream): Omit<AmbientFavorite, "id" | "created_at"> {
  return {
    source: "somafm",
    external_id: s.id,
    name: s.name,
    stream_url: s.url,
    cached_path: null,
    duration_secs: null,
    attribution: "SomaFM",
  };
}

export function favoriteFromProcedural(
  kind: ProceduralKind,
): Omit<AmbientFavorite, "id" | "created_at"> {
  return {
    source: "procedural",
    external_id: kind,
    name: PROCEDURAL_NAMES[kind],
    stream_url: null,
    cached_path: null,
    duration_secs: null,
    attribution: null,
  };
}
