/**
 * Typed wrapper around Tauri's `invoke`.
 *
 * Centralizing IPC here gives us: (1) one place to add logging/retry, (2) a clean
 * `isTauri` guard so the UI degrades gracefully when opened in a plain browser
 * (e.g. `vite` preview outside the Tauri shell), instead of throwing on a missing
 * global, and (3) end-to-end typing via `src/lib/types.ts`.
 */

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type {
  ChapterView,
  ConsistencySummary,
  CourseView,
  DashboardData,
  FolderPreview,
  GoalSummary,
  GoalView,
  HealthReport,
  ImportResult,
  ImportSummary,
  Note,
  PlayerView,
  RegisteredDir,
  RescanCounts,
  ScanProgress,
  SearchResult,
  SubjectView,
  Task,
  WizardImport,
} from "./types";

/** True when running inside the Tauri webview (the IPC bridge is present). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Raised when an IPC command is attempted outside the Tauri runtime. */
export class NotInTauriError extends Error {
  constructor(command: string) {
    super(`IPC command "${command}" is only available inside the Tauri app.`);
    this.name = "NotInTauriError";
  }
}

/** Low-level typed invoke. Throws `NotInTauriError` when not in the Tauri shell. */
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new NotInTauriError(command);
  return invoke<T>(command, args);
}

export const ipc = {
  /**
   * Roundtrip smoke test: React → Tauri → Rust → SQLite (write) → (read) → back.
   * A resolved value proves the whole backend stack is live.
   */
  healthCheck(token: string): Promise<HealthReport> {
    return call<HealthReport>("health_check", { token });
  },

  /** Dry-run a folder: preview the sub-folder → chapter mapping (no DB writes). */
  previewFolder(path: string): Promise<FolderPreview> {
    return call<FolderPreview>("preview_folder", { path });
  },

  /** Import a folder: create goal/subject, scan, batch-insert materials. */
  scanAndImport(input: WizardImport): Promise<ImportResult> {
    return call<ImportResult>("scan_and_import", { import: input });
  },

  /** Goals-with-counts feed for the Library grid. */
  listLibrary(): Promise<GoalSummary[]> {
    return call<GoalSummary[]>("list_library");
  },

  /** Run library-wide metadata extraction (OCR/embeddings). */
  extractLibraryMetadata(): Promise<void> {
    return call<void>("extract_library_metadata");
  },

  /** Aggregated Dashboard payload (stats, continue-learning, activity, streak). */
  dashboardData(): Promise<DashboardData> {
    return call<DashboardData>("dashboard_data");
  },

  /** Goal page: header + its subjects grid. */
  goalView(goalId: number): Promise<GoalView> {
    return call<GoalView>("goal_view", { goalId });
  },

  /** Subject page: header (+ parent goal) + its chapters list. */
  subjectView(subjectId: number): Promise<SubjectView> {
    return call<SubjectView>("subject_view", { subjectId });
  },

  /** Chapter page: header (+ full ancestry) + its materials list. */
  chapterView(chapterId: number): Promise<ChapterView> {
    return call<ChapterView>("chapter_view", { chapterId });
  },

  /** Course detail page: subject header + chapters + a flattened, sequence-ordered
   *  lesson list + a subject-wide rollup (Courses re-architecture, Step 4). */
  courseView(subjectId: number): Promise<CourseView> {
    return call<CourseView>("course_view", { subjectId });
  },

  /** Goal id of the most recently watched material, or null if nothing opened.
   *  Used by the Courses page to default the goal pill tab to the active goal. */
  recentGoalId(): Promise<number | null> {
    return call<number | null>("get_recent_goal");
  },

  /** Player: the material to open + siblings for the chapter sidebar. */
  openMaterial(materialId: number): Promise<PlayerView> {
    return call<PlayerView>("open_material", { materialId });
  },

  /** Persist watch progress (called on pause / seek / finish + a periodic flush). */
  saveProgress(materialId: number, positionSecs: number, durationSecs: number): Promise<void> {
    return call<void>("save_progress", { materialId, positionSecs, durationSecs });
  },

  /** Toggle a material's bookmark flag. */
  setBookmark(materialId: number, bookmarked: boolean): Promise<void> {
    return call<void>("set_bookmark", { materialId, bookmarked });
  },

  /** Explicitly set a material's completed flag (the `M` shortcut / control button). */
  setCompleted(materialId: number, completed: boolean): Promise<void> {
    return call<void>("set_completed", { materialId, completed });
  },

  /**
   * Log a study session of `seconds` ending now (feeds the activity chart + streak).
   * `materialId` is optional (a Pomodoro focus block need not target a file) and
   * `sessionType` (`work` | `short_break` | `long_break`, default `work`) lets the
   * Pomodoro timer record breaks separately — only `work` counts as study time.
   */
  logSession(
    materialId: number | null,
    seconds: number,
    sessionType: "work" | "short_break" | "long_break" = "work",
  ): Promise<void> {
    return call<void>("log_session", { materialId, seconds, sessionType });
  },

  /** Full-text search over materials for the Ctrl+K palette. */
  searchMaterials(query: string, fileType?: string): Promise<SearchResult[]> {
    return call<SearchResult[]>("search_materials", { query, fileType });
  },

  // ── Timestamped notes (v5) ──────────────────────────────────────────────────

  /** All notes for a material, earliest timestamp first. */
  listNotes(materialId: number): Promise<Note[]> {
    return call<Note[]>("list_notes", { materialId });
  },
  /** Create a note anchored at `timestampSecs`. Returns the new note id. */
  createNote(materialId: number, timestampSecs: number, body: string): Promise<number> {
    return call<number>("create_note", { materialId, timestampSecs, body });
  },
  /** Update a note's body. */
  updateNote(id: number, body: string): Promise<void> {
    return call<void>("update_note", { id, body });
  },
  /** Delete a note. */
  deleteNote(id: number): Promise<void> {
    return call<void>("delete_note", { id });
  },

  // ── Tasks (dashboard to-do list) ────────────────────────────────────────────

  /** List all tasks (unfinished first, then priority / due date / manual order). */
  listTasks(): Promise<Task[]> {
    return call<Task[]>("list_tasks");
  },

  /** Create a task; `priority` 0-3, `dueAt` (ISO datetime)/`materialId`/`estimatedMins`
   *  optional. Returns new id. */
  createTask(
    title: string,
    priority: number,
    dueAt: string | null,
    materialId: number | null,
    estimatedMins: number | null = null,
  ): Promise<number> {
    return call<number>("create_task", { title, priority, dueAt, materialId, estimatedMins });
  },

  /** Update a task's title / priority / due date / material link / estimate. */
  updateTask(
    id: number,
    title: string,
    priority: number,
    dueAt: string | null,
    materialId: number | null,
    estimatedMins: number | null = null,
  ): Promise<void> {
    return call<void>("update_task", { id, title, priority, dueAt, materialId, estimatedMins });
  },

  /** Set a task's done flag (stamps/clears completed_at; re-snapshots today). */
  setTaskDone(id: number, done: boolean): Promise<void> {
    return call<void>("set_task_done", { id, done });
  },

  /** Delete a task. */
  deleteTask(id: number): Promise<void> {
    return call<void>("delete_task", { id });
  },

  /** Consistency summary (score, streak, per-day series) for the Planning Hub. */
  consistencySummary(windowDays?: number): Promise<ConsistencySummary> {
    return call<ConsistencySummary>("consistency_summary", { windowDays });
  },

  // ── Settings (Section 8 Page 7) ─────────────────────────────────────────────

  /** List registered folders for the Manage Folders panel. */
  listRegisteredDirs(): Promise<RegisteredDir[]> {
    return call<RegisteredDir[]>("list_registered_dirs");
  },

  /** Unregister a folder (materials stay in the library). */
  removeRegisteredDir(id: number): Promise<void> {
    return call<void>("remove_registered_dir", { id });
  },

  /** Re-scan a registered folder for new/changed files. */
  rescanFolder(id: number): Promise<RescanCounts> {
    return call<RescanCounts>("rescan_folder", { id });
  },

  /** Read a setting (`null` if unset). */
  getSetting(key: string): Promise<string | null> {
    return call<string | null>("get_setting", { key });
  },

  /** Write a setting (upsert). */
  setSetting(key: string, value: string): Promise<void> {
    return call<void>("set_setting", { key, value });
  },

  /** Export the full content tree + settings to a JSON file at `path`. */
  exportDataToFile(path: string): Promise<void> {
    return call<void>("export_data_to_file", { path });
  },

  /** Backup the database file to `dest`. */
  backupDatabase(dest: string): Promise<void> {
    return call<void>("backup_database", { dest });
  },

  /** Merge a JSON export file into the DB (duplicates resolve via upserts). */
  importDataFromFile(path: string): Promise<ImportSummary> {
    return call<ImportSummary>("import_data_from_file", { path });
  },

  /**
   * Read a local file as base64. Used by the PDF viewer because WebView2
   * blocks PDFs loaded via the asset:// protocol.
   */
  readFileBase64(path: string): Promise<string> {
    return call<string>("read_file_base64", { path });
  },

  /**
   * Read a local file as raw bytes (the fast path for the PDF viewer — no base64
   * encode/decode). Returns an `ArrayBuffer` (Tauri `ipc::Response`).
   */
  readFileBytes(path: string): Promise<ArrayBuffer> {
    return call<ArrayBuffer>("read_file_bytes", { path });
  },

  /**
   * Open a file with the OS default app — used for videos the integrated HTML5 player
   * can't decode (MKV container / HEVC codec), handing them to VLC / mpv / WMP.
   */
  openInSystemPlayer(path: string): Promise<void> {
    return call<void>("open_in_system_player", { path });
  },
};

/**
 * Convert a local file path into a URL the webview can load via the Tauri asset
 * protocol (supports HTTP range requests, so `<video>` seeking streams natively).
 * Returns "" outside the Tauri shell so callers can show the browser-preview state.
 */
export function assetUrl(path: string): string {
  if (!isTauri()) return "";
  return convertFileSrc(path);
}

/**
 * Open the native folder picker and return the chosen absolute path, or `null` if
 * the user cancelled. Thin wrapper over `@tauri-apps/plugin-dialog` (the
 * `dialog:allow-open` capability is granted in `capabilities/default.json`).
 */
export async function pickFolder(): Promise<string | null> {
  if (!isTauri()) throw new NotInTauriError("pickFolder");
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: true, multiple: false });
  // `open` returns string | string[] | null; we requested a single directory.
  return typeof selected === "string" ? selected : null;
}

/**
 * Open a native save dialog and return the chosen path, or `null` if cancelled.
 * `dialog:allow-save` is granted in `capabilities/default.json`.
 */
export async function saveDialog(
  defaultName: string,
  extensions: string[],
): Promise<string | null> {
  if (!isTauri()) throw new NotInTauriError("saveDialog");
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    defaultPath: defaultName,
    filters: [{ name: "File", extensions }],
  });
  return typeof path === "string" ? path : null;
}

/**
 * Open a native file picker (single file) and return the chosen path, or `null`.
 */
export async function openFileDialog(extensions: string[]): Promise<string | null> {
  if (!isTauri()) throw new NotInTauriError("openFileDialog");
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ multiple: false, filters: [{ name: "Import", extensions }] });
  return typeof selected === "string" ? selected : null;
}

/**
 * Subscribe to live scan-progress events. Returns an unlisten function; call it on
 * cleanup. Resolves to a no-op unlisten when not in the Tauri shell.
 */
export async function onScanProgress(
  cb: (progress: ScanProgress) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<ScanProgress>("scan://progress", (event) => {
    cb(event.payload);
  });
  return unlisten;
}

/**
 * Subscribe to `library://changed` — emitted by the live watcher after a watched
 * folder is rescanned (new/removed/renamed files). Call `cb` to trigger a refetch.
 * Returns an unlisten function; no-op outside the Tauri shell.
 */
export async function onLibraryChanged(cb: () => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<number>("library://changed", () => {
    cb();
  });
  return unlisten;
}
