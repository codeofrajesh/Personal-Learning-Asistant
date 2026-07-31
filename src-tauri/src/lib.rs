//! PLE backend library root.
//!
//! Declares the module tree (Section 12) and builds the Tauri application:
//! opens the shared SQLite connection, stores it in managed state, and registers
//! the IPC command handlers.

pub mod commands;
pub mod db;
pub mod planner;
pub mod player;
pub mod scanner;
pub mod utils;

use tauri::Manager;

use crate::db::Db;

/// Build and run the Tauri application. Called by `main.rs`.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_libmpv::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // Resolve the Tauri-managed app data dir and open `ple.db` there
            // (Section 1: store DB in app_data_dir).
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app_data_dir");
            let db_path = data_dir.join("ple.db");

            let db = Db::open(&db_path).expect("failed to open/initialize database");
            app.manage(db);

            // Start the live file watcher on every active registered folder (Section 11
            // App Boot step 4). A failure to start the watcher must not block boot.
            if let Err(e) = scanner::watcher::WatcherManager::start(app.handle()) {
                log::error!("watcher: failed to start: {e}");
            }

            // Close out any past days whose blocks were never resolved, THEN backfill the
            // consistency log. Order matters: reconciliation flips abandoned pending blocks to
            // skipped/partial, and the snapshot that follows must see those final states or the
            // adherence half of each day's score would be computed from stale rows.
            //
            // Both are one-shot O(days-since-last-open) passes on boot — NOT background loops —
            // so idle CPU stays at zero on the 4 GB target. Failure must not block boot.
            //
            // `date('now')` here is UTC, whereas the planner is local-wall-clock throughout.
            // Using it for reconciliation is deliberate and safe: the only risk is that "today"
            // is judged up to a day early, which errs toward leaving a day OPEN (the frontend
            // re-reconciles with the real local date on first load). Closing a day too early
            // would be the damaging direction, and this can't do that.
            let boot_reconcile = app.state::<Db>().with(|conn| {
                let today: String = conn.query_row("SELECT date('now')", [], |r| r.get(0))?;
                let skipped = db::plan::reconcile_plan_days(conn, &today)?;
                db::queries::backfill_consistency(conn)?;
                Ok(skipped)
            });
            match boot_reconcile {
                Ok(n) if n > 0 => log::info!("planner: reconciled {n} unresolved block(s)"),
                Ok(_) => {}
                Err(e) => log::error!("planner/consistency: boot reconciliation failed: {e}"),
            }

            // Trigger background metadata extraction for any materials missing duration or thumbnails
            let app_clone = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let _ = scanner::metadata::extract_missing_metadata(app_clone).await;
            });

            log::info!("PLE backend initialized; database at {:?}", db_path);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::health_check,
            commands::dashboard_data,
            commands::scanner::preview_folder,
            commands::scanner::scan_and_import,
            commands::scanner::list_library,
            commands::scanner::extract_library_metadata,
            commands::library::goal_view,
            commands::library::subject_view,
            commands::library::chapter_view,
            commands::library::course_view,
            commands::library::get_recent_goal,
            commands::nodes::node_children,
            commands::nodes::node_ancestors,
            commands::nodes::node_materials,
            commands::nodes::pinned_nodes,
            commands::nodes::nodes_in_progress,
            commands::nodes::recent_nodes,
            commands::nodes::set_node_pinned,
            commands::player::open_material,
            commands::player::save_progress,
            commands::player::set_bookmark,
            commands::player::set_completed,
            commands::player::log_session,
            commands::player::list_notes,
            commands::player::create_note,
            commands::player::update_note,
            commands::player::delete_note,
            commands::player::recommended_materials,
            commands::player::read_file_base64,
            commands::player::read_file_bytes,
            commands::player::open_in_system_player,
            commands::materials::search_materials,
            commands::settings::list_registered_dirs,
            commands::settings::remove_registered_dir,
            commands::settings::rescan_folder,
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::settings::export_data_to_file,
            commands::settings::backup_database,
            commands::settings::import_data_from_file,
            commands::tasks::list_tasks,
            commands::tasks::create_task,
            commands::tasks::update_task,
            commands::tasks::set_task_done,
            commands::tasks::delete_task,
            commands::tasks::consistency_summary,
            commands::plan::plan_day,
            commands::plan::upsert_plan_block,
            commands::plan::delete_plan_block,
            commands::plan::set_plan_block_status,
            commands::plan::start_plan_block,
            commands::plan::active_plan_block,
            commands::plan::set_plan_day_window,
            commands::plan::recovery_plans,
            commands::plan::apply_recovery,
            commands::plan::undo_recovery,
            commands::plan::dismiss_recovery,
            commands::plan::apply_plan_template,
            commands::plan::reconcile_plan,
            commands::plan::score_summary,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
