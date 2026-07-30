//! walkdir-based recursive file scanner (initial scan).
//!
//! The initial scan is a one-shot recursive walk of a registered folder that turns
//! its files into [`ScannedFile`] records grouped by an inferred **chapter name**.
//! The grouping rule matches the categorization design (Section 2):
//!
//! - Each top-level sub-folder becomes a chapter (its name cleaned by
//!   [`strip_chapter_prefix`], e.g. `01 - Intro` -> `Intro`).
//! - Files sitting directly in the root (no sub-folder) fall into a single default
//!   `"General"` chapter.
//! - Only files with a recognized learning-material extension are kept
//!   ([`classify_extension`]); everything else (dotfiles, `.tmp`, `.exe`, ...) is
//!   skipped so the library stays clean.
//!
//! This module is pure I/O + string logic with no database or Tauri dependency, so
//! its core (`classify_extension`, `strip_chapter_prefix`) is unit-tested directly.

use std::path::{Path, PathBuf};

use walkdir::WalkDir;

/// Legacy default chapter name (pre-v6). Files in the import root now attach directly to
/// the root node (no forced "General" level), so this is retained only as a fallback.
#[allow(dead_code)]
pub const DEFAULT_CHAPTER: &str = "General";

/// A single file discovered by the scan, with just enough metadata to insert a
/// `materials` row. Heavier metadata (video duration, PDF page count) is filled in
/// later by the `metadata` module — kept out of the hot scan path.
#[derive(Debug, Clone)]
pub struct ScannedFile {
    /// Absolute path on disk (also the UNIQUE key in `materials.file_path`).
    pub path: String,
    /// File name including extension, e.g. `lecture-01.mp4`.
    pub name: String,
    /// Coarse type used for filtering/icons: `video` | `pdf` | `note` | `image` | `audio`.
    pub file_type: String,
    /// Lowercased extension without the dot, e.g. `mp4`.
    pub extension: String,
    /// Size in bytes (0 if it could not be read).
    pub size_bytes: i64,
}

/// One scanned folder mapped to its relative path segment chain (from the import root
/// down to this folder) + the files that live DIRECTLY in it. `rel_segments` is empty for
/// files sitting in the import root itself (they attach to the root node). Produced by
/// [`scan_tree`], which mirrors an arbitrarily deep folder structure into the `nodes`
/// tree (v6). Cleaned folder names via [`strip_chapter_prefix`].
#[derive(Debug, Clone)]
pub struct ScannedNode {
    /// Cleaned folder names from the import root down to (and including) this folder.
    /// Empty = the import root itself.
    pub rel_segments: Vec<String>,
    /// Files directly in this folder (not its subfolders — those are their own nodes).
    pub files: Vec<ScannedFile>,
}

/// Map a file extension to a coarse material type, or `None` if unsupported.
///
/// The supported set matches the brief's scanner spec (Section 3). `ext` may be in
/// any case and may or may not include a leading dot; it is normalized internally.
pub fn classify_extension(ext: &str) -> Option<&'static str> {
    let e = ext.trim_start_matches('.').to_ascii_lowercase();
    match e.as_str() {
        // Video
        "mp4" | "mkv" | "webm" | "avi" | "mov" | "m4v" | "flv" | "wmv" => Some("video"),
        // Documents
        "pdf" => Some("pdf"),
        // Notes / text
        "md" | "txt" | "html" | "htm" | "epub" => Some("note"),
        // Images
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" => Some("image"),
        // Audio
        "mp3" | "wav" | "m4a" | "flac" | "ogg" | "aac" => Some("audio"),
        _ => None,
    }
}

/// Clean a raw folder name into a human chapter title by stripping common ordering
/// prefixes: leading numbers, separators, and words like `Chapter`/`Lecture`/`Week`.
///
/// Examples:
/// - `"01 - Introduction"` -> `"Introduction"`
/// - `"Ch3_Recursion"`      -> `"Recursion"`
/// - `"Lecture 5 Trees"`    -> `"Trees"`
/// - `"Section-2"`          -> `"Section-2"` (nothing meaningful left, keep original)
///
/// Deliberately regex-free (avoids pulling in the `regex` crate for the memory
/// target). If stripping would leave an empty string, the original (trimmed) name is
/// returned so a chapter is never nameless.
pub fn strip_chapter_prefix(raw: &str) -> String {
    let original = raw.trim();
    let mut s = original;

    // Repeatedly peel a leading ordering token, then any separators after it.
    loop {
        let before = s;

        // 1) Leading keyword like "chapter", "ch", "lecture", "week", "section", "part",
        //    "unit", "module", "day" (case-insensitive), possibly glued to a number.
        for kw in [
            "chapter", "lecture", "section", "module", "week", "unit", "part", "day", "ch", "lec",
        ] {
            if let Some(rest) = strip_leading_keyword(s, kw) {
                s = rest;
                break;
            }
        }

        // 2) Leading digits (the "01" / "3" ordering number).
        s = s.trim_start_matches(|c: char| c.is_ascii_digit());

        // 3) Leading separators / whitespace between the prefix and the real title.
        s = s.trim_start_matches([' ', '-', '_', '.', ')', '(', ':', '#', '\t']);

        // Stop once a full pass changes nothing.
        if s == before {
            break;
        }
    }

    let cleaned = s.trim();
    if cleaned.is_empty() {
        original.to_string()
    } else {
        cleaned.to_string()
    }
}

/// If `s` starts (case-insensitively) with `kw` at a word boundary, return the rest.
fn strip_leading_keyword<'a>(s: &'a str, kw: &str) -> Option<&'a str> {
    if s.len() < kw.len() {
        return None;
    }
    let (head, rest) = s.split_at(kw.len());
    if !head.eq_ignore_ascii_case(kw) {
        return None;
    }
    // Only treat as a prefix keyword if what follows is a boundary (digit, space,
    // separator, or end) — so "Charts" is NOT mistaken for the "ch" keyword.
    match rest.chars().next() {
        None => Some(rest),
        Some(c) if c.is_ascii_digit() || matches!(c, ' ' | '-' | '_' | '.' | ':' | '#') => {
            Some(rest)
        }
        _ => None,
    }
}

/// Recursively scan `root`, mirroring its ENTIRE folder tree (any depth) into a flat list
/// of [`ScannedNode`]s — one per folder that directly contains at least one supported
/// file. `rel_segments` records the cleaned folder chain from the import root to that
/// folder (empty = the root itself), so the importer can rebuild the tree in `nodes`.
///
/// Insertion order is preserved (first-seen folder, first-seen file) so the library
/// ordering is stable and predictable. Unreadable entries are skipped rather than aborting
/// the whole scan — a single permission error shouldn't lose the folder.
pub fn scan_tree(root: &Path) -> Vec<ScannedNode> {
    // Group files by their containing folder's relative segment chain. A Vec + parallel
    // key lookup preserves first-seen order without pulling in an ordered-map dependency.
    let mut nodes: Vec<ScannedNode> = Vec::new();
    let mut index_of: Vec<(Vec<String>, usize)> = Vec::new();

    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();

        let ext = match path.extension().and_then(|e| e.to_str()) {
            Some(e) => e,
            None => continue,
        };
        let file_type = match classify_extension(ext) {
            Some(t) => t,
            None => continue,
        };
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };

        let segments = folder_segments(root, path);
        let size_bytes = entry.metadata().map(|m| m.len() as i64).unwrap_or(0);
        let file = ScannedFile {
            path: path.to_string_lossy().to_string(),
            name,
            file_type: file_type.to_string(),
            extension: ext.to_ascii_lowercase(),
            size_bytes,
        };

        match index_of.iter().find(|(segs, _)| segs == &segments) {
            Some((_, i)) => nodes[*i].files.push(file),
            None => {
                index_of.push((segments.clone(), nodes.len()));
                nodes.push(ScannedNode {
                    rel_segments: segments,
                    files: vec![file],
                });
            }
        }
    }

    nodes
}

/// The cleaned folder-name chain from `root` down to the folder that contains
/// `file_path` (excluding the file itself). Empty when the file sits directly in `root`.
/// Each segment is run through [`strip_chapter_prefix`]; a segment that would clean to
/// empty keeps its original name so no folder is ever nameless.
fn folder_segments(root: &Path, file_path: &Path) -> Vec<String> {
    let rel = match file_path.strip_prefix(root) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let comps: Vec<PathBuf> = rel.iter().map(PathBuf::from).collect();
    if comps.len() <= 1 {
        return Vec::new(); // file is a direct child of the import root
    }
    // All components except the last (the file name) are folder segments.
    comps[..comps.len() - 1]
        .iter()
        .map(|c| strip_chapter_prefix(&c.to_string_lossy()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_extension_maps_known_types() {
        assert_eq!(classify_extension("mp4"), Some("video"));
        assert_eq!(classify_extension(".MP4"), Some("video")); // case + dot insensitive
        assert_eq!(classify_extension("mkv"), Some("video"));
        assert_eq!(classify_extension("pdf"), Some("pdf"));
        assert_eq!(classify_extension("md"), Some("note"));
        assert_eq!(classify_extension("PNG"), Some("image"));
        assert_eq!(classify_extension("mp3"), Some("audio"));
    }

    #[test]
    fn classify_extension_rejects_unknown() {
        assert_eq!(classify_extension("exe"), None);
        assert_eq!(classify_extension("tmp"), None);
        assert_eq!(classify_extension(""), None);
        assert_eq!(classify_extension("zip"), None);
    }

    #[test]
    fn strip_chapter_prefix_removes_ordering() {
        assert_eq!(strip_chapter_prefix("01 - Introduction"), "Introduction");
        assert_eq!(strip_chapter_prefix("Ch3_Recursion"), "Recursion");
        assert_eq!(strip_chapter_prefix("Chapter 3: Recursion"), "Recursion");
        assert_eq!(strip_chapter_prefix("Lecture 5 Trees"), "Trees");
        assert_eq!(strip_chapter_prefix("Week 2 - Graphs"), "Graphs");
        assert_eq!(strip_chapter_prefix("  07.Sorting  "), "Sorting");
    }

    #[test]
    fn strip_chapter_prefix_preserves_real_titles() {
        // No ordering junk -> unchanged.
        assert_eq!(strip_chapter_prefix("Recursion"), "Recursion");
        // "Charts" must not be eaten by the "ch" keyword (word-boundary guard).
        assert_eq!(strip_chapter_prefix("Charts"), "Charts");
        // If stripping would empty it, keep the original.
        assert_eq!(strip_chapter_prefix("01"), "01");
        assert_eq!(strip_chapter_prefix("Chapter 1"), "Chapter 1");
    }

    #[test]
    fn scan_tree_mirrors_arbitrary_depth() {
        use std::fs;
        // Build a deep folder tree in a temp dir:
        //   root/root.mp4                                   → rel_segments []
        //   root/GS2/Polity/intro.mp4                       → ["GS2","Polity"]
        //   root/GS2/Polity/Topic/01 - Deep/note.pdf        → ["GS2","Polity","Topic","Deep"]
        //   root/ignore.txtx (unsupported)                  → skipped
        let base = std::env::temp_dir().join(format!("ple_scan_tree_{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let deep = base.join("GS2").join("Polity").join("Topic").join("01 - Deep");
        fs::create_dir_all(&deep).unwrap();
        fs::write(base.join("root.mp4"), b"x").unwrap();
        fs::write(base.join("GS2").join("Polity").join("intro.mp4"), b"x").unwrap();
        fs::write(deep.join("note.pdf"), b"x").unwrap();
        fs::write(base.join("ignore.xyz"), b"x").unwrap();

        let nodes = scan_tree(&base);

        // Root file → empty segments.
        let root_node = nodes.iter().find(|n| n.rel_segments.is_empty()).unwrap();
        assert_eq!(root_node.files.len(), 1);
        assert_eq!(root_node.files[0].name, "root.mp4");

        // Depth-2 folder.
        let polity = nodes
            .iter()
            .find(|n| n.rel_segments == vec!["GS2".to_string(), "Polity".to_string()])
            .unwrap();
        assert_eq!(polity.files.len(), 1);

        // Depth-4 folder, with the "01 - " ordering prefix stripped to "Deep".
        let deep_node = nodes
            .iter()
            .find(|n| {
                n.rel_segments
                    == vec![
                        "GS2".to_string(),
                        "Polity".to_string(),
                        "Topic".to_string(),
                        "Deep".to_string(),
                    ]
            })
            .unwrap();
        assert_eq!(deep_node.files.len(), 1);
        assert_eq!(deep_node.files[0].file_type, "pdf");

        // Unsupported extension skipped entirely.
        assert!(nodes
            .iter()
            .all(|n| n.files.iter().all(|f| f.name != "ignore.xyz")));

        let _ = fs::remove_dir_all(&base);
    }
}
