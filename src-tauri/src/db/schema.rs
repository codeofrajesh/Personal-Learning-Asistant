//! Database schema — all `CREATE TABLE`/index/trigger statements.
//!
//! This is the canonical schema from the project brief (Section 6). It is applied
//! idempotently on every boot inside a single transaction. `user_version` in the
//! SQLite header tracks the applied migration version so future migrations can be
//! layered on without re-running v1.

/// Bump this when adding a migration step below.
///
/// v2: added the `tasks` table (dashboard to-do list) + its indexes.
/// v3: added `study_sessions.session_type` (Pomodoro focus/break tracking).
/// v4: added `tasks.estimated_mins` + the `consistency_log` table (Planning Hub).
/// v5: added the `notes` table (timestamped video notes).
pub const SCHEMA_VERSION: i64 = 5;

/// The complete v1 schema. Every statement is `IF NOT EXISTS` where SQLite allows,
/// so re-application is a no-op.
pub const SCHEMA_SQL: &str = r#"
-- Goals: Top-level learning objectives
CREATE TABLE IF NOT EXISTS goals (
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
CREATE TABLE IF NOT EXISTS subjects (
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
CREATE TABLE IF NOT EXISTS chapters (
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
CREATE TABLE IF NOT EXISTS materials (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    chapter_id      INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    file_path       TEXT NOT NULL UNIQUE,
    file_name       TEXT NOT NULL,
    file_type       TEXT NOT NULL,
    file_extension  TEXT NOT NULL,
    file_size_bytes INTEGER DEFAULT 0,
    duration_secs   REAL,
    thumbnail_path  TEXT,
    resolution      TEXT,
    codec           TEXT,
    bitrate         INTEGER,
    page_count      INTEGER,
    status          TEXT DEFAULT 'active',
    is_bookmarked   INTEGER DEFAULT 0,
    is_completed    INTEGER DEFAULT 0,
    last_opened_at  TEXT,
    sort_order      INTEGER DEFAULT 0,
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
);

-- Watch Progress
CREATE TABLE IF NOT EXISTS watch_progress (
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
CREATE TABLE IF NOT EXISTS registered_dirs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    path            TEXT NOT NULL UNIQUE,
    category_level  TEXT NOT NULL,
    goal_id         INTEGER REFERENCES goals(id),
    subject_id      INTEGER REFERENCES subjects(id),
    chapter_id      INTEGER REFERENCES chapters(id),
    is_active       INTEGER DEFAULT 1,
    scan_status     TEXT DEFAULT 'pending',
    last_scanned_at TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
);

-- User Settings
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Study Sessions (for analytics)
CREATE TABLE IF NOT EXISTS study_sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    material_id     INTEGER REFERENCES materials(id),
    started_at      TEXT NOT NULL,
    ended_at        TEXT,
    duration_secs   REAL DEFAULT 0,
    session_type    TEXT DEFAULT 'work',   -- 'work' | 'short_break' | 'long_break'
    session_date    TEXT GENERATED ALWAYS AS (date(started_at)) STORED
);

-- Tasks (dashboard to-do list). Optional deep-link to a material (ON DELETE SET
-- NULL: deleting a file keeps the task, just drops the link).
CREATE TABLE IF NOT EXISTS tasks (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    title          TEXT NOT NULL,
    done           INTEGER DEFAULT 0,
    priority       INTEGER DEFAULT 0,          -- 0 none / 1 low / 2 medium / 3 high
    due_at         TEXT,                        -- ISO datetime (YYYY-MM-DD HH:MM:SS), nullable
    material_id    INTEGER REFERENCES materials(id) ON DELETE SET NULL,
    sort_order     INTEGER DEFAULT 0,
    estimated_mins INTEGER,                     -- optional effort estimate (schedule view)
    completed_at   TEXT,
    created_at     TEXT DEFAULT (datetime('now')),
    updated_at     TEXT DEFAULT (datetime('now'))
);

-- Consistency log (Planning Hub). One APPEND-ONLY snapshot row per calendar day,
-- written lazily on app boot (no background loop). Isolated from `tasks` /
-- `study_sessions` so deleting/editing a task never rewrites past scores — the
-- snapshot already captured that day. `score` is 0-100 (see queries::score_for_day).
CREATE TABLE IF NOT EXISTS consistency_log (
    day                     TEXT PRIMARY KEY,   -- YYYY-MM-DD
    tasks_due               INTEGER DEFAULT 0,
    tasks_completed_on_time INTEGER DEFAULT 0,
    tasks_completed_late    INTEGER DEFAULT 0,
    tasks_missed            INTEGER DEFAULT 0,
    study_minutes           REAL DEFAULT 0,
    score                   REAL DEFAULT 0,
    created_at              TEXT DEFAULT (datetime('now'))
);

-- Timestamped Notes (v5): a note tied to a specific point in a material's playback.
CREATE TABLE IF NOT EXISTS notes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    material_id    INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
    timestamp_secs REAL NOT NULL DEFAULT 0,
    body           TEXT NOT NULL,
    created_at     TEXT DEFAULT (datetime('now')),
    updated_at     TEXT DEFAULT (datetime('now'))
);

-- Full-Text Search Index
CREATE VIRTUAL TABLE IF NOT EXISTS materials_fts USING fts5(
    file_name,
    file_path,
    content='materials',
    content_rowid='id',
    tokenize='unicode61'
);

-- FTS Sync Triggers
CREATE TRIGGER IF NOT EXISTS materials_ai AFTER INSERT ON materials BEGIN
    INSERT INTO materials_fts(rowid, file_name, file_path)
    VALUES (new.id, new.file_name, new.file_path);
END;

CREATE TRIGGER IF NOT EXISTS materials_ad AFTER DELETE ON materials BEGIN
    INSERT INTO materials_fts(materials_fts, rowid, file_name, file_path)
    VALUES ('delete', old.id, old.file_name, old.file_path);
END;

CREATE TRIGGER IF NOT EXISTS materials_au AFTER UPDATE ON materials BEGIN
    INSERT INTO materials_fts(materials_fts, rowid, file_name, file_path)
    VALUES ('delete', old.id, old.file_name, old.file_path);
    INSERT INTO materials_fts(rowid, file_name, file_path)
    VALUES (new.id, new.file_name, new.file_path);
END;

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_materials_chapter ON materials(chapter_id);
CREATE INDEX IF NOT EXISTS idx_materials_type ON materials(file_type);
CREATE INDEX IF NOT EXISTS idx_materials_status ON materials(status);
CREATE INDEX IF NOT EXISTS idx_materials_bookmarked ON materials(is_bookmarked) WHERE is_bookmarked = 1;
CREATE INDEX IF NOT EXISTS idx_watch_progress_last ON watch_progress(last_watched_at DESC);
CREATE INDEX IF NOT EXISTS idx_study_sessions_date ON study_sessions(session_date);
CREATE INDEX IF NOT EXISTS idx_chapters_subject ON chapters(subject_id);
CREATE INDEX IF NOT EXISTS idx_subjects_goal ON subjects(goal_id);
CREATE INDEX IF NOT EXISTS idx_tasks_done ON tasks(done);
CREATE INDEX IF NOT EXISTS idx_tasks_material ON tasks(material_id);
CREATE INDEX IF NOT EXISTS idx_notes_material ON notes(material_id, timestamp_secs);
"#;
