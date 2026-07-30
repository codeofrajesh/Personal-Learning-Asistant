//! PLE backend library root.
//!
//! Declares the module tree (Section 12) and builds the Tauri application:
//! opens the shared SQLite connection, stores it in managed state, and registers
//! the IPC command handlers.

pub mod commands;
pub mod db;
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

            // Lazily backfill the consistency log up to today (Planning Hub). This is a
            // one-shot O(days-since-last-open) upsert on boot — NOT a background loop —
            // so it costs ~0 idle CPU. Runs regardless of the on/off setting so enabling
            // the feature later shows real history. Failure must not block boot.
            if let Err(e) = app.state::<Db>().with(|conn| db::queries::backfill_consistency(conn)) {
                log::error!("consistency: backfill failed: {e}");
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
