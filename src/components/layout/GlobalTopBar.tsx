/**
 * GlobalTopBar — the single, universal top bar rendered on every route.
 *
 * It is deliberately stripped to exactly THREE floating glass pills over an otherwise
 * transparent, empty bar:
 *   1. Left pill  — hamburger (toggles the sidebar) + the "Personal Learning
 *                   Environment" title.
 *   2. Timer      — the global Pomodoro `HeaderTimeBox`.
 *   3. Search     — the Ctrl+K search launcher.
 *
 * The bar is a flex sibling ABOVE the scroll container (`<main>` in AppShell), so it
 * stays put while page content scrolls beneath it — universally identical across pages.
 *
 * The strip itself is 100% transparent on EVERY route (including the video/PDF player):
 * only the three glass pills float. The bar is never rendered while the OS window is
 * fullscreen.
 */

import { HeaderTimeBox } from "./HeaderTimeBox";
import { MenuIcon, SearchIcon } from "../ui/icons";

interface GlobalTopBarProps {
  /** Current sidebar collapse state (for the toggle's aria-pressed/label). */
  sidebarCollapsed: boolean;
  /** Toggle the left sidebar (also Ctrl+B). */
  onToggleSidebar: () => void;
  /** Open the global search modal (also Ctrl+K). */
  onOpenSearch: () => void;
}

export default function GlobalTopBar({
  sidebarCollapsed,
  onToggleSidebar,
  onOpenSearch,
}: GlobalTopBarProps) {
  return (
    <header className="z-30 flex h-16 shrink-0 items-center justify-between gap-3 bg-transparent px-4 pt-3">
      {/* 1 — Left pill: sidebar toggle + app title */}
      <div className="flex min-w-0 items-center gap-1.5 rounded-full border border-white/[0.05] bg-white/[0.02] py-1.5 pl-1.5 pr-4 shadow-2xl backdrop-blur-xl [box-shadow:0_16px_40px_-12px_rgba(0,0,0,0.55),inset_0_1px_1px_rgba(255,255,255,0.06)]">
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-pressed={!sidebarCollapsed}
          title="Toggle sidebar (Ctrl+B)"
          className="grid h-9 w-9 place-items-center rounded-full text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content-primary"
        >
          <MenuIcon />
        </button>
        <span className="truncate text-sm font-medium text-content-secondary max-[1100px]:hidden">
          Personal Learning Environment
        </span>
      </div>

      {/* 2 + 3 — Timer + search launcher */}
      <div className="flex shrink-0 items-center gap-3">
        <HeaderTimeBox />
        <div className="flex items-center gap-1.5 rounded-full border border-white/[0.05] bg-white/[0.02] p-1.5 shadow-2xl backdrop-blur-xl [box-shadow:0_16px_40px_-12px_rgba(0,0,0,0.55),inset_0_1px_1px_rgba(255,255,255,0.06)]">
          <button
            type="button"
            onClick={onOpenSearch}
            aria-label="Search materials (Ctrl+K)"
            title="Search (Ctrl+K)"
            className="flex items-center gap-2 rounded-full px-3 py-1.5 text-sm text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content-primary"
          >
            <SearchIcon className="h-4 w-4 shrink-0" />
            <span className="hidden xl:inline">Search</span>
            <kbd className="ml-1 hidden rounded border border-glass-border px-1.5 py-0.5 font-mono text-[10px] text-content-muted xl:inline">
              Ctrl K
            </kbd>
          </button>
        </div>
      </div>
    </header>
  );
}
