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
}
