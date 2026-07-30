//! SQLite connection management.
//!
//! Per the architectural rules (Section 1): a **single shared connection** kept
//! for the app's lifetime, in **WAL journal mode**, to prevent UI-blocking writes
//! and "database is locked" errors. The connection is wrapped in a `Mutex` and
//! stored in Tauri's managed state as [`Db`].

use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;

use crate::db::schema::{SCHEMA_SQL, SCHEMA_VERSION};
use crate::utils::errors::{AppError, AppResult};

/// Managed application database handle.
///
/// The `Mutex<Connection>` gives us the "single shared connection" mandated by the
/// spec. Because WAL mode allows concurrent readers, the practical contention here
/// is low; writes are short and batched.
pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    /// Open (creating if necessary) the database at `path`, configure pragmas,
    /// and apply the schema migration.
    pub fn open(path: &Path) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let conn = Connection::open(path)?;
        configure_pragmas(&conn)?;
        migrate(&conn)?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Open an in-memory database — used by tests and the IPC smoke test.
    #[allow(dead_code)]
    pub fn open_in_memory() -> AppResult<Self> {
        let conn = Connection::open_in_memory()?;
        configure_pragmas(&conn)?;
        migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Run a closure with exclusive access to the connection.
    ///
    /// This is the single choke-point through which all queries flow, keeping the
    /// "one connection for the app lifetime" invariant enforceable in one place.
    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
        let guard = self.conn.lock().map_err(|_| AppError::Poisoned)?;
        f(&guard)
    }

    /// Like [`Db::with`], but hands the closure a `&mut Connection` — required by
    /// `rusqlite`'s transaction API (`Connection::transaction` borrows mutably).
    /// Used by batched writes such as the scan importer.
    pub fn with_mut<T>(&self, f: impl FnOnce(&mut Connection) -> AppResult<T>) -> AppResult<T> {
        let mut guard = self.conn.lock().map_err(|_| AppError::Poisoned)?;
        f(&mut guard)
    }
}

/// A fully-migrated in-memory connection for unit tests in other db modules
/// (e.g. `queries::tests`). Panics on failure — tests want a hard stop.
#[cfg(test)]
pub(crate) fn test_conn() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    configure_pragmas(&conn).expect("pragmas");
    migrate(&conn).expect("migrate");
    conn
}

/// Apply connection-level pragmas. WAL + a generous busy timeout is the spec's
/// answer to "database locked" (Section 3 error table).
fn configure_pragmas(conn: &Connection) -> AppResult<()> {
    // WAL: concurrent reads while a write is in progress; far fewer lock errors.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    // NORMAL is the recommended durability level under WAL — safe against app
    // crashes, only at risk on OS/power loss, and much faster than FULL.
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    // Enforce ON DELETE CASCADE etc. (off by default in SQLite).
    conn.pragma_update(None, "foreign_keys", "ON")?;
    // Wait up to 5s for a lock before erroring — backstops the WAL guarantee.
    conn.busy_timeout(std::time::Duration::from_secs(5))?;

    // ── Low-RAM tuning (4GB-laptop target) ──────────────────────────────────────────
    // Cap the page cache so SQLite can't balloon RAM on a big library. A negative
    // cache_size is a size in KiB — -2000 ≈ 2 MB, plenty for our small, index-backed
    // queries and far below SQLite's ~2MB-per-connection default growth under load.
    conn.pragma_update(None, "cache_size", -2000)?;
    // Keep temp b-trees (ORDER BY / GROUP BY spills) in RAM rather than writing temp
    // files to the (possibly nearly-full, 10-15GB) SSD.
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    // A modest memory-mapped I/O window (32 MB) speeds reads without committing the
    // whole DB to RAM. Bounded so it can't grow unbounded on a huge database file.
    conn.pragma_update(None, "mmap_size", 32 * 1024 * 1024)?;
    // Cap the WAL file so it can't grow without bound on a low-disk machine; SQLite
    // checkpoints back into the main DB when it exceeds this many pages (~4 MB).
    conn.pragma_update(None, "wal_autocheckpoint", 1000)?;
    Ok(())
}

/// Apply the schema idempotently and stamp `user_version`.
///
/// Two-part strategy:
///   1. Run `SCHEMA_SQL` (all `CREATE ... IF NOT EXISTS`) — creates any missing tables
///      and, on a *fresh* install, tables already include the latest columns.
///   2. Run guarded incremental `ALTER TABLE ... ADD COLUMN` steps for columns added to
///      *existing* tables in later versions (a `CREATE TABLE IF NOT EXISTS` can't add a
///      column to a table that already exists). Each ALTER is conditional on the column
///      being absent, so it's a no-op on fresh installs and safe to re-run.
/// All in one transaction so a partial apply can't leave a half-schema.
fn migrate(conn: &Connection) -> AppResult<()> {
    let current: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if current >= SCHEMA_VERSION {
        return Ok(());
    }

    // v6: fold the legacy goals/subjects/chapters chain into the `nodes` adjacency tree
    // and repoint materials/registered_dirs. Runs BEFORE the generic SCHEMA_SQL below so
    // the new `materials.node_id` column + node indexes exist when SCHEMA_SQL re-applies.
    // Only fires on a real pre-v6 DB that still has the `goals` table (fresh installs get
    // the tree straight from SCHEMA_SQL and skip this entirely).
    if current < 6 && table_exists(conn, "goals")? {
        migrate_v6_tree(conn)?;
    }

    conn.execute_batch("BEGIN")?;
    let result = (|| -> AppResult<()> {
        conn.execute_batch(SCHEMA_SQL)?;
        // v3: study_sessions.session_type — add it to pre-v3 databases that already
        // have the table (fresh installs get it from CREATE TABLE above).
        if !column_exists(conn, "study_sessions", "session_type")? {
            conn.execute_batch(
                "ALTER TABLE study_sessions ADD COLUMN session_type TEXT DEFAULT 'work'",
            )?;
        }
        // v4: tasks.estimated_mins — add it to pre-v4 databases that already have the
        // tasks table (the consistency_log table is created by SCHEMA_SQL above).
        if !column_exists(conn, "tasks", "estimated_mins")? {
            conn.execute_batch("ALTER TABLE tasks ADD COLUMN estimated_mins INTEGER")?;
        }
        // v7: materials.metadata_attempts — add it to pre-v7 databases that already have the
        // materials table (fresh installs get it from CREATE TABLE above).
        if !column_exists(conn, "materials", "metadata_attempts")? {
            conn.execute_batch(
                "ALTER TABLE materials ADD COLUMN metadata_attempts INTEGER NOT NULL DEFAULT 0",
            )?;
        }
        Ok(())
    })();

    match result {
        Ok(()) => {
            conn.execute_batch("COMMIT")?;
            conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

/// v6 data migration: rebuild the rigid goals→subjects→chapters hierarchy as rows in a
/// single self-referencing `nodes` table, then repoint `materials` and `registered_dirs`.
///
/// Strategy (chosen to preserve `materials.id` so watch_progress / notes / study_sessions
/// / tasks stay valid, and to avoid a risky full `materials` table rebuild that would
/// disturb the FTS triggers + child FKs):
///   1. FK enforcement OFF (a schema surgery must not trip cascade/ordering checks).
///   2. Create `nodes`; insert goals (depth 0, kind 'root'), subjects (depth 1), chapters
///      (depth 2), recording old_id→new_node_id maps in Rust.
///   3. `materials`: ADD COLUMN node_id, UPDATE from the chapter map, drop the old
///      `idx_materials_chapter` index, then DROP COLUMN chapter_id.
///   4. `registered_dirs`: ADD COLUMN root_node_id (mapped from its subject_id), DROP the
///      legacy goal_id/subject_id/chapter_id/category_level columns.
///   5. Drop chapters, subjects, goals (their indexes vanish with them).
///   6. `PRAGMA foreign_key_check`, COMMIT, FK back ON.
///
/// PRAGMA foreign_keys can only change OUTSIDE a transaction, so we toggle it around the
/// explicit BEGIN/COMMIT here.
fn migrate_v6_tree(conn: &Connection) -> AppResult<()> {
    use std::collections::HashMap;

    conn.pragma_update(None, "foreign_keys", "OFF")?;
    conn.execute_batch("BEGIN")?;

    let result = (|| -> AppResult<()> {
        // 1. The nodes table (mirrors SCHEMA_SQL; IF NOT EXISTS so the later re-run is a no-op).
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS nodes (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                parent_id   INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
                name        TEXT NOT NULL,
                kind        TEXT NOT NULL DEFAULT 'folder',
                description TEXT,
                icon        TEXT,
                color       TEXT,
                depth       INTEGER NOT NULL DEFAULT 0,
                path        TEXT,
                sort_order  INTEGER DEFAULT 0,
                created_at  TEXT DEFAULT (datetime('now')),
                updated_at  TEXT DEFAULT (datetime('now')),
                UNIQUE(parent_id, name)
            )",
        )?;

        // 2a. Goals → root nodes (depth 0).
        let mut goal_map: HashMap<i64, i64> = HashMap::new();
        {
            let mut stmt =
                conn.prepare("SELECT id, name, icon, color, sort_order, created_at FROM goals")?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, i64>(4)?,
                        r.get::<_, Option<String>>(5)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            for (old_id, name, icon, color, sort_order, created_at) in rows {
                conn.execute(
                    "INSERT INTO nodes(parent_id, name, kind, icon, color, depth, sort_order, created_at)
                     VALUES(NULL, ?1, 'root', ?2, ?3, 0, ?4, COALESCE(?5, datetime('now')))",
                    rusqlite::params![name, icon, color, sort_order, created_at],
                )?;
                goal_map.insert(old_id, conn.last_insert_rowid());
            }
        }

        // 2b. Subjects → depth-1 nodes under their goal.
        let mut subject_map: HashMap<i64, i64> = HashMap::new();
        {
            let mut stmt = conn.prepare(
                "SELECT id, goal_id, name, icon, color, sort_order, created_at FROM subjects",
            )?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, Option<String>>(4)?,
                        r.get::<_, i64>(5)?,
                        r.get::<_, Option<String>>(6)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            for (old_id, goal_id, name, icon, color, sort_order, created_at) in rows {
                let parent = goal_map.get(&goal_id).copied();
                conn.execute(
                    "INSERT INTO nodes(parent_id, name, kind, icon, color, depth, sort_order, created_at)
                     VALUES(?1, ?2, 'folder', ?3, ?4, 1, ?5, COALESCE(?6, datetime('now')))",
                    rusqlite::params![parent, name, icon, color, sort_order, created_at],
                )?;
                subject_map.insert(old_id, conn.last_insert_rowid());
            }
        }

        // 2c. Chapters → depth-2 nodes under their subject.
        let mut chapter_map: HashMap<i64, i64> = HashMap::new();
        {
            let mut stmt = conn
                .prepare("SELECT id, subject_id, name, sort_order, created_at FROM chapters")?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, Option<String>>(4)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            for (old_id, subject_id, name, sort_order, created_at) in rows {
                let parent = subject_map.get(&subject_id).copied();
                conn.execute(
                    "INSERT INTO nodes(parent_id, name, kind, depth, sort_order, created_at)
                     VALUES(?1, ?2, 'folder', 2, ?3, COALESCE(?4, datetime('now')))",
                    rusqlite::params![parent, name, sort_order, created_at],
                )?;
                chapter_map.insert(old_id, conn.last_insert_rowid());
            }
        }

        // 3. materials: add node_id, map from chapter_id, drop the old index + column.
        if !column_exists(conn, "materials", "node_id")? {
            conn.execute_batch("ALTER TABLE materials ADD COLUMN node_id INTEGER")?;
        }
        {
            let mut stmt = conn.prepare("SELECT id, chapter_id FROM materials")?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            for (mid, chapter_id) in rows {
                if let Some(node_id) = chapter_map.get(&chapter_id) {
                    conn.execute(
                        "UPDATE materials SET node_id = ?1 WHERE id = ?2",
                        rusqlite::params![node_id, mid],
                    )?;
                }
            }
        }
        conn.execute_batch("DROP INDEX IF EXISTS idx_materials_chapter")?;
        conn.execute_batch("ALTER TABLE materials DROP COLUMN chapter_id")?;

        // 4. registered_dirs: add root_node_id (from subject_id — imports always mapped a
        //    folder to a subject), drop the legacy columns.
        if !column_exists(conn, "registered_dirs", "root_node_id")? {
            conn.execute_batch("ALTER TABLE registered_dirs ADD COLUMN root_node_id INTEGER")?;
        }
        {
            let mut stmt = conn.prepare("SELECT id, subject_id FROM registered_dirs")?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, Option<i64>>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            for (dir_id, subject_id) in rows {
                if let Some(node_id) = subject_id.and_then(|s| subject_map.get(&s).copied()) {
                    conn.execute(
                        "UPDATE registered_dirs SET root_node_id = ?1 WHERE id = ?2",
                        rusqlite::params![node_id, dir_id],
                    )?;
                }
            }
        }
        for col in ["category_level", "goal_id", "subject_id", "chapter_id"] {
            if column_exists(conn, "registered_dirs", col)? {
                conn.execute_batch(&format!("ALTER TABLE registered_dirs DROP COLUMN {col}"))?;
            }
        }

        // 5. Drop the legacy hierarchy tables (their indexes drop with them).
        conn.execute_batch(
            "DROP TABLE IF EXISTS chapters;
             DROP TABLE IF EXISTS subjects;
             DROP TABLE IF EXISTS goals;",
        )?;

        // 6. Integrity check before committing the surgery. `foreign_key_check` yields one
        //    row PER violation and no rows when clean, so count the rows.
        let violations: i64 = {
            let mut stmt = conn.prepare("PRAGMA foreign_key_check")?;
            let mut rows = stmt.query([])?;
            let mut n = 0i64;
            while rows.next()?.is_some() {
                n += 1;
            }
            n
        };
        if violations > 0 {
            return Err(AppError::Other(
                "v6 migration left dangling foreign keys".into(),
            ));
        }
        Ok(())
    })();

    match result {
        Ok(()) => {
            conn.execute_batch("COMMIT")?;
            conn.pragma_update(None, "foreign_keys", "ON")?;
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            let _ = conn.pragma_update(None, "foreign_keys", "ON");
            Err(e)
        }
    }
}

/// True if a table with `name` exists.
fn table_exists(conn: &Connection, name: &str) -> AppResult<bool> {
    let n: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1",
        [name],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

/// True if `table` has a column named `column` (via `PRAGMA table_info`).
fn column_exists(conn: &Connection, table: &str, column: &str) -> AppResult<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?; // column 1 of table_info is the column name
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_applies_and_is_idempotent() {
        let db = Db::open_in_memory().expect("open");
        // Re-running migrate must be a no-op (already at version).
        db.with(|c| {
            let v: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0))?;
            assert_eq!(v, SCHEMA_VERSION);
            // FTS5 virtual table must exist — proves the bundled SQLite has FTS5.
            let n: i64 = c.query_row(
                "SELECT count(*) FROM sqlite_master WHERE name='materials_fts'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(n, 1);
            // v3 column must be present on a fresh install.
            assert!(column_exists(c, "study_sessions", "session_type")?);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn migrates_pre_v3_db_by_adding_session_type() {
        // Simulate a pre-v3 database: study_sessions WITHOUT session_type, user_version=2.
        let conn = Connection::open_in_memory().expect("open");
        configure_pragmas(&conn).unwrap();
        conn.execute_batch(
            "CREATE TABLE study_sessions (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                material_id   INTEGER,
                started_at    TEXT NOT NULL,
                ended_at      TEXT,
                duration_secs REAL DEFAULT 0,
                session_date  TEXT GENERATED ALWAYS AS (date(started_at)) STORED
            );
            INSERT INTO study_sessions(started_at, duration_secs) VALUES ('2024-01-01 10:00:00', 60);",
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 2i64).unwrap();
        assert!(!column_exists(&conn, "study_sessions", "session_type").unwrap());

        // Run the migration — it should ADD the column and stamp user_version=3.
        migrate(&conn).unwrap();

        assert!(column_exists(&conn, "study_sessions", "session_type").unwrap());
        let v: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(v, SCHEMA_VERSION);
        // The pre-existing row's session_type must default to 'work' (so old study time
        // still counts in the activity aggregates).
        let stype: String = conn
            .query_row("SELECT session_type FROM study_sessions LIMIT 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(stype, "work");
    }

    #[test]
    fn migrates_pre_v4_db_by_adding_estimated_mins_and_consistency_log() {
        // Simulate a pre-v4 database: a tasks table WITHOUT estimated_mins, no
        // consistency_log, user_version=3.
        let conn = Connection::open_in_memory().expect("open");
        configure_pragmas(&conn).unwrap();
        conn.execute_batch(
            "CREATE TABLE tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                done INTEGER DEFAULT 0,
                priority INTEGER DEFAULT 0,
                due_at TEXT,
                material_id INTEGER,
                sort_order INTEGER DEFAULT 0,
                completed_at TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            );
            INSERT INTO tasks(title) VALUES ('legacy task');",
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 3i64).unwrap();
        assert!(!column_exists(&conn, "tasks", "estimated_mins").unwrap());

        migrate(&conn).unwrap();

        // v4 column added, consistency_log created, version stamped.
        assert!(column_exists(&conn, "tasks", "estimated_mins").unwrap());
        let has_log: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='consistency_log'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_log, 1);
        let v: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(v, SCHEMA_VERSION);
        // The legacy task survived the migration.
        let n: i64 = conn
            .query_row("SELECT count(*) FROM tasks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn migrates_pre_v6_hierarchy_into_nodes_tree() {
        // Simulate a pre-v6 DB: the rigid goals→subjects→chapters→materials chain plus a
        // watch_progress row tied to a material id (must survive the migration untouched).
        let conn = Connection::open_in_memory().expect("open");
        configure_pragmas(&conn).unwrap();
        conn.execute_batch(
            "CREATE TABLE goals (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
                 description TEXT, icon TEXT, color TEXT, sort_order INTEGER DEFAULT 0,
                 created_at TEXT, updated_at TEXT);
             CREATE TABLE subjects (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id INTEGER NOT NULL,
                 name TEXT NOT NULL, description TEXT, icon TEXT, color TEXT,
                 sort_order INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);
             CREATE TABLE chapters (id INTEGER PRIMARY KEY AUTOINCREMENT, subject_id INTEGER NOT NULL,
                 name TEXT NOT NULL, description TEXT, sort_order INTEGER DEFAULT 0,
                 created_at TEXT, updated_at TEXT);
             CREATE TABLE materials (id INTEGER PRIMARY KEY AUTOINCREMENT, chapter_id INTEGER NOT NULL,
                 file_path TEXT NOT NULL UNIQUE, file_name TEXT NOT NULL, file_type TEXT NOT NULL,
                 file_extension TEXT NOT NULL, file_size_bytes INTEGER DEFAULT 0, duration_secs REAL,
                 thumbnail_path TEXT, resolution TEXT, codec TEXT, bitrate INTEGER, page_count INTEGER,
                 status TEXT DEFAULT 'active', is_bookmarked INTEGER DEFAULT 0,
                 is_completed INTEGER DEFAULT 0, last_opened_at TEXT, sort_order INTEGER DEFAULT 0,
                 created_at TEXT, updated_at TEXT);
             CREATE TABLE watch_progress (id INTEGER PRIMARY KEY AUTOINCREMENT,
                 material_id INTEGER NOT NULL UNIQUE, position_secs REAL DEFAULT 0,
                 duration_secs REAL DEFAULT 0, completed INTEGER DEFAULT 0,
                 last_watched_at TEXT, watch_count INTEGER DEFAULT 1);
             CREATE TABLE registered_dirs (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE,
                 category_level TEXT NOT NULL, goal_id INTEGER, subject_id INTEGER, chapter_id INTEGER,
                 is_active INTEGER DEFAULT 1, scan_status TEXT DEFAULT 'pending',
                 last_scanned_at TEXT, created_at TEXT);
             INSERT INTO goals(id, name) VALUES (1, 'UPSC');
             INSERT INTO subjects(id, goal_id, name) VALUES (1, 1, 'GS2');
             INSERT INTO chapters(id, subject_id, name) VALUES (1, 1, 'Polity');
             INSERT INTO materials(id, chapter_id, file_path, file_name, file_type, file_extension)
                 VALUES (42, 1, '/x/polity/intro.mp4', 'intro.mp4', 'video', 'mp4');
             INSERT INTO watch_progress(material_id, position_secs, duration_secs) VALUES (42, 30, 100);
             INSERT INTO registered_dirs(path, category_level, goal_id, subject_id)
                 VALUES ('/x/polity', 'subject', 1, 1);",
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 5i64).unwrap();

        migrate(&conn).unwrap();

        // nodes tree: UPSC(root,depth0) → GS2(depth1) → Polity(depth2).
        let (root_id, root_depth): (i64, i64) = conn
            .query_row(
                "SELECT id, depth FROM nodes WHERE name='UPSC' AND parent_id IS NULL",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(root_depth, 0);
        let (gs2_id, gs2_depth): (i64, i64) = conn
            .query_row("SELECT id, depth FROM nodes WHERE name='GS2'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(gs2_depth, 1);
        let gs2_parent: i64 = conn
            .query_row("SELECT parent_id FROM nodes WHERE name='GS2'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(gs2_parent, root_id);
        let (polity_id, polity_depth): (i64, i64) = conn
            .query_row("SELECT id, depth FROM nodes WHERE name='Polity'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(polity_depth, 2);
        let _ = gs2_id;

        // material id 42 preserved, now pointing at the Polity node; chapter_id gone.
        let node_id: i64 = conn
            .query_row("SELECT node_id FROM materials WHERE id=42", [], |r| r.get(0))
            .unwrap();
        assert_eq!(node_id, polity_id);
        assert!(!column_exists(&conn, "materials", "chapter_id").unwrap());

        // watch_progress row still tied to material 42 (downstream data preserved).
        let pos: f64 = conn
            .query_row("SELECT position_secs FROM watch_progress WHERE material_id=42", [], |r| r.get(0))
            .unwrap();
        assert_eq!(pos, 30.0);

        // registered_dirs repointed to the GS2 node; legacy columns dropped.
        let dir_root: i64 = conn
            .query_row("SELECT root_node_id FROM registered_dirs LIMIT 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(dir_root, gs2_id);
        assert!(!column_exists(&conn, "registered_dirs", "subject_id").unwrap());

        // Legacy tables dropped; version stamped.
        assert!(!table_exists(&conn, "goals").unwrap());
        assert!(!table_exists(&conn, "chapters").unwrap());
        let v: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(v, SCHEMA_VERSION);
    }
}
