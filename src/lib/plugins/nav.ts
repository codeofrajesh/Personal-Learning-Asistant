/**
 * useNavItems — the primary-sidebar nav composed from the plugin registry.
 *
 * Previously `Sidebar` imported a static `NAV_ITEMS`. Now the nav is a *composition*:
 *   · core items (Dashboard / Courses / Planning / Settings) always render, in order;
 *   · pinned plugin items render as normal nav links, in their `nav.order` position;
 *   · unpinned plugins are reachable via a special `/plugins` item pinned near the bottom.
 *
 * Every item is a `NavItem` (the exact shape Sidebar already consumed), so Sidebar's
 * rendering, active-state logic, and roving navigation are unchanged.
 */

import { getPlugins } from "./registry";
import { usePins } from "./pinStore";
import { Puzzle } from "lucide-react";
import { StatusDot } from "./statusDot";
import type { ElementType, ComponentType } from "react";

/** A plugin status-dot renderer for a nav item (`pluginId` + `collapsed`). */
export type NavStatusDot = ComponentType<{ pluginId: string; collapsed?: boolean }>;

/** The nav item shape shared with the Sidebar (compatible with the old `NavItem`). */
export interface NavItem {
  /** Router path — also the React key. */
  to: string;
  label: string;
  icon: ElementType;
  /** Only the exact path is "active". */
  end?: boolean;
  /** True for the pinned-plugins composition pass (relevant to core items that are never pinned). */
  pinned?: boolean;
  /** Registered plugin this item belongs to (`undefined` for core + the Plugins overflow item). */
  pluginId?: string;
  /** Rendered after the label when the plugin's manifest declares `badge: "status-dot"`. */
  statusDot?: NavStatusDot;
}

/**
 * Compose the full nav list. Call this from a React component that subscribes to the
 * pin store (a `usePins`-subscribing hook) so pinning re-renders the sidebar immediately.
 */
export function useNavItems(): NavItem[] {
  const pins = usePins((s) => s.pins);
  const hydrated = usePins((s) => s.hydrated);
  void hydrated; // hydration triggers re-render; pins carry the values.

  const plugins = getPlugins();
  const core = plugins.filter((p) => p.core);
  const pinnable = plugins.filter((p) => !p.core && p.nav).sort((a, b) => (a.nav!.order ?? 0) - (b.nav!.order ?? 0));

  const items: NavItem[] = core.map((p) => {
    const to = coreRoute(p.id) ?? routeFor(p);
    return {
      to,
      label: p.name,
      icon: p.icon,
      ...(p.nav?.order === 0 ? { end: true as const } : {}),
      pluginId: p.id,
    };
  });

  // Insert pinned plugins into the main nav (before the Settings core item, by order).
  const pinned = pinnable.filter((p) => pins[p.id] ?? p.nav?.defaultPinned ?? false);
  const settingsIndex = items.findIndex((i) => i.pluginId === "settings");

  for (const p of pinned) {
    items.splice(settingsIndex < 0 ? items.length : settingsIndex, 0, {
      to: routeFor(p),
      label: p.name,
      icon: p.icon,
      pluginId: p.id,
      // A plugin declaring `badge: "status-dot"` gets its nav dot via the shared shell.
      statusDot: p.nav?.badge === "status-dot" ? StatusDot : undefined,
    });
  }

  // The Plugins overflow item — always present, opens the hub. Sits before Settings.
  items.splice(settingsIndex < 0 ? items.length : settingsIndex, 0, {
    to: "/plugins",
    label: "Plugins",
    icon: Puzzle,
    pluginId: "plugins",
  });

  return items;
}

/** The primary route for a plugin (its first registered route, or a fallback). */
function routeFor(p: { id: string; routes: { path: string }[] }): string {
  return p.routes[0]?.path ?? "/plugins/" + p.id;
}

/** Core items declare their canonical route here (their manifests have empty routes). */
function coreRoute(id: string): string | undefined {
  switch (id) {
    case "dashboard":
      return "/";
    case "courses":
      return "/courses";
    case "planning":
      return "/planning";
    case "settings":
      return "/settings";
    default:
      return undefined;
  }
}