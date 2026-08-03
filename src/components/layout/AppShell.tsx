/**
 * Main layout wrapper: sidebar + top bar + scrollable content region.
 *
 * Owns two pieces of shell-level state:
 *  - `collapsed` — sidebar collapse, toggled by the top-bar button and `Ctrl+B`.
 *  - search-modal open flag — reserved for the Ctrl+K SearchModal (Section 8);
 *    the shortcut is registered here now so the wiring is ready when the modal lands.
 *
 * Semantics (web-design-guidelines): <aside> sidebar, <header> top bar, <main>
 * content landmark. The content region is the only scroll container (body is
 * `overflow:hidden` in index.css) and uses `.scroll-thin`.
 */

import { useCallback, useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { subscribeFullscreen } from "../../lib/fullscreen";
import Sidebar from "./Sidebar";
import GlobalTopBar from "./GlobalTopBar";
import SearchModal from "../ui/SearchModal";
import ToastHost from "../ui/ToastHost";
import AddFolderModal from "../wizard/AddFolderModal";
import MiniPlayer from "../player/MiniPlayer";
import { useMiniPlayer } from "../../lib/miniPlayerStore";
import { usePerf } from "../../lib/perfStore";
import { useTaskReminders } from "../useTaskReminders";
import { useBlockReminders } from "../../lib/scheduleReminders";
import { usePluginBoot } from "../../lib/plugins/boot";

export default function AppShell() {
  const [collapsed, setCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [appFullscreen, setAppFullscreen] = useState(false);
  const location = useLocation();
  // Docked mini-player rect — used to punch a transparent notch through the opaque
  // ambient canvas so the MPV surface (behind the webview) shows through the mini card.
  const miniRect = useMiniPlayer((s) => s.rect);

  // Reconcile the performance tier with the DB-backed preference once on mount. The tier
  // was already applied to <html> pre-paint from the localStorage mirror (main.tsx); this
  // confirms it against the source-of-truth setting and corrects it if they diverged.
  const hydratePerf = usePerf((s) => s.hydrate);
  useEffect(() => {
    void hydratePerf();
  }, [hydratePerf]);

  // App-wide reminders. Both are event-driven off the shared minute clock (no polling) and
  // deduped through the durable `reminder_state` ledger, so nothing re-fires after a restart.
  // They live here rather than on the Planning page because a reminder that only arrives while
  // you're already looking at your schedule isn't a reminder.
  useTaskReminders();
  useBlockReminders();

  // Run each plugin's `init` contribution once per launch. This is what makes a plugin's
  // nav chrome (e.g. Telegram's connected dot) accurate before its page is ever opened;
  // the shell stays plugin-agnostic because it only walks the registry.
  usePluginBoot();

  // On the player route, force the sidebar into minimized (icon-only) mode for the
  // immersive 3-column layout. The user can still toggle it; this just sets the
  // initial state when entering/leaving the player.
  const isPlayerRoute = location.pathname.includes("/library/material/");
  const sidebarCollapsed = collapsed;

  // Enter the player in icon-only mode once; the visible toggle remains functional.
  useEffect(() => {
    if (isPlayerRoute) setCollapsed(true);
  }, [isPlayerRoute]);

  const toggleSidebar = useCallback(() => setCollapsed((c) => !c), []);
  const toggleSearch = useCallback(() => setSearchOpen((o) => !o), []);
  const openSearch = useCallback(() => setSearchOpen(true), []);
  const closeSearch = useCallback(() => setSearchOpen(false), []);

  // Global shortcuts: Ctrl+B toggles the sidebar, Ctrl+K toggles search.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
      } else if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        toggleSearch();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSidebar, toggleSearch]);

  // When the Tauri window goes fullscreen (triggered by the player's Fullscreen
  // button), hide the sidebar + top bar entirely so the transparent video anchor
  // can fill the screen with no chrome bleeding through. Esc (OS-handled) exits.
  // Uses the shared, debounced fullscreen source (one window listener app-wide) instead
  // of a per-component onResized poll — that de-duplicates the IPC storm during the
  // fullscreen animation that used to cause the transition lag.
  useEffect(() => subscribeFullscreen(setAppFullscreen), []);

  // Chrome is only sacrificed for the VIDEO. Fullscreen exists so the transparent mpv anchor can
  // fill the screen, which is a player concern — but the suppression was written app-wide, while
  // the sidebar's (below) was already correctly scoped to the player route. The asymmetry was the
  // bug: F11 or a title-bar double-click on Today / Planner / Library / Dashboard removed the top
  // bar, and with it the running focus timer, with no video on screen to justify it. Scoped here
  // so the timer survives fullscreen everywhere it isn't covering a video.
  const immersive = appFullscreen && isPlayerRoute;

  // The Player route keeps the transparent shell + flush opaque sidebar (libmpv
  // renders behind the webview, so a floating panel / ambient canvas can't sit over
  // it). Every other route gets the unified cinematic canvas + a floating sidebar.
  const floating = !isPlayerRoute;

  return (
    <div 
      className="relative flex h-full w-full overflow-hidden"
      style={
        miniRect
          ? {
              clipPath: `polygon(
                0% 0%, 
                100% 0%, 
                100% 100%, 
                0% 100%, 
                0% ${miniRect.y}px, 
                ${miniRect.x}px ${miniRect.y}px, 
                ${miniRect.x}px ${miniRect.y + miniRect.h}px, 
                ${miniRect.x + miniRect.w}px ${miniRect.y + miniRect.h}px, 
                ${miniRect.x + miniRect.w}px ${miniRect.y}px, 
                0% ${miniRect.y}px
              )`,
            }
          : undefined
      }
    >
      {/* ── Unified app canvas (non-player only) ──────────────────────────────
          One dark gradient + two cinematic lime/cyan blobs behind the whole app, so
          the floating sidebar + pages hover over a single continuous background. The
          player route omits this (its window stays transparent for the mpv overlay).

          When the docked mini-player is active, we punch a transparent notch through
          the entire AppShell (via clip-path on the root) so MPV's native surface (behind
          the webview) shows through the mini card, cutting out overlapping page content. */}
      {floating && !immersive && (
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
          <div className="absolute inset-0 -z-20 bg-gradient-to-br from-[#0C0C0C] to-[#050505]" />
          {/* The two blur blobs are the premium ambient finish. `perf-blob` lets the tier
              CSS (index.css) shrink their blur radius on balanced and drop them on lite,
              where large-radius blurs are too costly for a weak GPU. */}
          <div className="perf-blob absolute left-[-8%] top-[-12%] -z-10 h-[55%] w-[42%] rounded-full bg-lime/10 blur-[150px]" />
          <div className="perf-blob absolute bottom-[-14%] right-[-6%] -z-10 h-[50%] w-[38%] rounded-full bg-cyan-400/10 blur-[140px]" />
        </div>
      )}

      {/* Sidebar — hidden only in immersive playback (so the video anchor fills the screen).
          Otherwise minimized on the player route. */}
      {!immersive && (
        <Sidebar collapsed={sidebarCollapsed} onOpenSearch={openSearch} floating={floating} />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* One universal top bar on every route — and therefore the running focus timer, which is
            the single piece of app state a student most needs to keep seeing while they work. It
            is a flex sibling ABOVE the scroll container, so it stays fixed while content scrolls.
            The strip is fully transparent on every route (only the three glass pills float),
            including the video/PDF player. Hidden ONLY in immersive playback: covering a
            fullscreen video is the one case where the timer costs more than it gives, and the
            mini-player carries the thread back. */}
        {!immersive && (
          <GlobalTopBar
            sidebarCollapsed={sidebarCollapsed}
            onToggleSidebar={toggleSidebar}
            onOpenSearch={openSearch}
          />
        )}

        {/* Content — transparent + NO padding here. On the floating canvas, pages are
            transparent so the unified background shows through; the player page leaves
            its video viewport transparent for the mpv overlay.

            Scroll ownership: on the PLAYER route the main region does NOT scroll — the
            player uses a strict full-height layout and its columns scroll internally.
            This is the key fix for the mpv scroll-lag: the transparent video anchor never
            moves on scroll, so mpv never needs re-alignment mid-scroll. Every other route
            keeps the single page scroll container. */}
        <main
          className={
            isPlayerRoute
              ? "min-h-0 flex-1 overflow-hidden"
              : "scroll-thin min-h-0 flex-1 overflow-y-auto"
          }
        >
          <Outlet />
        </main>
      </div>

      <SearchModal open={searchOpen} onClose={closeSearch} />
      <AddFolderModal />
      <MiniPlayer />
      <ToastHost />
    </div>
  );
}
