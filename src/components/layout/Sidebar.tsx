/**
 * Primary navigation sidebar.
 *
 * Design DNA (Section 7): narrow, dark, icon + text. The active item gets a neon
 * lime pill background. Collapsible via `Ctrl+B` (handled in AppShell) — collapsed
 * mode shows icons only.
 *
 * Accessibility (web-design-guidelines): semantic <nav>, <ul>/<li> list, roving
 * arrow-key navigation between items, accent focus-visible ring (from index.css),
 * and `aria-current="page"` on the active link. Icons are aria-hidden; the text
 * label (or aria-label when collapsed) names each link.
 *
 * The bottom of the rail carries the ambient `StudyMeter` (today's real time on task). It is
 * deliberately the LAST thing in the column: navigation is what this surface is for, and a
 * progress readout that displaced it would trade the primary job for a secondary one.
 */

import { useEffect, useRef } from "react";
import { Link, matchPath, useLocation } from "react-router-dom";
import StudyMeter from "./StudyMeter";
import { GraduationIcon, SearchIcon } from "../ui/icons";
import { usePins } from "../../lib/plugins/pinStore";
import { useNavItems } from "../../lib/plugins/nav";
import { navSource } from "../../lib/navigation";
import { cn } from "../../lib/utils";

interface SidebarProps {
  collapsed: boolean;
  /** Opens the global search modal (Ctrl+K). Wired when SearchModal lands. */
  onOpenSearch?: () => void;
  /**
   * Floating mode: detached glass panel hovering over the unified app canvas
   * (all routes except the player, which keeps a flush opaque column so the
   * transparent mpv window doesn't bleed the desktop through the sidebar).
   */
  floating?: boolean;
}

export default function Sidebar({ collapsed, onOpenSearch, floating = true }: SidebarProps) {
  const listRef = useRef<HTMLUListElement>(null);
  const location = useLocation();
  const navItems = useNavItems();
  const hydrate = usePins((s) => s.hydrate);

  // Hydrate plugin pin state once on mount (the store dedupes); keeps the nav in sync
  // with the persisted settings table after a restart.
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Context-aware active state. The Player route (/library/material/:id) is a prefix
  // match for the Library tab, so a player launched from Courses would light up
  // "Library" — wrong surface. When the location state says the player came from
  // Courses, the Courses tab is active instead.
  const playerFromCourses =
    matchPath("/library/material/*", location.pathname) != null &&
    navSource(location) === "courses";

  const isItemActive = (item: { to: string; end?: boolean }): boolean => {
    const base = item.end
      ? location.pathname === item.to
      : location.pathname === item.to || location.pathname.startsWith(item.to + "/");
    if (playerFromCourses) {
      if (item.to === "/courses") return true;
      if (item.to === "/library") return false;
    }
    return base;
  };

  // Roving focus: Up/Down move between nav links, Home/End jump to ends.
  function onKeyDown(e: React.KeyboardEvent<HTMLUListElement>) {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(e.key)) return;
    const links = Array.from(
      listRef.current?.querySelectorAll<HTMLAnchorElement>("a[href]") ?? []
    );
    if (links.length === 0) return;
    const idx = links.findIndex((el) => el === document.activeElement);
    e.preventDefault();
    let next = idx;
    if (e.key === "ArrowDown") next = idx < 0 ? 0 : (idx + 1) % links.length;
    else if (e.key === "ArrowUp") next = idx <= 0 ? links.length - 1 : idx - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = links.length - 1;
    links[next]?.focus();
  }

  return (
    <aside
      className={cn(
        "flex flex-col gap-2 transition-[width] duration-300 ease-smooth",
        collapsed ? "w-[96px]" : "w-72",
        floating
          ? // Floating glass panel: detached with margin, heavily rounded, frosted,
            // 1px inner border + inner sheen + heavy tinted shadow (ui-ux-pro-max).
            "m-4 h-[calc(100vh-2rem)] rounded-[32px] border border-white/[0.05] bg-white/[0.02] p-4 shadow-2xl backdrop-blur-xl [box-shadow:0_24px_60px_-12px_rgba(0,0,0,0.6),inset_0_1px_1px_rgba(255,255,255,0.06)]"
          : // Flush column (player route): opaque so the transparent mpv window
            // doesn't show the desktop through the sidebar.
            "h-full rounded-none border-y-0 border-l-0 border-r border-glass-border bg-ink-900 p-4"
      )}
    >
      {/* Brand */}
      <div className={cn("flex items-center gap-2.5 px-2 py-3", collapsed && "justify-center")}>
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-btn bg-lime/15 text-lime shadow-glow-lime">
          <GraduationIcon />
        </span>
        {!collapsed && (
          <div className="min-w-0 leading-tight">
            <div className="truncate text-sm font-semibold text-content-primary">PLE</div>
            <div className="truncate text-[11px] text-content-muted">Learning Environment</div>
          </div>
        )}
      </div>

      {/* Search launcher (opens Ctrl+K modal) */}
      <button
        type="button"
        onClick={onOpenSearch}
        aria-label="Search materials (Ctrl+K)"
        className={cn(
          "group flex items-center gap-2.5 rounded-btn border border-glass-border bg-white/[0.02] px-2.5 py-2 text-sm text-content-secondary transition-colors hover:bg-white/[0.05] hover:text-content-primary",
          collapsed && "justify-center px-0"
        )}
      >
        <SearchIcon className="shrink-0 text-content-muted group-hover:text-content-secondary" />
        {!collapsed && (
          <>
            <span className="flex-1 text-left">Search</span>
            <kbd className="rounded border border-glass-border px-1.5 py-0.5 font-mono text-[10px] text-content-muted">
              Ctrl K
            </kbd>
          </>
        )}
      </button>

      {/* Primary nav */}
      <nav aria-label="Primary" className="mt-4">
        <ul ref={listRef} onKeyDown={onKeyDown} className="flex flex-col gap-4">
          {navItems.map((item) => {
            const { to, label, icon: Icon } = item;
            const active = isItemActive(item);
            return (
              <li key={to}>
                <Link
                  to={to}
                  title={collapsed ? label : undefined}
                  aria-label={collapsed ? label : undefined}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "group relative flex items-center gap-4 rounded-2xl px-4 py-3 text-[15px] font-medium transition-all duration-200",
                    collapsed && "justify-center px-0",
                    active
                      ? // Subtle glass pill (not a heavy solid fill): translucent white
                        // with an inner top sheen; the icon glows lime instead.
                        "bg-white/[0.05] text-content-primary shadow-[inset_0_1px_1px_rgba(255,255,255,0.1)]"
                      : "text-content-secondary hover:bg-white/[0.04] hover:text-content-primary"
                  )}
                >
                  {/* Active accent line — a soft glowing lime indicator on the left edge. */}
                  {active && !collapsed && (
                    <span
                      aria-hidden
                      className="absolute left-1.5 top-1/2 h-5 w-1 -translate-y-1/2 rounded-full bg-lime shadow-glow-lime"
                    />
                  )}
                  <Icon
                    className={cn(
                      "shrink-0 w-7 h-7 transition-colors duration-200",
                      active
                        ? "text-lime [filter:drop-shadow(0_0_6px_rgba(170,255,0,0.55))]"
                        : "text-current"
                    )}
                  />
                  {!collapsed && <span className="truncate">{label}</span>}
                  {/* Plugin status dot (e.g. Telegram connected/offline) — only when the
                      plugin's manifest declares `badge: "status-dot"`. */}
                  {item.statusDot && (
                    <item.statusDot pluginId={item.pluginId!} collapsed={collapsed} />
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Study meter + footer.
          Pinned to the bottom (`mt-auto`) and BELOW the nav on purpose: it is ambient feedback,
          not a destination, so it must never push navigation off-centre or compete with it for
          the eye. It adapts to `collapsed` itself — see StudyMeter. */}
      <div className="mt-auto">
        <StudyMeter collapsed={collapsed} />
        <div className="px-2 pb-1 pt-3">
          {!collapsed && (
            <div className="text-[11px] text-content-faint">v0.1.0 · local-first</div>
          )}
        </div>
      </div>
    </aside>
  );
}
