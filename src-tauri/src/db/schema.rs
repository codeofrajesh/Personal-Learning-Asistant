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
/// v6: introduced the `nodes` adjacency-list tree (infinite-depth categorization).
///     `materials.node_id` replaces `chapter_id`; `registered_dirs.root_node_id`
///     replaces goal_id/subject_id/chapter_id. Legacy goals/subjects/chapters tables
///     are migrated into `nodes` then dropped. See `migrate_v6_tree` in connection.rs.
/// v7: added `materials.metadata_attempts` — a counter so the thumbnail/duration engine
///     stops re-running ffmpeg on files that repeatedly fail to yield metadata (corrupt /
///     unsupported), which otherwise re-spawned ffmpeg for them on every boot/import.
/// v8: added `nodes.is_pinned` — the Courses hub "Pinned" feature. A user can favorite any
///     node (course/folder) to surface it in a dedicated hub section, mirroring how
///     `materials.is_bookmarked` works for files.
/// v9: the Planning / Scheduling / Intelligence system. Adds the time-block planner
///     (`plan_blocks`), its append-only lifecycle ledger (`plan_events`), per-day intent +
///     pre-mortem verdict (`plan_days`), routine templates (`plan_templates`,
///     `plan_template_blocks`), a DURABLE reminder ledger (`reminder_state`, so reminders
///     don't re-fire after a restart) and learned pace per course (`node_velocity`).
///     Extends `consistency_log` with schedule-adherence columns + `score_version` so the
///     scoring formula can evolve without rewriting the meaning of historical snapshots.
///     NOTE: no new scoring tables — Weekly/Monthly/Rolling-90 are DERIVED aggregates over
///     the existing one-row-per-day `consistency_log`.
pub const SCHEMA_VERSION: i64 = 9;

/// The complete v1 schema. Every statement is `IF NOT EXISTS` where SQLite allows,
/// so re-application is a no-op.
pub const SCHEMA_SQL: &str = r#"
-- Nodes: the unified, infinite-depth categorization tree (v6). One self-referencing
-- adjacency list replaces the old rigid goals→subjects→chapters chain. A node with
-- `parent_id IS NULL` is a root ("Goal"); any node can have children to any depth. A
-- casual learner has one root with materials directly under it; a power user nests
-- Goal→Subject→Sub-subject→Topic→… as deep as they like. `depth` is denormalized
-- (parent.depth + 1) so top-level listing is a cheap `WHERE depth = 0`. `path` holds the
-- absolute disk folder this node mirrors (NULL for hand-made nodes).
CREATE TABLE IF NOT EXISTS nodes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id   INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'folder',   -- 'root' | 'folder' (semantic hint)
    description TEXT,
    icon        TEXT,
    color       TEXT,
    depth       INTEGER NOT NULL DEFAULT 0,
    path        TEXT,
    sort_order  INTEGER DEFAULT 0,
    is_pinned   INTEGER NOT NULL DEFAULT 0,   -- Courses hub "Pinned" favorite (v8)
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    UNIQUE(parent_id, name)
);

-- Materials: Actual files. `node_id` points at the node (folder) they live under (v6,
-- was `chapter_id`).
CREATE TABLE IF NOT EXISTS materials (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id         INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
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
    metadata_attempts INTEGER NOT NULL DEFAULT 0,  -- times the metadata engine tried this file (v7)
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

-- Registered Directories. `root_node_id` is the node the scanned folder maps to (v6,
-- replaces goal_id/subject_id/chapter_id + category_level). The watcher keys on it.
CREATE TABLE IF NOT EXISTS registered_dirs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    path            TEXT NOT NULL UNIQUE,
    root_node_id    INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
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
-- The v9 columns extend the SAME snapshot row with schedule adherence rather than
-- introducing parallel weekly/monthly score tables: this table is already one row per day
-- (365/year), so Week / Month / Rolling-90 are sub-millisecond derived GROUP BY aggregates.
-- `score_version` lets the scoring formula evolve WITHOUT silently rewriting the meaning of
-- historical rows, preserving the append-only snapshot promise.
CREATE TABLE IF NOT EXISTS consistency_log (
    day                     TEXT PRIMARY KEY,   -- YYYY-MM-DD
    tasks_due               INTEGER DEFAULT 0,
    tasks_completed_on_time INTEGER DEFAULT 0,
    tasks_completed_late    INTEGER DEFAULT 0,
    tasks_missed            INTEGER DEFAULT 0,
    study_minutes           REAL DEFAULT 0,
    score                   REAL DEFAULT 0,
    blocks_planned          INTEGER DEFAULT 0,  -- v9: schedule adherence
    blocks_completed        INTEGER DEFAULT 0,
    blocks_partial          INTEGER DEFAULT 0,
    blocks_skipped          INTEGER DEFAULT 0,
    planned_minutes         REAL DEFAULT 0,
    executed_minutes        REAL DEFAULT 0,
    adherence               REAL,               -- 0-100, NULL when nothing was planned
    score_version           INTEGER DEFAULT 1,
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

-- ── Planning / Scheduling / Intelligence (v9) ────────────────────────────────────────
--
-- Design note (deliberate, load-bearing): a BLOCK is a time *intention*; a TASK is a
-- *deliverable*. They stay separate tables. A task can be worked across several blocks,
-- and a block can target a QUANTITY of content ("2 lectures of Physics") rather than one
-- specific row — neither fits as columns on `tasks`. Keeping them apart is what makes
-- spillover, partial credit and schedule adherence measurable at all, and leaves the
-- existing `tasks.due_at` consistency engine completely untouched.
--
-- Time is stored as LOCAL WALL-CLOCK 'HH:MM' + a `day` (YYYY-MM-DD), never UTC. A student
-- who plans "6:00 AM study" means 6 AM wherever/whenever they are; storing UTC makes the
-- block silently jump an hour across a DST boundary. Only `plan_events.at` is absolute,
-- because those rows are real observations rather than intentions.
CREATE TABLE IF NOT EXISTS plan_blocks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    day             TEXT NOT NULL,                  -- YYYY-MM-DD (local)
    planned_start   TEXT NOT NULL,                  -- 'HH:MM' (local wall clock)
    planned_mins    INTEGER NOT NULL,
    -- The live/adjusted position. Diverges from planned_* once a recovery plan is applied;
    -- keeping BOTH is what lets us score punctuality AND show "moved from 6:00".
    actual_start    TEXT,
    actual_mins     INTEGER,

    title           TEXT NOT NULL,
    -- What the block is FOR:
    --   'material'     one specific file
    --   'node_count'   N items from a course ("2 lectures of Physics")
    --   'node_minutes' time-boxed study of a course
    --   'task'         an existing to-do row
    --   'freeform'     untracked ("read textbook page 10") → needs manual confirmation
    target_kind        TEXT NOT NULL DEFAULT 'freeform',
    target_node_id     INTEGER REFERENCES nodes(id)     ON DELETE SET NULL,
    target_material_id INTEGER REFERENCES materials(id) ON DELETE SET NULL,
    target_task_id     INTEGER REFERENCES tasks(id)     ON DELETE SET NULL,
    target_count       INTEGER,                     -- e.g. 2 lectures

    weight          INTEGER NOT NULL DEFAULT 2,     -- 0-3, drives triage value (weight²)
    -- An 'anchored' block cannot move (a live class, a coaching slot). This is the single
    -- most important solver input — without it, cascade produces nonsense.
    is_anchored     INTEGER NOT NULL DEFAULT 0,
    -- Below this many minutes the block is pointless; the solver DROPS rather than shrinks.
    min_viable_mins INTEGER,

    status          TEXT NOT NULL DEFAULT 'pending',
        -- pending | active | done | partial | skipped | spilled
    executed_mins   REAL NOT NULL DEFAULT 0,        -- accumulated from study_sessions
    progress_count  INTEGER NOT NULL DEFAULT 0,     -- items finished vs target_count
    completed_at    TEXT,
    -- Set when this block is the carry-over of an earlier one → the spillover debt ledger.
    -- A dropped block is never deleted; it spills forward and its spill count PROMOTES it
    -- in later triage, which is how chronic avoidance of a disliked subject self-corrects.
    spilled_from_id INTEGER REFERENCES plan_blocks(id) ON DELETE SET NULL,
    template_id     INTEGER REFERENCES plan_templates(id) ON DELETE SET NULL,
    notes           TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
);

-- Append-only lifecycle audit. NEVER updated, only inserted. This is what makes velocity
-- learning + adherence scoring possible without destroying the plan-vs-outcome distinction.
CREATE TABLE IF NOT EXISTS plan_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    block_id   INTEGER REFERENCES plan_blocks(id) ON DELETE CASCADE,
    day        TEXT NOT NULL,
    kind       TEXT NOT NULL,   -- started|paused|resumed|completed|partial|skipped
                                -- |shifted|compressed|dropped|spilled|confirmed
    at         TEXT NOT NULL DEFAULT (datetime('now')),   -- absolute (a real observation)
    delta_mins INTEGER,         -- for shifted/compressed: by how much
    meta       TEXT             -- small JSON e.g. {"plan":"triage","reason":"late_start"}
);

-- Per-day plan intent + the pre-mortem verdict. `hard_stop_at` is per-day (a student may
-- legitimately study late on a Saturday) and falls back to the global
-- `plan.hard_stop` setting when NULL.
CREATE TABLE IF NOT EXISTS plan_days (
    day               TEXT PRIMARY KEY,   -- YYYY-MM-DD
    wake_at           TEXT,               -- 'HH:MM' — start of the usable window
    hard_stop_at      TEXT,               -- 'HH:MM' — never schedule past this
    planned_mins      INTEGER NOT NULL DEFAULT 0,
    capacity_mins     INTEGER,            -- realistic capacity after the fatigue discount
    integrity         REAL,               -- 0-100: is this plan physically achievable?
    adjust_state      TEXT,               -- null | 'prompted' | 'applied' | 'dismissed'
    last_adjust_at    TEXT,
    reconciled_at     TEXT,               -- set once the day is closed out on boot
    template_id       INTEGER REFERENCES plan_templates(id) ON DELETE SET NULL,
    created_at        TEXT DEFAULT (datetime('now'))
);

-- Routine days ("my normal weekday"), applied to generate a day's blocks in one tap.
CREATE TABLE IF NOT EXISTS plan_templates (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    dow_mask   INTEGER NOT NULL DEFAULT 127,   -- bitmask, bit 0 = Sunday .. bit 6 = Saturday
    is_active  INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plan_template_blocks (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id    INTEGER NOT NULL REFERENCES plan_templates(id) ON DELETE CASCADE,
    planned_start  TEXT NOT NULL,
    planned_mins   INTEGER NOT NULL,
    title          TEXT NOT NULL,
    target_kind    TEXT NOT NULL DEFAULT 'freeform',
    target_node_id INTEGER REFERENCES nodes(id) ON DELETE SET NULL,
    target_count   INTEGER,
    weight         INTEGER NOT NULL DEFAULT 2,
    is_anchored    INTEGER NOT NULL DEFAULT 0,
    sort_order     INTEGER DEFAULT 0
);

-- DURABLE reminder ledger. Fixes a real bug in the current reminder engine: dedupe lives
-- only in toastStore's in-memory `_cooldowns` map, so every reminder re-fires after an app
-- restart. Persisting fired/ack/snooze state makes "fire at most once" actually true.
CREATE TABLE IF NOT EXISTS reminder_state (
    key        TEXT PRIMARY KEY,   -- e.g. 'block-42-start' | 'block-42-t10' | 'block-42-end'
    fired_at   TEXT NOT NULL,
    ack_at     TEXT,
    snooze_to  TEXT
);

-- Learned pace per course. `pace_ratio` is an EWMA of (wall minutes spent / content minutes
-- consumed): 1.0 = real-time, 1.6 = this student needs 96 min of clock for 60 min of
-- lecture (pauses, notes, rewinds). Multiplying planned durations by it is what turns the
-- planner from aspirational into honest. Updated on the EXISTING log_session write path —
-- no new polling.
CREATE TABLE IF NOT EXISTS node_velocity (
    node_id        INTEGER PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
    samples        INTEGER NOT NULL DEFAULT 0,
    pace_ratio     REAL NOT NULL DEFAULT 1.0,
    avg_focus_mins REAL,           -- typical uninterrupted stretch before drifting off
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
CREATE INDEX IF NOT EXISTS idx_materials_node ON materials(node_id);
CREATE INDEX IF NOT EXISTS idx_materials_type ON materials(file_type);
CREATE INDEX IF NOT EXISTS idx_materials_status ON materials(status);
CREATE INDEX IF NOT EXISTS idx_materials_bookmarked ON materials(is_bookmarked) WHERE is_bookmarked = 1;
CREATE INDEX IF NOT EXISTS idx_watch_progress_last ON watch_progress(last_watched_at DESC);
CREATE INDEX IF NOT EXISTS idx_study_sessions_date ON study_sessions(session_date);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_nodes_depth ON nodes(depth);
CREATE INDEX IF NOT EXISTS idx_nodes_path ON nodes(path);
-- NOTE: idx_nodes_pinned (partial index on the v8 nodes.is_pinned column) is created in
-- connection.rs::migrate AFTER the guarded ADD COLUMN, because on a migrating pre-v8 DB the
-- column doesn't exist yet when SCHEMA_SQL first re-applies.
CREATE INDEX IF NOT EXISTS idx_tasks_done ON tasks(done);
CREATE INDEX IF NOT EXISTS idx_tasks_material ON tasks(material_id);
CREATE INDEX IF NOT EXISTS idx_notes_material ON notes(material_id, timestamp_secs);
-- v9 planner indexes. The plain (non-partial) ones are safe here because their tables are
-- created above in this same batch. The PARTIAL index on plan_blocks(status) is created in
-- connection.rs::migrate for symmetry with idx_nodes_pinned — see the note above.
CREATE INDEX IF NOT EXISTS idx_blocks_day ON plan_blocks(day, planned_start);
CREATE INDEX IF NOT EXISTS idx_blocks_node ON plan_blocks(target_node_id);
CREATE INDEX IF NOT EXISTS idx_blocks_task ON plan_blocks(target_task_id);
CREATE INDEX IF NOT EXISTS idx_blocks_spill ON plan_blocks(spilled_from_id);
CREATE INDEX IF NOT EXISTS idx_events_day ON plan_events(day, at);
CREATE INDEX IF NOT EXISTS idx_events_block ON plan_events(block_id, at);
CREATE INDEX IF NOT EXISTS idx_tmpl_blocks ON plan_template_blocks(template_id, sort_order);
"#;
