/**
 * Central navigation manifest for the primary sidebar.
 *
 * One source of truth for routes + icons so the Sidebar, breadcrumb labels, and
 * keyboard navigation all stay in sync. New top-level pages are added here.
 */

import type { ElementType } from "react";
import { GraduationCap, CalendarCheck } from "lucide-react";
import { DashboardIcon, LibraryIcon, SettingsIcon } from "../ui/icons";

export interface NavItem {
  /** Router path (also used as the React key). */
  to: string;
  /** Sidebar label + breadcrumb root label. */
  label: string;
  /** Leading icon — accepts both the project's inline SVG icons and lucide-react icons. */
  icon: ElementType;
  /** When true, only the exact path is "active" (used for the index route). */
  end?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Dashboard", icon: DashboardIcon, end: true },
  { to: "/courses", label: "Courses", icon: GraduationCap },
  { to: "/planning", label: "Planning", icon: CalendarCheck },
  { to: "/library", label: "Library", icon: LibraryIcon },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];
