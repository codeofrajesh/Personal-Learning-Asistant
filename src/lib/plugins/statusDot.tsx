/**
 * PluginStatusDot — the shared `badge: "status-dot"` renderer for nav items.
 *
 * A plugin with `nav.badge === "status-dot"` exposes a live connected/offline indicator on
 * its sidebar item (Obsidian-ribbon-style chrome affordance). The shell resolves the state
 * through the manifest's `useStatus` contribution and NEVER imports a plugin directly — an
 * earlier revision imported Telegram's `authStore` here, which quietly made the "generic"
 * shell depend on one specific plugin.
 *
 * `useStatus` is a hook, not a value, so the plugin picks its own subscription mechanism
 * (Zustand selector, context, polling) and the dot re-renders when that state changes.
 */

import { cn } from "../../lib/utils";
import { getPlugin } from "./registry";

export type PluginStatus = "connected" | "disconnected" | "unknown";

/** Human-readable label for each state. Color is never the only signal (a11y). */
const STATUS_LABEL: Record<PluginStatus, string> = {
  connected: "Connected",
  disconnected: "Not connected",
  unknown: "Checking…",
};

/** A presentational status dot for a nav item. Resolves state from the plugin's manifest. */
export function StatusDot({
  pluginId,
  collapsed,
}: {
  pluginId: string;
  collapsed?: boolean;
}) {
  const manifest = getPlugin(pluginId);
  // A manifest is stable for the process lifetime, so this hook is never conditionally
  // swapped between renders — the identity of `useStatus` can't change under us.
  const status: PluginStatus = manifest?.useStatus?.() ?? "unknown";

  const tone =
    status === "connected"
      ? "bg-lime shadow-glow-lime"
      : status === "disconnected"
        ? "bg-white/25"
        : "bg-white/15"; // unknown / idle

  const label = STATUS_LABEL[status];

  return (
    <span
      data-status-dot
      className={cn(
        "inline-flex shrink-0 items-center",
        collapsed ? "absolute right-1.5 top-1/2 -translate-y-1/2" : "ml-auto"
      )}
      title={label}
    >
      <span className={cn("h-2 w-2 rounded-full", tone)} />
      {/* The nav link's own label carries the name; this adds the state for screen readers
          so the dot isn't a color-only signal. */}
      <span className="sr-only">{label}</span>
    </span>
  );
}
