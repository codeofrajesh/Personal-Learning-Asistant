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

## 14. Planning, Scheduling & Intelligence System (schema v9)

Time-blocked scheduling with an Intelligent Adjustment engine, an advisory pre-mortem, learned
pace, and schedule-adherence scoring. **Phases A + B (backend) and C (Today view, one clock,
durable reminders) are DONE**: `cargo test --lib` **81/81** green (was 14), zero new warnings;
`npm run build` + `tsc --noEmit` clean. Phases D–F are not started.

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

### 14.6 Command surface (19 registered, untested live)
`plan_day`, `upsert_plan_block`, `delete_plan_block`, `set_plan_block_status`,
`start_plan_block`, `active_plan_block`, `set_plan_day_window`, `recovery_plans` (**read-only**),
`apply_recovery` (→ undo token), `undo_recovery`, `dismiss_recovery`, `apply_plan_template`,
`reconcile_plan`, `score_summary`, plus the Phase C reminder ledger: `claim_reminder`
(atomic, returns whether YOU get to fire), `list_reminders`, `ack_reminder`, `snooze_reminder`,
`prune_reminders`.

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

### 14.8 Next — Phase D onward
- **D:** Recovery Card (inline, never a modal; suppressed during fullscreen video; one prompt
  per drift event via `plan_days.adjust_state`; 10s Undo).
- **E:** Score drill-downs (Today/Week/Month/Rolling-90) + weekly review.
- **F:** Innovations — Plan Integrity surfacing, templates UI, **exam backward-planning**,
  learned peak hours, streak insurance, Pomodoro↔block binding, focus contract.
- **Also owed:** live smoke test of v9 against a real pre-v9 DB, plus §13.5's outstanding items.
