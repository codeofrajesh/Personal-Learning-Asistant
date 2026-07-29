//! Live file watcher (Section 3 "Live Watcher", Section 11 App Boot step 4).
//!
//! `notify` (already a dependency) watches each active registered folder recursively.
//! On file changes the watcher schedules a **debounced rescan** of the affected folder
//! (coalesced via a per-dir in-flight guard, so a burst of events = one walk), which
//! re-walks the folder, upserts materials, marks anything now absent as `status=
//! 'missing'` (never hard-deletes), and emits `library://changed` so open pages refresh.
//!
//! This "re-walk on change" approach (rather than per-event create/modify/delete/rename
//! handling) is a deliberate trade-off: a local learning folder holds hundreds — not
//! millions — of files, so a `walkdir` pass is milliseconds, and reusing the import
//! pipeline keeps the DB-disk consistency logic in one place. Low-resource: notify is
//! event-driven (near-zero idle CPU), and a rescan only runs after ~700 ms of quiet.
//!
//! The watcher is held in managed state so it lives for the app's lifetime; newly
//! imported folders add their watch via [`WatcherManager::add_watch`].

use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager};

use crate::db::{queries, Db};
use crate::scanner::walker;
use crate::utils::errors::{AppError, AppResult};

/// Debounce: wait this long after the last event for a folder before rescanning it.
const DEBOUNCE: Duration = Duration::from_millis(700);

/// Event channel for the frontend: emitted after a watched folder's rescan applies.
const LIBRARY_CHANGED_EVENT: &str = "library://changed";

/// One watched registered directory.
#[derive(Clone)]
struct WatchRoot {
    dir_id: i64,
    path: String,
    subject_id: i64,
}

/// Owns the `notify` watcher + the bookkeeping needed to map events to watch roots.
/// Held in Tauri managed state. (The per-dir debounce guard lives in an `Arc<Mutex<…>>`
/// captured by the notify callback, since the manager itself doesn't exist until after
/// the watcher is constructed.)
pub struct WatcherManager {
    watcher: Mutex<Option<RecommendedWatcher>>,
    roots: Mutex<Vec<WatchRoot>>,
}

impl WatcherManager {
    /// Start watching every active registered folder. Safe to call with none — the
    /// manager is still installed so [`Self::add_watch`] can extend it later.
    pub fn start(app: &AppHandle) -> AppResult<()> {
        let roots: Vec<WatchRoot> = app
            .state::<Db>()
            .with(|conn| queries::active_watch_roots(conn))?
            .into_iter()
            .map(|(id, path, subject_id)| WatchRoot {
                dir_id: id,
                path,
                subject_id,
            })
            .collect();

        let roots_arc = Arc::new(Mutex::new(roots.clone()));
        let pending_arc: Arc<Mutex<HashSet<i64>>> = Arc::new(Mutex::new(HashSet::new()));
        let app_for_cb = app.clone();

        let mut watcher: RecommendedWatcher = Watcher::new(
            move |res: Result<Event, notify::Error>| {
                if let Ok(event) = res {
                    handle_event(&app_for_cb, &event, &roots_arc, &pending_arc);
                }
            },
            Config::default(),
        )
        .map_err(|e| AppError::Other(format!("watcher init: {e}")))?;

        // Register every root recursively.
        for r in &roots {
            if let Err(e) = watcher.watch(Path::new(&r.path), RecursiveMode::Recursive) {
                log::warn!("watcher: failed to watch {}: {e}", r.path);
            }
        }

        app.manage(WatcherManager {
            watcher: Mutex::new(Some(watcher)),
            roots: Mutex::new(roots),
        });
        Ok(())
    }

    /// Add a watch for a newly registered folder (called from `scan_and_import`).
    /// Idempotent — adding an already-watched path is a no-op at the notify level.
    pub fn add_watch(app: &AppHandle, dir_id: i64, path: &str, subject_id: i64) {
        // Record the root (skip if the watcher isn't installed or the dir is already
        // tracked). Each `try_state` borrow is kept short to satisfy the borrow checker.
        let already_present = app
            .try_state::<WatcherManager>()
            .map(|mgr| {
                let mut roots = mgr.roots.lock().unwrap();
                if roots.iter().any(|r| r.dir_id == dir_id) {
                    return true;
                }
                roots.push(WatchRoot {
                    dir_id,
                    path: path.to_string(),
                    subject_id,
                });
                false
            })
            .unwrap_or(true);
        if already_present {
            return;
        }

        // Add the notify watch.
        if let Some(mgr) = app.try_state::<WatcherManager>() {
            if let Some(w) = mgr.watcher.lock().unwrap().as_mut() {
                if let Err(e) = w.watch(Path::new(path), RecursiveMode::Recursive) {
                    log::warn!("watcher: failed to watch {path}: {e}");
                }
            }
        }
    }

    /// Remove a watch (called when a folder is unregistered).
    pub fn remove_watch(app: &AppHandle, dir_id: i64) {
        // Remove the tracked root, capturing its path so we can unwatch.
        let removed: Option<String> = app.try_state::<WatcherManager>().and_then(|mgr| {
            let mut roots = mgr.roots.lock().unwrap();
            roots
                .iter()
                .position(|r| r.dir_id == dir_id)
                .map(|p| roots.remove(p).path)
        });
        if let Some(path) = removed {
            if let Some(mgr) = app.try_state::<WatcherManager>() {
                if let Some(w) = mgr.watcher.lock().unwrap().as_mut() {
                    let _ = w.unwatch(Path::new(&path));
                }
            }
        }
    }
}

/// Map a notify event to its watch root and schedule a debounced rescan.
fn handle_event(
    app: &AppHandle,
    event: &Event,
    roots: &Arc<Mutex<Vec<WatchRoot>>>,
    pending: &Arc<Mutex<HashSet<i64>>>,
) {
    // Find the watch root whose path is a prefix of any event path.
    let root = {
        let rs = roots.lock().unwrap();
        event.paths.iter().find_map(|p| {
            let pstr = p.to_string_lossy();
            rs.iter().find(|r| pstr.starts_with(&r.path)).cloned()
        })
    };
    let Some(root) = root else { return };

    // Debounce: drop the event if a rescan is already scheduled for this dir.
    {
        let mut pend = pending.lock().unwrap();
        if pend.contains(&root.dir_id) {
            return;
        }
        pend.insert(root.dir_id);
    }

    let app = app.clone();
    let pending = pending.clone();
    // A short-lived std thread per debounced rescan: no async-runtime timer needed, and
    // the rescan itself is sync (walk + Db lock). The thread sleeps out the burst, then
    // applies; the `pending` guard ensures only one is scheduled per dir at a time.
    std::thread::spawn(move || {
        std::thread::sleep(DEBOUNCE);
        rescan(&app, &root);
        pending.lock().unwrap().remove(&root.dir_id);
    });
}

/// Debounced rescan of one watched folder: re-walk, upsert, mark missing, emit.
fn rescan(app: &AppHandle, root: &WatchRoot) {
    let dir = Path::new(&root.path);
    if !dir.exists() {
        // Folder gone (drive disconnected / deleted) — mark its materials missing.
        let _ = app.state::<Db>().with(|conn| {
            queries::mark_subject_missing_except(conn, root.subject_id, &HashSet::new())
        });
        let _ = app.emit(LIBRARY_CHANGED_EVENT, root.dir_id);
        return;
    }

    let groups = walker::scan_dir(dir);
    let seen: HashSet<String> = groups
        .iter()
        .flat_map(|g| g.files.iter().map(|f| f.path.clone()))
        .collect();

    let result: AppResult<()> = app.state::<Db>().with_mut(|conn| {
        queries::import_chapter_groups(conn, root.subject_id, &groups, |_, _| {})?;
        queries::mark_subject_missing_except(conn, root.subject_id, &seen)?;
        queries::mark_dir_scanned(conn, root.dir_id)?;
        Ok(())
    });
    if let Err(e) = result {
        log::warn!("watcher: rescan of {} failed: {e}", root.path);
    }

    let _ = app.emit(LIBRARY_CHANGED_EVENT, root.dir_id);
}
