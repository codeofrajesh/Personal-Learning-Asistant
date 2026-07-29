/**
 * Dashboard layout configuration — the lightweight (no-dependency) customization
 * layer for the bento grid. Users show/hide and reorder widgets from Settings; the
 * config is persisted to a single `settings` DB row (`dashboard.layout`) so it rides
 * along in the app's export/backup (layout is user data, not cache).
 *
 * The registry below is the SINGLE SOURCE OF TRUTH for which widgets exist, their
 * labels, their default order, and their grid span. `resolveLayout()` merges a saved
 * config over the registry so newly-added widgets appear automatically (appended,
 * visible) and removed ids are dropped — forward/backward compatible.
 */

import { ipc, isTauri } from "./ipc";

/** Stable ids for every dashboard widget. */
export type WidgetId =
  | "progress"
  | "current"
  | "activity"
  | "pomodoro"
  | "nextup"
  | "tasks"
  | "recent"
  | "quickaccess";

/** Registry entry: identity + presentation defaults. */
export interface WidgetMeta {
  id: WidgetId;
  /** Human label shown in the Settings customization list. */
  label: string;
  /** One-line description for the Settings list. */
  description: string;
  /** Column span on the lg 3-col grid (1 or 2). */
  span: 1 | 2;
}

/** One widget's saved state. */
export interface WidgetConfig {
  id: WidgetId;
  visible: boolean;
}

/** The persisted layout: an ordered list of {id, visible}. */
export type DashboardLayout = WidgetConfig[];

/** The setting key the layout JSON is stored under. */
export const LAYOUT_SETTING_KEY = "dashboard.layout";

/**
 * The widget registry, in default display order. Adding a widget here (and rendering
 * it in Dashboard) is all that's needed — it shows up in Settings and on the grid.
 */
export const WIDGET_REGISTRY: WidgetMeta[] = [
  { id: "progress", label: "Progress statistics", description: "Overall completion, in-progress, bookmarked", span: 1 },
  { id: "current", label: "Current course", description: "Resume your most recent lesson", span: 1 },
  { id: "activity", label: "Activity", description: "Study hours across the last 7 days", span: 1 },
  { id: "pomodoro", label: "Focus timer", description: "Pomodoro focus/break timer with cycle tracking", span: 1 },
  { id: "nextup", label: "Next up", description: "The next unstarted lesson in each course", span: 1 },
  { id: "tasks", label: "To-do list", description: "Tasks with due dates, priority, and material links", span: 1 },
  { id: "recent", label: "Recent", description: "Recently opened lessons, quick-resume", span: 2 },
  { id: "quickaccess", label: "Quick access", description: "Your bookmarked materials", span: 1 },
];

/** The default layout (everything visible, registry order). */
export function defaultLayout(): DashboardLayout {
  return WIDGET_REGISTRY.map((w) => ({ id: w.id, visible: true }));
}

/**
 * Merge a saved (possibly stale) config over the registry: keeps the saved order +
 * visibility for known ids, drops unknown ids, and appends any new registry widgets
 * (visible) at the end. Guarantees the result covers exactly the current registry.
 */
export function resolveLayout(saved: DashboardLayout | null): DashboardLayout {
  const known = new Set(WIDGET_REGISTRY.map((w) => w.id));
  const seen = new Set<WidgetId>();
  const out: DashboardLayout = [];

  if (saved) {
    for (const item of saved) {
      if (known.has(item.id) && !seen.has(item.id)) {
        out.push({ id: item.id, visible: item.visible !== false });
        seen.add(item.id);
      }
    }
  }
  // Append any registry widgets not present in the saved config (new widgets).
  for (const w of WIDGET_REGISTRY) {
    if (!seen.has(w.id)) out.push({ id: w.id, visible: true });
  }
  return out;
}

/** Look up a widget's metadata by id. */
export function widgetMeta(id: WidgetId): WidgetMeta | undefined {
  return WIDGET_REGISTRY.find((w) => w.id === id);
}

/** Read + resolve the saved layout (falls back to defaults outside Tauri / on error). */
export async function loadLayout(): Promise<DashboardLayout> {
  if (!isTauri()) return defaultLayout();
  try {
    const raw = await ipc.getSetting(LAYOUT_SETTING_KEY);
    if (!raw) return defaultLayout();
    const parsed = JSON.parse(raw) as DashboardLayout;
    if (!Array.isArray(parsed)) return defaultLayout();
    return resolveLayout(parsed);
  } catch {
    return defaultLayout();
  }
}

/** Persist the layout to the settings row (no-op outside Tauri). */
export async function saveLayout(layout: DashboardLayout): Promise<void> {
  if (!isTauri()) return;
  await ipc.setSetting(LAYOUT_SETTING_KEY, JSON.stringify(layout));
}
