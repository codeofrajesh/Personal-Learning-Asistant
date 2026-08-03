/**
 * sourceAdapter — resolve a material row into a playable source.
 *
 * The decoupling core of the plugin architecture: the player accepts a URL; WHERE that
 * URL comes from is a pluggable capability. Local files resolve via the Tauri asset
 * protocol (`asset://`); a plugin (e.g. Telegram, Phase 5) resolves via its own adapter
 * to an `http://…` stream URL. The player, watch-time, Study Meter, notes and bookmarks
 * are all source-agnostic — they key on material id + time-pos, never the URL.
 *
 * Phase 1 ships the default (local) resolver only and the query surface that plugins
 * will implement; the Telegram adapter lands in Phase 5 alongside the streaming backend.
 */

import { convertFileSrc } from "@tauri-apps/api/core";
import { getPlugins } from "./registry";
import type { ResolvedSource, SourceAdapterDescriptor } from "./types";

/** The local-file resolver — the default when no plugin claims a material's source. */
const LOCAL_SOURCE: SourceAdapterDescriptor = {
  source: "local",
  resolve: (m) =>
    Promise.resolve({ url: convertFileSrc(m.file_path), kind: "local" }),
};

/** Every registered source adapter, keyed by `materials.source`. */
function adapters(): Map<string, SourceAdapterDescriptor> {
  const map = new Map<string, SourceAdapterDescriptor>();
  map.set("local", LOCAL_SOURCE);
  for (const p of getPlugins()) {
    for (const a of p.sourceAdapters ?? []) map.set(a.source, a);
  }
  return map;
}

/**
 * Resolve a material into a playable source. Falls back to the local asset protocol
 * for any row whose `source` is null/'local' or not claimed by a registered plugin.
 */
export async function resolveMaterialSource(m: {
  source?: string | null;
  file_path: string;
}): Promise<ResolvedSource> {
  const source = m.source && m.source !== "local" ? m.source : "local";
  const adapter = adapters().get(source);
  if (adapter) {
    try {
      return await adapter.resolve(m as { source: string | null; file_path: string });
    } catch {
      // A broken plugin adapter must not brick playback — fall back to local (if a path
      // exists) and let the caller surface an error.
      if (m.file_path) return LOCAL_SOURCE.resolve(m as never);
      throw new Error(`Unable to resolve source for source type "${source}"`);
    }
  }
  // Unknown source type with no adapter → try the raw file path as a local asset.
  return { url: convertFileSrc(m.file_path), kind: "local" };
}