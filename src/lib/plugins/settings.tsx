/**
 * PluginSettingsRegistry — settings sections contributed by plugins.
 *
 * The Settings page has a built-in "Plugins" category. Plugins may ALSO contribute their
 * own settings sections; in Phase 1 (no external plugins registered yet) the management
 * category is the whole surface, and Phase 2's Telegram manifest contributes its config.
 *
 * Rather than a callback-injection dance, this keeps things data-driven: the Settings
 * page imports `getPluginContributedSections()` and renders whatever plugins declared,
 * so adding a plugin section never touches the Settings page again.
 */

import type { ReactNode } from "react";
import { getPlugins } from "./registry";

/** A contributed settings section. */
export interface ContributedSettingsSection {
  /** The plugin that owns this section. */
  pluginId: string;
  /** Stable key for React list rendering. */
  id: string;
  /** Rendered inside the Settings content panel. */
  render: () => ReactNode;
}

/** All settings sections contributed by every plugin (excludes core). */
export function getPluginSettingsSections(): ContributedSettingsSection[] {
  const sections: ContributedSettingsSection[] = [];
  for (const p of getPlugins()) {
    if (p.core) continue;
    for (const s of p.settingsSections ?? []) {
      sections.push({ pluginId: p.id, id: `${p.id}.${s.id}`, render: s.render });
    }
  }
  return sections;
}

/** Whether any plugin contributes settings sections (so Settings can show a hint). */
export function hasPluginSettingsSections(): boolean {
  return getPluginSettingsSections().length > 0;
}