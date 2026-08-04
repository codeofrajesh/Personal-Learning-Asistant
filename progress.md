# PLE — Personal Learning Environment · Progress & Architecture

A local-first desktop app that turns a folder of learning material (videos, PDFs, notes,
audio, images) into a structured, trackable study environment. Built with **Tauri v2 +
Rust** (backend, SQLite, native mpv playback) and **React + Vite + TypeScript + Tailwind**
(frontend). Everything runs offline. Content, progress, tasks, and database-backed settings
live in one local SQLite database; focus-timer runtime/configuration is kept in WebView
`localStorage`.

Last updated: 2026-07-31.

---

## 1. Tech Stack & Conventions

| Layer | Choice |
|-------|--------|
| Shell | Tauri v2 (transparent window; libmpv, dialog, shell, and asset protocol) |
| Backend | Rust — `rusqlite` (bundled SQLite, WAL), single `Mutex<Connection>` |
| Video | libmpv rendered behind the transparent WebView (HTML5 fallback) |
| Frontend | React 18, Vite, TypeScript, React Router (`HashRouter`) |
| State | Zustand (timer, toasts), local component state elsewhere |
| Styling | Tailwind, dark glassmorphism design system |
| Animation | GSAP for entrances, modal/toast transitions, player-control fades, and lesson-state motion |
| Icons | `lucide-react` v1.27.0 (verify names against `node_modules` before use) |

### Design DNA (glassmorphism, dark)
- Primary lime `#AAFF00`, secondary cyan-400 `#22D3EE`, accent orange `#FF6B35`.
- Cards: `bg-white/[0.02] border-white/[0.05] shadow-2xl backdrop-blur-xl rounded-[24px]`.
- One unified ambient canvas (gradient + lime/cyan blur blobs) sits behind the whole app;
  the sidebar and header float over it as frosted-glass pills.
- **Transparent-window constraint:** the player route keeps a *flush opaque* sidebar
  because libmpv renders *behind* the WebView — a floating panel or ambient canvas can't sit
  over the video. The **top bar is fully transparent on every route** (only its 3 glass
  pills float), so it overlays the player without an opaque strip; the sidebar stays opaque
  on the player route to avoid desktop bleed-through.

### Verify pattern
- Frontend: `npm run build` (tsc typecheck + Vite build).
- Backend: `cargo test` in `src-tauri` — **7 tests, all passing** (3 schema/migration, 4
  scanner). Most motion is reduced-motion gated; `LessonOverview` still needs an explicit
  reduced-motion guard.

---

## 2. Routing

`HashRouter` (avoids deep-link 404s under Tauri's static-file origin). All pages are
code-split with `React.lazy` + `Suspense` and nested inside a single `AppShell` layout route
(eager-loaded so the sidebar/header never flash).

| Path | Page | Purpose |
|------|------|---------|
| `/` | `Dashboard` | Bento home: progress, activity, Pomodoro, Next Up, tasks, recents |
| `/library` | `Library` | Goals grid (top of the library tree) |
| `/library/goal/:goalId` | `GoalPage` | Subjects in a goal |
| `/library/subject/:subjectId` | `SubjectPage` | Chapters in a subject |
| `/library/chapter/:chapterId` | `ChapterPage` | Materials in a chapter |
| `/library/material/:materialId` | `PlayerPage` | Video/PDF/audio/image player |
| `/courses` | `CoursesPage` | LMS-style course cards |
| `/courses/:subjectId` | `CourseDetailPage` | Flattened, sequence-ordered lessons |
| `/planning` | `PlanningHub` | Planner + View (Timeline / Table) + Consistency |
| `/settings` | `Settings` | Folders, widgets, focus timer, theme, data, shortcuts |
| `*` | `NotFound` | Catch-all |

`main.tsx` → `<StrictMode>` → `<ErrorBoundary>` → `<App/>`.

---

## 3. Database Schema

Canonical DDL in `src-tauri/src/db/schema.rs` (`SCHEMA_SQL`). Migration logic in
`src-tauri/src/db/connection.rs::migrate()`.

- **`SCHEMA_VERSION = 4`**, stamped into SQLite `PRAGMA user_version`.
- **Migration model:** two-part and idempotent — (1) run all
  `CREATE TABLE IF NOT EXISTS` from `SCHEMA_SQL`, then (2) guarded incremental
  `ALTER TABLE ... ADD COLUMN` steps for columns added to already-existing DBs. Those schema
  changes run transactionally; after commit, `PRAGMA user_version` is stamped to 4. This is
  not a numbered migration-file list.
- **Pragmas:** `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`,
  `busy_timeout=5s`.

### Version history
- **v2** — added the `tasks` table + indexes.
- **v3** — added `study_sessions.session_type` (`'work' | 'short_break' | 'long_break'`).
- **v4** — added `tasks.estimated_mins` + the `consistency_log` table.

### Tables (10 ordinary + 1 FTS5 virtual + 3 sync triggers)

**Content tree** — `goals` → `subjects` → `chapters` → `materials` (each `ON DELETE
CASCADE` down the chain). `materials` carries file metadata (`file_type`, `duration_secs`,
`thumbnail_path`, `resolution`, `codec`, `page_count`, `status`, `is_bookmarked`,
`is_completed`, …). `watch_progress` holds one row per material (`position_secs`,
`duration_secs`, a STORED generated `completion_pct`, `completed`, `watch_count`).
`registered_dirs` tracks scanned folders (`path`, `category_level`, scan status).

**`settings`** — key/value store.
| Column | Type |
|--------|------|
| `key` | TEXT PRIMARY KEY |
| `value` | TEXT NOT NULL |

**`study_sessions`** — session logging (feeds the activity chart + consistency study-minutes).
| Column | Type / Notes |
|--------|------|
| `id` | INTEGER PK AUTOINCREMENT |
| `material_id` | INTEGER → materials(id), nullable (Pomodoro sessions have no material) |
| `started_at` | TEXT NOT NULL |
| `ended_at` | TEXT |
| `duration_secs` | REAL DEFAULT 0 |
| `session_type` | TEXT DEFAULT 'work' — `'work' \| 'short_break' \| 'long_break'` (v3) |
| `session_date` | TEXT GENERATED ALWAYS AS `date(started_at)` STORED |

**`tasks`** — to-do items (Planning Hub).
| Column | Type / Notes |
|--------|------|
| `id` | INTEGER PK AUTOINCREMENT |
| `title` | TEXT NOT NULL |
| `done` | INTEGER DEFAULT 0 |
| `priority` | INTEGER DEFAULT 0 — 0 none / 1 low / 2 medium / 3 high |
| `due_at` | TEXT — ISO `YYYY-MM-DD HH:MM:SS`, nullable |
| `material_id` | INTEGER → materials(id) ON DELETE SET NULL |
| `sort_order` | INTEGER DEFAULT 0 |
| `estimated_mins` | INTEGER — optional effort estimate (v4) |
| `completed_at` | TEXT |
| `created_at` / `updated_at` | TEXT DEFAULT `datetime('now')` |

**`consistency_log`** — at most one upserted snapshot per SQLite UTC date. Task completion
refreshes today; boot backfill refreshes the latest logged day and fills subsequent dates.
| Column | Type / Notes |
|--------|------|
| `day` | TEXT PRIMARY KEY — `YYYY-MM-DD` |
| `tasks_due` | INTEGER DEFAULT 0 |
| `tasks_completed_on_time` | INTEGER DEFAULT 0 |
| `tasks_completed_late` | INTEGER DEFAULT 0 |
| `tasks_missed` | INTEGER DEFAULT 0 |
| `study_minutes` | REAL DEFAULT 0 |
| `score` | REAL DEFAULT 0 — 0-100 (`queries::score_for_day`) |
| `created_at` | TEXT DEFAULT `datetime('now')` |

**`materials_fts`** — FTS5 virtual table (`file_name`, `file_path`; `unicode61`), kept in
sync with `materials` by the `materials_ai` / `materials_ad` / `materials_au` triggers.

**Indexes:** materials (chapter/type/status/bookmarked-partial), watch_progress (last),
study_sessions (date), chapters (subject), subjects (goal), tasks (done/material).

---

## 4. IPC Surface

34 commands registered in `generate_handler!` (`src-tauri/src/lib.rs`), by module. The
frontend calls them through the typed `ipc` object in `src/lib/ipc.ts`, which throws
`NotInTauriError` outside the shell (guarded by `isTauri()`).

- **root** (`commands/mod.rs`): `health_check`, `dashboard_data`.
- **scanner**: `preview_folder`, `scan_and_import`, `list_library`, `extract_library_metadata`.
- **library**: `goal_view`, `subject_view`, `chapter_view`, `course_view`, `get_recent_goal`.
- **player**: `open_material`, `save_progress`, `set_bookmark`, `set_completed`,
  `log_session`, `read_file_base64`, `read_file_bytes`, `open_in_system_player`.
- **materials**: `search_materials` (FTS5).
- **settings**: `list_registered_dirs`, `remove_registered_dir`, `rescan_folder`,
  `get_setting`, `set_setting`, `export_data_to_file`, `backup_database`,
  `import_data_from_file`.
- **tasks**: `list_tasks`, `create_task`, `update_task`, `set_task_done`, `delete_task`,
  `consistency_summary` (default window 91 days ≈ 13 weeks).

`create_task` / `update_task` validate a non-empty title and clamp priority to 0-3.
`set_task_done` stamps/clears `completed_at`, then re-runs the day snapshot for today.

Frontend `ipc` task/session/consistency/settings methods:
`listTasks`, `createTask(title, priority, dueAt, materialId, estimatedMins=null)`,
`updateTask(id, …)`, `setTaskDone(id, done)`, `deleteTask(id)`,
`logSession(materialId, seconds, type='work')`, `consistencySummary(windowDays?)`,
`getSetting(key)`, `setSetting(key, value)`, plus folder/data-management helpers.

---

## 5. Feature Sets

### 5.1 Library & Courses
Folder scan wizard imports a directory into the goal → subject → chapter → material tree,
extracting metadata + thumbnails in the background. The Library exposes the raw tree; the
Courses surface re-presents subjects as sequence-ordered "courses" with a flattened lesson
list under sticky chapter headers. FTS5 powers Ctrl+K search.

### 5.2 Player
Three-column immersive layout. libmpv renders behind the transparent WebView for MKV/HEVC;
HTML5 is the automatic fallback, and "Open in system player" always hands off to the OS.
Resume position, bookmark, and completion are persisted. Shortcuts: Space, ←/→ seek, ↑/↓
volume, F fullscreen, M complete, N/P next/previous. Fullscreen hides all app chrome so the
video anchor fills the screen.

### 5.3 Dashboard (bento)
Customizable bento grid. Widgets (`dashboard.layout` setting via `dashboardLayout.ts`):
progress · current/continue · activity chart · pomodoro · next-up · tasks · recents ·
quick-access. Each can be shown/hidden/reordered in Settings.

### 5.4 Planning Hub (`/planning`)
Top-level **Planner | View** tabs, sharing one task state via `usePlanningTasks`
(optimistic CRUD hook).

- **Planner tab** — dashboard-style: to-do list + Consistency (score + heatmap) + Next Up.
- **View tab** — full-screen, with a **Timeline | Table** sub-toggle.

**Task creation** — a slash-command `QuickAddBar` (`/high` `/today` `/1h` `/link`) parses
tokens live into chips, plus a glass `TaskModal` (segmented priority, date-time picker,
estimate presets, FTS lesson linker) for full detail. Rows stay pristine; editing opens the
modal.

**Timeline (`CalendarTimeline`)** — a true Google-Calendar-style experience with Day / Month
/ Year granularity and a `‹ Today ›` navigator:
- **Day** — vertical 24-hour axis, positioned gradient-glass blocks, a live now-line
  (auto-scrolls to the workday).
- **Month** — 7-column day grid with task chips + "+k more"; click a day → Day view.
- **Year** — 12 density-tinted mini-months; click a month → Month view.
- **Status color-coding** (status-only): upcoming → neutral slate,
  **due soon (≤24h) → amber**, **overdue → red**, **done → muted green**. Logic centralized
  in `planningUtils.ts` (`taskStatus`, `statusStyle`, `SOON_WINDOW_MS`).
- **Deadline-window meter** — each expanded Day block has a subtle bar showing elapsed time
  across a derived window (`deadline − estimate`, or a 60-minute fallback). It is explicitly
  labeled "Window", not task completion progress.
- **Collision layout** — concurrent intervals are partitioned into deterministic horizontal
  lanes instead of painting full-width blocks over one another.
- **Type icons** — `TaskGlyph` maps a task to a lucide glyph (video/pdf/note/image/audio, or
  a generic checklist for unlinked tasks); shown on Day + Month.
- **Legend** — `TimelineLegend`, a glassmorphic key (status colors + type icons) in normal
  flow below Day/Month, so it never covers content. Year has a density explanation.
- Native scroll (`overflow-auto` + `.scroll-thin`) for ~0-CPU smoothness; GSAP only for
  cell entrances, reduced-motion gated.

**Table (`TableView`)** — Notion-database style: quiet header, click-to-sort columns
(Task · Priority · Deadline · Lesson · Status) with asc/desc arrows, `divide-y` rows, status
pills, type glyphs, hover edit/delete. Header and rows share one horizontal/vertical scroll
surface with a sticky header and minimum table width; Task/Lesson use `min-w-0` + `truncate`,
so long filenames ellipsize and never overlap or desynchronize Status.

### 5.5 Consistency Engine
Every task-completion mutation re-snapshots today's row in `consistency_log`; startup also
runs a one-shot backfill. On days with due tasks, score = 60% on-time completion rate + 40%
`consistency_summary` returns a trailing weighted score, a streak of signal-bearing days
scoring at least 60 (neutral dates neither extend nor break it), and heatmap rows. There is
no periodic snapshot loop: newly logged study sessions appear after the next applicable
refresh. Consistency dates currently follow SQLite UTC dates while task due strings use
frontend local time.

### 5.6 Pomodoro / Focus Timer
`timerStore.ts` — a single global Zustand store, **timestamp-based**: it stores the absolute
`phaseEndsAt` and derives `remaining = phaseEndsAt − now` on each 1 Hz tick, so WebView2
background throttling causes no drift. State persists to `localStorage` on every transition
and resolves forward on boot (a phase that ended while the app was closed is logged +
advanced). Naturally completed phases are logged in full; skipping logs the elapsed portion
before advancing (breaks are excluded from study-time aggregates). Long break after every 4
focus sessions.
- **`HeaderTimeBox`** is the persistent cross-route timer surface; the Dashboard also has a
  larger Pomodoro widget backed by the same store. The header shows
  a "Start focus" pill when idle and a live MM:SS + ring + phase label + play/pause when
  running (lime for focus, cyan for breaks). Idle starts in place; the active timer body
  routes to the Dashboard.
- **Truly global:** the header renders on *every* route including the Player page (in the
  player's opaque sibling bar, so it never covers the mpv overlay); it is only hidden when
  the OS window is in full-screen immersive mode.
- **Configurable durations:** Settings → Focus Timer edits Focus / Short Break / Long Break
  in **hours : minutes : seconds** (`setDurations`, clamped 5s–8h). Idle → the visible clock
  re-syncs instantly; running/paused sessions retain an immutable current-session baseline,
  so new lengths take effect only on the next phase without corrupting ring/logged time.

### 5.7 Notifications (Toasts)
`toastStore.ts` + `ToastHost` (mounted once in `AppShell`). Glassmorphism cards tinted by
tone (focus/break/success/warning/info), GSAP slide-fade enter, timed auto-dismiss with a
progress hairline, a vertically bounded scrollable stack, and dedupe by `key`/cooldown.
`useTaskReminders` polls every 60s, warns for deadlines within 60 minutes, and emits an
overdue toast only when it observes the deadline crossing within roughly one poll. Timer
phase completions raise
focus/break toasts with a one-tap action to start the next phase.

### 5.8 Settings
A **two-pane left-nav tab shell** (`role="tablist"` rail + `role="tabpanel"`), hash
deep-linkable (`/settings#library`), reusing every section component:
- **Library & Content** — Manage Folders (add / rescan / remove).
- **Appearance** — Theme, Dashboard Widgets.
- **Focus & Planning** — Focus Timer durations, Consistency Tracking.
- **Playback** — Default Player (mpv/HTML5).
- **Data** — export JSON / backup DB / import merge.
- **About & Shortcuts** — keyboard shortcuts + app info.
Arrow-key roving on the rail; on narrow widths the rail becomes a horizontal scroll strip.

### 5.9 Global Top Bar
One `GlobalTopBar` (`components/layout/GlobalTopBar.tsx`) rendered once in `AppShell` on
every route, stripped to exactly three floating glass pills — (1) hamburger + "Personal
Learning Environment", (2) the Pomodoro `HeaderTimeBox`, (3) the Ctrl+K search launcher —
over a **fully transparent** strip. It's a flex sibling above `<main>` (the only scroll
container), so it stays fixed while content scrolls, identical across pages. Hidden only in
OS fullscreen. On the player route the transparent bar overlays the video; the player's own
breadcrumb/actions render as a **second row directly beneath** it.

### 5.10 Unified Material Management
- **`materialManagerStore` (Zustand)** is the single source of truth for add/scan state:
  `openAddFolder()` / `closeAddFolder()` and an `importNonce` counter bumped on each
  successful import. Library, Courses, and Settings all call `openAddFolder()` and refetch
  when `importNonce` changes — replacing three independently-mounted wizards.
- **`AddFolderModal`** is mounted once in `AppShell` (like ToastHost). It's a deliberate,
  **Goal-first stepper** with a visible progress rail: **Folder** (explicit Browse button,
  no auto-picker) → **Goal** (assign/create) → **Subject & preview** (editable name + live
  chapter mapping) → **Review** (summary) → scanning → done. Categorization is single-level
  per product decision: picked folder = Subject, sub-folders = Chapters, files = materials.
  `CategoryPicker` gained `showGoal`/`showSubject` flags to split its combos across steps.
- The old `AddFolderWizard.tsx` was deleted.

### 5.11 Thumbnail Engine (CPU-safe)
`scanner/metadata.rs` rewritten as a CPU-safe engine:
- **Single-flight guard** (`AtomicBool`): overlapping triggers (boot / post-import /
  on-demand) no longer stack — only one pass runs at a time.
- **Bounded concurrency** via a `tokio::Semaphore` capped at `min(cores, 2)` — at most a
  couple of ffmpeg processes at once, so the UI never janks.
- **Downscaled thumbnails** (`-vf scale=640:-2`, JPEG q4) instead of full-res frames.
- **Random-ish frame**: a deterministic golden-ratio hash of the material id picks a
  timestamp in the 10–80% range (avoids intros/black frames/credits), stable across re-runs.
- **Idempotent + resumable**: only rows missing duration/thumbnail are selected.
- ffprobe/ffmpeg remain bundled sidecars; video-only for v1 (audio → duration only;
  PDF/others fall back to the gradient below).
- **`CoverArt` component** (`components/ui/CoverArt.tsx`) is the shared cover surface for
  course cards: it shows the extracted thumbnail when present, else a **deterministic CSS
  gradient** derived from a stable seed (id/name) — same item always renders the same
  brand-palette (lime/cyan/orange) duotone blob with a centered glyph, so courses never
  look empty or flicker. Image tier fades in over the gradient; falls back on load error.
  Wired into `CourseCard` and the Courses "Continue Learning" featured card.

---

## 6. Key Files

**State / lib**
- `src/lib/timerStore.ts` — global Pomodoro store (timestamp-based, persisted, session-logging).
- `src/lib/toastStore.ts` — global toast store (dedupe by key/cooldown).
- `src/lib/dashboardLayout.ts` — bento widget registry + persistence.
- `src/lib/ipc.ts` — typed IPC wrapper + Tauri helpers.
- `src/lib/types.ts` — TS interfaces mirroring Rust structs.

**Layout**
- `src/components/layout/AppShell.tsx` — sidebar + top bar + content; ambient canvas; mounts
  `GlobalTopBar`, `SearchModal`, `AddFolderModal`, `ToastHost` + `useTaskReminders`.
- `src/components/layout/GlobalTopBar.tsx` — the single universal transparent top bar.
- `src/components/layout/HeaderTimeBox.tsx` — the global timer control (named + default export).
- `src/components/layout/Sidebar.tsx` — floating nav (sidebar timer removed).
- `src/components/ui/ToastHost.tsx` — toast stack renderer.
- `src/components/ui/CoverArt.tsx` — shared thumbnail/gradient cover surface.
- `src/components/useTaskReminders.ts` — 60s deadline-reminder poll.

**Material management**
- `src/lib/materialManagerStore.ts` — Zustand store for the global add/scan flow.
- `src/components/wizard/AddFolderModal.tsx` — the single Goal-first stepper modal.
- `src/components/wizard/CategoryPicker.tsx` / `ComboSelect.tsx` / `FolderPreview.tsx`.

**Planning (`src/components/planning/`)**
`usePlanningTasks.ts`, `planningUtils.ts`, `TaskModal.tsx`, `QuickAddBar.tsx`, `TaskRow.tsx`,
`PlannerTab.tsx`, `ViewTab.tsx`, `CalendarTimeline.tsx`, `TableView.tsx`, `TaskGlyph.tsx`,
`TimelineLegend.tsx`, `DateTimePicker.tsx`, `ConsistencyHeatmap.tsx`, `ConsistencyScore.tsx`.

**Backend (`src-tauri/src/`)**
- `db/schema.rs` (SCHEMA_SQL, SCHEMA_VERSION), `db/connection.rs` (migrate + pragmas),
  `db/queries.rs` (score_for_day, snapshot_day, …).
- `commands/` — active handlers in `mod.rs`, `scanner.rs`, `library.rs`, `player.rs`,
  `materials.rs`, `settings.rs`, `tasks.rs`; declared placeholders: `goals.rs`,
  `subjects.rs`, `chapters.rs`, `progress.rs`.
- `scanner/` — `walker.rs`, `metadata.rs`, `watcher.rs`; `player/` — `mpv.rs`, `server.rs`.
- `lib.rs` — `generate_handler!` registration.

---

## 7. Recent Session — Planning polish, global timer, docs

1. **Timeline refinements** — status-only colors, visible relative-deadline labels,
   side-by-side collision lanes, semantic type icons, a correctly labeled deadline-window
   meter, native sibling controls, local date-only parsing, safe month/year navigation, and
   a non-obscuring glass legend.
2. **Table fix** — one synchronized overflow viewport + sticky header + minimum width;
   long lesson names truncate, and status labels/sorting match Timeline.
3. **Global timer** — `HeaderTimeBox` now also mounts in the Player page's opaque header, so
   Pomodoro status is always visible (hidden only in OS full-screen). Scaled up the timer
   ring/digits and the toast cards for prominence.
4. **Configurable durations** — bounded h/m/s editors and an immutable active-session total,
   so configuration changes cannot alter elapsed/logged time for a running or paused phase.
5. **Docs** — this file rewritten end-to-end.

---

## 9. Recent Session — Video Player & Performance Architecture

1. **Scroll lag fix (Step 1)** — The `PlayerPage` was locked into a strict, non-scrolling `100dvh` layout. Because the transparent video anchor never moves relative to the OS window, MPV never needs async re-alignment mid-scroll, completely eliminating the "tearing/lag" effect. Window metrics are cached to single-call alignment.
2. **PDF fullscreen unify (Step 2)** — Killed the conflicting HTML5 Fullscreen API path in `PdfViewer`. PDFs now use the exact same Tauri OS-window fullscreen as the video player, eliminating the "opens then instantly escapes" loop.
3. **Tracking hardening (Step 3)** — Coalesced rapid pause/seek saves (ignoring changes < 5s), fixed the wildly inflating `watch_count` bug (counts views on open, not every save), added forced flushes on `beforeunload` + `visibilitychange`, and added `timePosRef` updates on seek for accurate persistence.
4. **4GB perf program (Step 4)** — PDFs now stream via asset-protocol range requests. Long material/lesson lists use CSS `content-visibility` to skip off-screen layout. SQLite tuned for low RAM (bounded `cache_size`, `mmap_size`, `temp_store=MEMORY`, `wal_autocheckpoint`). Thumbnails capped at 4000 files via LRU eviction.
5. **Timestamped notes (Step 5a & 5b)** — Schema v5 with `notes` table + full IPC CRUD. `playerBridge` exposes live time/seek to the Notes panel. Users add notes at the current video timestamp; click timestamp chips to seek. Right column has Lessons | Notes tab (video only).
6. **Below-video recommendations (Step 5c)** — Ranked query (next-in-series → same course → same goal) feeds a compact card rail with CoverArt thumbnails, reason tags, and progress bars.
7. **In-app docked MPV mini-player (Step 5d)** — Reuses the global MPV singleton. When leaving the player route mid-video, a floating glass card docks at bottom-right with transparent video anchor (ambient canvas gets a clip-path notch so MPV shows through). Controls: play/pause, expand, close. Mutual-exclusive with the full player.

Verification: `npm run build` green; `cargo test` green (7/7).

---

## 10. Software Updates & OTA Deployment

- **Implemented Auto-updater**: Added seamless Over-The-Air updates using `@tauri-apps/plugin-updater`.
- **UI Integration**: Users can check for updates, view release notes, and download new versions directly from the `Settings -> Software Update` tab.
- **Automated CI/CD**: Pushing a new version tag to GitHub automatically builds the installer and cryptographically signs it (via GitHub Actions & `latest.json`).
- **One-Command Release**: Added `npm run release` script to completely automate the bumping, tagging, and pushing of new versions.

### 📦 How to Push a New Update to Users

To push a brand new version of the app to all users, you no longer need to manually change version files or write Git commands. 

Simply run this one command in your terminal:
```bash
npm run release
```

**What this script does:**
1. Automatically bumps the version (e.g. `v0.1.3` -> `v0.1.4`) in `package.json`, `tauri.conf.json`, and `Cargo.toml`.
2. Commits the changes to Git.
3. Creates a new version tag (e.g. `v0.1.4`).
4. Pushes everything to GitHub.

Once pushed, **GitHub Actions** will automatically compile the app in the cloud, sign the installer, and publish it. Within ~15 minutes, anyone using the app can click "Check for Updates" to receive the new version!

*(Note: You can also specify the bump type by running `npm run release minor` or `npm run release major`)*

---

## 11. Infinite-Depth Categorization Tree (DONE — all phases shipped)

Replacing the rigid **Goal → Subject → Chapter → Material** hierarchy with a single
self-referencing **`nodes`** adjacency-list tree so a folder can nest to ANY depth (UPSC:
Goal→GS2→Polity→Topic→Sub-topic→Material) OR stay flat (casual learner: one Goal with files
dumped directly in it). Approved decisions: **(1) in-place v6 migration** (preserve
progress/notes), **(2) unified tree browser** replaces the old `/library/*` pages, **(3)
depth-cap WARNING** in the UI past a threshold (breadcrumb still scrolls; nesting stays
unlimited in the DB).

### 11.1 Architecture (the model)
- **`nodes` table** (adjacency list): `id, parent_id (NULL = root/"Goal"), name, kind
  ('root'|'folder'), description, icon, color, depth (denormalized = parent.depth+1),
  path, sort_order, created_at, updated_at`, `UNIQUE(parent_id, name)`. Indexes on
  `parent_id`, `depth`, `path`.
- **`materials.node_id`** replaces `chapter_id` (FK → nodes, ON DELETE CASCADE). Material
  `id`s are PRESERVED by the migration, so `watch_progress` / `notes` / `study_sessions` /
  `tasks.material_id` all stay valid.
- **`registered_dirs.root_node_id`** replaces `goal_id`/`subject_id`/`chapter_id`/
  `category_level`. The watcher keys on it.
- **Legacy tables dropped** (`goals`, `subjects`, `chapters`) after migration.
- **Tree reads use `WITH RECURSIVE`.** Direct children = plain
  `WHERE parent_id = ?` (index-backed). Subtree rollups + ancestry via recursive CTEs.
- **Backward-compat shim — `MAT_ANC_CTE`** (a `pub const` in `queries.rs`): a reusable set
  of CTEs that, for any material, resolves its immediate parent node (its "chapter"), its
  **depth-1 ancestor** (its "subject"), and its **root ancestor** (its "goal"). This lets
  every existing DTO (`RecentMaterial`, `NextUpItem`, `SubjectSummary`, `CourseLesson`,
  `PlayerMaterial`, `SearchResult`, `Recommendation`) keep its `goal_*`/`subject_*`/
  `chapter_*` field names UNCHANGED while the store is a tree. Shallow trees fall back
  sensibly (root doubles as subject). **Covers now use each material's OWN
  `thumbnail_path`** (CoverArt handles the gradient fallback) instead of the old
  random-subject-cover subquery.

### 11.2 DONE (committed, `cargo test` 9/9 green, `cargo build` clean)
- **Phase 1** (`schema.rs` + `connection.rs`): `SCHEMA_VERSION = 6`; fresh installs get
  `nodes`; `migrate_v6_tree()` does the in-place surgery (FK OFF → create nodes → insert
  goals(depth0)/subjects(depth1)/chapters(depth2) building old→new id maps → add
  `materials.node_id` + map from chapter_id → drop `chapter_id` → add
  `registered_dirs.root_node_id` + map from subject_id → drop legacy cols → drop
  goals/subjects/chapters → `foreign_key_check` → FK ON). Test:
  `migrates_pre_v6_hierarchy_into_nodes_tree`.
- **Phase 2** (`queries.rs`): all ~20 coupled functions rewired to nodes via `MAT_ANC_CTE`
  + recursive subtree CTEs. New write helpers: `upsert_root_node`, `upsert_child_node`,
  `insert_material(node_id,…)`, `import_tree(root_node_id, &[ScannedNode], on_progress)`,
  `insert_registered_dir(path, root_node_id)`. Rewrote `list_goals_with_counts`,
  `list_subjects`, `list_chapters`, `goal_detail`, `subject_detail`, `chapter_detail`,
  `list_materials`, `course_lessons`, `recommended_materials`, `get_recent_goal`,
  `material_for_player`, `search_materials`, `continue_learning`/`bookmarked`/`next_up`
  (via `recent_select()`), `mark_subject_missing_except(root_node_id,…)`, `build_export`,
  `merge_import`. **DTO field names/shapes UNCHANGED** except `ImportResult` (below).
- **Phase 3** (`walker.rs` + `scanner.rs` + `settings.rs` + `watcher.rs`): `scan_tree()`
  recursively mirrors arbitrary folder depth → `Vec<ScannedNode>` (`rel_segments` =
  cleaned folder chain, empty = import root; `files` = files directly in that folder).
  `folder_segments()` cleans each segment via `strip_chapter_prefix`. `scan_and_import`
  resolves destination (existing `parent_node_id` OR new root via `new_root_name`) and
  calls `import_tree`. Rescan + watcher use `scan_tree`/`import_tree`/`root_node_id`. Test:
  `scan_tree_mirrors_arbitrary_depth`.

### 11.3 BREAKING API CHANGES the frontend absorbed (Phase 6 — DONE)
- **`WizardImport`** (Rust `commands/scanner.rs`) is now
  `{ path: string, parent_node_id?: number | null, new_root_name?: string }`.
  The old `goal_name` / `subject_name` fields are GONE. `src/lib/types.ts` `WizardImport`
  and `src/lib/ipc.ts` `scanAndImport` must be updated to match.
- **`ImportResult`** is now `{ root_node_id, chapters_created, materials_imported }` — the
  old `goal_id` / `subject_id` fields are GONE. Update `types.ts` + any consumer
  (`materialManagerStore.ts` stores it; check no one reads `.goal_id`/`.subject_id`).
- **`FolderPreview`** gained `max_depth: number`; each `ChapterMapping` gained
  `depth: number` (was `{chapter, file_count}`, now `{chapter, depth, file_count}`).
- Existing IPC commands STILL WORK unchanged (they return the same DTO shapes via the
  shim): `goal_view`, `subject_view`, `chapter_view`, `course_view`, `list_library`,
  `dashboard_data`, `open_material`, `search_materials`, `recommended_materials`,
  `get_recent_goal`, `rescan_folder`, etc. So the app will still RUN on the old UI once the
  two struct mismatches above are fixed — that's the minimum to get `npm run build` green.

### 11.4 DONE — frontend phases (committed; `npm run build` + `cargo build`/`cargo test --lib` 9/9 all green)
- **Phase 6** (`types.ts` + `ipc.ts` + new node IPC): absorbed the 3 changed DTOs
  (`WizardImport` {path, parent_node_id?, new_root_name?}, `ImportResult` {root_node_id,
  chapters_created, materials_imported}, `FolderPreview` +`max_depth` / `ChapterMapping`
  +`depth`). Added `commands/nodes.rs` (registered in `lib.rs`) + `queries.rs` helpers:
  - `node_children(parent_id: Option<i64>) -> Vec<NodeCard>` — direct child folders of a
    node (or roots when null); `?1 IS NULL` picks the root set; whole-subtree material/
    completed rollups + a cover thumbnail + `depth` + `child_count` (list_subjects pattern).
  - `node_ancestors(node_id) -> Vec<NodeCrumb{id,name,depth}>` — root-first breadcrumb
    (recursive climb, `ORDER BY depth ASC`).
  - `node_materials(node_id)` — thin alias of `list_materials`.
  - New TS types `NodeCard` / `NodeCrumb`; `ipc.nodeChildren/nodeAncestors/nodeMaterials`.
  - Also fixed a pre-existing **malformed `package.json`** (its `"scripts": {` opening line
    was missing, so npm couldn't parse it and no frontend build/verify could run).
- **Phase 4** (`AddFolderModal.tsx`): replaced the Goal+Subject stepper with a 3-step flow
  Folder → **Destination** → Review. Destination offers (a) "New goal" (free-text
  `new_root_name`, reuse-by-name via `ComboSelect`) or (b) "Add into existing" (new
  `NodePicker.tsx` — a drill-down node tree over `nodeChildren`, select a `parent_node_id`).
  `FolderPreview.tsx` is now a **depth-aware indented tree** (uses `ChapterMapping.depth`)
  with a **non-blocking depth-cap warning** at `DEPTH_CAP = 6` (exported from FolderPreview).
  `CategoryPicker.tsx` is now unused (left in tree, no importers).
- **Phase 5** (`CoursesPage.tsx` → unified file-explorer tree browser): drills the `nodes`
  tree at `/courses` (roots) and `/courses/:nodeId` (a node's child `FolderCard`s +
  materials-directly-on-node rows). Breadcrumb from `node_ancestors` (scrolls when deep +
  depth-cap cue past 6); files open in the player with `source: "courses"`; Continue-Learning
  feature card shows at the root only. New `components/courses/FolderCard.tsx`. GSAP
  entrances re-stagger per drill (gsap.context + ctx.revert, reduced-motion gated).

### 11.4a Final routing (App.tsx)
- Browser owns `/courses` and `/courses/:nodeId`. Legacy Library routes REDIRECT (Navigate
  `replace`): `/library` → `/courses`; `/library/goal|subject|chapter/:id` →
  `/courses/:id` (safe because the v6 shim already returns node ids in those fields).
- `/library/material/:materialId` STILL renders `PlayerPage` (unchanged; MAT_ANC_CTE shim).
- Old page files (`Library.tsx`, `GoalPage.tsx`, `SubjectPage.tsx`, `ChapterPage.tsx`,
  `CourseDetailPage.tsx`) are no longer routed → dropped from the bundle; files remain on
  disk (harmless, can be deleted later). "Library" nav item removed from `nav.ts` (Courses
  is the single content hub); `PlayerPage`/`CourseDetailPage` IPC untouched.

### 11.5 Gotchas (kept for reference)
- Roots have `parent_id IS NULL`; SQLite `UNIQUE(parent_id,name)` treats NULLs as distinct,
  so you CANNOT `ON CONFLICT` on roots — look up by name first (`upsert_root_node`). Note
  `node_children` handles the root vs child cases with a single `?1 IS NULL` guard.
- `PRAGMA foreign_keys` toggles OUTSIDE a transaction only (the migration does this around
  its own BEGIN/COMMIT).
- `MAT_ANC_CTE` is prefixed with `format!("WITH {MAT_ANC_CTE} …")`; chain a query's own CTE
  with a comma (`format!("WITH {MAT_ANC_CTE}, ranked AS (…) …")`).
- Depth cap is UI-only (warn, don't block); DB depth stays unlimited.
- SQL errors surface at RUNTIME only (rusqlite isn't compile-checked), so exercise the real
  flows in `npm run tauri dev` — the new node queries have NOT yet been run against a live
  migrated DB, only type/compile-checked. Next session should smoke-test: import into a new
  goal, import into an existing node, drill the browser, open a file from a node.

### 11.6 Optimizations & Regressions Fixed (Post-Update)
- **`MAT_ANC_CTE` Performance Catastrophe:** The initial CTE recursively evaluated ancestry starting from *every material* in the DB, causing an `O(files * depth)` Cartesian explosion that locked the SQLite Mutex, freezing both the Dashboard load and the Video Player (which could no longer save progress). **Fix:** Rewrote the CTE to recursively climb starting from `nodes` (folders) instead, reducing the complexity to `O(folders * depth)`. The lock is eliminated and performance is completely restored.
- **`CoursesPage` UI Restoration:** The previous phase accidentally replaced the premium 3D material list view with a generic one. **Fix:** Ported the `LessonRow` component from the dropped `CourseDetailPage.tsx` directly into the new `CoursesPage.tsx` file explorer, restoring the tactile numbered circles, cyan hover states, and sleek typography. Fixed the subsequent `TYPE_GLYPH` reference and map-index bugs that arose during the port.
- **`health_check` crash:** Swapped the legacy `"goals"` table string for `"nodes"` in `commands/mod.rs` to prevent an IPC error when verifying the database state.

Verification at handoff: `cargo build` clean; `cargo test --lib` 9/9 green; `npm run build`
green. All 4 phases committed (Phase 6, 4, 5 + this doc).

---

## 12. Low-End-PC Optimization & Bug-Fix Program

Targeted at the core audience — students on **4GB-RAM / weak-CPU/GPU** machines browsing
**600GB–1TB** offline libraries. The premium glassmorphism UI had started to lag on that
hardware, and the v6 tree migration left a few regressions. Diagnosis: the lag wasn't slow
logic, it was **the premium visual layer rendered at full weight on every machine**, plus
post-migration bugs and event/CPU storms. Each phase committed separately; all verified with
`npm run build` + (from `src-tauri`) `cargo build && cargo test --lib` (**12/12** green).

### 12.1 Adaptive Performance Tier (the keystone) — `src/lib/perfStore.ts`
`backdrop-filter: blur()` is ~O(surfaces × blurred-area) *per composited frame* and the
Courses grid alone stacked 24–48 blur surfaces over two large ambient blur blobs. Rather
than branch per-component, one tier is resolved and applied as **`data-perf` on `<html>`**,
so all gating is pure CSS (zero JS in the render/paint path):
- **high** — full finish (unchanged).
- **balanced** — blur radius halved, ambient blobs shrunk, animated ring glows dropped.
- **lite** — NO `backdrop-filter` (solid tinted surfaces), no ambient blobs, no filter
  glows, `content-visibility` forced on cards.
- **Auto-detect** from `deviceMemory`/`hardwareConcurrency` (≤4GB or ≤2 cores → lite; ≤8GB
  or ≤4 cores → balanced). Persisted to the `settings` table (`perf.pref`) + a localStorage
  mirror; `applyPerfClassEarly()` stamps `<html>` **before first paint** (no flash of the
  heavy finish). User override in **Settings → Appearance → Performance**.
- CSS lives in `index.css` (overrides Tailwind `backdrop-blur-*` utilities directly so all
  existing markup responds); marker classes `perf-blob`, `perf-glow`, `perf-card`.

### 12.2 Always-on compositor churn
- The Pomodoro + `HeaderTimeBox` countdown rings animated `stroke-dashoffset` **plus a live
  `filter: drop-shadow()`** every 1 Hz tick inside a blurred card → a steady per-second
  hitch on every route while a timer ran. Tagged `perf-glow`; the glow is dropped on
  balanced/lite (kept on high).
- The mini-player recomputed a whole-app `clip-path` polygon + fired an mpv IPC on **every**
  resize tick; now debounced (120ms), since the fixed-corner card only moves once resize
  settles.

### 12.3 Player: black screens & fullscreen lag
- **Shared debounced fullscreen source** (`src/lib/fullscreen.ts`): AppShell, PlayerPage,
  and MpvVideoPlayer each ran their own un-debounced `onResized → isFullscreen()` — three
  IPC calls per tick during the DWM fullscreen animation (the lag). Now ONE app-wide,
  debounced listener fans out; app-initiated toggles still broadcast `app-fullscreen-changed`
  for instant response.
- **No more mpv remount on fullscreen toggle:** `PlayerPage` used `isFullscreen ? A : B`,
  rendering `MpvVideoPlayer` in two different DOM subtrees → unmount/remount → black frame +
  full re-init every toggle. The media element is now rendered ONCE at a stable tree
  position; only wrapper classNames change.
- **Stale-metrics black band:** `alignViewport` now always refreshes window metrics before
  measuring (was only when the cache was empty), so an anchor-only layout change can't align
  mpv against stale window dimensions.

### 12.4 Scanner unbroken + CPU spikes
- **Scanner was fully broken (issue #3):** `list_registered_dirs` still `LEFT JOIN`ed the
  dropped `goals`/`subjects` tables and read dropped columns → `no such table: goals` at
  runtime → Settings → Manage Folders couldn't load → rescan unreachable. Rewritten against
  v6 (`root_node_id` → `nodes`; struct/TS type updated). Legacy dirs with a NULL
  `root_node_id` are **self-healed** on rescan (`ensure_dir_root_node`) instead of
  `COALESCE(...,0)`, which inserted `materials.node_id = 0` and FK-failed the whole import.
- **Diffing import:** `insert_material` now reads-first and only writes when a row is
  genuinely new/changed (returns `bool`). The watcher re-imports the whole tree on any file
  event, and the old UPSERT always bumped `updated_at`, so every rescan fired the
  `materials_au` FTS triggers across the **entire library** — a big CPU spike on a large
  tree. Unchanged rescans now do zero writes / zero FTS work. `import_tree` reports only
  actually-changed rows.
- **Metadata attempt cap (schema v7 `materials.metadata_attempts`):** the ffmpeg/ffprobe
  engine excludes files that failed `MAX_METADATA_ATTEMPTS` (3) and increments the counter
  each pass, so corrupt/unsupported files stop being re-ffmpeg'd on every boot/import (a
  recurring random spike). Only emits `metadata://extracted` when new data was produced.
- **Watcher root matching** is now path-boundary-aware (`path_within`) so an event under
  `.../Math2` no longer mis-triggers a rescan of `.../Math`.

### 12.5 Query scaling on a large tree
- **`MAT_ANC_CTE` seed constraint:** the ancestry climb now seeds only from
  material-bearing nodes (a `mat_nodes` CTE), not every node. `dashboard_data` was
  O(all-nodes × depth) on the UI hot path; now O(material-nodes × depth). (Note: this builds
  on 11.6, which already fixed Gemini's catastrophe of seeding from every *material*.)
- **CoursesPage render:** optimistic bookmark toggle patches one row in local state instead
  of refetching the node (which re-rendered the whole grid + replayed GSAP just to flip a
  star); `LessonRow` memoized; folder/course cards tagged `perf-card`.

### 12.6 Files touched
- New: `src/lib/perfStore.ts`, `src/lib/fullscreen.ts`.
- Frontend: `main.tsx`, `index.css`, `AppShell.tsx`, `PlayerPage.tsx`, `MpvVideoPlayer.tsx`,
  `MiniPlayer.tsx`, `PomodoroWidget.tsx`, `HeaderTimeBox.tsx`, `Settings.tsx`,
  `CoursesPage.tsx`, `FolderCard.tsx`, `CourseCard.tsx`, `types.ts`.
- Backend: `db/queries.rs` (list_registered_dirs, insert_material diff, MAT_ANC_CTE,
  ensure_dir_root_node, tests), `db/schema.rs` (v7), `db/connection.rs` (v7 ALTER +
  `test_conn`), `scanner/metadata.rs`, `scanner/watcher.rs`.

### 12.7 Tier refinement + draggable mini-player (session 2)
Live testing on weak hardware showed **lite still stuttered**. Root cause: the tier was
**CSS-only** — it scaled the glass finish but never touched JS motion or CSS hover/transition
motion, so lite ran the *same* animation workload as high. Fixed the leak + built the
requested resizable/draggable mini-player. Both phases committed; `npm run build` +
`cargo build && cargo test --lib` (**12/12**) green.

- **Motion is now tier-gated, not just reduced-motion-gated.** New `motionAllowed()` +
  `currentTier()` in `perfStore.ts` (read `data-perf` synchronously; also honors
  `prefers-reduced-motion`). Every GSAP entrance early-returns on `!motionAllowed()`:
  `CoursesPage`, `Dashboard`, `CourseDetailPage`, `PlanningHub`, `CalendarTimeline`,
  `ConsistencyHeatmap`. On **lite** the staggers don't run — folder cards / file rows /
  widgets appear **instantly** (the drill/navigation stagger was the felt lag).
- **Lite CSS motion kill-switch (`index.css`):** one sweep zeroes all transition/animation
  duration+delay and cancels `:hover`/`:focus-visible` transforms app-wide — no `hover:scale`
  repaint churn, no transition delays, instant cards (VLC / native-explorer feel), without
  editing 25+ components. High/balanced keep the flair.
- **`perf-card` content-visibility reserve corrected** 220px → **288px** (matches real card
  height) so the scrollbar stops jumping as off-screen estimates are swapped for real cards.
- **`FolderCard`** `transition-all` → scoped `transition-[transform,border-color,background-color]`
  (helps balanced too; stops animating *every* property on hover).
- **Draggable + resizable mini-player** (`MiniPlayer.tsx` + `miniPlayerStore.ts`): drag by
  the video area, resize by the bottom-right grip. Architecture that keeps a weak CPU cool:
  the gesture runs entirely on a **DOM ref inside a rAF loop** (pointermove writes a ref; one
  rAF applies `transform: translate3d()` + width) — **zero React/zustand writes per move**.
  mpv is **never repositioned mid-gesture**: on first travel the clip-path cutout is dropped
  (`setRect(null)`) and a **freeze-frame placeholder** shows, so the decoder isn't asked to
  move (no lag / no rapid-IPC crash). On release, **one** `setVideoMarginRatio` + one
  `setRect` snaps mpv to the new rect. Frame (x/y/w; height derived 16:9 + strip) is
  clamped on-screen (width 240–640), persisted to localStorage, re-clamped on window resize.
  A no-travel click still expands to the full player (4px drag threshold).

### 12.8 Still owed / next session
- **LIVE SMOKE TEST (needs `npm run tauri dev`):** (a) tier feel — switch to **Lite** and
  confirm buttery navigation (no entrance stagger, no hover scale, instant cards) vs **High**
  restoring the full finish; (b) **mini-player drag + resize** — drag stays 60fps with the
  freeze-frame during the gesture, snaps back to live video on release, survives navigation,
  can't go off-screen; (c) still-open v6/v7 items from 12.7: fullscreen enter/exit, scan into
  NEW + EXISTING node, drill browser, open file, rescan from Settings, v7 migration on a real
  pre-v7 DB. Node queries + scan flow + v7 migration remain compile/test-checked only.
- Consider surfacing the resolved tier + a "reduce effects" hint the first time a `lite`
  device is detected.

> **Update:** the draggable/resizable mini-player (12.7) was later **reverted** to the fixed
> bottom-right card — the drag/resize fought the clip-path hole (phantom mpv frame at 0,0,
> flickering controls at the transparent-hole seam). `MiniPlayer.tsx` + `miniPlayerStore.ts`
> are back at their pre-drag state; the tier-motion refinements from 12.7 all remain.

---

## 13. Courses Page → Multi-Section EdTech Hub

Redesigned the flat root Courses page into a responsive dashboard hub (Coursera/Udemy
vocabulary), keeping the `/courses/:nodeId` tree explorer untouched. Research grounded in the
`ui-ux-pro-max` DB (EdTech design-system + navigation/dashboard/react-perf domains) plus the
`frontend-design`/`ui-styling` skills. Each phase committed; `npm run build` +
(`src-tauri`) `cargo build && cargo test --lib` (**14/14**) green.

### 13.1 Backend — schema v8 (`nodes.is_pinned`)
- New `nodes.is_pinned` column (the hub "Pinned" favorite; mirrors `materials.is_bookmarked`).
  Guarded `ADD COLUMN` migration for pre-v8 DBs. **Gotcha handled:** the partial
  `idx_nodes_pinned` is created in `connection.rs::migrate` *after* the ALTER, NOT in
  `SCHEMA_SQL` — SCHEMA_SQL re-applies before the ALTER on a migrating DB, so an index there
  fails with `no such column: is_pinned`.
- `NodeCard` gained `is_pinned` + `created_at`. Extracted the shared subtree-rollup SELECT
  into `node_card_sql()`/`map_node_card()` so every hub feed reuses the exact count+cover
  logic. New queries: `pinned_nodes`, `nodes_in_progress` (roots with 0<done<total, HAVING),
  `recent_nodes` (newest roots), `set_node_pinned`. New commands registered in `lib.rs`.
- Tests: pin toggle+list, in-progress/recent feeds (2 new → 14 total).

### 13.2 Frontend — the hub (`/courses`, root only)
- Sections top→bottom: **Continue Learning** (featured resume card, reuses
  `dashboard_data.continue_learning`), **Pinned** (hidden when empty), **In Progress**,
  **Recently Added**, **All Courses**. Comfortable margins (`max-w-[100rem]`, `p-6/10/14`),
  `space-y-12` between sections.
- New `CourseHubSection.tsx`: header (icon + title + count + **Explore ›**) over a **capped
  responsive grid** (2→3→4→5 cols, max 5 cards). Deliberately NOT a sideways swimlane — the
  UX DB flags horizontal scroll High-severity on mobile, and a wrapping grid is cheaper on
  weak GPUs.
- New `PinButton.tsx` (favorite toggle) + `FolderCard` optional pin overlay. Pin toggles are
  **optimistic** (local state + Pinned-section membership patched, no refetch/re-stagger).
- Motion: GSAP entrance extended to `.hub-section`, still gated on `motionAllowed()` (zero on
  lite / reduced-motion). New IPC wrappers: `pinnedNodes`, `nodesInProgress`, `recentNodes`,
  `setNodePinned`.

### 13.3 Frontend — the Explore drill-down (`/explore/:category`)
- New lazy `ExploreCategoryPage.tsx` (own 7.6 kB chunk = "conditional loading"). Categories
  `pinned | in-progress | recent | all`, each backed by its hub feed. Lists EVERY course with
  large-library tooling: **in-page search**, **sort** (Default/A–Z/%complete/Most content),
  **status filter chips** (All/In progress/Completed/Not started). Filter+sort are pure +
  memoized (no refetch on keystroke).
- **Instant-drill-down performance:** NO GSAP stagger even on high tier — the list paints
  immediately. Off-screen cards virtualized for free via the existing `perf-card`
  `content-visibility` marker (no new dependency). All motion scoped → lite kill-switch
  neutralizes it. Route added in `App.tsx`.

### 13.4 Files touched
- New: `src/components/courses/PinButton.tsx`, `src/components/courses/CourseHubSection.tsx`,
  `src/pages/ExploreCategoryPage.tsx`.
- Frontend: `CoursesPage.tsx` (root → hub), `FolderCard.tsx` (pin overlay), `App.tsx` (route),
  `lib/types.ts` (NodeCard fields), `lib/ipc.ts` (4 wrappers).
- Backend: `db/schema.rs` (v8), `db/connection.rs` (migration + index), `db/queries.rs`
  (NodeCard fields, node_card_sql/map_node_card, 3 feeds + set_node_pinned, 2 tests),
  `commands/nodes.rs` (4 commands), `lib.rs` (registration).

### 13.5 Still owed — LIVE SMOKE TEST (`npm run tauri dev`)
Node queries + v8 migration are compile/test-checked only. Verify: (a) hub renders all
sections with correct membership; (b) **pin/unpin** a course from a hub card and from Explore
— Pinned section/list updates instantly, persists across reload, survives app restart
(v8 column); (c) each **Explore ›** opens the right full list; search/sort/filter chips work;
(d) drill a node from "All Courses" still works (explorer unchanged); (e) **Lite tier**: hub
+ Explore have zero entrance motion / hover scale; (f) v8 migration on a real pre-v8 DB.

---

## 14. Planning, Scheduling & Intelligence System (schema v10)

Time-blocked scheduling with an Intelligent Adjustment engine, an advisory pre-mortem, learned
pace, and schedule-adherence scoring. **ALL phases (A–F) are DONE**: `cargo test --lib`
**137 passed** (was 14), no new clippy warnings; `npm run build` + `tsc --noEmit` clean.
**38 plan commands** registered. Post-QA fixes in §14.11 (tracking attribution, timeline geometry,
timer visibility), §14.12 (revision credit, rendered-space collisions, progress visibility,
routines UI, sidebar Study Meter) and §14.13 (player granular speed + the resume-position race).
Still owed: a live smoke test against a real pre-v9 DB (§14.14).

### 14.0 Architectural decisions (pushbacks accepted by the user)
These were argued *against* the original brief and approved — they are load-bearing, not
preferences:
1. **Propose, never auto-reschedule.** The engine emits named, previewable plans; nothing moves
   without a tap, and Apply is undoable. Silent mutation is why users distrust Motion-style
   tools — for a student who woke up late, a rewritten day looks like data loss.
2. **No lifetime "Overall" score.** After a bad month a lifetime average is mathematically
   unrecoverable, turning feedback into a permanent indictment (a known driver of study-app
   abandonment). Replaced with **Rolling 90**, which always recovers.
3. **Week/Month are DERIVED, not stored.** `consistency_log` is already one row/day, so windows
   are a sub-millisecond `GROUP BY`. No second write path to keep in sync.
4. **Blocks ≠ Tasks (separate tables).** A block is a time *intention*; a task is a
   *deliverable*. One task can span several blocks, and a block can target a *quantity*
   ("2 lectures of Physics"). Cramming this into `tasks` would either duplicate rows or destroy
   the plan-vs-outcome distinction that makes adherence measurable at all.
5. **No Rust polling loop.** Reminders will be event-driven (`setTimeout` armed to the next
   reminder, ~30 wakeups/day vs 1,440 polls) — both cheaper *and* lower-latency than the
   current 60s poll. Boot reconciliation is one-shot, mirroring `backfill_consistency`.
6. **Inline + batched confirmation, never a modal.** A modal about a *past* block has no
   urgency and is the fastest route to the feature being disabled.

### 14.1 Backend — schema v9
- **New tables:** `plan_blocks` (the planner), `plan_events` (append-only lifecycle ledger),
  `plan_days` (per-day window + pre-mortem + `adjust_state`), `plan_templates` /
  `plan_template_blocks` (routine days), `reminder_state` (**durable** dedupe), `node_velocity`
  (learned pace). All arrive via `CREATE TABLE IF NOT EXISTS` — none existed pre-v9.
- **`consistency_log` extended** with `blocks_planned/completed/partial/skipped`,
  `planned_minutes`, `executed_minutes`, `adherence`, `score_version` via **guarded ALTERs**
  (it already exists on pre-v9 DBs). `score_version` (1 = tasks only, 2 = blended) means the
  formula can evolve without silently rewriting historical rows.
- **Gotcha handled again:** the partial `idx_blocks_status` is created in
  `connection.rs::migrate`, not `SCHEMA_SQL` — same trap as v8's `idx_nodes_pinned`.
- **Time model:** local wall-clock `'HH:MM'` + `day`, **never UTC**. "6:00 AM study" means 6 AM
  wherever the student is; UTC would jump an hour across DST. Only `plan_events.at` is absolute
  (a real observation). Every command takes `day`/`now_mins` from the frontend, because
  SQLite's `date('now')` is UTC and would mis-file late-evening study.

### 14.2 Backend — the pure solver (`src-tauri/src/planner/`)
- `solver.rs` is **pure**: no `Connection`, no clock, no I/O. `db::plan` reads a snapshot under
  the mutex, **releases it**, then computes. This is the constraint that matters: the app has
  ONE `Mutex<Connection>`, so computing while holding it would stall `save_progress` /
  `log_session` and surface as video stutter. `now_mins` is injected, so every scenario is a
  unit test. n ≈ 10–25 blocks → single-digit microseconds.
- **Capacity:** `(raw_window − 5min×blocks) × 0.85` fatigue discount, with anchored blocks
  carved out via gap inversion (overlapping anchors merged).
- **Three strategies:** *Cascade* (preserve order, drop from the tail), *Triage* (greedy
  knapsack on value density, then redistribute slack — usually recommended), *Compress* (scale
  toward the floor, **drop rather than shrink** below `min_viable`).
- **Value = `(weight+1)² × exam × spill`.** Deviation from the proposal's literal `weight²` is
  deliberate: `weight²` makes a priority-0 block worth *exactly 0*, so it could never be
  admitted and contributed nothing to coverage — it would vanish from every plan silently.
  `(weight+1)²` keeps the ~16× spread while giving unprioritized work a small real voice.
- **Ranking:** `0.6·coverage + 0.25·integrity + 0.15·continuity`; exactly one `recommended`.
- **When everything still fits → ONE gentle shift, not three options.** Offering a "choose what
  to sacrifice" dialog for a 20-minute sleep-in manufactures a crisis out of a non-event.
- **Spillover, not deletion:** a dropped block is marked `spilled` and re-created next day with
  `spilled_from_id`. The recursive spill depth **promotes** chronically-dodged work in later
  triage — that's how avoidance of a disliked subject self-corrects.

### 14.3 Backend — persistence, scoring, boot (`src-tauri/src/db/plan.rs`)
- Block CRUD with real validation (rejects bad `HH:MM`, unknown `target_kind`/`status`,
  zero/over-long durations, blank titles) — a wrong-but-plausible time is worse in a planner
  than an error. One `active` block at a time; a demoted block that saw work becomes `partial`,
  never losing progress.
- **Window precedence:** per-day override → global setting (`plan.hard_stop` / `plan.wake`) →
  default 06:00/22:00. An inverted window falls back rather than yielding a zero-length day.
- **Velocity EWMA** (α=0.2, first sample trusted outright) feeds `effective_mins()`, so
  estimates become personal. Degenerate samples ignored.
- **Adherence** = 50% completion (partial = half) + 30% time-on-task + 20% punctuality
  (from the append-only ledger, so edits can't rewrite history). `None` when nothing was
  planned — an unplanned day stays *neutral*, never a zero.
- `blended_score` = 50/50 tasks+adherence when both exist, else whichever exists — so a
  to-do-only user and a schedule-only user both get honest numbers.
- **Boot:** `reconcile_plan_days()` closes out past days (pending → `skipped`, or `partial` if
  work was logged) **before** `backfill_consistency` so snapshots see final states. One-shot,
  O(days since last open), 365-day cap. Uses UTC date deliberately — it can only err toward
  leaving a day *open* (the frontend re-reconciles with the true local date), never closing one
  early.

### 14.4 `next_up` is now NODE-NATIVE (open question #3, resolved)
New `MAT_ROOT_CTE` replaces the `MAT_ANC_CTE` shim for scheduling: it answers only "which
course is this material in?" instead of manufacturing a goal/subject/chapter vocabulary the
tree doesn't have. `NextUpItem` now carries `node_id`/`node_name` (immediate folder) +
`root_id`/`root_name` (course). **Breaking DTO change** — `types.ts`, `NextUp.tsx`,
`PlannerTab.tsx` updated. `MAT_ANC_CTE` still serves the library/dashboard DTOs.

### 14.5 Files touched
- **New:** `src-tauri/src/planner/mod.rs` (wall-clock helpers), `src-tauri/src/planner/solver.rs`
  (pure engine, 25 tests), `src-tauri/src/db/plan.rs` (persistence, 22 tests),
  `src-tauri/src/commands/plan.rs` (14 commands).
- **Backend:** `db/schema.rs` (v9), `db/connection.rs` (migration + pre-v9 test),
  `db/queries.rs` (`MAT_ROOT_CTE`, node-native `next_up`, `blended_score`, `score_window`,
  `score_summary`, adherence in `snapshot_day`, 5 tests), `db/mod.rs`, `commands/mod.rs`,
  `lib.rs` (module + boot reconcile + 14 registrations).
- **Frontend (DTO absorption only):** `lib/types.ts`, `components/dashboard/NextUp.tsx`,
  `components/planning/PlannerTab.tsx`.

### 14.6 Command surface (38 registered, untested live)
**Blocks & day (A–B):** `plan_day`, `upsert_plan_block`, `delete_plan_block`,
`set_plan_block_status`, `start_plan_block`, `active_plan_block`, `set_plan_day_window`,
`reconcile_plan`, `score_summary`.
**Adjustment (D):** `recovery_plans` (**read-only**), `apply_recovery` (→ undo token),
`undo_recovery`, `dismiss_recovery`.
**Reminder ledger (C):** `claim_reminder` (atomic, returns whether YOU get to fire),
`list_reminders`, `ack_reminder`, `snooze_reminder`, `prune_reminders`.
**Routines (F):** `apply_plan_template`, `list_plan_templates`, `plan_template_blocks`,
`upsert_plan_template`, `delete_plan_template`, `upsert_plan_template_block`,
`delete_plan_template_block`, `save_day_as_template`, `suggested_plan_template`.
**Exams (F, v10):** `list_exams`, `upsert_exam`, `delete_exam`, `exam_plans`.
**Insight & commitment (F):** `peak_hours`, `streak_status`, `commit_focus`, `resolve_focus`,
`focus_contract`, `focus_record`, `study_meter` (§14.12; takes BOTH the local day and the UTC
offset, because sessions are stored in UTC).

Every command that needs "today"/"now"/a weekday/a UTC offset takes it as a **parameter**. This
is now enforced across the whole surface — Phase E found `score_window` and `consistency_summary`
still anchored on SQLite's UTC `date('now')`, which silently mis-filed a student's evening.

### 14.7 Phase C — DONE (Today view, one clock, durable reminders)
`cargo test --lib` **81/81** green (was 74); `tsc --noEmit` + `npm run build` clean.

**Backend — the 5 `reminder_state` commands** (`db/plan.rs` + `commands/plan.rs` + `lib.rs`):
`claim_reminder`, `list_reminders`, `ack_reminder`, `snooze_reminder`, `prune_reminders`
(7 new tests). Design points that are load-bearing:
- **`claim_reminder` is ONE atomic upsert, not read-then-write** — `INSERT … ON CONFLICT DO
  UPDATE … WHERE ack_at IS NULL AND snooze_to <= excluded.fired_at`, returning `n == 1`. Two
  clocks racing the same key cannot both fire. `fired_at` keeps the FIRST fire time.
- **`norm_dt()` normalizes every datetime to `'YYYY-MM-DD HH:MM:SS'`** because the ledger
  compares timestamps **lexicographically** — `'…T21:05'` vs `'… 21:05:00'` are the same instant
  but sort differently, so a snooze in one shape would compare wrongly against a claim in the
  other. A trailing `Z` is **rejected, not stripped**: reading a UTC instant as local would shift
  every reminder by the caller's offset.
- **`list_reminders` matches with `substr(key,1,length(?1)) = ?1`, not `LIKE`** — a prefix
  containing `%`/`_` would otherwise act as a wildcard and return unrelated reminders. Also
  `block-4-` must NOT match `block-42-start` (tested).
- **`ack_reminder` upserts** so an ack can't fail on a pruned row (losing the ack would let a
  handled reminder fire again — the exact bug this table exists to fix).
- **`prune_reminders` keeps rows whose snooze is still in the future** regardless of age;
  deleting one would let it be re-claimed immediately, resurfacing what the student pushed away.
  `keep_days` clamped 1..=3650 so a stray `0` can't wipe today's ledger.

**Frontend — one clock** (`src/lib/scheduleClock.ts`): replaces BOTH old clocks. `PlannerTab`'s
1 Hz `setNowTick` re-rendered its whole subtree (every row + heatmap + Next Up) once a second
for labels rendered in *minutes* — 59 of 60 renders could not change a pixel. Now a Zustand
store ticking on the **minute boundary** with selectors, so subscribers re-render alone. Each
tick re-arms a fresh `setTimeout` from the wall clock (self-correcting; `setInterval` would
drift under WebView2 throttling and skip hours across a laptop sleep), plus
`visibilitychange`/`focus` resync. `ViewTab`'s separate 30s interval is gone too. Helpers:
`localDay`, `localMinutes`, `dayOffset` (noon-anchored so DST can't repeat a date), `hhmmToMins`,
`minsToHhmm`, `localDateTime`, `dayMinsToMs`, `relativeMins`.

**Frontend — reminder ladder** (`src/lib/scheduleReminders.ts`): event-driven, ~30 wakeups/day
vs 1,440 polls, and it fires *on time* instead of up to a poll late. Rungs per block: `t10`
(heads-up), `start` (one-tap Start + the shared `playChime()`, now exported from `timerStore`),
`over` (~5 min past the end while still `active`). Each rung is gated on
`ipc.claimReminder(key, at)` with `key = block-<id>-<rung>`; a rung more than `STALE_MINS` in
the past is **skipped, not replayed** ("starts in 10 minutes" delivered 40 minutes late is
noise). Sleeps until the next future rung, bounded to 15 min.
- **Armed in `AppShell` (`useBlockReminders`), NOT in the Today tab** — a reminder that only
  fires while you're already looking at your schedule isn't a reminder; the student needs it most
  while on the player route. Since the *editing* happens on an unmounted page, `usePlanRevision`
  (a counter bumped by `useDayPlan`) tells the global ladder to refetch. A counter, not a poll.
- `useTaskReminders` rewritten on the same basis: no interval, no fetch of its own (takes the
  caller's list), claims through the ledger. This kills the "every reminder re-fires after
  restart" bug — reopening at 21:00 used to replay the whole day.

**Frontend — Today view** (`TodayTab.tsx`, `useDayPlan.ts`, `BlockModal.tsx`):
- **Now-line is CSS** (`.now-line` in `index.css`): `animation: now-sweep 86400s linear` with a
  **negative delay** (`--now-delay`) so it's correct on the first painted frame and the
  compositor carries it — zero JS per frame, no jitter during playback. `--now-offset` is a
  static fallback because the lite-tier/reduced-motion sweeps zero out animation duration.
- Day axis reuses `CalendarTimeline`'s 64px/hour grid + greedy lane partitioning; out-of-window
  time (before wake / after hard stop) is shaded so an impossible late block reads as outside
  the day. GSAP block stagger gated on `motionAllowed()`.
- `useDayPlan` owns the day pointer and **follows the clock across midnight only while parked on
  today** (`pinnedRef`) — otherwise midnight would yank a student off the Friday they were
  planning. Mutations always refetch rather than patching locally, because the backend recomputes
  the pre-mortem and the pace-adjusted durations.
- `BlockModal` is deliberately separate from `TaskModal`: its distinctive fields (`weight`,
  `is_anchored`, `min_viable_mins`) are solver inputs, and a merged form would be half-irrelevant
  in either mode. Editing changes `planned_start`, not `effective_start`, so editing an adjusted
  block changes the *intention* instead of baking the adjustment in.
- `blockVisualState()` in `planningUtils.ts` derives `now`/`late`/`overrun` from the clock (a
  `pending` block reads differently at 05:00, 06:05 and 09:00) — gated on `isToday`.
- Phase C also finished boot reconciliation with the **true local date** (`ipc.reconcilePlan`)
  once per hub mount; `lib.rs`'s UTC pass can only err toward leaving a day open.
- **`ToastHost` × `MiniPlayer` collision FIXED:** the stack now lifts by `rect.h + 32` whenever
  `useMiniPlayer(s => s.rect)` is non-null. A toast over that clip-path hole is unreadable (mpv
  is behind it, not the app background) and covers the video.

### 14.8 Phase D — DONE (Recovery Card)
Inline in the Today rail, above the pre-mortem: "today is off the rails" outranks "this plan was
ambitious", and the card is actionable while the verdict is not.

- `useRecovery.ts` owns *when the card may speak*; `RecoveryCard.tsx` is presentation only.
- **`DayPlan` now carries `adjust_state`** (new field, `db/plan.rs` + `types.ts`). Without it the
  client cannot tell a *dismissed* day from a fresh one, so the gate could not survive a remount.
  A missing `plan_days` row and a row with a NULL `adjust_state` both read as "never prompted" —
  setting a day window creates the row, and that must not silence the card forever (2 tests).
- **One prompt per DAY, then only on request.** The original brief said "one prompt per drift
  *event*", and escalating buckets (30 → 60 → 90 min) was implemented first — then removed:
  `adjust_state` records only THAT the student answered, not at what drift, so after a restart
  there is no way to distinguish a genuine escalation from the prompt they already declined.
  Re-opening a dismissed card is the worst thing this feature could do, so worsening drift now
  surfaces a quiet one-line `ReopenRow` (`canOpen` + `open()`) instead. Storing the answered
  drift would need a v10 migration — not worth it for this.
- **Fullscreen suppression is a hold, not a skip** — checked after `hasOffer`, so leaving
  fullscreen brings the card back rather than losing the event.
- Consequences in CONTENT terms (the backend's `summary`), coverage as "keeps 91% of what today
  was worth". The per-block diff is behind a disclosure; the summary is enough to decide.
- "Leave it as it is" is a first-class button, not an X: sometimes today is honestly a write-off,
  and a card that only offers rescue teaches the student to lie to it.
- 10s `UndoBar` replaces the card after an apply — that undo is what makes pre-selecting a
  recommendation defensible. Undo clears `adjust_state` server-side, so the offer returns.
- `aria-live="polite"`, never `assertive`: an offer must not interrupt a screen reader to deliver
  bad news. Apply/undo both `bumpPlanRevision()` so the reminder ladder re-arms on new starts.
- Verified: `cargo test --lib` **83 passed**, `tsc --noEmit` clean, `npm run build` green.

### 14.9 Phase E — DONE (score drill-down + weekly review)
New **Review** tab (4th in the hub): four window cards, the weekly review, and the 13-week
heatmap. `useScoreReview.ts` owns the data; `ReviewTab.tsx` is presentation.

**Three backend bugs found and fixed while wiring this up** — all the same root cause as the
planner's local-time rule, which had not been applied to the scoring layer:

1. **`score_window` anchored on UTC `date('now')`.** West of Greenwich after 17:00 local, the
   "Today" window meant *tomorrow* and read as empty — the student's whole day missing from their
   own score, exactly when they'd just done the work. `score_summary(conn, today)` now takes the
   caller's local date, as every planner command already did. Same fix for `consistency_summary`
   (the heatmap window), which also now excludes future rows.
2. **Two different definitions of "a day that mattered."** `score_window`'s SQL counted
   `tasks_due > 0 OR study_minutes > 0 OR blocks_planned > 0`, but `consistency_summary`'s
   weighted average and streak tested only the first two. A day where the student planned and
   worked a full schedule with no deadline due was therefore *signal* for the score windows and
   *neutral* for the streak — the same table giving two answers. Extracted `day_has_signal()`,
   used by both, mirrored on the client as `dayHasSignal()` and now shared by the heatmap bucket
   and the trend sparkline (that day used to render as an empty cell, which reads as "did
   nothing").
3. `ConsistencyDay` did not carry the v9 adherence columns, so no per-day schedule data reached
   the client. Added `blocks_planned/completed`, `planned_minutes`, `executed_minutes`,
   `adherence`. This is what lets the review name *which* days slipped instead of only reporting
   a week average.

Design decisions:
- **`null` is never rendered as 0.** A window with no signal says "No data". Telling a new user
  they score zero is both wrong and discouraging.
- The review is derived on the client — every input is already in the `ConsistencySummary`
  payload, so a new IPC command would only add a second definition of "this week".
- **The 7-day window is sliced by DATE, not array position.** The series has gaps (a day with no
  row simply isn't there), so positional slicing would silently compare mismatched spans.
- **Adherence is minute-weighted, not a mean of daily percentages.** A day with one 15-min block
  must not swing the week as hard as a day with six hours planned (verified: 105/375 = 28%, where
  mean-of-percentages would claim 62%).
- Weekday pattern needs >= 3 samples per weekday and >= 2 comparable weekdays, else it's a single
  data point dressed up as an insight. Drawn from all 13 weeks: one bad Tuesday is noise.
- `longestStreak` **skips** neutral days rather than breaking on them, matching the backend's
  loop. A calendar-contiguity rule was implemented first and dropped: it made this number mean
  something different from the streak on the Planner tab, and two disagreeing "streak" figures
  are worse than either rule alone.
- The review is allowed to say "Worse than last week." A review that only encourages is one the
  student stops reading.
- Verified: `cargo test --lib` **87 passed** (+3: local-day anchoring, schedule-only signal,
  neutral-day handling). No frontend test runner exists in this project, so `buildWeeklyReview` /
  `dayHasSignal` were verified by bundling the REAL modules with esbuild and running 22 assertions
  (date-gap slicing, month/year rollover, minute-weighting, streak rules, sample thresholds) —
  which is how the dead contiguity check in `longestStreak` was caught. Temp files removed.
  `tsc --noEmit` clean, `npm run build` green.

### 14.10 Phase F — DONE (the seven innovations)
All seven shipped. Plan Integrity surfacing already landed in Phase C as `IntegrityCard`, so this
phase covered the remaining six. `cargo test --lib` **117/117**; no new clippy warnings.

**1. Pomodoro↔block binding — and the silent bug it exposed.**
`add_executed_mins` was called from **nowhere but tests**, despite its own doc comment claiming the
`log_session` path used it. Consequence: every block's `executed_mins` stayed `0.0` forever, so
adherence scored every planned day as a total failure, the solver computed drift against work
already done, and block progress bars never moved. `queries::log_study_session` now credits the
active block for `work` sessions only — breaks are recorded but never credited, since crediting
them would let a student score full adherence by starting a block and walking away. Every caller
reports one DISCRETE elapsed chunk, so summing cannot double-count. Best-effort by contract, like
`plan::log_event`. `PomodoroWidget` shows "Counting toward X"; the crediting is entirely
server-side.

**2. Routine templates UI (9 commands).** Backend had only `apply_template`. Authoring is by
**capture, not by form**: nobody builds a good routine in an empty form, they build a good *day*
and want it back. `save_day_as_template` captures `planned_*` (the intention), never `effective_*`
(one morning's adjustments baked in permanently), and excludes spill carry-overs that belong to the
day that went wrong. It refuses an empty day rather than leaving a routine that silently does
nothing, deleting the orphan row it just created. Applying is **additive and idempotent** — never
clears the day. Template blocks get the same validation as real blocks: a bad time in a routine
would generate broken days on every application. `suggested_template` takes the weekday from the
frontend (`strftime('%w')` is UTC → offers tomorrow's routine at 22:00); inactive and empty
routines are never suggested. Deleting a routine never touches the days it generated.

**3. Exam backward-planning (schema v10).** New `exams` table — the headline item, and what
finally makes `solver::DayBlock.exam_linked` **real**: it was hardcoded `false`, so the solver's
1.5× urgency multiplier was dead code. `exam_plan()` derives, never caches (materials change
daily): remaining syllabus ÷ usable days, at the learned pace. Partial progress **counts** (a
60-min lecture watched to 40 leaves 20, not 60 — counting it whole makes the feature cry wolf);
unknown durations get a conservative 10-min placeholder rather than being free work; the revision
tail is withheld from new material, because a plan that has you learning new content the night
before has already failed. Out of study days it switches from coverage to **triage** instead of
dividing by zero. `exam_linked` matches the exam node **and its descendants** — an exam is set on
"Physics" while blocks target a chapter underneath, so exact-node matching would leave real blocks
unlinked. Keyed on the day being planned, not `now`, and past exams stop conferring urgency.

**4. Learned peak hours.** `utc_offset_mins` is a **required** parameter: `started_at` is written
with UTC `datetime('now')`, so bucketing on `strftime('%H')` alone would tell a UTC+5:30 student
they peak five and a half hours from when they actually study — i.e. advise them to schedule their
hardest work while asleep. Out-of-range offsets are rejected rather than silently rotating the
histogram. `usePeakHours` negates `getTimezoneOffset()` **once, at the boundary** (it returns the
inverse of the offset people mean). **Confidence gate:** under 180 logged minutes across 4+
distinct days the card reports how much more data it needs instead of naming an hour — advice from
two sessions is noise, and a student who follows it once and has a bad time stops trusting
everything else. The histogram still renders; only the *conclusion* needs a threshold. Best window
is 2 hours, since a single-hour spike may just be when a long lecture started.

**5. Streak insurance.** A derived **tolerance**, not a spendable token. A wallet design was
rejected: it requires persisting which days were paid for (a write during a read) and makes the
displayed streak depend on the order the student happened to open the app in. This reads
`consistency_log` only, so the same history always yields the same number — nothing to migrate,
nothing to farm. Earning is progressive (7 good days for the first bridge, 14 for the second) and
capped at 2: consistency buys forgiveness, never invulnerability. A third bad day ends the streak
and the next one starts from scratch, insurance included. Neutral days are skipped, not bridged.
**The chronological walk is load-bearing** — the first implementation scanned newest-first and
counted the good days *after* a bad day toward its cost; tests caught it bridging nothing.

**6. Focus contract.** Pre-commitment: write in one line what "done" means, then say whether you
kept it. Stored as `plan_events` rows (`committed` / `contract_kept` / `contract_broken`) rather
than new columns — it's a sequence of observations about a block, which is what that append-only
ledger is for, so no migration and the history survives block edits. **Not enforcement:** nothing
is locked or punished, because a planner that fights the student loses and an enforced commitment
teaches nothing about whether they'd have kept it. **Self-reported** because "did I do what I
said?" isn't observable from playback — inferring it from minutes would score *sitting in front of
a lecture* rather than finishing what was promised. `keep_rate` counts resolved contracts only and
stays `null` under 3 samples (unanswered-as-broken punishes blocks in flight; unanswered-as-kept
flatters). The intention is JSON-escaped via `serde_json`, not string-formatted — a quote would
otherwise produce invalid `meta` that reads back empty (test covers it). The prompt appears on the
**leading block only** (four commitment fields at once is a form, not a decision), plus a separate
`OpenContracts` list, because `UpNextCard` shows only *open* blocks — a finished block would
otherwise take its unanswered question with it when it left the list.

### 14.11 Tracking attribution — the Phase C event hook (schema v10, no migration)
`cargo test --lib` **130 passed** (was 122); `tsc --noEmit` + `npm run build` clean; clippy still 18
pre-existing warnings.

**The disconnect found by the audit.** Three write paths observe real learning, and only one of them
reached the schedule, for only one of the two things it should carry:

| Path | Wrote | Touched `plan_blocks`? |
|---|---|---|
| `queries::save_progress` | `watch_progress`, `materials.is_completed` at 95% | **nothing at all** |
| `queries::log_study_session` | `study_sessions`, then `add_executed_mins` | time only, `active` only |
| `plan::set_block_status` | status + `executed_mins` | manual only |

- **`progress_count` was a dead column.** Declared in v9's schema, selected by `BLOCK_SELECT`, mapped
  into the DTO, exported in `types.ts` — and written by NO code and read by NO component. That is the
  whole reason "N lessons" could never tick over: nothing counted lessons.
- **Time credit couldn't reach the mpv player.** `MpvVideoPlayer` called `logSession` in exactly one
  place: its unmount cleanup. Watching two minutes of an MKV credited the block nothing until the
  student left the page — and lost the time entirely if the app was closed on the video. The HTML5
  path already drained on `useMediaProgress`'s 15s flush; mpv never got the same treatment.

**The architecture — one funnel, in `db::plan`.** `attribute_time(material, mins)` and
`attribute_completion(material)`, called from the two paths that observe learning. Load-bearing
decisions:
- **Gated on the ACTIVE block, not "today's open block for this course".** This module's contract is
  that callers supply local time (SQLite's `now` is UTC), and the playback commands have no local
  date to give — a day-blind search would credit *tomorrow's* block for tonight's watching.
  `status = 'active'` needs no date, is already a `start_block` invariant, and carries real intent:
  pressing Start is what arms tracking, so nothing is credited that the student never claimed.
- **Attribution can REFUSE.** `block_covers_material` climbs the material's node path, so a block on
  "Physics" covers a lecture in Physics → Waves (same reasoning as `exam_linked_nodes`), but a
  History lecture credits nothing. Adherence is the signal the recovery engine trusts; a false
  credit there is worse than none. The `study_sessions` row still lands either way, so the activity
  chart and streak never lose real time — only the *schedule* declines it.
- **Completion is an EVENT, not a state.** `save_progress` keeps firing for the rest of a finished
  video, so the completed flag is read *before* the write and credited only on the false → true
  crossing. Otherwise a "2 lectures" block would race to done inside a minute (test covers it).
- **`node_minutes` is never auto-completed by an item.** A time box is answered in minutes, which
  `executed_mins` already tracks; closing it because one lecture ended would cut a 90-minute block
  short at 20. Only `material` (its own file finished) and `node_count` (target met) auto-complete,
  and they route through `set_block_status` so `completed_at`, the lifecycle event and the score
  behave exactly as for a manual tick.
- Pomodoro passes `material_id: None` and always credits — the timer targets no file.

**Timeline geometry — `planning/timelineLayout.ts`** (new, shared by the Today axis and the Calendar
Day view). Both surfaces had the same defect: width was divided by the whole collision *cluster*, so
ONE long block dragged every block it touched into the same divisor — a 6:00–12:00 block beside three
unrelated 30-minute blocks rendered all four at 25%, none of which overlap each other. That is the
reported "cramped and messy", and it was never caused by the blocks that actually collide. Now two
passes, like Google/Apple Calendar: **column assignment** (leftmost free column — the part that
existed), then **column-span expansion** (grow rightward while nothing there overlaps — the part that
was missing). A block only surrenders width to blocks it genuinely intersects; with no collisions
everything spans every column and is full-width, which is the common case and the one that must look
calm. Intervals are half-open, matching `find_conflict`, so the UI can't draw an overlap the backend
would have refused. Open work ranks ahead of settled work for the primary column, so an active block
sharing a slot with a skipped one reads as primary. Geometry only — the module returns column
indices and spans, no px or colours, so it stays unit-testable and both surfaces keep their own
vocabulary. Backend bindings, `blockDetail` row-gating and course linking are untouched.

**Top-bar timer visibility.** The bar already rendered on every route; the real defect was an
asymmetry in `AppShell`. The sidebar's suppression was scoped to the player
(`!appFullscreen || !isPlayerRoute`), the top bar's was app-wide (`!appFullscreen`) — so F11 or a
title-bar double-click on Today/Planner/Library/Dashboard removed the running timer with no video on
screen to justify it. Both now share one `immersive = appFullscreen && isPlayerRoute` flag. Chrome is
only sacrificed for the video. `HeaderTimeBox` also names the bound block (replacing the phase label,
which the ring colour and play/pause icon already convey) via the existing `useActiveBlock` — off the
Dashboard the binding was invisible, and a timer that doesn't say what it's counting toward reads as
a stopwatch, not as progress against today's plan.

### 14.12 Second QA pass — revision credit, rendered-space collisions, meter (no migration)
`cargo test --lib` **137 passed** (was 130); `tsc --noEmit` + `npm run build` clean; clippy still 18
pre-existing warnings. Schema stays v10.

**Revision credit — the transition gate was the wrong invariant.** §14.11 credited an item only on a
material's not-completed → completed crossing. That stopped a finished video from spamming its own
block, but it also made the **revision workflow** unrewardable: re-watching a lecture finished last
month never transitions again, so a "2 lectures" revision block could never move. The fix replaces
the gate with the invariant that was actually wanted — **one block counts one material at most
once** — enforced against the `plan_events` ledger (`kind = 'credited'`, `meta = {"material":N}`).
One rule buys both properties: a video can't spam its own block (the second call finds the event),
and a *different* block credits the same file normally, because revision is a different block. The
ledger was chosen over a new column because it is already append-only, cascade-deleted with its
block and indexed by `block_id` — so this needed no migration. `meta` is compared exactly, never
with `LIKE`, or material 12 would satisfy the check for material 123. The credit event is written
*before* the increment: a failure between them must not leave a counted item with no record of
having been counted. `save_progress` no longer reads the prior completed flag at all, which also
removes the read-before-write race that gate implied.

**Timeline overlap, again — and the algorithm was never the bug.** The report blamed
"column-span expansion" for stacking same-slot blocks in one pixel space. Traced by hand, two blocks
at 10:00–11:00 come out `col 0/span 1` and `col 1/span 1` of 2 columns, which renders side by side;
that path was correct. The real defect was that collisions were measured in **scheduled** space while
blocks are drawn in **rendered** space. Both surfaces floor block height for tappability
(`MIN_BLOCK_H = 46` on the Today axis, 44px in the Calendar Day view), and at `HOUR_H = 64` a 46px
floor is ~43 minutes of axis. So two 15-minute blocks at 10:00 and 10:15 don't overlap *as schedule*
— the engine gave both column 0 at full width — and were then drawn 43px tall, 16px apart, one over
the other. `layoutIntervals` now takes `minMins` (the caller's own floor, in minutes) and every
collision decision compares `max(end, start + minMins)`: cluster breaks, column assignment, and
span expansion. Scheduled times are still what gets *displayed*; this only changes who shares width.
Both call sites pass their real floor, and `CalendarTimeline`'s magic `44` is now the same constant
the engine is told about, so the two can't drift apart again.

**Progress visibility — `blockProgressLabel` in `planningUtils`.** The backend had tracked
intermediate progress since §14.11 and no surface showed it, which is indistinguishable from a
broken tracker. The unit follows the block's own contract, because that is what the student agreed
to: `node_count` → "1 / 2 lessons" (items, with minutes still on the bar); `node_minutes` and
freeform → "15m / 1h"; `material` → "Watched" or nothing, since "0 / 1 lessons" is noise for a block
whose title already names the one video. Returns `null` when there is nothing honest to say, so an
untouched block stays quiet instead of advertising "0m". Shown on the timeline block and in
"What's next". A `node_count` block's bar now fills by **items** rather than minutes — half of a
"2 lessons" block is one lesson, however long it took.

**Routine templates UI — built, then unreachable.** `useTemplates`, `RoutinesModal` and all six
commands existed; the only entry point was the empty-day offer. So the feature vanished the moment a
day had blocks, and "save *this* day as a routine" was unreachable **by definition** — capture needs
a day with blocks in it, which is exactly the state that hid the button. Added a "Routines" control
to `DayHeader`, which is on screen whether or not the day is empty. No new modal: the existing one
already does capture, apply, per-block editing and delete.

**Sidebar Study Meter (`study_meter` command + `StudyMeter`/`useStudyMeter`).**
- **Local day via the caller's offset.** `study_sessions.started_at` is UTC and its `session_date`
  generated column is therefore a UTC date. Reading that column — as `weekly_activity` and
  `day_facts` still do — mis-files evening study west of Greenwich: at 19:00 in New York it is
  already tomorrow in UTC, so the meter would read zero while the student was actively using the
  app. `study_meter` shifts `started_at` by `utc_offset_mins` first (the `peak_hours` precedent) and
  compares against the local `day` the frontend passes in. Offset is range-checked, not trusted.
- **The goal prefers the plan.** A meter needs a denominator, and the honest one is what the student
  already committed to: the sum of today's live blocks. It re-derives when they re-plan, and reads
  "you said 3h, you've done 40m" instead of comparing real work to an arbitrary constant. Falls back
  to `study.daily_goal_mins`, then to a 2h default. **Skipped and spilled blocks are excluded** —
  time deliberately given up is not still owed, and counting it would make the meter recede as the
  day is triaged, punishing exactly the students who are honest about what they dropped. A blank or
  junk setting can never become the denominator (test covers `""`, `"abc"`, `"0"`, `"-30"`).
- **Breaks excluded**, consistent with adherence and the activity chart: a meter fillable by walking
  away measures nothing.
- **Collapsed state is a different composition, not a squeeze.** At 96px the meter becomes a 44px
  conic-gradient ring with an hour count inside — the ring *is* the information, so nothing must be
  read at that width, and `title`/`aria-label` carry the full sentence. Zero renders as "–", because
  "0m" inside a glowing ring reads as broken rather than as "not started".
- **Costs one query a minute.** The sidebar is mounted on every route for the whole session, which
  makes it the most expensive place in the app to put a timer; `useStudyMeter` subscribes to the
  shared `useScheduleClock` minute tick instead of owning an interval (the `useActiveBlock` rule).
  Minutes are also the display resolution, so a faster refresh couldn't change a pixel. Invalidated
  by the minute tick, `usePlanRevision` (the goal depends on today's blocks) and the local day
  rolling over. Fills are CSS gradients driven by one custom property — no JS animation, no SVG.
  Colour carries state (cyan → orange → lime) and is never red: an unfinished day is not a failure.

### 14.13 Player: granular speed + the resume-position bug (no schema change)
`tsc --noEmit` + `npm run build` clean; `cargo test --lib` 137 (backend untouched); clippy still 18.
Frontend only — no command, DTO or schema change, so nothing crosses the IPC boundary that didn't
before.

**The resume bug was a stale-state race, not a missing seek.** Both players already contained resume
code, and the backend was already returning `position_secs` correctly
(`COALESCE(wp.position_secs, 0.0)` in `material_for_player`, threaded through `PlayerPage`). What
failed was `MpvVideoPlayer`'s gate:

```
if (!resumeAppliedRef.current && ready && startPosition > 0 && duration > 0) { … }
```

`duration` was React **state**, and the load effect calls `setDuration(0)` on every file change. mpv
reports the real duration through an async property event, so for a locally-cached file that event
routinely landed *before* React committed the 0 — the effect ran, saw `duration === 0`, skipped, and
latched `resumeAppliedRef` for the path so it never retried. The DB held 29% and the video sat at
0:00. Whether it worked was a race, which is why it looked intermittent.

**The fix: resume is applied BY the load, not after it.** `loadfile` carries `start=<secs>` as a
per-file option, so the first frame mpv decodes and presents *is* the resume frame. This is also the
architecture-safe shape: one IPC call on a path that already ran, no dependency on any React state
having settled, no second command, and nothing whatsoever touching the anchor, the wrapper tree or
the layout — so it cannot reintroduce the §12.3 class of bug. The old post-load `seek` was worse than
unreliable: even when it fired it decoded frames from 0:00 first and then jumped, a visible flash of
the wrong content.
- **Argument order is version-sensitive and fails hard.** mpv 0.38.0 inserted an insertion `index`
  parameter: `loadfile <url> [<flags> [<index> [<options>]]]`. Options are the **fourth** argument.
  Passing them third (correct pre-0.38) makes mpv reject the whole command, so *nothing loads* — a
  black screen. Verified against the bundled `src-tauri/lib/libmpv-2.dll` (**v0.41.0**) and the 0.41
  manual before writing the call; `index` is passed as -1, which `replace` ignores.
- **A safety net, because that's a version-coupled assumption.** `pendingResumeRef` is armed before
  the load and checked by the first `time-pos` observation: if playback began more than 2s away from
  the target (a future libmpv bump moving the argument again, or a container that can't seek
  precisely on open), it issues one corrective seek and disarms. Fires at most once per load, so it
  can never fight a deliberate seek.
- **Guards.** `> 1` rules out negatives, which `start` would read as *relative to the end of the
  file*. `toFixed(3)` keeps the value inside the documented `[[hh:]mm:]ss[.ms]` grammar — a raw float
  in exponential notation is not a valid timestamp. Position mirrors are seeded before the load so a
  flush firing before the first `time-pos` can't persist 0 over a real resume point.
- **The reconnect guard survives by construction.** `start=` only exists on the `loadfile` call, and
  that call is already skipped when the component reattaches to an engine holding this path (the
  `globalLoadedPath === path` early return, which now also disarms `pendingResumeRef`). A fullscreen
  remount still can't yank playback back to the old DB position — previously the job of a
  `didLoadFileRef` flag, now structural.
- **`duration` React state deleted.** It existed *only* to gate that broken effect; the duration
  label has always been a direct `textContent` write per the §15 perf rule. Removing it drops a
  re-render per file load.
- **HTML5 + audio had a quieter version of the same race.** `onLoadedMetadata` as a React prop is
  attached when the element commits, but an asset-protocol local file can reach `readyState >= 1`
  first — in which case the event has already fired and resume never runs. Both now also apply start
  state from an effect when metadata is already available, and re-arm on `path`. Their clamp
  `Math.min(startPosition, Math.max(0, (duration || 0) - 1))` was itself a bug: with duration
  unknown, `NaN || 0` is 0, so the clamp collapsed the resume point to 0. Duration is only used as a
  bound when it is finite.

**Granular speed — `src/lib/playbackRate.ts`,** shared by both engines so `[` behaves identically on
an MKV and an MP4. `[` / `]` step by 0.10×, `\` (and `Backspace`) resets to 1× — the same bindings
mpv itself uses, so the shortcut a student knows from mpv/VLC works here.
- **Float arithmetic is the whole reason this is a module.** 0.1 isn't representable in binary, so
  naive stepping gives `0.7000000000000001`, which renders verbatim in the control bar and never
  compares equal to a preset. Stepping is done in integer tenths and snapped by `quantizeRate`;
  verified by hand that 1.0 steps down to exactly 0.9 … 0.25 with no drift, that off-grid presets
  (1.25) snap onto the grid rather than carrying the 0.05 forever, and that the clamps hold.
  Quantized on the way *in* from the mpv `speed` observer too, so a rate set from anywhere still
  displays cleanly.
- **`rateRef` mirrors the state** for the same reason `isPlayingRef` exists: both keyboard listeners
  are deliberately bound once with empty deps, so a closure over `rate` would be frozen at 1× and
  every press would recompute from there.
- **HTML5 speed now survives a lesson change.** `playbackRate` is an element property that resets to
  1 on a source swap; the ref is re-applied on `loadedmetadata`, so the engine matches the UI.
- **UI reflects granular values**: `formatRate` trims trailing zeros (`1.2×`, not `1.20×`), the
  trigger turns lime when off 1× so a non-preset speed is visible without opening the menu, and the
  menu gained a −/+ stepper naming the `[` / `]` keys so the shortcut is discoverable. Both control
  bars match.

**No React unmounts introduced.** No component boundaries, keys, conditional subtrees or wrapper
structure changed in any of the three players; the mpv effect graph lost one effect and gained none.

### 14.14 Still owed
- **Live smoke test against a real pre-v9 DB.** Everything above is compile-, test- and
  build-verified only. The v9→v10 migration path is covered by unit tests but has never run
  against a real user database. The attribution funnel in particular has never been exercised
  against a real playing video — only against its unit tests.
- **Resume + speed need one live pass.** The `start=` option and the `[`/`]` bindings are verified
  against the mpv 0.41 manual and the bundled DLL version, not against a running video. Worth
  confirming once with `npm run tauri dev`: watch ~30% of an MKV, leave, reopen (should open AT the
  saved position with no flash of 0:00), then step speed with `[`/`]` and toggle fullscreen to
  confirm neither resume nor speed is disturbed.
- **A frontend test runner (Vitest).** Phase E's client-side derivations had to be verified with a
  throwaway esbuild harness, and it found a genuine bug (`longestStreak`'s dead contiguity check).
  That shouldn't be a manual step. Phase F's client logic is thinner but equally unguarded.
- §13.5's outstanding items.
- **Known minor:** on the Planning page `useDayPlan` and the global `useBlockReminders` both read
  `plan_day` for today, so that day is fetched twice while the page is open. Cheap and correct,
  but redundant — worth collapsing if that wiring is touched again.

---

## 15. Plugin System & Telegram Integration (Phases 1–6)

Source of truth: `telegram.md` (architecture) + `implementation_plan.md` (Phases 1–2 detail).
Turns Telegram into a **first-class plugin** rather than a hard-coded page: a contribution-point
registry (VSCode-style) owns nav, routes, settings sections, boot hooks and status badges, so
future integrations register a manifest instead of editing the shell. **Phases 1–6 are DONE**
(shell → skeleton → auth → import → streaming → player wiring); 7 is partly covered (error
taxonomy, token auth, file-reference refresh) and 8 is explicitly stretch. `cargo test --lib`
**196 passed** (was 137), clippy still 18 pre-existing warnings, `tsc --noEmit` +
`npm run build` clean. Nothing past auth has been exercised against a live connection — §15.8.

### 15.1 Phase 1 — the contribution-point shell (`src/lib/plugins/`)
- `types.ts` — `PluginManifest` + contribution types (`nav`, `routes`, `settingsSections`,
  `sourceAdapters`, `init`, `useStatus`, `capabilities`) and `validateManifest`.
- `registry.ts` — the ONE list. The four core surfaces (Dashboard / Courses / Planning /
  Settings) are declared as built-in manifests too, so nav composition has a single path
  instead of "static array + special cases".
- `nav.ts` (`useNavItems`) — core items in order, pinned plugins spliced in by `nav.order`,
  and a permanent **Plugins** overflow item before Settings. `Sidebar` renders this instead of
  the old static `NAV_ITEMS`; its active-state and roving-focus logic was untouched.
- `pinStore.ts` — pin state in the existing `settings` table (`plugins.<id>.pinned`), so no new
  table and the same optimistic-write shape as `perfStore`.
- `routes.ts` / `settings.tsx` / `sourceAdapter.ts` — lazy route composition, contributed
  Settings sections, and the material-source resolution seam (default local resolver).
- `/plugins` hub (`PluginsPage.tsx`) + a `Plugins` category in Settings. Pure refactor: with
  every built-in present, nav output is byte-identical to before.

### 15.2 Phase 2 — Telegram skeleton
`src/plugins/telegram/` — `manifest.ts` (nav `defaultPinned: false`, `order: 3`,
`badge: "status-dot"`, lazy route), `TelegramPage.tsx`, and the shared `StatusDot`. Proved the
contribution points end-to-end with zero backend.

### 15.3 Phase 3 — auth core (reviewed, repaired, completed)
Deps: `grammers-client`/`grammers-session`/`grammers-tl-types` 0.10. Backend in
`src-tauri/src/plugins/telegram/{mod,session,auth}.rs`, registered in `lib.rs` (8 `tg_*`
commands). **Phase 3 was ~70% written and did not compile;** the phase gate
(`cargo test --lib`) had never passed. What the review found and this session fixed:

1. **Build break:** `grammers_client::RpcError` doesn't exist — `RpcError` is re-exported at
   `grammers_client::sender::RpcError`. The `lib` compiled; only the test cfg referenced it, so
   `cargo build` looked fine while `cargo test` failed.
2. **No way to enter credentials — Phase 3 was unreachable.** `ensure_client` hard-errors
   without `api_id`/`api_hash`, and the `tg_*_api_credentials` commands from `telegram.md` §3.3
   were never written. Added both commands + a **contributed** `TelegramSettings` section
   (rendered through the registry, so `Settings.tsx` still never imports Telegram) and a
   credential gate in `ConnectFlow`. `api_hash` is **write-only**: the backend returns
   `has_api_hash`, never the value, so a stored secret can't be read back out of the UI. Shape
   is validated on save (32-char hex) because the common error is pasting the two fields
   swapped, and reporting that at connect time blames the phone number instead.
3. **The session never restored — the headline feature of the phase.** `is_authorized()` read
   the in-memory client, which is `None` until a login runs, so a valid `tg.session` reported
   `Disconnected` on **every launch** and the user would re-login daily. `tg_check_auth` now
   brings the client up from the session file and asks Telegram. It short-circuits on
   `has_session_file()` first, so a fresh install never dials Telegram (or complains about
   unset credentials) merely to render a gray dot.
4. **`LoginHandle` serde mismatch — runtime-only failure.** Rust had a unit struct (serde
   expects `null`); `api.ts` sent `{ handle: {} }`, so **every** sign-in would have failed
   deserialization. Compiles clean, breaks only live. Resolved by removing the handle from the
   wire entirely: no token ever crosses IPC, so `tg_sign_in` takes only the code, and
   `tg_request_code` returns the normalized phone (for the UI's "sent to +1 555…" line).
5. **One wrong digit destroyed the login.** `take_login_token()` consumed the token *before*
   `sign_in`, so a typo forced a brand-new code request — walking the user toward
   `FLOOD_WAIT` for a typo. Tokens are now held in a `login_guard()` and cleared only on
   **success**. Same bug on 2FA, and worse: `check_password` returns a *fresh*
   `PasswordToken` on failure and the old one is spent — that token is now put back, which is
   what lets the user simply retype the password. The guard is deliberately held across the
   network call, which also makes a double-submit unable to spend the token twice.
6. **`sign_out` didn't sign out.** It never called `auth.logOut` (the session stayed valid
   server-side — a real security gap, not a cosmetic one), never stopped the sender-pool
   runner, and left `-wal`/`-shm` behind. Order is now load-bearing: revoke while the client
   still works → `disconnect()` → **await the runner's join handle** → unlink. Dropping the
   handle only *detaches* the task, which keeps the session SQLite file open, and **Windows
   refuses to unlink an open file** — so on Windows the old code's `remove_file` would fail and
   the session would survive a "sign out". Local wipe proceeds even if Telegram is
   unreachable, so a network failure can't strand the user connected with no way out.
7. **Error taxonomy** (`implementation_plan.md` §A.4) was unimplemented — `FLOOD_WAIT` surfaced
   as `"Telegram error (420): FLOOD_WAIT"` and **discarded `rpc.value`**, the one field that
   makes it actionable. `map_rpc` now names the wait ("wait 2 minutes") and maps
   `PHONE_NUMBER_INVALID`, `PHONE_CODE_EXPIRED/INVALID`, `AUTH_KEY_*`/`SESSION_REVOKED`,
   `API_ID_INVALID`; unknown errors are de-screamed rather than shown raw. Expressed as prose,
   not an enum: `AppError` already serializes to a string and the UI's only job is to show it.
   Pure `map_rpc`/`humanize_secs` are unit-tested (`InvocationError` can't be constructed for
   every case; `RpcError` can).
8. **`normalize_phone` rejected what people actually type.** It refused `+1 (555) 000-1234`
   outright; it now strips punctuation and validates E.164 length (7–15 digits), rejecting an
   interior `+`.
9. **New `Unreachable` status.** Telling an offline student they're signed out invites a
   pointless re-login (and a `FLOOD_WAIT`) over missing wifi. `unreachable` is distinct from
   `disconnected` all the way through to the page banner.

**Frontend architecture fixes.** Two Phase-3 additions had quietly broken the Phase-1
principle that the shell never imports a plugin:
- **`statusDot.tsx` imported Telegram's `authStore` directly** — with a docstring claiming it
  "NEVER imports a plugin directly". It also exported a `pluginStatus()` that called
  `useAuth.getState()` from a plain function (no subscription; dead code). Replaced with a
  `useStatus?: () => PluginStatus` **hook** contribution on the manifest: the plugin owns its
  subscription, the shell just calls it. `validateManifest` now fails a `status-dot` with no
  `useStatus`, since a dot that can never report reads as broken rather than as unknown.
- **The dot was gray until you opened the page it describes.** `hydrate()` ran from
  `TelegramPage`'s mount only. Added an `init` contribution + `usePluginBoot()` in `AppShell`
  (beside `hydratePerf`), which walks the registry and swallows per-plugin failures so a plugin
  that can't reach its backend can't take boot down. `TelegramPage` no longer hydrates on mount
  — that round trip only re-learned what the nav dot already showed.
- `validateManifest` also enforces the **manifest↔command-prefix contract** (§6.7):
  `commandPrefix("telegram") === "tg_"` is explicit, not derived, since deriving it would
  reject the real names.
- `ConnectFlow`'s step is **derived from the store** (`needs_password` / `pendingPhone`) rather
  than local state, so the backend-discovered 2FA hand-off advances the flow and a remount
  mid-login lands on the right step instead of resetting to Phone.
- `TelegramSettings` is `React.lazy` + `Suspense`: the manifest is pulled into the main bundle
  by the Sidebar, so a top-level import would drag the form into the initial chunk to render a
  panel most launches never open. Verified: its own 3.15 kB chunk.



### 15.4 The `libsql` × `rusqlite` symbol collision (crash fix)
First live run of Phase 3 panicked the moment a session was opened:

```
libsql was configured with an incorrect threading configuration and the api is not safe to use.
```

**Cause (verified in the crate sources, not guessed).** `grammers-session`'s default feature set
is `["sqlite-storage"]`, which pulls in `libsql` — and `libsql` bundles its own SQLite C library
while `rusqlite = { features = ["bundled"] }` bundles another. Both export the same symbols into
one binary. `libsql::Database::new` (`libsql-0.9.30/src/local/database.rs:326`) **asserts**
`sqlite3_config(SQLITE_CONFIG_SERIALIZED) == SQLITE_OK`, but `sqlite3_config` returns
`SQLITE_MISUSE` once SQLite has been initialized — and `ple.db` opens at boot, long before any
`tg_*` command runs. So the assert could never hold in this app: the ordering guarantees it.

**Fix — drop `libsql`, persist as JSON** (`default-features = false, features = ["serde"]`).
This returns to what `telegram.md` §3.2 specified in the first place (`FileSession`); the
`SqliteSession` was the deviation. Two traps found while implementing it, both of which would
have failed a naive port:
- **`SessionData` has no serde derives** — only its *component* types (`DcOption`, `PeerInfo`,
  `UpdatesState`) do. So persistence goes through a `PersistedSession` mirror struct rather
  than serializing `SessionData` directly, which does not compile.
- **`peer_infos: HashMap<PeerId, PeerInfo>` cannot be a JSON object.** `PeerId` is a newtype
  over `i64` and serializes as a *scalar*, which `serde_json` rejects as a map key at runtime
  (it would have compiled and then failed on first peer cache). Both maps are persisted as
  arrays and re-keyed on load — `PeerInfo`/`DcOption` each carry their own id.
- `auth_key` survives because grammers hex-encodes it via `serde_with`; a raw `[u8; 256]` would
  not round-trip through JSON. **This is the property the file exists for** — losing the key
  forces a fresh login, the most flood-limited operation Telegram has — so it is covered by a
  dedicated test rather than trusted.

Writes are synchronous and immediate (temp file + atomic rename, so a crash mid-write leaves
either the old session or the new one, never a truncated file that would lock the user out). A
**corrupt file is a hard error, not a silent reset**, for the same reason. `sign_out` now also
sweeps the legacy `tg.session` + `-wal`/`-shm` left behind by the crashing build.

Verified: `cargo tree` shows **zero** `libsql` (only rusqlite's `libsqlite3-sys` remains — one
SQLite in the binary); `cargo test --lib` **152 passed** (+4 session round-trip tests); clippy
back to the 18-warning baseline with zero telegram warnings.

### 15.5 Phases 4–6 — import, streaming, and player wiring

**Phase 4 (import).** `link.rs` (pure `t.me` parser) + `import.rs` (`tg_import_link`,
`tg_channel_media`) + `LinkImport.tsx`. Schema **v11** adds `materials.source`
(`'local'|'telegram'`) + `tg_chat_id` / `tg_message_id`; existing rows migrate to `'local'`,
never NULL, because the scanner, metadata engine and player all branch on it. `file_path`
holds a synthetic `tg://<chat>/<msg>` key (the column is NOT NULL UNIQUE and predates
streaming), and a partial UNIQUE index on `(tg_chat_id, tg_message_id)` makes re-importing a
link UPDATE the existing lesson rather than duplicating it, so progress and notes stay
attached. Two silent-corruption bugs were found while integrating: `mark_subject_missing_except`
would flip every Telegram lesson to `missing` on any filesystem rescan (a `tg://` path is never
in the scanner's `seen` set), and the metadata engine would spawn ffprobe against `tg://` paths
three times per lesson. Both are now scoped to `source = 'local'`.

**Private-channel peer resolution — the retry that could not work.** A `/c/` link carries no
access hash, so the only available ref is `PeerId::to_ambient_ref()`, which is
`PeerAuth::default()` — literally `PeerAuth(0)`. `get_messages_by_id` serializes
`channel: peer.into()` with **no session lookup**, so priming the peer cache and re-issuing the
same ambient request rebuilds byte-identical wire data and fails identically. The fix resolves
through `Session::peer_ref(id)` (the actual cache lookup) and sends a ref carrying a real hash;
`TgState` keeps its own `Arc<FileSession>` because grammers holds `Client.session` private.
Invite links (`t.me/+hash`) are a first-class target via `messages.checkChatInvite` — a
read-only lookup that does NOT join — because a username-less private channel the user *owns*
has no other pasteable handle.

### 15.6 Phase 5 — the streaming engine

**`reader.rs` — and why `telegram.md` §5.3 is inverted for grammers 0.10.** The plan says to
avoid `iter_download` (it `panic!`s on `File::CdnRedirect`) in favour of raw
`invoke_in_dc(upload::GetFile)`. Verified against the sources, that recommendation is backwards:
media routinely lives on a **non-home DC**, where `upload.getFile` returns
`AUTH_KEY_UNREGISTERED` and must be repaired by an auth-key export/import. `DownloadIter` does
exactly that (`files.rs:128`), but the function it calls — `copy_auth_to_dc` — is **`pub(crate)`**
(`net.rs:168`) with no public equivalent, and `invoke_in_dc` only applies the retry policy. So
the "safe" raw path fails permanently on precisely the private-channel media this feature
exists to serve. Meanwhile the panic is conditional: `iter_download` sets `cdn_supported: false`,
and CDN offload targets *popular public* files. The rare failure beats the common one — and it
is contained: every chunk fetch runs inside `catch_unwind`, so a CDN redirect degrades to a
failed stream instead of unwinding through the HTTP handler.
- 512 KB chunks (Telegram's `MAX_CHUNK_SIZE`), offsets always `index * CHUNK_SIZE` so the
  4 KB-alignment rule holds by construction. 64-chunk (32 MB) LRU per open lesson, so a short
  seek backwards is free. Global semaphore of 4 concurrent fetches — Telegram's own clients cap
  parallel file ops around 4-8 and exceeding it is a documented `FLOOD_WAIT` trigger.
- `FILE_REFERENCE_*` expiry re-fetches the message for a fresh reference and retries once. This
  is what lets a student pause overnight and resume without re-importing.

**`server.rs` — hyper on `127.0.0.1`.** hyper + `http-body-util` were already transitive deps of
Tauri, so this added no new third-party code (axum, which the plan names, would have). Ephemeral
port, per-run 256-bit token in the path (`/tg/<token>/<chat>/<msg>`); a stale URL from a previous
run cannot be replayed, and a token mismatch 404s rather than 403s so it is indistinguishable
from a bad path. **Range correctness is the whole safety story here** — mpv seeks by issuing a
fresh ranged GET, and `<video>` won't expose a seek bar unless the first response advertises
`Accept-Ranges`. 11 unit tests pin the forms real clients send: inclusive `bytes=N-M`, suffix
`bytes=-N` (mp4 clients use it to find a trailing moov atom), clamping past EOF, `416` with
`bytes */size`, HEAD parity, and short-read re-derivation of `Content-Length` (an over-large
length leaves the client waiting for bytes that never arrive). Open-ended ranges serve a bounded
slice, so a 2 GB lecture starts immediately instead of buffering whole.

### 15.7 Phase 6 — player wiring (deliberately the smallest possible diff)

The §12.3 black-frame and §14.13 resume-race regressions both came from **remounting**
`MpvVideoPlayer`, so the integration was designed to make that structurally impossible:
resolution happens in **`open_material` (Rust)**, which rewrites `file_path` into the stream URL
before the DTO ever reaches the frontend.

**No player component was modified — `git status src/components/player/` is empty.** Component
identity, props, keys, conditional subtrees and the mpv effect graph are all untouched; the
players receive a different *string*, nothing else. An async resolve step inside `PlayerPage`
would have reintroduced exactly the remount risk that caused §12.3.
- mpv needed **zero** changes: it passes `path` straight to `loadfile`, which plays HTTP
  natively, and never called `convertFileSrc`.
- The three HTML5-side viewers (`VideoPlayer`, `AudioPlayer`, `PdfViewer`, `ImageViewer`) all
  funnel through `assetUrl()`, so one guard there — return an `http(s)://` URL untouched instead
  of mangling it into `asset://` — covers all of them.
- **CSP:** `media-src` allowed `http://localhost:*` but NOT `http://127.0.0.1:*`, which are
  different origins to a browser. mpv bypasses CSP entirely, so without this fix video would
  have worked while the HTML5 fallback and PDF viewer failed *silently*. Added to `media-src`,
  `connect-src`, `img-src`, `frame-src` and `object-src`.
- "Open in system player" is hidden for streamed lessons — handing a loopback URL to the OS
  opens a browser, not a player.
- Watch progress, notes, bookmarks, the Study Meter and schedule attribution all key on
  `materials.id` and were already source-agnostic; none of them needed touching.

Verified: `cargo test --lib` **196 passed** (was 176), clippy still **18** (unchanged baseline,
zero warnings in the new modules), `tsc --noEmit` + `npm run build` clean.

### 15.8 The mid-playback stall — DC round-trip amplification

First live playback froze after ~10 seconds. Diagnosis (verified against grammers 0.10 sources,
not inferred):

`DownloadIter::next` starts **every** iterator from `session.home_dc_id()` (`files.rs:105`), and
on `FILE_MIGRATE_X` it updates only a local variable (`files.rs:135`) — `set_home_dc_id` is
called *exclusively* from the login path (`auth.rs:200,280`), never from a download. Since
`download_chunk` built a fresh iterator per chunk, **every chunk paid a wasted round trip**: ask
the home DC, get redirected, ask the real DC. Media commonly lives off-DC, so this was the
normal case, not an edge one.

Three fixes, in order of effect:
1. **Cache the resolved `dc_id`** and call `upload.getFile` directly on it. `invoke_in_dc`
   reuses one live connection per DC (`sender_pool.rs:239-247`), so the fast path is free.
   The first chunk still goes through `iter_download` — deliberately, because it performs the
   `copy_auth_to_dc` export/import that a raw call cannot (`copy_auth_to_dc` is `pub(crate)`,
   `net.rs:168`). `FILE_MIGRATE` or `AUTH_KEY_UNREGISTERED` on the direct path invalidates the
   cached value and falls back to the iterator, so a wrong guess self-corrects at the cost of
   one round trip.
2. **`OPEN_RANGE_SERVE` 1 MB → 8 MB.** This constant sets how often the player must come back
   for more. mpv fills a large read-ahead cache, so a 1 MB slice meant dozens of HTTP requests
   (each formerly carrying a wasted redirect) in the first seconds of playback. That
   amplification is what walked the account into `FLOOD_WAIT`.
3. **One-chunk sequential read-ahead**, using `try_acquire` — never `acquire`. A prefetch that
   waited for a permit would compete with the chunk the player is actually blocked on, making
   playback worse while looking like an optimization.

**Gemini's proposed fix was rejected**, though its core mechanism was right. It suggested caching
a live `DownloadIter` and reusing it across sequential reads. That type owns its own `offset` and
advances on `next()`, but ranges arrive from the player in arbitrary order and **concurrently** —
two tasks sharing one iterator would interleave and receive each other's chunks. Silent video
corruption is far worse than a stall. Caching an `i32` DC id is immutable data and safe under any
concurrency. Its claim of "hundreds of errors per second" was also wrong: the global semaphore
caps concurrent fetches at 4. And the stall is not a silently-dropped connection — `AutoSleep`
*sleeps* on `FLOOD_WAIT` ≤60 s (`retry_policy.rs:69`), which is precisely what a freeze looks
like.

**Error handling for real browsing behaviour**, added alongside:
- **Retry on transient I/O** (1s/2s/4s), not just on flood. Telegram drops idle connections and
  home wifi blips during a 40-minute lecture; without this, one dropped socket ended playback.
- **`FLOOD_WAIT` retried up to 3× with the interval Telegram asks for, capped at 45 s** —
  grammers' own policy gives up after one (`fail_count == 1`), which is exactly when a streaming
  workload hits its second flood.
- **Disconnected account is reported honestly.** `open_material` now checks the session before
  handing back a URL; otherwise a signed-out account produced a valid-looking URL whose every
  request 404s, and the player showed an unexplained failure.
- **`reader_for` race fixed.** mpv opens several connections at once, so two concurrent requests
  for the same lesson both missed the cache, both spent a `resolve_file` round trip, and one
  reader (with its warmed cache and learned DC) was discarded — doubling requests exactly when
  playback starts. The lock is now held across creation.
- **Reader map bounded to 16.** Each holds up to 32 MB of chunks; unbounded growth would
  accumulate hundreds of megabytes on the 4 GB machines §12 targets.

Verified: `cargo test --lib` **199 passed** (+3: direct-vs-iterator offset parity, bounded
backoff, flood cap), clippy still 18, `tsc --noEmit` + `npm run build` clean. Still no player
component modified.

### 15.9 The ~1-minute stall — an un-timed-out await, and a permit deadlock

The `dc_id` fix (§15.8) removed the 10-second stall, and playback then failed at "1 minute and
some seconds". That timing is the evidence: `grammers-mtsender` uses
**`PING_DELAY = 60s`** and **`NO_PING_DISCONNECT = 75s`** (`sender.rs:49,58`) — the keepalive
interval and the server-side disconnect window. A failure clustered just past 60 s points at the
connection lifecycle, not at throughput.

**Root cause (the one that makes the stall permanent).** `SenderPoolHandle::invoke_in_dc` ends in
a bare `rx.await` with **no timeout** (`sender_pool.rs:130`). A socket that dies without
producing a read error — a silently dropped NAT/firewall mapping, exactly what happens to an idle
connection — leaves `run_sender` never erroring, the oneshot never resolved, and that future
waiting **forever**. And because `chunk()` held a semaphore permit across the whole fetch, a
hung fetch held its permit forever too: with `MAX_CONCURRENT_FETCHES = 4`, four hangs deadlock
every subsequent read. Playback stops dead with nothing in the log, which is precisely the
reported symptom.

Three fixes:
1. **`REQUEST_TIMEOUT = 30s` around every Telegram call.** A timeout is reported as an `Io`
   error so the existing backoff treats it as the dropped connection it is, and the cached
   `dc_id`/`auth_ready` are cleared so the next attempt rebuilds the connection through the
   iterator path.
2. **Permits no longer span retries.** The permit is scoped to a single network attempt inside
   `fetch_once`, so backoff sleeps (up to 7 s of I/O backoff, or a 45 s flood wait) never occupy
   a network slot. Previously four slow chunks could block every other read for a minute.
3. **Streamed response body** (`UnsyncBoxBody` + `StreamBody`) instead of buffering the whole
   8 MB slice. The buffered version sent nothing until the last byte arrived — on a slow link
   that is seconds of silence, long enough for a player to treat the connection as stalled.
   Chunks now reach the player as they land. (`UnsyncBoxBody`, not `BoxBody`: the stream holds
   non-`Sync` futures, and hyper only requires `Send`.)

**Gemini's analysis was directionally right and its streaming fix is the one adopted here**, but
its two diagnoses were incomplete: the 8 MB buffering explains a *delay*, not a permanent freeze,
and it missed the permit deadlock entirely — which is what turns a recoverable timeout into a
dead player. Its proposed 10 s timeout was also too aggressive: a healthy 512 KB read on a slow
link can exceed it, so it would kill working connections. 30 s is beyond any healthy read and
still well inside a user's patience.

**A prefetch/stream duplicate-fetch bug was found while doing this.** With a streamed body,
`read_range` warms chunk N+1 and the stream's next step then requests exactly that chunk — both
hitting the network. The read-ahead was *doubling* requests instead of hiding latency. An
`in_flight` claim set now makes the second caller wait for the first (bounded, so a wedged
prefetch can't block a real read).

Verified: `cargo test --lib` **201 passed** (+2: timeout bounds, worst-case chunk time), clippy
still 18, `tsc --noEmit` + `npm run build` clean. Still no player component modified.

### 15.10 Still owed
- **LIVE SMOKE TEST (`npm run tauri dev`) — nothing below has run against real Telegram.**
  Everything is compile-, test- and build-verified only. Verify in order: (a) Settings → Plugins
  shows the credentials form, and a bad `api_hash` is rejected next to the field; (b) save real
  my.telegram.org keys, connect with a phone number, confirm the code step names the number;
  (c) mistype the code once — it must report a bad code and let you retype WITHOUT sending a new
  code (this is the token-retention fix, and the highest-value thing to confirm); (d) 2FA path if
  the account has it, including a wrong password then the right one; (e) **restart the app — the
  nav dot must be lime before you open the plugin page** (session restore + boot `init`, the two
  headline fixes); (f) Disconnect, then confirm `tg.session.json` is gone from `app_data_dir`
  and the dot is gray; (g) unplug the network while connected → status should read
  "unreachable", NOT "not connected".
- **LIVE SMOKE TEST for Phases 4–6 — the player-regression checks are the important ones.**
  The whole streaming path is compile-, test- and build-verified only; no byte has moved over a
  real MTProto connection. Verify in order:
  1. **Import** a message link from a private channel → the lesson appears in the chosen folder.
  2. **Re-import the same link** → "Updated … already in your library", and NO duplicate row.
  3. **Browse channel** with an invite link (`t.me/+…`) on a channel with no username.
  4. **Play a streamed video** — first frame should appear within a couple of seconds (the
     open-ended range serves 1 MB, not the whole file).
  5. **Seek** in that video, forwards and backwards. This is the range-handling proof: a
     `Content-Range` off by one byte shows up here as a black frame or a dead seek bar.
  6. **REGRESSION WATCH — toggle fullscreen mid-playback.** §12.3's bug was a black frame from
     an mpv remount. No player component changed, so this *should* be untouched — confirm it.
  7. **REGRESSION WATCH — resume.** Watch ~30%, leave, reopen: it must open AT that position
     with no flash of 0:00 (§14.13's `start=` on `loadfile`).
  8. **REGRESSION WATCH — play/pause + progress.** Confirm the button state tracks reality and
     that watch time accrues (Study Meter / activity chart), since `useMediaProgress` and the
     mpv `time-pos` observer were deliberately not touched.
  9. **A streamed PDF** — PDF.js range-fetches page by page; this exercises the same server
     from a different client. Watch for the CSP fix having worked (a `127.0.0.1` block would
     fail *silently*).
  10. **Local files must be unaffected** — open a normal local video and PDF and confirm nothing
      regressed for them. `assetUrl()` is on their path too.
  11. Restart the app and play a streamed lesson again (fresh token + fresh server bind).
- **`FLOOD_WAIT` is reported but not enforced.** The message names the wait; nothing prevents the
  user from immediately retrying and extending it. A client-side cooldown belongs with Phase 7
  hardening.
- **CDN redirect is contained, not handled.** `catch_unwind` turns grammers' panic into a failed
  stream with an honest message. If it ever fires in practice, the real fix is the
  `upload.getCdnFile` flow (new DC connection, RSA key verification against
  `help.getCdnConfig`, per-chunk SHA-256 verification, `reuploadCdnFile` on
  `cdnFileReuploadNeeded`) — a substantial piece of work, deliberately deferred until there is
  evidence it's needed for private-channel media.
- **No prefetch.** Chunks are fetched on demand, so a seek into cold territory waits one round
  trip. `telegram.md` §5.5 calls for read-ahead; worth adding only if playback actually stutters.
- **Split/4 GB files (`.001`, `.002`) remain out of scope** (telegram.md issue #10), as does
  subtitle extraction (Phase 8, explicitly stretch).
- Telegram's own ACL/capability gating is still declarative only (`capabilities` is documentation,
  not enforcement) — as designed for v1, but it means "enabling" a plugin grants nothing revocable.
