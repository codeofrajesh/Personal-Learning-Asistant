//! Background media-metadata + thumbnail extraction — CPU-safe engine.
//!
//! ## Why this is careful about CPU
//! Extraction shells out to ffprobe/ffmpeg (bundled sidecars). Naively looping over every
//! pending file, or letting the three trigger sites (boot, post-import, on-demand) each
//! start their own loop, can saturate the CPU and fight over the same output files. This
//! module therefore enforces:
//!   - a **single-flight guard** (`EXTRACTING`): only one extraction pass runs at a time;
//!     overlapping triggers return immediately instead of stacking.
//!   - a **bounded concurrency cap** (`Semaphore`, ≤2, derived from core count): at most a
//!     couple of ffmpeg processes run simultaneously, so the UI never janks.
//!   - **downscaled thumbnails** (`-vf scale=640:-2`): small JPEGs, not full-res frames.
//!   - a **random-ish frame** in the 10–80% range (avoids intros/black frames/credits),
//!     seeded deterministically from the material id so re-runs are stable.
//!   - **idempotence**: only rows missing duration/thumbnail are selected, so it is safe to
//!     re-run and it resumes after a restart.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::ShellExt;
use tokio::sync::Semaphore;

use crate::db::Db;
use crate::utils::errors::AppResult;

#[derive(serde::Serialize, Clone)]
pub struct MetadataExtractedEvent {
    pub material_id: i64,
    pub duration_secs: Option<f64>,
    pub thumbnail_path: Option<String>,
}

/// Single-flight guard: true while an extraction pass is in progress.
static EXTRACTING: AtomicBool = AtomicBool::new(false);

/// Hard ceiling on simultaneous ffmpeg/ffprobe processes (keeps the CPU calm).
const MAX_CONCURRENT: usize = 2;
/// Give up on a file after this many failed metadata passes. Corrupt/unsupported files
/// otherwise stay NULL forever and get re-ffmpeg'd on every boot/import — a recurring CPU
/// spike. After this many tries the row is excluded from future passes (v7).
const MAX_METADATA_ATTEMPTS: i64 = 3;
/// Thumbnail width in px; height auto (`-2` keeps aspect + even dimension).
const THUMB_WIDTH: u32 = 640;
/// LRU cap on the thumbnail cache (4GB / 10-15GB-free-SSD target). At ~40KB per
/// downscaled JPEG, 4000 files ≈ 160MB — a hard bound so a huge library can never fill
/// the disk with covers. Beyond this we evict the least-recently-modified thumbnails.
const MAX_THUMBNAILS: usize = 4000;

/// Enforce the thumbnail-cache cap: if the dir holds more than `MAX_THUMBNAILS` JPEGs,
/// delete the oldest (by modified time) down to the cap. Best-effort; never fails the
/// extraction pass. Rows whose thumbnail is evicted simply regenerate on next demand.
fn enforce_thumbnail_cap(dir: &std::path::Path) {
    let mut entries: Vec<(std::time::SystemTime, PathBuf)> = match std::fs::read_dir(dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let p = e.path();
                if p.extension().and_then(|x| x.to_str()) != Some("jpg") {
                    return None;
                }
                let modified = e.metadata().ok()?.modified().ok()?;
                Some((modified, p))
            })
            .collect(),
        Err(_) => return,
    };
    if entries.len() <= MAX_THUMBNAILS {
        return;
    }
    // Oldest first; remove until we're back under the cap.
    entries.sort_by_key(|(t, _)| *t);
    let excess = entries.len() - MAX_THUMBNAILS;
    for (_, path) in entries.into_iter().take(excess) {
        let _ = std::fs::remove_file(path);
    }
}

/// Resets the single-flight flag on drop, even on early return / error.
struct FlightGuard;
impl Drop for FlightGuard {
    fn drop(&mut self) {
        EXTRACTING.store(false, Ordering::SeqCst);
    }
}

/// Deterministic frame fraction in [0.10, 0.80) from a material id (golden-ratio hash).
/// Stable per id, so re-runs pick the same frame — no flicker across regenerations.
fn frame_fraction(id: i64) -> f64 {
    let mixed = (id as f64 * 0.618_033_988_749_895).fract().abs();
    0.10 + mixed * 0.70
}

pub async fn extract_missing_metadata(app: AppHandle) -> AppResult<()> {
    // Single-flight: if a pass is already running, don't start another.
    if EXTRACTING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let _guard = FlightGuard;

    let db = app.state::<Db>();
    let pending = db.with(|conn| {
        // Exclude files that have already failed MAX_METADATA_ATTEMPTS times, so a corrupt
        // or unsupported file is not re-ffmpeg'd on every boot/import forever.
        //
        // `source = 'local'` (v11): a plugin-sourced row's `file_path` is a synthetic
        // `tg://<chat>/<msg>` key, not a path ffprobe can open. Without this guard every
        // imported Telegram lesson would spawn ffprobe MAX_METADATA_ATTEMPTS times — a real
        // CPU cost on exactly the low-end machines this engine was rewritten to protect — and
        // fail every time. Telegram supplies duration in the message metadata at import.
        let mut stmt = conn.prepare(
            "SELECT id, file_path, file_type
             FROM materials
             WHERE status = 'active'
               AND source = 'local'
               AND file_type IN ('video', 'audio')
               AND metadata_attempts < ?1
               AND (duration_secs IS NULL OR (file_type = 'video' AND thumbnail_path IS NULL))",
        )?;
        let rows = stmt.query_map([MAX_METADATA_ATTEMPTS], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    })?;

    if pending.is_empty() {
        return Ok(());
    }

    let data_dir = app
        .path()
        .app_data_dir()
        .expect("failed to resolve app_data_dir");
    let thumbnails_dir = data_dir.join("thumbnails");
    std::fs::create_dir_all(&thumbnails_dir)?;

    // Bounded concurrency: at most MAX_CONCURRENT (and never more than the core count)
    // ffmpeg processes run at once.
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    let permits = cores.min(MAX_CONCURRENT).max(1);
    let sem = Arc::new(Semaphore::new(permits));
    let thumbnails_dir = Arc::new(thumbnails_dir);

    let mut handles = Vec::with_capacity(pending.len());
    for (id, path, file_type) in pending {
        let app = app.clone();
        let sem = sem.clone();
        let thumbnails_dir = thumbnails_dir.clone();
        handles.push(tauri::async_runtime::spawn(async move {
            // Acquire a permit; released when this task ends (RAII).
            let _permit = sem.acquire_owned().await;
            process_one(&app, id, &path, &file_type, &thumbnails_dir).await;
        }));
    }

    for h in handles {
        let _ = h.await;
    }

    // Keep the thumbnail cache bounded so a huge library can't fill a small SSD.
    enforce_thumbnail_cap(&thumbnails_dir);

    Ok(())
}

/// Extract duration (+ a downscaled thumbnail for video) for one material, then persist.
async fn process_one(
    app: &AppHandle,
    id: i64,
    path: &str,
    file_type: &str,
    thumbnails_dir: &PathBuf,
) {
    let mut duration: Option<f64> = None;
    let mut thumb_path: Option<String> = None;

    // Duration via ffprobe (both video + audio).
    match app.shell().sidecar("ffprobe") {
        Ok(ffprobe) => {
            let cmd = ffprobe.args([
                "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                path,
            ]);
            if let Ok(output) = cmd.output().await {
                if output.status.success() {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    if let Ok(d) = stdout.trim().parse::<f64>() {
                        duration = Some(d);
                    }
                } else {
                    log::warn!(
                        "ffprobe failed for {}: {}",
                        path,
                        String::from_utf8_lossy(&output.stderr)
                    );
                }
            }
        }
        Err(e) => log::error!("Failed to resolve ffprobe sidecar: {e}"),
    }

    // Thumbnail for videos: a random-ish frame, downscaled to THUMB_WIDTH.
    if file_type == "video" {
        let out_file = thumbnails_dir.join(format!("{}.jpg", id));
        // Random-ish frame within the body of the clip (fallback 0s if duration unknown).
        let timestamp = duration.map(|d| d * frame_fraction(id)).unwrap_or(0.0);
        let ts_str = format!("{:.3}", timestamp);
        let scale = format!("scale={}:-2", THUMB_WIDTH);

        match app.shell().sidecar("ffmpeg") {
            Ok(ffmpeg) => {
                let cmd = ffmpeg.args([
                    "-ss", &ts_str,
                    "-i", path,
                    "-vframes", "1",
                    "-vf", &scale,
                    "-q:v", "4",
                    "-y",
                    out_file.to_string_lossy().as_ref(),
                ]);
                if let Ok(output) = cmd.output().await {
                    if output.status.success() {
                        thumb_path = Some(out_file.to_string_lossy().to_string());
                    } else {
                        log::warn!(
                            "ffmpeg failed for {}: {}",
                            path,
                            String::from_utf8_lossy(&output.stderr)
                        );
                    }
                }
            }
            Err(e) => log::error!("Failed to resolve ffmpeg sidecar: {e}"),
        }
    }

    // Always bump metadata_attempts (so repeated failures eventually exhaust the cap and
    // the file drops out of future passes), and fill in whatever we learned this pass.
    let learned = duration.is_some() || thumb_path.is_some();
    let d = duration;
    let t = thumb_path.clone();
    let db = app.state::<Db>();
    let res = db.with_mut(move |conn| {
        let count = conn.execute(
            "UPDATE materials
             SET duration_secs     = COALESCE(?1, duration_secs),
                 thumbnail_path    = COALESCE(?2, thumbnail_path),
                 metadata_attempts = metadata_attempts + 1,
                 updated_at        = CASE WHEN ?1 IS NOT NULL OR ?2 IS NOT NULL
                                          THEN datetime('now') ELSE updated_at END
             WHERE id = ?3",
            rusqlite::params![d, t, id],
        )?;
        Ok(count)
    });

    // Only notify the UI when we actually produced new metadata.
    if learned && res.is_ok() {
        let _ = app.emit(
            "metadata://extracted",
            MetadataExtractedEvent {
                material_id: id,
                duration_secs: duration,
                thumbnail_path: thumb_path,
            },
        );
    }
}
