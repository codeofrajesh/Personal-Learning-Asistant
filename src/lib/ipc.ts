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
  BlockInput,
  BlockStatus,
  ChapterView,
  ConsistencySummary,
  CourseView,
  DashboardData,
  DayPlan,
  Exam,
  ExamInput,
  ExamPlan,
  FocusContract,
  FocusRecord,
  FolderPreview,
  GoalSummary,
  GoalView,
  HealthReport,
  ImportResult,
  ImportSummary,
  MaterialRow,
  NodeCard,
  NodeCrumb,
  Note,
  PeakHour,
  PlanBlock,
  PlanTemplate,
  PlanTemplateBlock,
  PlayerView,
  Recommendation,
  RecoveryReport,
  RegisteredDir,
  ReminderState,
  RescanCounts,
  ScanProgress,
  ScoreWindow,
  SearchResult,
  StreakStatus,
  SubjectView,
  Task,
  TemplateBlockInput,
  TemplateInput,
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

  // ── Infinite-depth node tree (v6) ───────────────────────────────────────────

  /** Direct child folder nodes of `parentId` (or the root goals when null), each with
   *  rolled-up subtree counts + a cover thumbnail. Powers the tree-browser grid. */
  nodeChildren(parentId: number | null): Promise<NodeCard[]> {
    return call<NodeCard[]>("node_children", { parentId });
  },

  /** Ancestry chain for a node, root-first, for the breadcrumb. */
  nodeAncestors(nodeId: number): Promise<NodeCrumb[]> {
    return call<NodeCrumb[]>("node_ancestors", { nodeId });
  },

  /** Materials sitting directly under a node (opened in the player). */
  nodeMaterials(nodeId: number): Promise<MaterialRow[]> {
    return call<MaterialRow[]>("node_materials", { nodeId });
  },

  // ── Courses hub sections (v8) ───────────────────────────────────────────────

  /** Nodes the user pinned to the Courses hub ("Pinned" section + Explore Pinned). */
  pinnedNodes(): Promise<NodeCard[]> {
    return call<NodeCard[]>("pinned_nodes");
  },

  /** Root courses partway done ("In Progress" section + Explore). */
  nodesInProgress(): Promise<NodeCard[]> {
    return call<NodeCard[]>("nodes_in_progress");
  },

  /** Root courses newest-first ("Recently Added" section + Explore). */
  recentNodes(): Promise<NodeCard[]> {
    return call<NodeCard[]>("recent_nodes");
  },

  /** Pin or unpin a node (the hub "Pin" control). Mirrors `setBookmark`. */
  setNodePinned(nodeId: number, pinned: boolean): Promise<void> {
    return call<void>("set_node_pinned", { nodeId, pinned });
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

  /** Suggested lectures below the current video (next → course → goal). */
  recommendedMaterials(materialId: number, limit?: number): Promise<Recommendation[]> {
    return call<Recommendation[]>("recommended_materials", { materialId, limit });
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

  /** Consistency summary (score, streak, per-day series) for the Planning Hub.
   *  `today` is the caller's LOCAL date — the window is anchored on it, not on UTC. */
  consistencySummary(today: string, windowDays?: number): Promise<ConsistencySummary> {
    return call<ConsistencySummary>("consistency_summary", { today, windowDays });
  },

  // ── Planning / Scheduling / Intelligence (v9 — commands::plan) ──────────────
  //
  // `day` is always a LOCAL 'YYYY-MM-DD' and `nowMins` local minutes-since-midnight.
  // The backend refuses to guess either: SQLite's `date('now')` is UTC, which would
  // mis-file late-evening study for anyone not sitting on the prime meridian.

  /** The whole Today payload: window, blocks, and the advisory pre-mortem verdict. */
  planDay(day: string): Promise<DayPlan> {
    return call<DayPlan>("plan_day", { day });
  },

  /** Create (no `id`) or update (with `id`) a time block. Returns its id. */
  upsertPlanBlock(block: BlockInput): Promise<number> {
    return call<number>("upsert_plan_block", { block });
  },

  /** Delete a block outright — distinct from skipping it, which keeps the record. */
  deletePlanBlock(id: number): Promise<void> {
    return call<void>("delete_plan_block", { id });
  },

  /**
   * Set a block's status, re-snapshotting the day so the score updates immediately.
   * Pass `day` to snapshot the block's OWN day: confirming yesterday's block during an
   * end-of-day review must move yesterday's score, not today's.
   */
  setPlanBlockStatus(
    id: number,
    status: BlockStatus,
    executedMins: number | null = null,
    day: string | null = null,
  ): Promise<void> {
    return call<void>("set_plan_block_status", { id, status, executedMins, day });
  },

  /** Mark a block as started (at most one is active at a time). */
  startPlanBlock(id: number): Promise<void> {
    return call<void>("start_plan_block", { id });
  },

  /** The block currently in progress, if any. */
  activePlanBlock(): Promise<PlanBlock | null> {
    return call<PlanBlock | null>("active_plan_block");
  },

  /** Set (or clear, with nulls) a day's wake / hard-stop overrides. */
  setPlanDayWindow(
    day: string,
    wakeAt: string | null,
    hardStopAt: string | null,
  ): Promise<void> {
    return call<void>("set_plan_day_window", { day, wakeAt, hardStopAt });
  },

  /** Compute recovery options. READ-ONLY — safe to call as often as the UI likes. */
  recoveryPlans(day: string, nowMins: number): Promise<RecoveryReport> {
    return call<RecoveryReport>("recovery_plans", { day, nowMins });
  },

  /** Apply one recovery plan in a single transaction. Returns an undo token.
   *  `nextDay` is where dropped blocks spill to (local calendar arithmetic lives here). */
  applyRecovery(
    day: string,
    planId: string,
    nowMins: number,
    nextDay: string,
  ): Promise<string> {
    return call<string>("apply_recovery", { day, planId, nowMins, nextDay });
  },

  /** Revert the most recently applied recovery. */
  undoRecovery(token: string): Promise<void> {
    return call<void>("undo_recovery", { token });
  },

  /** Record that the student dismissed the recovery card — enforces one prompt per drift. */
  dismissRecovery(day: string): Promise<void> {
    return call<void>("dismiss_recovery", { day });
  },

  /** Generate a day's blocks from a routine template. Returns how many were created.
   *  Idempotent: re-applying skips blocks that already exist at the same time+title. */
  applyPlanTemplate(templateId: number, day: string): Promise<number> {
    return call<number>("apply_plan_template", { templateId, day });
  },

  // ── Focus contract ──────────────────────────────────────────────────────────

  /** Record what "done" means for a block. Supersedes any unresolved commitment on it. */
  commitFocus(blockId: number, intention: string): Promise<void> {
    return call<void>("commit_focus", { blockId, intention });
  },

  /** Record whether the commitment was kept. Self-reported by design. */
  resolveFocus(blockId: number, kept: boolean): Promise<void> {
    return call<void>("resolve_focus", { blockId, kept });
  },

  /** The commitment for one block, if any. */
  focusContract(blockId: number): Promise<FocusContract | null> {
    return call<FocusContract | null>("focus_contract", { blockId });
  },

  /** Keep-rate over the trailing `days`. `today` is the caller's LOCAL date. */
  focusRecord(today: string, days?: number): Promise<FocusRecord> {
    return call<FocusRecord>("focus_record", { today, days });
  },

  /** The current streak with earned bad days bridged. `today` is the caller's LOCAL date. */
  streakStatus(today: string): Promise<StreakStatus> {
    return call<StreakStatus>("streak_status", { today });
  },

  /** Focus-by-hour over the trailing `days`, in LOCAL time.
   *  `utcOffsetMins` is required: sessions are stored in UTC, so without it the histogram is
   *  rotated by the caller's offset and the advice points at the wrong hours. Note the SIGN —
   *  `Date.getTimezoneOffset()` returns the inverse, so pass `-new Date().getTimezoneOffset()`. */
  peakHours(utcOffsetMins: number, days?: number): Promise<PeakHour[]> {
    return call<PeakHour[]>("peak_hours", { utcOffsetMins, days });
  },

  // ── Exams & backward planning (v10) ─────────────────────────────────────────

  /** All exams, soonest first. Archived ones are excluded unless asked for. */
  listExams(includeArchived = false): Promise<Exam[]> {
    return call<Exam[]>("list_exams", { includeArchived });
  },

  /** Create or update an exam. Returns its id. */
  upsertExam(exam: ExamInput): Promise<number> {
    return call<number>("upsert_exam", { exam });
  },

  /** Delete an exam. Blocks already scheduled for it are kept — the work still happened. */
  deleteExam(id: number): Promise<void> {
    return call<void>("delete_exam", { id });
  },

  /** Backward plans for every active exam, as of the caller's LOCAL date. */
  examPlans(today: string): Promise<ExamPlan[]> {
    return call<ExamPlan[]>("exam_plans", { today });
  },

  // ── Routine templates ───────────────────────────────────────────────────────

  /** All routines, newest first, with rolled-up block counts. */
  listPlanTemplates(): Promise<PlanTemplate[]> {
    return call<PlanTemplate[]>("list_plan_templates");
  },

  /** One routine's blocks, in routine order. */
  planTemplateBlocks(templateId: number): Promise<PlanTemplateBlock[]> {
    return call<PlanTemplateBlock[]>("plan_template_blocks", { templateId });
  },

  /** Create or update a routine. Returns its id. */
  upsertPlanTemplate(template: TemplateInput): Promise<number> {
    return call<number>("upsert_plan_template", { template });
  },

  /** Delete a routine. Days already generated from it keep their blocks. */
  deletePlanTemplate(id: number): Promise<void> {
    return call<void>("delete_plan_template", { id });
  },

  /** Create or update one block inside a routine. */
  upsertPlanTemplateBlock(block: TemplateBlockInput): Promise<number> {
    return call<number>("upsert_plan_template_block", { block });
  },

  /** Delete one block from a routine. */
  deletePlanTemplateBlock(id: number): Promise<void> {
    return call<void>("delete_plan_template_block", { id });
  },

  /** Capture a day's blocks as a reusable routine. Returns the new template id.
   *  Captures `planned_*` (the intention), skips spill carry-overs. */
  saveDayAsTemplate(day: string, name: string, dowMask: number): Promise<number> {
    return call<number>("save_day_as_template", { day, name, dowMask });
  },

  /** The routine matching `weekday` (0 = Sunday), if any. Local weekday, not UTC. */
  suggestedPlanTemplate(weekday: number): Promise<PlanTemplate | null> {
    return call<PlanTemplate | null>("suggested_plan_template", { weekday });
  },

  /** Close out past days from the caller's true LOCAL date. Returns days reconciled. */
  reconcilePlan(today: string): Promise<number> {
    return call<number>("reconcile_plan", { today });
  },

  /** Score drill-down: Today / Week / Month / Rolling 90 (no lifetime figure by design).
   *  `today` is the caller's LOCAL date — a UTC anchor would drop the student's evening
   *  out of the "Today" window west of Greenwich. */
  scoreSummary(today: string): Promise<ScoreWindow[]> {
    return call<ScoreWindow[]>("score_summary", { today });
  },

  // ── Durable reminder ledger (v9 `reminder_state`) ───────────────────────────

  /**
   * Atomically CLAIM a reminder: resolves `true` only if this call is the one that gets
   * to fire it. This is what makes "at most once" true across restarts — toastStore's
   * cooldown map is in-memory, so it forgets everything the moment the app closes.
   * A claim whose snooze has expired is re-granted.
   */
  claimReminder(key: string, nowIso: string): Promise<boolean> {
    return call<boolean>("claim_reminder", { key, nowIso });
  },

  /** Reminder ledger rows whose key starts with `prefix` (e.g. `block-42-`). */
  listReminders(prefix: string): Promise<ReminderState[]> {
    return call<ReminderState[]>("list_reminders", { prefix });
  },

  /** Mark a reminder acknowledged (the student acted on it). */
  ackReminder(key: string): Promise<void> {
    return call<void>("ack_reminder", { key });
  },

  /** Snooze a reminder until `snoozeTo` (absolute local datetime); it may fire again after. */
  snoozeReminder(key: string, snoozeTo: string): Promise<void> {
    return call<void>("snooze_reminder", { key, snoozeTo });
  },

  /** Drop ledger rows older than `keepDays` so the table can't grow without bound. */
  pruneReminders(keepDays: number): Promise<number> {
    return call<number>("prune_reminders", { keepDays });
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
