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
import { getCurrentWindow } from "@tauri-apps/api/window";
import Sidebar from "./Sidebar";
import GlobalTopBar from "./GlobalTopBar";
import SearchModal from "../ui/SearchModal";
import ToastHost from "../ui/ToastHost";
import AddFolderModal from "../wizard/AddFolderModal";
import MiniPlayer from "../player/MiniPlayer";
import { useMiniPlayer } from "../../lib/miniPlayerStore";
import { useTaskReminders } from "../useTaskReminders";

export default function AppShell() {
  const [collapsed, setCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [appFullscreen, setAppFullscreen] = useState(false);
  const location = useLocation();
  // Docked mini-player rect — used to punch a transparent notch through the opaque
  // ambient canvas so the MPV surface (behind the webview) shows through the mini card.
  const miniRect = useMiniPlayer((s) => s.rect);

  // App-wide task-deadline reminders (low-CPU 60s poll; deduped toasts).
  useTaskReminders();

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
  // Tauri v2 has no dedicated fullscreen event; onResized fires on the size change
  // a fullscreen transition causes, so re-read isFullscreen() there.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const onChange = async () => {
      try {
        setAppFullscreen(await getCurrentWindow().isFullscreen());
      } catch {
        /* ignore */
      }
    };
    void onChange();
    const onFullscreenEvent = (event: Event) => setAppFullscreen(Boolean((event as CustomEvent).detail));
    window.addEventListener("app-fullscreen-changed", onFullscreenEvent);
    getCurrentWindow()
      .onResized(() => void onChange())
      .then((u) => (unlisten = u))
      .catch(() => {});
    return () => {
      unlisten?.();
      window.removeEventListener("app-fullscreen-changed", onFullscreenEvent);
    };
  }, []);

  // The Player route keeps the transparent shell + flush opaque sidebar (libmpv
  // renders behind the webview, so a floating panel / ambient canvas can't sit over
  // it). Every other route gets the unified cinematic canvas + a floating sidebar.
  const floating = !isPlayerRoute;

  return (
    <div className="relative flex h-full w-full overflow-hidden">
      {/* ── Unified app canvas (non-player only) ──────────────────────────────
          One dark gradient + two cinematic lime/cyan blobs behind the whole app, so
          the floating sidebar + pages hover over a single continuous background. The
          player route omits this (its window stays transparent for the mpv overlay).

          When the docked mini-player is active, we punch a transparent notch through
          this canvas (via clip-path) so MPV's native surface (behind the webview) shows
          through the mini card. */}
      {floating && !appFullscreen && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10"
          style={
            miniRect
              ? {
                  clipPath: `polygon(
                    0 0,
                    100% 0,
                    100% ${miniRect.y}px,
                    ${miniRect.x + miniRect.w}px ${miniRect.y}px,
                    ${miniRect.x + miniRect.w}px ${miniRect.y + miniRect.h}px,
                    ${miniRect.x}px ${miniRect.y + miniRect.h}px,
                    ${miniRect.x}px ${miniRect.y}px,
                    0 ${miniRect.y}px
                  )`,
                }
              : undefined
          }
        >
          <div className="absolute inset-0 -z-20 bg-gradient-to-br from-[#0C0C0C] to-[#050505]" />
          <div className="absolute left-[-8%] top-[-12%] -z-10 h-[55%] w-[42%] rounded-full bg-lime/10 blur-[150px]" />
          <div className="absolute bottom-[-14%] right-[-6%] -z-10 h-[50%] w-[38%] rounded-full bg-cyan-400/10 blur-[140px]" />
        </div>
      )}

      {/* Sidebar — hidden entirely when the OS window is fullscreen (so the video
          anchor fills the screen). Otherwise minimized on the player route. */}
      {(!appFullscreen || !isPlayerRoute) && (
        <Sidebar collapsed={sidebarCollapsed} onOpenSearch={openSearch} floating={floating} />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* One universal top bar on every route (hidden only in OS fullscreen). It is a
            flex sibling ABOVE the scroll container, so it stays fixed while content
            scrolls. The strip is fully transparent on every route — only the three glass
            pills float — including the video/PDF player. */}
        {!appFullscreen && (
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
