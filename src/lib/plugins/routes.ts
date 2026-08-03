/**
 * usePluginRoutes — the route map composed from the plugin registry.
 *
 * Core routes (dashboard, courses, planning, settings, /plugins hub) are declared here;
 * plugin routes come from each manifest's `routes`. Every plugin page stays code-split
 * via `React.lazy` (the app's Section 15 perf rule) and is only fetched when visited.
 *
 * The router in `App.tsx` consumes this so adding a plugin = adding a manifest, never
 * editing the router.
 */

import type { ComponentType } from "react";
import { getPlugins } from "./registry";

/** A route entry ready for `<Routes>` (lazy import + fallback handled by App). */
export interface PluginRouteEntry {
  path: string;
  lazy: () => Promise<{ default: ComponentType }>;
}

/** All plugin routes (core + external), deduplicated by path (last wins). */
export function getPluginRoutes(): PluginRouteEntry[] {
  const map = new Map<string, PluginRouteEntry>();
  for (const p of getPlugins()) {
    for (const r of p.routes) map.set(r.path, r);
  }
  return Array.from(map.values());
}

/**
 * Whether a plugin declares a route for the given path (used by the Plugins hub /
 * empty-state to decide "this plugin has a page").
 */
export function hasPluginRoute(path: string): boolean {
  return getPluginRoutes().some((r) => r.path === path);
}