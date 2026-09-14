//! IPC commands for YouTube Audio Streaming & Search (powered by bundled yt-dlp sidecar).
//!
//! Provides:
//!  - Fast search with rich metadata (titles, channel name, duration, 16:9 thumbnails).
//!  - Direct high-bitrate stereo audio stream URL extraction (Opus / AAC).
//!  - One-click background caching to local storage for offline study.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::ShellExt;

use crate::db::queries;
use crate::db::Db;
use crate::utils::errors::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YouTubeSearchResult {
    pub video_id: String,
    pub title: String,
    pub channel: String,
    pub duration_secs: Option<f64>,
    pub thumbnail_url: Option<String>,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YouTubeStreamInfo {
    pub stream_url: String,
    pub video_id: String,
    pub title: String,
    pub channel: String,
    pub duration_secs: Option<f64>,
    pub thumbnail_url: Option<String>,
}

/// Search YouTube for focus music, ambient soundscapes, or lectures.
/// Supports both keywords (e.g. "lofi girl", "deep rain 4k") and direct YouTube URLs.
#[tauri::command]
pub async fn youtube_search(
    app: AppHandle,
    query: String,
    max_results: Option<usize>,
) -> AppResult<Vec<YouTubeSearchResult>> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }

    let limit = max_results.unwrap_or(12).clamp(1, 25);
    let yt_dlp = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| AppError::Other(format!("Failed to locate yt-dlp sidecar: {e}")))?;

    let is_direct_url = q.contains("youtube.com/") || q.contains("youtu.be/");
    let search_spec = if is_direct_url {
        q.to_string()
    } else {
        format!("ytsearch{limit}:{q}")
    };

    let cmd = yt_dlp.args([
        "--dump-json",
        "--flat-playlist",
        "--no-warnings",
        "--no-check-certificates",
        &search_spec,
    ]);

    let output = cmd
        .output()
        .await
        .map_err(|e| AppError::Other(format!("Failed to execute yt-dlp search: {e}")))?;

    if !output.status.success() && output.stdout.is_empty() {
        let err_msg = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Other(format!("YouTube search failed: {err_msg}")));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut results = Vec::new();

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        if let Ok(val) = serde_json::from_str::<serde_json::Value>(line) {
            let video_id = match val.get("id").and_then(|v| v.as_str()) {
                Some(id) if !id.is_empty() => id.to_string(),
                _ => continue,
            };

            let title = val
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("Untitled Focus Audio")
                .to_string();

            let channel = val
                .get("channel")
                .or_else(|| val.get("uploader"))
                .and_then(|v| v.as_str())
                .unwrap_or("YouTube")
                .to_string();

            let duration_secs = val.get("duration").and_then(|v| v.as_f64());

            // Pick highest quality thumbnail
            let thumbnail_url = val
                .get("thumbnails")
                .and_then(|t| t.as_array())
                .and_then(|arr| arr.last())
                .and_then(|t| t.get("url"))
                .and_then(|u| u.as_str())
                .or_else(|| {
                    // Fallback standard YouTube thumbnail
                    Some(Box::leak(
                        format!("https://i.ytimg.com/vi/{video_id}/hqdefault.jpg").into_boxed_str(),
                    ))
                })
                .map(|s| s.to_string());

            let url = format!("https://www.youtube.com/watch?v={video_id}");

            results.push(YouTubeSearchResult {
                video_id,
                title,
                channel,
                duration_secs,
                thumbnail_url,
                url,
            });
        }
    }

    Ok(results)
}

/// Extract direct 160k Opus / AAC audio stream URL for a given YouTube video.
#[tauri::command]
pub async fn get_youtube_audio_url(
    app: AppHandle,
    server: State<'_, crate::plugins::telegram::server::TgServer>,
    video_id_or_url: String,
) -> AppResult<YouTubeStreamInfo> {
    let target = video_id_or_url.trim();
    let full_url = if target.contains("youtube.com/") || target.contains("youtu.be/") {
        target.to_string()
    } else {
        format!("https://www.youtube.com/watch?v={target}")
    };

    let yt_dlp = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| AppError::Other(format!("Failed to locate yt-dlp sidecar: {e}")))?;

    // Request stream URL and metadata simultaneously
    let cmd = yt_dlp.args([
        "-g",
        "-f",
        "bestaudio/bestaudio[ext=m4a]/best",
        "--dump-single-json",
        "--no-warnings",
        "--no-check-certificates",
        &full_url,
    ]);

    let output = cmd
        .output()
        .await
        .map_err(|e| AppError::Other(format!("Failed to extract YouTube stream: {e}")))?;

    let stdout = String::from_utf8_lossy(&output.stdout);

    // yt-dlp prints stream URLs first, followed by or containing json
    let mut lines = stdout.lines();
    let mut stream_url = String::new();
    let mut json_str = String::new();

    while let Some(line) = lines.next() {
        let trimmed = line.trim();
        if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            if stream_url.is_empty() {
                stream_url = trimmed.to_string();
            }
        } else if trimmed.starts_with('{') {
            json_str.push_str(trimmed);
            // Collect rest of json lines if formatted
            for rem in lines.by_ref() {
                json_str.push_str(rem);
            }
            break;
        }
    }

    if stream_url.is_empty() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Other(format!(
            "Failed to resolve audio stream URL from YouTube: {err}"
        )));
    }

    let val: serde_json::Value = serde_json::from_str(&json_str).unwrap_or(serde_json::Value::Null);

    let video_id = val
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| {
            if target.contains("v=") {
                target.split("v=").nth(1).unwrap_or(target).split('&').next().unwrap_or(target)
            } else {
                target
            }
        })
        .to_string();

    let title = val
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("YouTube Ambient Track")
        .to_string();

    let channel = val
        .get("channel")
        .or_else(|| val.get("uploader"))
        .and_then(|v| v.as_str())
        .unwrap_or("YouTube")
        .to_string();

    let duration_secs = val.get("duration").and_then(|v| v.as_f64());

    let thumbnail_url = val
        .get("thumbnail")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| Some(format!("https://i.ytimg.com/vi/{video_id}/hqdefault.jpg")));

    let final_stream_url = match server.register_yt_stream(app.clone(), &video_id, &stream_url).await {
        Ok(local_url) => local_url,
        Err(e) => {
            log::warn!("Failed to register YouTube stream with local proxy: {e}, using direct stream URL");
            stream_url
        }
    };

    Ok(YouTubeStreamInfo {
        stream_url: final_stream_url,
        video_id,
        title,
        channel,
        duration_secs,
        thumbnail_url,
    })
}

/// Download a YouTube audio track to `ambient_cache/` for zero-data offline playback.
#[tauri::command]
pub async fn cache_youtube_audio(
    app: AppHandle,
    db: State<'_, Db>,
    video_id: String,
    name: String,
) -> AppResult<String> {
    let cache_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Other(format!("Failed to resolve app_data_dir: {e}")))?
        .join("ambient_cache");
    std::fs::create_dir_all(&cache_dir)?;

    let clean_id = video_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect::<String>();
    let dest_file = cache_dir.join(format!("youtube_{clean_id}.m4a"));
    let dest_str = dest_file.to_string_lossy().to_string();

    // If already cached, return immediately
    if dest_file.exists() && dest_file.metadata().map(|m| m.len() > 1024).unwrap_or(false) {
        let _ = db.with(|c| queries::set_ambient_cached_path(c, "youtube", &clean_id, Some(&dest_str)));
        return Ok(dest_str);
    }

    let full_url = format!("https://www.youtube.com/watch?v={clean_id}");
    let yt_dlp = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| AppError::Other(format!("Failed to locate yt-dlp sidecar: {e}")))?;

    let cmd = yt_dlp.args([
        "-f",
        "bestaudio[ext=m4a]/bestaudio/best",
        "--no-warnings",
        "--no-check-certificates",
        "-o",
        &dest_str,
        &full_url,
    ]);

    let output = cmd
        .output()
        .await
        .map_err(|e| AppError::Other(format!("Failed to download YouTube audio: {e}")))?;

    if !output.status.success() && !dest_file.exists() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Other(format!("Download failed: {err}")));
    }

    let _ = name;
    let _ = db.with(|c| queries::set_ambient_cached_path(c, "youtube", &clean_id, Some(&dest_str)));
    Ok(dest_str)
}
