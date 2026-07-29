/**
 * Launch-source tracking for the shared Player route.
 *
 * The player (`/library/material/:materialId`) is reachable from two parallel
 * browsing surfaces — the classic Library tree and the premium Courses view — so the
 * player can't tell from the URL alone which surface launched it. Launchers pass
 * `{ source: "courses" }` through React Router location state; every reader
 * (PlayerPage breadcrumbs, Sidebar active tab) defaults to the Library tree when the
 * state is absent (deep links, hard refresh, Dashboard/Search launches).
 *
 * Note: location state is preserved across browser Back/Forward (it's stored in the
 * history entry) but not across a hard reload or a bookmark — those fall back to the
 * Library default, which is the safe behaviour.
 */

import type { Location } from "react-router-dom";

/** Where the player was launched from. */
export type NavSource = "courses" | "library";

/** Read the launch source from a router location (defaults to the Library tree). */
export function navSource(location: Location): NavSource {
  const source = (location.state as { source?: string } | null)?.source;
  return source === "courses" ? "courses" : "library";
}

/**
 * Build the `navigate()` options object that carries the source forward. Player-to-
 * player jumps (sibling clicks, N/P shortcuts) must re-pass the state, otherwise the
 * context is silently dropped on the next history entry.
 */
export function withSource(source: NavSource): { state: { source: NavSource } } {
  return { state: { source } };
}
