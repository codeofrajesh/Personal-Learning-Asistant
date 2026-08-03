/**
 * usePluginBoot — runs every registered plugin's `init` contribution once per app launch.
 *
 * Mounted in `AppShell` alongside `hydratePerf` / the reminder hooks. This exists so a
 * plugin can hydrate the state its *chrome* depends on (Telegram's nav status dot) without
 * the shell knowing which plugin needs it — the alternative was importing `authStore` into
 * AppShell, which would re-couple the shell to a specific plugin.
 *
 * `init` failures are swallowed per-plugin: a plugin that can't reach its backend must not
 * take the app's boot path down with it.
 */

import { useEffect } from "react";
import { getPlugins } from "./registry";

export function usePluginBoot(): void {
  useEffect(() => {
    // Registry contents are static for the process lifetime, so this really is once-per-boot.
    for (const plugin of getPlugins()) {
      if (!plugin.init) continue;
      try {
        const result = plugin.init();
        if (result instanceof Promise) {
          result.catch((e) => {
            // eslint-disable-next-line no-console
            console.error(`[plugins] ${plugin.id}: init failed`, e);
          });
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[plugins] ${plugin.id}: init threw`, e);
      }
    }
  }, []);
}
