/**
 * Plugin registry — the single source of truth for every plugin surface.
 *
 * Built-in core nav items (Dashboard / Courses / Planning / Settings) are declared here
 * as manifests too, so the whole nav + routes + settings composition flows through ONE
 * list. New plugins register by importing their manifest into `externalPlugins()` and are
 * then picked up by `useNavItems()`, `usePluginRoutes()`, and the Settings registry
 * automatically — the shell never needs to change again.
 *
 * Core items are rendered in a fixed order (0..2 scaffold the app; Settings clamps last).
 * Plugin items slot in by their `nav.order`; whether a plugin *shows* in the primary nav
 * is decided by `pinStore` (persisted `plugins.<id>.pinned`), not by presence here.
 */

import type { PluginManifest } from "./types";
import { validateManifest } from "./types";
import { DashboardIcon, SettingsIcon } from "../../components/ui/icons";
import { GraduationCap, CalendarCheck } from "lucide-react";
import { telegramManifest } from "../../plugins/telegram/manifest";

/** Built-in core nav manifests. These are never pinnable; they always render. */
function corePlugins(): PluginManifest[] {
  return [
    {
      id: "dashboard",
      name: "Dashboard",
      version: "0.1.0",
      description: "Today's focus, plan, and progress at a glance.",
      icon: DashboardIcon,
      core: true,
      nav: { defaultPinned: true, order: 0 },
      routes: [],
      capabilities: [],
    },
    {
      id: "courses",
      name: "Courses",
      version: "0.1.0",
      description: "Browse your goal tree and open materials.",
      icon: GraduationCap,
      core: true,
      nav: { defaultPinned: true, order: 1 },
      routes: [],
      capabilities: [],
    },
    {
      id: "planning",
      name: "Planning",
      version: "0.1.0",
      description: "Plan your day and track consistency.",
      icon: CalendarCheck,
      core: true,
      nav: { defaultPinned: true, order: 2 },
      routes: [],
      capabilities: [],
    },
    {
      id: "settings",
      name: "Settings",
      version: "0.1.0",
      description: "Folders, appearance, focus, playback, and data.",
      icon: SettingsIcon,
      core: true,
      nav: { defaultPinned: true, order: 100 },
      routes: [],
      capabilities: [],
    },
  ];
}

/**
 * Installed plugin manifests — the extension points. Each is an in-repo module that
 * declares its own nav/route/settings/source-adapter contributions. Future tools
 * (YouTube, podcast sources, …) register here instead of touching the shell.
 */
function externalPlugins(): PluginManifest[] {
  return [telegramManifest];
}

let cache: PluginManifest[] | null = null;
let validated = false;

/** All manifests, in declaration order (core first, then external). */
export function getPlugins(): PluginManifest[] {
  if (cache == null) cache = corePlugins().concat(externalPlugins());

  // Contribution-point validation: cheap, runs once, surfaces broken manifests early.
  // `console.error` (not throw) so a validation failure never bricks the app at boot.
  if (!validated) {
    validated = true;
    const seen = new Set<string>();
    for (const p of cache) {
      if (seen.has(p.id)) {
        // eslint-disable-next-line no-console
        console.error(`[plugins] duplicate id: ${p.id}`);
      }
      seen.add(p.id);
      for (const problem of validateManifest(p)) {
        // eslint-disable-next-line no-console
        console.error(`[plugins] ${problem}`);
      }
    }
  }
  return cache;
}

/** Look up a plugin by id (`null` if not registered). */
export function getPlugin(id: string): PluginManifest | undefined {
  return getPlugins().find((p) => p.id === id);
}

/** All pinnable (non-core) plugin manifests in nav order. */
export function pinnablePlugins(): PluginManifest[] {
  return getPlugins()
    .filter((p) => !p.core && p.nav)
    .sort((a, b) => (a.nav!.order ?? 0) - (b.nav!.order ?? 0));
}

/** The persisted pin/enable state resolver — provided by pinStore.ts, injected to avoid a circular import. */
export type PinResolver = (manifest: PluginManifest) => boolean;