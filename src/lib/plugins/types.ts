/**
 * Plugin contribution-point types.
 *
 * Modeled on VSCode contribution points (manifest-declares-surfaces) and lean enough
 * for an in-repo plugin registry. A `PluginManifest` declares *what* a plugin adds
 * (nav item, routes, settings sections, media-source adapter, IPC command names);
 * the shell (`registry.ts`, `nav.ts`, `routes.ts`, `settings.tsx`) composes those
 * declarations — it never hard-codes a plugin.
 *
 * Core nav items (Dashboard / Courses / Planning / Settings) are themselves built-in
 * manifests (see `registry.ts`), so there is exactly ONE nav composition path. The
 * only hard constraint: a manifest's `id` must match its Rust command prefix
 * (`id: "telegram"` ↔ `tg_*` commands), enforced by `validateManifest`.
 */

import type { ComponentType, ElementType } from "react";

/** A single nav contribution. Pinned plugin items render as normal nav links. */
export interface PluginNavContribution {
  /** Persisted preference: pin to the primary sidebar nav (settings key `plugins.<id>.pinned`). */
  defaultPinned: boolean;
  /** Sort position among nav items (core items own 0..2; plugins slot in between/around). */
  order: number;
  /** Plugin may render a live status dot on its nav item (e.g. connected/offline). */
  badge?: "status-dot";
}

export interface PluginRoute {
  /** Router path (as registered under <Routes>). */
  path: string;
  /** Code-split page — only fetched when the route is first visited (Section 15 perf rule). */
  lazy: () => Promise<{ default: ComponentType }>;
}

/** A settings section contributed by a plugin, rendered inside the Settings page. */
export interface PluginSettingsSection {
  /** Named when the section is rendered so a plugin can expose multiple panels. */
  id: string;
  /** Rendered within the active Settings category panel. */
  render: () => React.ReactNode;
}

/** A media-source adapter: given a material row, produce a playable URL. */
export interface SourceAdapterDescriptor {
  /** The `materials.source` value this adapter serves (e.g. "telegram"). */
  source: string;
  /** Resolve a material into a source the player can consume. */
  resolve: (m: { source: string | null; file_path: string }) => Promise<ResolvedSource>;
}

/** The resolution result — `asset://` for local files, `http://…` for plugin sources. */
export interface ResolvedSource {
  url: string;
  kind: "local" | "http";
  /** Content type / size when known (used to give the player metadata early). */
  mime?: string;
  size?: number;
}

/** Coarse capability declaration — used for clarity + future ACL gating; not enforced in Phase 1. */
export type PluginCapability = "auth" | "network" | "media" | "storage";

/** Contribution-point manifest — the single declarative contract a plugin implements. */
export interface PluginManifest {
  /** Stable id; MUST match the Rust command prefix (`"telegram"` ↔ `tg_*`). */
  id: string;
  name: string;
  version: string;
  description: string;
  /** Leading icon for the nav item + hub card (accepts the app's inline SVGs or lucide). */
  icon: ElementType;
  /** Whether this is a core (always-present, unpinnable) navigation surface. */
  core?: boolean;
  nav?: PluginNavContribution;
  routes: PluginRoute[];
  settingsSections?: PluginSettingsSection[];
  sourceAdapters?: SourceAdapterDescriptor[];
  /** The `tg_*` IPC command names this plugin owns (validated against the id prefix in dev). */
  commands?: string[];
  capabilities: PluginCapability[];
}

/**
 * Validate a plugin manifest. Phase 1 enforces color-consistency + contribution integrity;
 * without an expected validation, adding sections the shell can't render silently breaks UX.
 */
export function validateManifest(m: PluginManifest): string[] {
  const problems: string[] = [];

  if (!/^[a-z0-9-]+$/.test(m.id)) {
    problems.push(`${m.name}: id must be [a-z0-9-]`);
  }
  if (m.routes.length === 0) {
    problems.push(`${m.id}: a plugin needs at least one route`);
  }

  // Nav contribution sanity: order must be >= 0, and status-dot plugins are expected to
  // eventually render a status (warn-only in Phase 1).
  if (m.nav) {
    if (m.nav.order < 0) problems.push(`${m.id}: nav.order must be >= 0`);
    if (m.nav.badge === "status-dot") {
      // Status dots are only valid on a *pinnable* nav item.
      if (m.core) problems.push(`${m.id}: core nav items cannot carry a status-dot`);
    }
  }

  return problems;
}