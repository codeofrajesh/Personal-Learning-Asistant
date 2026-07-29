# Project Brief: Local-First Personal Learning Management System (PLE)

You are a Senior Full-Stack Architect. Build a high-performance, lightweight (sub-100MB RAM), offline-capable Personal Learning Environment (PLE) desktop app.

**The Problem:** Students hoard educational content — scattered video lectures, PDFs, notes across dozens of folders and drives. There is no tool to organize, track progress, and resume learning from local files with a premium UI.

**The Solution:** A desktop app where users manually register local folders, categorize them into a structured hierarchy (Goal → Subject → Chapter), and get a beautiful dashboard with progress tracking, search, and a built-in video player.

---

## 1. Tech Stack & Optimization Requirements

### Desktop Wrapper & Core Backend: Tauri v2 with Rust backend

**Architectural Rule:** Do NOT use an always-on Python server. ALL core logic (database reads, file serving, folder watching, subprocess launching) must be written in Rust compiled into the Tauri binary to keep idle memory at 30-50MB. Python should ONLY be used as a short-lived, on-demand sidecar for future AI features (NOT in v1).

### Frontend UI: React + Vite (Static Export) + TailwindCSS

**Constraints:**
- No SSR, no Next.js Node server
- Static export only — Vite builds to static HTML/JS/CSS that Tauri serves

### Database: Local SQLite

**Constraints:**
- Must use `PRAGMA journal_mode=WAL;` and a single shared connection for the app's lifetime to prevent UI blocking
- Store the database in the user's `app_data_dir` (Tauri-managed path)
- Use `rusqlite` directly (NOT the high-level tauri-plugin-sql) for fine-grained control over FTS5

### Future Scope (NOT v1)
- "Open Core" model: local app is free, paid cloud layer (Firebase/Supabase) for multi-device sync
- AI tagging via Python sidecar (Ollama/Whisper for local inference)
- Google Drive backup integration
- Multi-user profiles

---

## 2. Categorization System — The Core Innovation

### Hierarchy (4 Levels)

Inspired by how Vedantu, Khan Academy, and Unacademy organize content:

```
Goal (e.g., "JEE 2025", "CBSE Class 12", "Web Development")
  └── Subject (e.g., "Physics", "Mathematics", "React")
       └── Chapter/Module (e.g., "Kinematics", "Calculus", "Hooks")
            └── Material (lecture1.mp4, notes.pdf, formula-sheet.png)
```

### Folder Registration UX Flow

**Step 1:** User clicks "➕ Add Folder" → Native OS folder picker opens → User selects a folder (e.g., `D:\Study\Physics PW`)

**Step 2:** Categorization Wizard modal appears:

```
┌──────────────────────────────────────────────────────────┐
│  📁 Selected: D:\Study\Physics PW                        │
│                                                          │
│  What does this folder contain?                          │
│                                                          │
│  ○ A complete Goal     (e.g., "JEE Preparation")        │
│  ● A single Subject    (e.g., "Physics")                │
│  ○ A single Chapter    (e.g., "Thermodynamics")         │
│  ○ Mixed/Unsorted files                                 │
│                                                          │
│  ─────────────────────────────────────────────────       │
│                                                          │
│  Assign to Goal:  [ JEE 2025        ▾ ] [+ New Goal]   │
│  Subject Name:    [ Physics          ▾ ] [+ New]        │
│                                                          │
│  ─────────────────────────────────────────────────       │
│  Sub-folder mapping preview:                             │
│                                                          │
│  📁 01-Kinematics/     → Chapter: "Kinematics"         │
│  📁 02-Laws-of-Motion/ → Chapter: "Laws of Motion"     │
│  📁 03-Work-Energy/    → Chapter: "Work & Energy"      │
│  📂 PDFs/              → ⚙ Distribute to chapters      │
│  📄 syllabus.pdf       → 📎 Attached to Subject        │
│                                                          │
│           [ Scan & Import ]    [ Cancel ]                │
└──────────────────────────────────────────────────────────┘
```

**Key UX Rules:**
1. **Smart defaults** — Sub-folder names auto-become chapter names. Strip numbering prefixes (e.g., "01-", "Ch1_", "Lecture ") automatically.
2. **Goal/Subject dropdowns** — Show existing items + "Create New" option to prevent duplicates.
3. **Mixed folder handling** — If user picks "Mixed/Unsorted", show a flat file list and let them drag-drop into chapter buckets.
4. **Preview before import** — User sees exactly how files will be organized before committing.
5. **Re-categorize later** — Right-click any material → "Move to..." with the same Goal/Subject/Chapter picker.

---

## 3. File Scanning — WizTree-Inspired Architecture

### How WizTree Achieves Speed
WizTree reads the NTFS Master File Table (MFT) directly — a hidden database that indexes every file on the drive. Instead of "walking" the directory tree via slow OS-level API calls, it reads this single table and builds the entire file tree in memory. Result: scans 100K+ files in seconds.

### Our Dual-Mode Scanner

| Mode | When | How |
|---|---|---|
| **Initial Scan** | First time a folder is registered, or user triggers "Rescan" | Use `walkdir` crate for recursive scan. Batch INSERT files into SQLite using transactions (50x faster than individual inserts). |
| **Live Watcher** | After initial scan, continuously in background | Use `notify` crate (uses `ReadDirectoryChangesW` on Windows). Near-zero CPU usage, event-driven. |

### Scanner Logic (Rust)

```
1. User registers folder → INSERT into registered_dirs table
2. Spawn background task:
   a. Use walkdir to recursively enumerate files
   b. For each file:
      - Filter by known extensions: .mp4, .mkv, .avi, .webm, .pdf, .md, .txt, .png, .jpg, .docx
      - Extract basic metadata: size, modified date
      - For videos: spawn ffprobe as subprocess → get duration, resolution, codec
      - For PDFs: read page count via lightweight Rust PDF parser
   c. Batch INSERT into materials table (use SQLite transactions)
   d. Emit Tauri event → frontend updates progress bar
3. After scan complete → start `notify` watcher on that path
4. On file change events:
   - Created: INSERT new material, categorize under existing chapter
   - Modified: UPDATE file_size, re-extract metadata
   - Deleted: Mark material as status='missing' (DON'T hard-delete — show "File not found" in UI)
   - Renamed: UPDATE file_path and file_name
```

### Supported File Extensions
- **Video:** .mp4, .mkv, .avi, .webm, .mov
- **Document:** .pdf, .docx, .pptx
- **Notes:** .md, .txt
- **Images:** .png, .jpg, .jpeg, .gif
- **Audio:** .mp3, .wav, .m4a

### Error Handling Strategy

| Error | Handling |
|---|---|
| **File moved/deleted** | Mark with `status = 'missing'` in DB. Show ⚠️ icon in UI. Offer "Relocate" dialog. |
| **Permission denied** | Skip file, log warning. Show notification: "X files couldn't be scanned (permission denied)" |
| **Corrupt video** (ffprobe fails) | Set `duration_secs = NULL`. Show file but indicate "Metadata unavailable" |
| **Drive disconnected** | Pause watcher. Show banner: "Drive X is disconnected." |
| **Database locked** | WAL mode + single connection prevents this. If it occurs, retry with exponential backoff (3 attempts). |
| **Scan interrupted** (app crash) | Track `scan_status` per registered_dir. On next boot, resume from last scanned offset. |

---

## 4. Architecture & UI Performance Rules

### List Rendering
The app will handle thousands of files. You MUST use list virtualization (`@tanstack/react-virtual`) for all long lists — dashboard, file lists, search results.

### Progress Scrubber (Critical Performance Rule)
When tracking video progress, do NOT pipe `timeupdate` events into React state (causes massive re-render lag). Write position updates directly to a DOM ref via `requestAnimationFrame`. Only touch React state on discrete events (pause, seek, finish).

### Video Playback — Option A (Integrated Player)
The Rust backend serves local .mp4 files over localhost via HTTP byte-range requests.

**Constraint:** Never buffer the whole video in memory. Stream in small chunks (~1MB) and strictly honor `Range` headers so seeking works instantly.

### Video Playback — Option B (External Native Player)
mpv is the default external player (VLC as secondary fallback).

**Tracking:** The Rust backend launches mpv with `--input-ipc-server=<path>`. It connects to mpv's native named pipe (Windows) / Unix socket to send and receive JSON IPC messages. It fetches the live playback timestamp and updates SQLite in the background. Pushes events to React via Tauri events for real-time UI progress updates.

---

## 5. Search System — SQLite FTS5

### Architecture (Zero External Dependencies)

```
User types in search bar
        │
        ▼
  400ms debounce (don't search on every keystroke)
        │
        ▼
  React sends IPC to Rust: search_materials(query, filters)
        │
        ▼
  Rust builds FTS5 query with highlighted results + BM25 ranking
        │
        ▼
  Return top 50 results → "Load More" pagination for rest
```

### Filter System

| Filter | UI | Implementation |
|---|---|---|
| **By Type** | Pill buttons: All, Videos, PDFs, Notes, Images | `WHERE file_type IN (?)` |
| **By Goal** | Dropdown | JOIN through goal_id |
| **By Subject** | Cascading dropdown (updates when Goal changes) | JOIN through subject_id |
| **By Status** | All, In Progress, Completed, Not Started | Derived from watch_progress table |
| **By Recency** | Recently Added, Recently Watched, Oldest First | ORDER BY clause |

### Global Search Shortcut
`Ctrl+K` opens a search modal from any page — similar to VS Code's command palette.

---

## 6. Database Schema

```sql
-- Goals: Top-level learning objectives
CREATE TABLE goals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    description TEXT,
    icon        TEXT DEFAULT '🎯',
    color       TEXT DEFAULT '#AAFF00',
    sort_order  INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
);

-- Subjects: Second level
CREATE TABLE subjects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id     INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT,
    icon        TEXT DEFAULT '📚',
    color       TEXT,
    sort_order  INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    UNIQUE(goal_id, name)
);

-- Chapters: Third level
CREATE TABLE chapters (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id  INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT,
    sort_order  INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    UNIQUE(subject_id, name)
);

-- Materials: Actual files
CREATE TABLE materials (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    chapter_id      INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    file_path       TEXT NOT NULL UNIQUE,
    file_name       TEXT NOT NULL,
    file_type       TEXT NOT NULL,        -- 'video', 'pdf', 'note', 'image', 'audio'
    file_extension  TEXT NOT NULL,
    file_size_bytes INTEGER DEFAULT 0,
    duration_secs   REAL,                  -- video/audio only
    thumbnail_path  TEXT,
    resolution      TEXT,                  -- video: "1920x1080"
    codec           TEXT,
    bitrate         INTEGER,
    page_count      INTEGER,               -- PDF only
    status          TEXT DEFAULT 'active', -- 'active', 'missing', 'error'
    is_bookmarked   INTEGER DEFAULT 0,
    is_completed    INTEGER DEFAULT 0,
    last_opened_at  TEXT,
    sort_order      INTEGER DEFAULT 0,
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
);

-- Watch Progress
CREATE TABLE watch_progress (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    material_id     INTEGER NOT NULL UNIQUE REFERENCES materials(id) ON DELETE CASCADE,
    position_secs   REAL NOT NULL DEFAULT 0,
    duration_secs   REAL NOT NULL DEFAULT 0,
    completion_pct  REAL GENERATED ALWAYS AS (
                        CASE WHEN duration_secs > 0
                        THEN MIN(100.0, (position_secs / duration_secs) * 100)
                        ELSE 0 END
                    ) STORED,
    completed       INTEGER DEFAULT 0,
    last_watched_at TEXT DEFAULT (datetime('now')),
    watch_count     INTEGER DEFAULT 1
);

-- Registered Directories
CREATE TABLE registered_dirs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    path            TEXT NOT NULL UNIQUE,
    category_level  TEXT NOT NULL,          -- 'goal', 'subject', 'chapter', 'mixed'
    goal_id         INTEGER REFERENCES goals(id),
    subject_id      INTEGER REFERENCES subjects(id),
    chapter_id      INTEGER REFERENCES chapters(id),
    is_active       INTEGER DEFAULT 1,
    scan_status     TEXT DEFAULT 'pending', -- 'pending', 'scanning', 'complete', 'error'
    last_scanned_at TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
);

-- User Settings
CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Study Sessions (for analytics)
CREATE TABLE study_sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    material_id     INTEGER REFERENCES materials(id),
    started_at      TEXT NOT NULL,
    ended_at        TEXT,
    duration_secs   REAL DEFAULT 0,
    session_date    TEXT GENERATED ALWAYS AS (date(started_at)) STORED
);

-- Full-Text Search Index
CREATE VIRTUAL TABLE materials_fts USING fts5(
    file_name,
    file_path,
    content='materials',
    content_rowid='id',
    tokenize='unicode61'
);

-- FTS Sync Triggers
CREATE TRIGGER materials_ai AFTER INSERT ON materials BEGIN
    INSERT INTO materials_fts(rowid, file_name, file_path)
    VALUES (new.id, new.file_name, new.file_path);
END;

CREATE TRIGGER materials_ad AFTER DELETE ON materials BEGIN
    INSERT INTO materials_fts(materials_fts, rowid, file_name, file_path)
    VALUES ('delete', old.id, old.file_name, old.file_path);
END;

CREATE TRIGGER materials_au AFTER UPDATE ON materials BEGIN
    INSERT INTO materials_fts(materials_fts, rowid, file_name, file_path)
    VALUES ('delete', old.id, old.file_name, old.file_path);
    INSERT INTO materials_fts(rowid, file_name, file_path)
    VALUES (new.id, new.file_name, new.file_path);
END;

-- Performance Indexes
CREATE INDEX idx_materials_chapter ON materials(chapter_id);
CREATE INDEX idx_materials_type ON materials(file_type);
CREATE INDEX idx_materials_status ON materials(status);
CREATE INDEX idx_materials_bookmarked ON materials(is_bookmarked) WHERE is_bookmarked = 1;
CREATE INDEX idx_watch_progress_last ON watch_progress(last_watched_at DESC);
CREATE INDEX idx_study_sessions_date ON study_sessions(session_date);
CREATE INDEX idx_chapters_subject ON chapters(subject_id);
CREATE INDEX idx_subjects_goal ON subjects(goal_id);
```

---

## 7. UI/UX Design — Reference Screenshots

Design screenshots are in three folders in this project directory:
- `dashboard Designs/` — 5 images, 3 marked "fav" in filename
- `coursepage design/` — 5 images
- `videoplayer design/` — 1 image

**CRITICAL:** Take inspiration ONLY from the visual design (colors, layout, typography, animations, card styles) — NOT the features shown in those screenshots. We are building a LOCAL file organizer, not an online course marketplace.

### Design DNA (Extracted from Favorites)

| Element | Specification |
|---|---|
| **Theme** | Dark mode primary — deep charcoal backgrounds (`#0D0D0D` to `#1A1A1A`) |
| **Glass effect** | Glassmorphism on cards — frosted glass, thin borders (`border: 1px solid rgba(255,255,255,0.08)`), `backdrop-filter: blur(12px)` |
| **Primary accent** | Neon green/lime (`#AAFF00`) — active nav items, progress bars, highlights |
| **Secondary accent** | Warm orange (`#FF6B35`) — CTAs, completion badges, alerts |
| **Card layout** | Bento grid — irregular card sizes, not uniform. Stats get small cards, featured content gets hero cards |
| **Sidebar** | Narrow, dark, icon + text. Active item has accent-color pill background |
| **Typography** | Inter font (Google Fonts). Large bold headings, muted gray (`#888`) secondary text |
| **Progress** | Circular progress rings + horizontal gradient bars |
| **Charts** | Minimal bar charts for daily activity, line charts for trends |
| **Spacing** | 20-24px padding inside cards, 12-16px gaps between grid items |
| **Radius** | 12-16px border radius on cards, 8px on buttons and inputs |
| **Shadows** | Subtle dark shadows (`0 4px 24px rgba(0,0,0,0.3)`) |
| **Animations** | Smooth hover scale (1.02), fade-in on mount, slide transitions between pages |

---

## 8. Pages to Build

### PAGE 1: Dashboard (Home)
- Welcome greeting: "Welcome back, User" with current date
- **"Continue Learning" section:** Cards showing last-accessed materials with progress bars and "Resume" buttons (inspired by Crossfader/Courseon screenshots)
- **Progress Statistics card:** Total Activity %, counts for In Progress / Completed / Total materials
- **Activity chart:** Bar chart showing daily study hours for the past 7 days (like Courseon "Activity" card)
- **Study streak:** Calendar-style weekly streak indicator showing active days
- **Quick access:** Recently bookmarked items list

### PAGE 2: Library (All Goals)
- Grid of Goal cards with auto-generated thumbnails, overall progress rings, total material counts
- Category filter tabs with counts (like Crossfader: "Continue learning (12)", "Beginner (13)", etc.)
- Prominent "➕ Add Folder" button that triggers the categorization wizard
- Sort: By name, by recent activity, by completion %

### PAGE 3: Goal Detail → Subjects List
- Breadcrumb: `Library / Goal Name`
- Grid of Subject cards within the selected goal
- Overall goal progress bar
- Subject cards show: icon, name, chapter count, material count, completion %

### PAGE 4: Subject Detail → Chapters List
- Breadcrumb: `Library / Goal / Subject`
- Vertical list of chapters:
  - Chapter number + name
  - Material count per chapter (videos, PDFs separately)
  - Completion percentage with progress bar
  - "Start" or "Continue" button

### PAGE 5: Chapter Detail → Materials List
- Breadcrumb: `Library / Goal / Subject / Chapter`
- Numbered material list (like Crossfader lesson list screenshot):
  - **Video:** Thumbnail + title + duration + progress bar + bookmark toggle + Done/Start status
  - **PDF:** Page icon + title + page count + "Open" button
  - **Note:** Text icon + title + preview snippet
- Bookmark toggle on each item
- Right-click context menu: "Move to...", "Mark as complete", "Remove"

### PAGE 6: Video Player
- **Layout:** 70% video area + 30% chapter sidebar (collapsible) — like the videoplayer design screenshot
- **Chapter sidebar:** Accordion with all chapters in the current subject. Current lesson highlighted with accent color. Click any lesson to switch.
- **Below video:** Tab bar with "Description" (filename-based info), "Materials" (related PDFs in same chapter), "Notes" (personal notes — future feature)
- **Custom controls:** Play/pause, seek bar (DOM ref-based, NOT React state), volume, fullscreen, playback speed selector (0.5x to 2x)
- **Progress:** Auto-save to SQLite on pause, seek, finish, and window close. Show progress bar in chapter sidebar for each lesson.

### PAGE 7: Settings
- **Manage Folders:** List of registered directories with scan status indicators, "Add Folder" / "Remove" / "Rescan" buttons
- **Default Player:** Radio buttons — Integrated / mpv / VLC
- **Theme:** Dark mode toggle (dark is default, light mode is future)
- **Data Management:** Export Progress (JSON), Backup Database (copy .db file), Import Data
- **Keyboard Shortcuts:** Reference card showing all shortcuts
- **About:** App name, version

### PAGE 8: Search Modal (Ctrl+K Overlay)
- Full-screen overlay with large search input (like VS Code command palette)
- Filter pills below search bar: All, Videos, PDFs, Notes
- Results list with highlighted matching text, grouped by Goal → Subject
- Click result → navigate directly to that material's player/viewer
- Empty state: "Start typing to search across all your materials..."

---

## 9. Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+K` | Open global search |
| `Space` | Play/pause video (when player focused) |
| `←` / `→` | Seek -10s / +10s |
| `↑` / `↓` | Volume up / down |
| `F` | Toggle fullscreen |
| `Ctrl+B` | Toggle sidebar |
| `Esc` | Close modal / dialog / search |
| `N` | Next lesson in chapter |
| `P` | Previous lesson |
| `M` | Mark current material as complete |

---

## 10. Data & Backup

- All data stored locally in SQLite (`app_data_dir/ple.db`)
- **Export:** JSON export of all goals, subjects, chapters, progress, settings
- **Backup:** Copy the `.db` file to a user-chosen location via native save dialog
- **Import:** Read JSON and merge into current database (handle duplicates gracefully)
- **Future (v2):** Google Drive API integration for cloud backup

---

## 11. Application Workflow

### App Boot
1. Tauri launches
2. Rust backend initializes SQLite connection (WAL mode)
3. Load registered directories from DB
4. Start `notify` watchers on all active registered directories (asynchronous, low-resource)
5. Check for any files marked `status='missing'` — verify if they've reappeared

### Dashboard Load
1. React frontend mounts
2. Requests categorized library via Tauri IPC `invoke` commands
3. Rust returns JSON tree: Goals → Subjects → Chapters (with material counts and progress aggregates)
4. Frontend renders the bento grid dashboard

### Playback & Tracking
1. User clicks a video material
2. **Option A (Integrated):** React mounts the HTML5 video player. Rust serves bytes via localhost HTTP with Range headers. React batches progress updates via IPC on pause/seek/finish.
3. **Option B (mpv):** React sends IPC command to Rust. Rust launches mpv subprocess with IPC pipe. Rust polls `time-pos` property via JSON IPC, saves to SQLite in background, pushes events to React via Tauri events.

---

## 12. Monorepo Directory Structure

```
ple/
├── src-tauri/                    # Rust backend (Tauri v2)
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── build.rs
│   ├── icons/
│   └── src/
│       ├── main.rs               # Tauri entry point
│       ├── lib.rs                # Module declarations
│       ├── db/
│       │   ├── mod.rs            # Database module
│       │   ├── connection.rs     # SQLite connection (WAL mode, single shared)
│       │   ├── schema.rs         # CREATE TABLE migrations
│       │   └── queries.rs        # All SQL queries as functions
│       ├── scanner/
│       │   ├── mod.rs
│       │   ├── walker.rs         # walkdir-based recursive file scanner
│       │   ├── watcher.rs        # notify-based live file watcher
│       │   └── metadata.rs       # ffprobe, PDF page count extraction
│       ├── commands/
│       │   ├── mod.rs
│       │   ├── goals.rs          # CRUD IPC commands for goals
│       │   ├── subjects.rs       # CRUD IPC commands for subjects
│       │   ├── chapters.rs       # CRUD IPC commands for chapters
│       │   ├── materials.rs      # CRUD + search IPC commands
│       │   ├── progress.rs       # Watch progress IPC commands
│       │   ├── settings.rs       # Settings IPC commands
│       │   └── scanner.rs        # Scan trigger + status IPC commands
│       ├── player/
│       │   ├── mod.rs
│       │   ├── server.rs         # HTTP byte-range server for local video files
│       │   └── mpv.rs            # mpv subprocess launcher + IPC client
│       └── utils/
│           ├── mod.rs
│           └── errors.rs         # Custom error types
│
├── src/                          # React frontend
│   ├── main.tsx                  # React entry point
│   ├── App.tsx                   # Router + layout
│   ├── index.css                 # TailwindCSS imports + global styles
│   ├── components/
│   │   ├── layout/
│   │   │   ├── Sidebar.tsx       # Navigation sidebar
│   │   │   ├── AppShell.tsx      # Main layout wrapper
│   │   │   └── Breadcrumb.tsx
│   │   ├── ui/
│   │   │   ├── Card.tsx          # Glassmorphism card
│   │   │   ├── ProgressRing.tsx  # Circular progress indicator
│   │   │   ├── ProgressBar.tsx   # Horizontal progress bar
│   │   │   ├── Badge.tsx         # Status/count badges
│   │   │   ├── Button.tsx
│   │   │   ├── Modal.tsx         # Reusable modal
│   │   │   ├── Skeleton.tsx      # Loading skeleton
│   │   │   └── SearchModal.tsx   # Ctrl+K search overlay
│   │   ├── dashboard/
│   │   │   ├── ContinueLearning.tsx
│   │   │   ├── ProgressStats.tsx
│   │   │   ├── ActivityChart.tsx
│   │   │   ├── StudyStreak.tsx
│   │   │   └── QuickAccess.tsx
│   │   ├── library/
│   │   │   ├── GoalCard.tsx
│   │   │   ├── SubjectCard.tsx
│   │   │   ├── ChapterList.tsx
│   │   │   └── MaterialItem.tsx
│   │   ├── player/
│   │   │   ├── VideoPlayer.tsx   # HTML5 player with custom controls
│   │   │   ├── PlayerControls.tsx
│   │   │   ├── ChapterSidebar.tsx
│   │   │   └── PlayerTabs.tsx
│   │   └── wizard/
│   │       ├── AddFolderWizard.tsx
│   │       ├── CategoryPicker.tsx
│   │       └── FolderPreview.tsx
│   ├── pages/
│   │   ├── Dashboard.tsx
│   │   ├── Library.tsx
│   │   ├── GoalDetail.tsx
│   │   ├── SubjectDetail.tsx
│   │   ├── ChapterDetail.tsx
│   │   ├── PlayerPage.tsx
│   │   └── Settings.tsx
│   ├── hooks/
│   │   ├── useIPC.ts             # Tauri invoke wrapper
│   │   ├── useSearch.ts          # FTS5 search with debounce
│   │   ├── useKeyboardShortcuts.ts
│   │   └── useProgress.ts       # Video progress tracking
│   ├── stores/
│   │   └── appStore.ts           # Zustand or similar lightweight state
│   └── lib/
│       ├── types.ts              # TypeScript interfaces matching Rust structs
│       └── utils.ts              # Formatters (duration, file size, dates)
│
├── index.html
├── package.json
├── vite.config.ts
├── tailwind.config.js
├── tsconfig.json
└── README.md
```

---

## 13. Rules of Engagement

1. **Do NOT code blindly.** If a requirement is ambiguous or there is a major architectural trade-off, pause and ask clarifying questions.
2. **Provide high-level outlines or pseudocode** for complex parts before writing hundreds of lines.
3. **Single profile for now.** The database schema allows multi-user later but don't build it now.
4. **No AI features in v1.** Everything runs 100% locally without internet.
5. **Don't build the entire app at once.** Follow this build order:
   - Project scaffold → Database schema → Folder registration wizard → File scanner →
   - Dashboard → Library pages → Course/Chapter pages → Video player →
   - Search modal → Settings → Keyboard shortcuts → Polish & animations

---

## 14. First Task

Start with the foundation. Do NOT write the entire application at once.

1. **Scaffold** the Tauri v2 + React/Vite + TailwindCSS monorepo as described in the directory structure above.
2. **Implement** the SQLite database schema with all tables, FTS5, triggers, and indexes.
3. **Verify** the Tauri IPC roundtrip works (a simple test command that writes to and reads from the database).
4. **Build** the App Shell (sidebar + main content area) with the dark glassmorphism design system.
5. Then proceed to the Folder Registration Wizard and file scanner.

---

## 15. AI Skill & MCP Directions — Use These When Building

You have the following skills and MCP servers installed globally. Each one is a specialist — invoke the right skill at the right time to produce world-class output. **Do not ignore these skills.** Read their SKILL.md files from `~/.agents/skills/` before starting each component.

### Installed Skills (17 total)

| Skill Name | Location | Purpose |
|---|---|---|
| `frontend-design` | `~/.agents/skills/frontend-design/` | Anthropic's official frontend patterns |
| `ui-ux-pro-max` | `~/.agents/skills/ui-ux-pro-max/` | Premium agency-quality UI intelligence |
| `design-taste-frontend` | `~/.agents/skills/design-taste-frontend/` | Anti-slop: layout, typography, motion, spacing |
| `design` | `~/.agents/skills/design/` | General design best practices |
| `design-system` | `~/.agents/skills/design-system/` | Consistent design token management |
| `ui-styling` | `~/.agents/skills/ui-styling/` | CSS/Tailwind styling excellence |
| `vercel-react-best-practices` | `~/.agents/skills/vercel-react-best-practices/` | 40+ React performance rules from Vercel |
| `web-design-guidelines` | `~/.agents/skills/web-design-guidelines/` | 100+ accessibility, UX, and performance rules |
| `gsap-core` | `~/.agents/skills/gsap-core/` | GSAP animation engine fundamentals |
| `gsap-react` | `~/.agents/skills/gsap-react/` | useGSAP hook, refs, cleanup |
| `gsap-timeline` | `~/.agents/skills/gsap-timeline/` | Sequenced animation timelines |
| `gsap-scrolltrigger` | `~/.agents/skills/gsap-scrolltrigger/` | Scroll-linked animations |
| `gsap-performance` | `~/.agents/skills/gsap-performance/` | GPU-friendly animation optimization |
| `gsap-plugins` | `~/.agents/skills/gsap-plugins/` | SplitText, Flip, MorphSVG, etc. |
| `gsap-utils` | `~/.agents/skills/gsap-utils/` | Utility helpers (clamp, mapRange, etc.) |
| `gsap-frameworks` | `~/.agents/skills/gsap-frameworks/` | Framework integration patterns |
| `find-skills` | `~/.agents/skills/find-skills/` | Skill discovery utility |

### Installed MCP Server

| MCP | Config | Purpose |
|---|---|---|
| `21st.dev Magic` | `.mcp.json` in project root | On-demand premium UI component generation. Use `/ui <description>` to fetch polished components from 21st.dev's library. Requires `API_KEY_21ST` env var. |

---

### Skill-to-Component Mapping — FOLLOW THIS

#### 🎨 DESIGN SYSTEM & GLOBAL STYLES (`src/index.css`, `tailwind.config.js`)
**Primary Skills:** `design-system` + `design-taste-frontend` + `ui-styling`

Before writing ANY CSS or Tailwind config:
1. Read `design-taste-frontend` SKILL.md — it defines anti-slop spacing systems, typographic scales, and color harmony rules.
2. Read `design-system` SKILL.md — use it to create a consistent token system for the dark glassmorphism theme defined in Section 7.
3. Read `ui-styling` SKILL.md — apply its Tailwind-specific patterns for efficient class composition.

**Tokens to establish first:**
- Color palette: `#0D0D0D`, `#1A1A1A`, `#AAFF00`, `#FF6B35`, glass borders, muted grays
- Spacing scale: 4px base grid
- Typography: Inter font, heading sizes, body sizes, muted secondary text
- Border radius: 12-16px cards, 8px buttons
- Glass effect utilities: `backdrop-blur`, border opacity, shadow values

---

#### 🧱 REUSABLE UI COMPONENTS (`src/components/ui/`)
**Primary Skills:** `ui-ux-pro-max` + `frontend-design` + `design-taste-frontend`
**MCP:** `21st.dev Magic` for rapid component scaffolding

For each component (`Card.tsx`, `Button.tsx`, `Modal.tsx`, `ProgressRing.tsx`, `Badge.tsx`, `Skeleton.tsx`):
1. Read `ui-ux-pro-max` SKILL.md — it enforces premium, non-generic component patterns (proper hover states, focus rings, micro-interactions, visual weight).
2. Read `frontend-design` SKILL.md — it provides Anthropic's official component structure patterns (composition, prop design, accessibility).
3. Optionally use `21st.dev` MCP to fetch a starting point: e.g., ask `/ui dark glassmorphism card component with frosted glass effect` — then adapt to match our Section 7 design DNA.
4. Apply `design-taste-frontend` anti-slop rules: no default browser focus, no generic hover colors, no lazy spacing.

**Critical components that MUST feel premium:**
- `Card.tsx` → Glassmorphism: frosted glass, thin glowing border, subtle shadow. Hover: scale(1.02) + border brightness increase.
- `ProgressRing.tsx` → SVG circle with stroke-dasharray animation. Neon green fill with glow effect.
- `Modal.tsx` → Centered overlay with backdrop blur, enter/exit animation (fade + scale), focus trap.
- `SearchModal.tsx` → Full-screen overlay inspired by VS Code command palette. Instant-feel filtering.

---

#### 📐 LAYOUT SHELL (`src/components/layout/`)
**Primary Skills:** `frontend-design` + `web-design-guidelines` + `design-taste-frontend`

For `AppShell.tsx`, `Sidebar.tsx`, `Breadcrumb.tsx`:
1. Read `web-design-guidelines` SKILL.md — follow its 100+ accessibility rules (semantic HTML, aria-labels, keyboard navigation, focus-visible patterns).
2. Read `frontend-design` for layout composition best practices.
3. Apply `design-taste-frontend` layout rules — proper visual hierarchy, no "floating" elements, consistent rhythm.

**Sidebar specifics:** Narrow, icon + text. Active item has neon green pill background. Use `Ctrl+B` toggle with GSAP slide animation. Must be keyboard-navigable (arrow keys cycle items, Enter selects).

---

#### 📊 DASHBOARD PAGE (`src/pages/Dashboard.tsx`, `src/components/dashboard/`)
**Primary Skills:** `ui-ux-pro-max` + `design-taste-frontend` + `gsap-react` + `gsap-timeline`

This is the HERO page — first thing users see. It MUST wow.
1. Read `ui-ux-pro-max` for premium dashboard card layout intelligence.
2. Use `gsap-react` (`useGSAP` hook) + `gsap-timeline` to create a staggered entrance animation: cards fade-in + slide-up in sequence (100ms stagger) when the dashboard mounts.
3. Apply `design-taste-frontend` spacing rhythm: bento grid with irregular card sizes, consistent 12-16px gaps.
4. Charts (`ActivityChart.tsx`) — use lightweight SVG or a minimal chart library. Apply `gsap-timeline` for animated bar chart reveals.

**Animation sequence on mount:**
```
gsap.timeline()
  .from(".stat-card", { y: 30, opacity: 0, stagger: 0.1, ease: "power2.out" })
  .from(".activity-chart", { y: 20, opacity: 0 }, "-=0.3")
  .from(".continue-learning", { x: -20, opacity: 0 }, "-=0.3")
```

---

#### 📚 LIBRARY & COURSE PAGES (`src/pages/Library.tsx`, `GoalDetail.tsx`, `SubjectDetail.tsx`, `ChapterDetail.tsx`)
**Primary Skills:** `vercel-react-best-practices` + `ui-ux-pro-max` + `gsap-react`

1. Read `vercel-react-best-practices` SKILL.md — these pages render lists of potentially hundreds of items. Apply its Critical-priority rules: eliminate render waterfalls, use `@tanstack/react-virtual` for long lists, memoize expensive computations.
2. Read `ui-ux-pro-max` for card design intelligence — Goal cards need auto-generated thumbnails, progress rings, and hover states that feel premium.
3. Use `gsap-react` for card entrance animations (staggered fade-in when page mounts or filter changes).

**Performance mandate:** The Library page MUST handle 100+ Goal cards without jank. Use virtualized rendering. Skeleton loading states while data loads (never show empty white space).

---

#### 🎬 VIDEO PLAYER (`src/pages/PlayerPage.tsx`, `src/components/player/`)
**Primary Skills:** `vercel-react-best-practices` + `frontend-design` + `gsap-react`

The player is the most performance-critical component.
1. Read `vercel-react-best-practices` — especially the re-render optimization rules. The seek bar MUST use DOM refs + requestAnimationFrame, NOT React state (Section 4 of this spec).
2. Read `frontend-design` for component composition — the player has a complex structure (video + controls + sidebar + tabs) that must be cleanly composed.
3. Use `gsap-react` for chapter sidebar slide-in/out animation and tab content transitions.

**Critical rules:**
- Seek bar thumb position: write to `element.style.transform` directly via `useRef`, NOT via `setState`.
- `timeupdate` events: throttle with `requestAnimationFrame`, write to DOM ref, batch IPC calls to Rust.
- Chapter sidebar: collapsible with smooth GSAP slide. Current lesson highlighted with `#AAFF00` accent.

---

#### 🔍 SEARCH MODAL (`src/components/ui/SearchModal.tsx`)
**Primary Skills:** `frontend-design` + `web-design-guidelines` + `gsap-react`

1. Read `web-design-guidelines` for accessibility — the search modal needs proper `role="dialog"`, `aria-modal="true"`, focus trap, and `Esc` to close.
2. Read `frontend-design` for modal/overlay patterns.
3. Use `gsap-react` for the open/close animation: backdrop fade + modal scale-in from 0.95.

**Must feel like VS Code's command palette:** instant filtering as you type (400ms debounce to Rust FTS5), highlighted matching text in results, keyboard navigation (arrow keys + Enter to select).

---

#### 🧙 FOLDER WIZARD (`src/components/wizard/`)
**Primary Skills:** `ui-ux-pro-max` + `design-taste-frontend` + `frontend-design`

1. Read `ui-ux-pro-max` for multi-step wizard UX intelligence — proper step indicators, smooth transitions between steps, clear progress communication.
2. Read `design-taste-frontend` for form design anti-slop — no tiny inputs, no cramped layouts, proper label-input spacing.
3. Read `frontend-design` for form composition and validation patterns.

**This wizard is the core UX innovation.** It must feel effortless: user picks a folder → instantly sees a categorization preview → one click to import. No confusion about what each step does.

---

#### ⚡ ANIMATIONS & TRANSITIONS (Global)
**Primary Skills:** `gsap-core` + `gsap-react` + `gsap-timeline` + `gsap-performance` + `gsap-scrolltrigger`

**Read `gsap-performance` BEFORE writing ANY animation.** Key rules:
- Use `transform` and `opacity` ONLY (compositor-friendly, no layout thrashing)
- Use `will-change` sparingly and remove after animation completes
- Batch animations into timelines, don't create individual tweens per element
- Use `gsap-react`'s `useGSAP` hook for proper cleanup (prevents memory leaks)

**Page transitions:** When navigating between pages, use a quick crossfade:
```
// Exit: current page fades out (150ms)
// Enter: new page fades in + slides up slightly (200ms)
gsap.fromTo(pageRef, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.2 })
```

**Hover animations:** Cards scale to 1.02 on hover with a 200ms ease. Use CSS for simple hovers, GSAP for complex multi-property animations.

**Do NOT use Framer Motion.** We use GSAP exclusively for animation to keep the dependency footprint small (important for the 30-50MB memory target).

---

#### ♿ ACCESSIBILITY & UX QUALITY (All Components)
**Primary Skills:** `web-design-guidelines` + `design-taste-frontend`

Read `web-design-guidelines` SKILL.md and apply these rules to EVERY component:
- Every interactive element has a visible focus state (`focus-visible` with `#AAFF00` outline)
- All images have `alt` text
- Color contrast ratio ≥ 4.5:1 for text (verify neon green on dark backgrounds)
- Prefer `prefers-reduced-motion` — disable GSAP animations if the OS-level setting is enabled
- Use semantic HTML: `<nav>`, `<main>`, `<aside>`, `<section>`, `<article>` — not `<div>` soup
- All forms have proper `<label>` associations and error states

---

#### ⚛️ REACT PERFORMANCE (All Pages)
**Primary Skill:** `vercel-react-best-practices`

Read this skill's SKILL.md and enforce these Critical and High-priority rules across the entire app:
- **Eliminate render waterfalls:** Don't fetch data in child components that depends on parent data sequentially. Fetch in parallel at the page level.
- **Bundle size:** Lazy-load pages with `React.lazy()` + `Suspense`. The Dashboard, Library, and Player pages should be separate chunks.
- **Memoization:** Use `React.memo` on expensive list item components (`GoalCard`, `MaterialItem`, `ChapterList`). Use `useMemo` for derived data (progress calculations, filtered lists).
- **State management:** Use Zustand (tiny, no provider wrapping). Only put SHARED state in the store (current playback, active goal). Keep page-local state in `useState`.

---

### 21st.dev MCP Usage Guide

The 21st.dev Magic MCP is available in this project (configured in `.mcp.json`). Use it strategically:

**When to use it:**
- When scaffolding a NEW component and you want a premium starting point
- When you need inspiration for a specific UI pattern (e.g., a bento grid layout, a glassmorphism card, a video player control bar)

**When NOT to use it:**
- Don't use it for every component — our design DNA (Section 7) is very specific
- Don't use 21st.dev components as-is — always adapt to match our color palette, glassmorphism style, and spacing system
- Don't use it for Rust/backend code (it's frontend-only)

**Example prompts for 21st.dev:**
- `21st search "glassmorphism card"` → fetch a card component, then adapt
- `21st search "video player controls"` → fetch player UI, then customize
- `21st search "bento grid dashboard"` → fetch layout inspiration
- `21st search "sidebar navigation dark"` → fetch sidebar pattern

---

### Skill Loading Priority

When starting work on any component, load skills in this order:

1. **First:** `design-taste-frontend` (establishes quality baseline — anti-slop)
2. **Second:** The domain-specific skill (`vercel-react-best-practices` for perf, `gsap-react` for animation, `web-design-guidelines` for a11y)
3. **Third:** `ui-ux-pro-max` (ensures the output is premium, not generic)
4. **Last:** `frontend-design` (Anthropic's structural patterns for clean composition)