//! Video playback: local HTTP byte-range server + external mpv IPC client.
//! Implemented in the video-player milestone (Section 13 build order).

pub mod mpv;
pub mod server;
