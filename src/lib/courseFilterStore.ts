/**
 * courseFilterStore — the single source of truth for course material filtering
 * (Tab: "all" | "lectures" | "notes", Source: "all" | "cloud" | "offline").
 *
 * Used across both:
 * 1. CoursesPage (folder navigation, breadcrumbs, forward/backward)
 * 2. LessonOverview (video player sidebar playlist, switching between lessons)
 *
 * Persisted to localStorage so filter preferences are retained across video switches,
 * folder transitions, and page reloads.
 */

import { create } from "zustand";

export type CourseTabFilter = "all" | "lectures" | "notes";
export type CourseSourceFilter = "all" | "cloud" | "offline";

const TAB_STORAGE_KEY = "ple.course.activeTab";
const FILTER_STORAGE_KEY = "ple.course.activeFilter";

const VALID_TABS: readonly CourseTabFilter[] = ["all", "lectures", "notes"] as const;
const VALID_FILTERS: readonly CourseSourceFilter[] = ["all", "cloud", "offline"] as const;

function getInitialTab(): CourseTabFilter {
  try {
    const saved = localStorage.getItem(TAB_STORAGE_KEY);
    if (saved && (VALID_TABS as readonly string[]).includes(saved)) {
      return saved as CourseTabFilter;
    }
  } catch {
    // localStorage unavailable or restricted
  }
  return "all";
}

function getInitialFilter(): CourseSourceFilter {
  try {
    const saved = localStorage.getItem(FILTER_STORAGE_KEY);
    if (saved && (VALID_FILTERS as readonly string[]).includes(saved)) {
      return saved as CourseSourceFilter;
    }
  } catch {
    // localStorage unavailable or restricted
  }
  return "all";
}

interface CourseFilterState {
  activeTab: CourseTabFilter;
  activeFilter: CourseSourceFilter;
  setActiveTab: (tab: CourseTabFilter) => void;
  setActiveFilter: (filter: CourseSourceFilter) => void;
}

export const useCourseFilterStore = create<CourseFilterState>((set) => ({
  activeTab: getInitialTab(),
  activeFilter: getInitialFilter(),

  setActiveTab: (tab: CourseTabFilter) => {
    try {
      localStorage.setItem(TAB_STORAGE_KEY, tab);
    } catch {
      // ignore
    }
    set({ activeTab: tab });
  },

  setActiveFilter: (filter: CourseSourceFilter) => {
    try {
      localStorage.setItem(FILTER_STORAGE_KEY, filter);
    } catch {
      // ignore
    }
    set({ activeFilter: filter });
  },
}));
