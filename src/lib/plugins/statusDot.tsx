/**
 * PluginStatusDot — the shared `badge: "status-dot"` renderer for nav items.
 *
 * A plugin with `nav.badge === "status-dot"` may expose a live connected/offline indicator
 * on its sidebar item (Obsidian-ribbon-style chrome affordance). To stay generic, the
 * shell resolves the component from the registry and renders it with the plugin id; it
 * NEVER imports a plugin directly. Phase 2 ships the shared shell that renders the
 * idle/offline dot; Telegram's live state hooks in during Phase 3 via `authStore`.
 *
 * The dot is deliberate chrome, not a button — it must never intercept clicks from the
 * surrounding nav link, and it must look right in both the expanded and collapsed sidebar
 * (collapsed tucks the dot beside the icon).
 */

import { cn } from "../../lib/utils";

export type PluginStatus = "connected" | "disconnected" | "unknown";

/**
 * Resolve the live status for a plugin. Phase 2: everything reports "unknown" until the
 * plugin's own auth store wires in (Telegram → Phase 3). Kept as a seam so the Sidebar
 * and nav.ts stay plugin-agnostic.
 */
export function pluginStatus(id: string): PluginStatus {
  void id;
  // Phase 3: read from the plugin's auth store keyed by `id`.
  return "unknown";
}

/** A presentational status dot for a nav item. Resolves state from the plugin id. */
export function StatusDot({
  pluginId,
  collapsed,
}: {
  pluginId: string;
  collapsed?: boolean;
}) {
  const status = pluginStatus(pluginId);
  const tone =
    status === "connected"
      ? "bg-lime shadow-glow-lime"
      : status === "disconnected"
        ? "bg-white/25"
        : "bg-white/15"; // unknown / idle
  return (
    <span
      data-status-dot
      className={cn(
        "inline-flex shrink-0 items-center",
        collapsed ? "absolute right-1.5 top-1/2 -translate-y-1/2" : "ml-auto"
      )}
      title={status === "connected" ? "Connected" : status === "disconnected" ? "Disconnected" : "Not connected"}
    >
      <span className={cn("h-2 w-2 rounded-full", tone)} />
    </span>
  );
}