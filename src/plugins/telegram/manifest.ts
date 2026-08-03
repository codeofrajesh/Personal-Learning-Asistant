/**
 * Telegram plugin manifest (Phase 2 — contribution-point skeleton).
 *
 * This file is the whole contract the shell needs to know about Telegram. Declaring
 * the manifest here is what makes the `/plugins` hub, the primary-sidebar nav item
 * (pinnable), the route, and the future settings/status contributions "just work" —
 * the shell (`registry.ts`) never hard-codes Telegram.
 *
 * Phase 2 deliberately ships the skeleton with ZERO backend:
 *   · a `/plugins/telegram` page with an honest empty state + disabled Connect button
 *     (auth lands in Phase 3);
 *   · a `status-dot` nav contribution rendered by the shared `TelegramStatusDot`
 *     (idle/offline state for now; wired live via authStore in Phase 3);
 *   · the `sourceAdapter` (material streaming adapter) is declared in Phase 5 alongside
 *     the streaming backend — intentionally absent here.
 *
 * The `capabilities` array is the coarse ACL grant the contract implies; a
 * `settingsSections` contribution for `api_id`/`api_hash`/`phone` config rides along
 * with the auth work.
 */

import type { PluginManifest } from "../../lib/plugins/types";
import { SendHorizontal } from "lucide-react";

/** The stable plugin id — MUST match the Rust command prefix (`tg_*`). */
export const TELEGRAM_PLUGIN_ID = "telegram";

export const telegramManifest: PluginManifest = {
  id: TELEGRAM_PLUGIN_ID,
  name: "Telegram",
  version: "0.2.0",
  description: "Stream and import private-channel media from your Telegram account.",
  icon: SendHorizontal,
  // A plugin in the sidebar is a *preference*, not a constant — Telegram starts unpinned
  // so a fresh install leaves the nav untouched; the hub + Settings let the user pin it.
  // (Open decision #2 in telegram.md: consider auto-pinning after the first Connect.)
  nav: {
    defaultPinned: false,
    // order 3 slots it between Planning (2) and the Settings item.
    order: 3,
    // Telegram may render a live connected/offline dot on its nav item. The component is
    // referenced declaration-style here; nav.ts resolves it generically from the registry.
    badge: "status-dot",
  },
  routes: [
    {
      path: "/plugins/telegram",
      // Code-split per the app's Section 15 rule: the page chunk is only fetched when the
      // route is first visited. `import("./TelegramPage")` (NOT a top-level import) is what
      // keeps the page in its own chunk — a top-level import here would defeat that.
      lazy: () => import("./TelegramPage"),
    },
  ],
  capabilities: ["auth", "network", "media"],
};

// The manifest exists for the shell to consume.
export {};