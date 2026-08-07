/**
 * Telegram plugin manifest — the contribution-point contract.
 *
 * This file is the whole contract the shell needs to know about Telegram. Declaring the
 * manifest here is what makes the `/plugins` hub, the primary-sidebar nav item (pinnable),
 * the route, the Settings section and the boot hydration "just work" — the shell
 * (`registry.ts`) never hard-codes Telegram.
 *
 * Phase 3 adds, on top of the Phase 2 skeleton:
 *   · `settingsSections` — the api_id / api_hash form, without which Connect cannot work at
 *     all (Telegram requires per-app credentials);
 *   · `init` — one `tg_check_auth` on boot, so the nav status dot is live before the page
 *     has ever been opened.
 *
 * The `sourceAdapter` (material streaming adapter) still lands in Phase 5 alongside the
 * streaming backend — intentionally absent here.
 */

import type { PluginManifest } from "../../lib/plugins/types";
import { TelegramIcon } from "../../components/ui/TelegramIcon";
import { createElement, lazy, Suspense } from "react";
import { useAuth } from "./authStore";

/**
 * The settings form is lazy for the same reason the page is: this manifest is imported by
 * the registry, which the Sidebar pulls into the main bundle. A top-level import would drag
 * the form (and its icons) into the initial chunk to render a panel most launches never open.
 */
const TelegramSettings = lazy(() => import("./TelegramSettings"));

/** The stable plugin id — MUST match the Rust command prefix (`tg_*`). */
export const TELEGRAM_PLUGIN_ID = "telegram";

export const telegramManifest: PluginManifest = {
  id: TELEGRAM_PLUGIN_ID,
  name: "Telegram",
  version: "0.3.0",
  description: "Stream and import private-channel media from your Telegram account.",
  icon: TelegramIcon,
  // A plugin in the sidebar is a *preference*, not a constant — Telegram starts unpinned
  // so a fresh install leaves the nav untouched; the hub + Settings let the user pin it.
  // (Open decision #2 in telegram.md: consider auto-pinning after the first Connect.)
  nav: {
    defaultPinned: false,
    // order 3 slots it between Planning (2) and the Settings item.
    order: 3,
    // Telegram renders a live connected/offline dot on its nav item. The component is
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
  // Rendered by the Settings page's Plugins category through the registry, so Settings
  // never imports this plugin.
  settingsSections: [
    {
      id: "credentials",
      render: () =>
        createElement(Suspense, { fallback: null }, createElement(TelegramSettings)),
    },
  ],
  // One cheap auth check at boot. Without it the nav dot stays gray until the user opens the
  // page — precisely the trip the dot exists to save them.
  init: () => useAuth.getState().hydrate(),
  // The shell's StatusDot calls this; the Zustand selector is what makes the dot live.
  // `connecting`/`needs_password` map to "unknown" rather than "disconnected": a login in
  // flight is neither, and flashing gray mid-flow would read as a failure.
  useStatus: () =>
    useAuth((s) =>
      s.status === "connected"
        ? "connected"
        : s.status === "disconnected"
          ? "disconnected"
          : "unknown"
    ),
  // Declared for the manifest↔prefix contract in `validateManifest`.
  commands: [
    "tg_get_api_credentials",
    "tg_set_api_credentials",
    "tg_check_auth",
    "tg_request_code",
    "tg_sign_in",
    "tg_sign_in_2fa",
    "tg_sign_out",
    "tg_get_me",
  ],
  capabilities: ["auth", "network", "media"],
};
