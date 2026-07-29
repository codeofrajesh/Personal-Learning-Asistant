/**
 * TypeScript interfaces mirroring the Rust backend structs.
 *
 * Keep these in lockstep with `src-tauri/src/commands/*` — every `#[derive(Serialize)]`
 * struct returned by an IPC command has a matching interface here so the frontend
 * gets end-to-end typing across the Tauri boundary.
 */

/** Result of the `health_check` IPC command (backend `commands::HealthReport`). */
export interface HealthReport {
  /** Echo of the token we wrote and read back — proves write+read works. */
  echo: string;
  /** Number of goals currently in the DB — proves a real table query works. */
  goal_count: number;
  /** Backend version string. */
  version: string;
}

// ── Folder registration + scan (commands::scanner) ──────────────────────────

/** Input to `scan_and_import` (backend `WizardImport`). */
export interface WizardImport {
  /** Absolute path of the picked folder. */
  path: string;
  /** Goal to file this under (created if absent). */
  goal_name: string;
  /** Subject within the goal (created if absent). */
  subject_name: string;
}

/** One sub-folder → chapter mapping row (backend `ChapterMapping`). */
export interface ChapterMapping {
  chapter: string;
  file_count: number;
}

/** A `(file_type, count)` tally entry (backend `TypeCount`). */
export interface TypeCount {
  file_type: string;
  count: number;
}

/** Read-only dry-run summary from `preview_folder` (backend `FolderPreview`). */
export interface FolderPreview {
  path: string;
  suggested_subject: string;
  chapters: ChapterMapping[];
  total_files: number;
  type_counts: TypeCount[];
}

/** Live scan progress event payload (backend `ScanProgress`, event `scan://progress`). */
export interface ScanProgress {
  /** Chapter being written, or a status word like "walking" / "done". */
  stage: string;
  files_imported: number;
  files_total: number;
  done: boolean;
}

/** Outcome of a completed import (backend `ImportResult`). */
export interface ImportResult {
  goal_id: number;
  subject_id: number;
  chapters_created: number;
  materials_imported: number;
}

/** A goal row with rolled-up counts for the Library grid (backend `GoalSummary`). */
export interface GoalSummary {
  id: number;
  name: string;
  icon: string;
  color: string;
  subject_count: number;
  material_count: number;
  completed_count: number;
}

// ── Dashboard (commands::dashboard_data) ────────────────────────────────────

/** Headline counts for the Progress Statistics card (backend `ProgressStats`). */
export interface ProgressStats {
  total_materials: number;
  completed: number;
  in_progress: number;
  bookmarked: number;
  /** 0-100 share of materials completed. */
  activity_pct: number;
}

/** A material to resume or quick-open (backend `RecentMaterial`). */
export interface RecentMaterial {
  id: number;
  file_name: string;
  file_type: string;
  chapter_id: number;
  chapter_name: string;
  subject_name: string;
  goal_name: string;
  /** 0-100 watch completion. */
  progress_pct: number;
  is_completed: boolean;
  is_bookmarked: boolean;
  /** Parent subject id (Courses "Continue Learning" → "To the course" link). */
  subject_id: number;
  /** Parent goal id (lets the Courses page highlight the active goal pill). */
  goal_id: number;
  /** Subject cover thumbnail (one random video material's thumbnail; null if none). */
  thumbnail_path: string | null;
}

/** One day of the 7-day activity chart (backend `ActivityDay`). */
export interface ActivityDay {
  /** ISO date `YYYY-MM-DD`. */
  date: string;
  hours: number;
}

/** One "Next Up" suggestion: the first unstarted lesson of a course (backend `NextUpItem`). */
export interface NextUpItem {
  id: number;
  file_name: string;
  file_type: string;
  chapter_name: string;
  subject_id: number;
  subject_name: string;
  goal_name: string;
  thumbnail_path: string | null;
  /** How many active, not-completed lessons remain in this course. */
  remaining: number;
}

/** Full Dashboard payload (backend `DashboardData`). */
export interface DashboardData {
  stats: ProgressStats;
  continue_learning: RecentMaterial[];
  bookmarks: RecentMaterial[];
  activity: ActivityDay[];
  /** Distinct `YYYY-MM-DD` dates with study activity in the last 7 days. */
  active_days: string[];
  /** Next unstarted lesson per active course (scheduling) — powers "Next Up". */
  next_up: NextUpItem[];
}

/** A to-do task (backend `Task`). */
export interface Task {
  id: number;
  title: string;
  done: boolean;
  /** 0 none / 1 low / 2 medium / 3 high. */
  priority: number;
  /** ISO datetime (YYYY-MM-DD HH:MM:SS) or date; null when no deadline. */
  due_at: string | null;
  /** Linked material id (null when unlinked). */
  material_id: number | null;
  /** Linked material's file name (null when unlinked / deleted). */
  material_name: string | null;
  /** Linked material's type (for the row glyph). */
  material_type: string | null;
  sort_order: number;
  /** Optional effort estimate in minutes (schedule view). */
  estimated_mins: number | null;
  completed_at: string | null;
  created_at: string;
}

/** A timestamped note tied to a material's playback (backend `Note`, v5). */
export interface Note {
  id: number;
  material_id: number;
  /** Seconds into the material this note is anchored to. */
  timestamp_secs: number;
  body: string;
  created_at: string;
  updated_at: string;
}

/** One day of the consistency series (backend `ConsistencyDay`). */
export interface ConsistencyDay {
  /** YYYY-MM-DD. */
  day: string;
  /** 0-100 consistency score for the day. */
  score: number;
  tasks_due: number;
  tasks_completed_on_time: number;
  tasks_completed_late: number;
  tasks_missed: number;
  study_minutes: number;
}

/** Consistency summary payload (backend `ConsistencySummary`). */
export interface ConsistencySummary {
  /** Trailing weighted score 0-100 (recent days heavier); null if no data. */
  score: number | null;
  /** Consecutive days scoring >= 60 ending today/yesterday. */
  streak: number;
  /** Per-day rows, oldest first (heatmap + trend). */
  days: ConsistencyDay[];
  /** Whether the strict-tracking UI is enabled (mirrors the setting). */
  enabled: boolean;
}

// ── Library drill-down (commands::library) ──────────────────────────────────

/** A goal's header fields (backend `GoalDetail`). */
export interface GoalDetail {
  id: number;
  name: string;
  icon: string;
  color: string;
}

/** A subject under a goal with rolled-up counts (backend `SubjectSummary`). */
export interface SubjectSummary {
  id: number;
  name: string;
  icon: string;
  chapter_count: number;
  material_count: number;
  completed_count: number;
  /** Cover image: one random video material's thumbnail (null if none). */
  thumbnail_path: string | null;
}

/** A subject header + its parent goal, for the breadcrumb (backend `SubjectDetail`). */
export interface SubjectDetail {
  id: number;
  name: string;
  goal_id: number;
  goal_name: string;
}

/** A chapter under a subject with rolled-up counts (backend `ChapterSummary`). */
export interface ChapterSummary {
  id: number;
  name: string;
  material_count: number;
  completed_count: number;
}

/** A chapter header + full ancestry, for the breadcrumb (backend `ChapterDetail`). */
export interface ChapterDetail {
  id: number;
  name: string;
  subject_id: number;
  subject_name: string;
  goal_id: number;
  goal_name: string;
}

/** A material row for the Chapter page list (backend `MaterialRow`). */
export interface MaterialRow {
  id: number;
  file_name: string;
  file_type: string;
  file_extension: string;
  file_size_bytes: number;
  /** Seconds; `null` until metadata extraction runs (a later milestone). */
  duration_secs: number | null;
  /** Absolute path to extracted thumbnail image. */
  thumbnail_path: string | null;
  /** 0-100 watch completion. */
  progress_pct: number;
  is_bookmarked: boolean;
  is_completed: boolean;
  /** `active` or `missing` (file no longer on disk — watcher marks it, never deletes). */
  status: string;
}

/** Goal page payload (backend `GoalView`). */
export interface GoalView {
  goal: GoalDetail;
  subjects: SubjectSummary[];
}

/** Subject page payload (backend `SubjectView`). */
export interface SubjectView {
  subject: SubjectDetail;
  chapters: ChapterSummary[];
}

/** Chapter page payload (backend `ChapterView`). */
export interface ChapterView {
  chapter: ChapterDetail;
  materials: MaterialRow[];
}

// ── Courses (LMS re-architecture) ───────────────────────────────────────────

/** One flattened lesson in a course (backend `CourseLesson`). Carries its chapter so
 *  the Course detail page can group lessons under sticky chapter headers. */
export interface CourseLesson {
  id: number;
  file_name: string;
  file_type: string;
  file_extension: string;
  duration_secs: number | null;
  thumbnail_path: string | null;
  /** 0-100 watch completion (0 if never opened / not a video). */
  progress_pct: number;
  is_bookmarked: boolean;
  is_completed: boolean;
  /** `active` or `missing` (file no longer on disk). */
  status: string;
  chapter_id: number;
  chapter_name: string;
  chapter_sort_order: number;
  sort_order: number;
}

/** Course-detail payload (backend `CourseView`): subject header + chapters + a
 *  flattened, sequence-ordered lesson list + a subject-wide active-material rollup. */
export interface CourseView {
  subject: SubjectDetail;
  chapters: ChapterSummary[];
  lessons: CourseLesson[];
  material_count: number;
  completed_count: number;
}

// ── Player (commands::player) ───────────────────────────────────────────────

/** The material a player opens, with ancestry + saved resume position (backend `PlayerMaterial`). */
export interface PlayerMaterial {
  id: number;
  file_path: string;
  file_name: string;
  file_type: string;
  file_extension: string;
  /** DB-known duration; `null` until metadata extraction runs. The media element
   * reports its own duration, so playback works regardless. */
  duration_secs: number | null;
  /** Absolute path to extracted thumbnail image. */
  thumbnail_path: string | null;
  chapter_id: number;
  chapter_name: string;
  subject_id: number;
  subject_name: string;
  goal_id: number;
  goal_name: string;
  /** Saved resume position in seconds (0 if never watched). */
  position_secs: number;
  is_completed: boolean;
  is_bookmarked: boolean;
}

/** One player load: the material + its sibling materials for the chapter sidebar. */
export interface PlayerView {
  material: PlayerMaterial;
  siblings: MaterialRow[];
}

// ── Search (commands::materials) ────────────────────────────────────────────

/** One FTS5 search hit, with context to render + navigate (backend `SearchResult`). */
export interface SearchResult {
  id: number;
  file_name: string;
  file_type: string;
  chapter_id: number;
  chapter_name: string;
  subject_name: string;
  goal_name: string;
  is_completed: boolean;
  /** Match snippet with ``/`` around matched terms — the frontend splits
   *  these into highlighted spans (never raw HTML). */
  snippet: string;
}

// ── Settings (commands::settings) ───────────────────────────────────────────

/** A registered folder row (backend `RegisteredDir`). */
export interface RegisteredDir {
  id: number;
  path: string;
  category_level: string;
  is_active: boolean;
  scan_status: string;
  last_scanned_at: string | null;
  goal_name: string | null;
  subject_name: string | null;
}

/** Counts from a JSON import/merge (backend `ImportSummary`). */
export interface ImportSummary {
  goals: number;
  subjects: number;
  chapters: number;
  materials: number;
}

/** Counts from a rescan (backend scanner `ImportCounts`). */
export interface RescanCounts {
  chapters_created: number;
  materials_imported: number;
}
