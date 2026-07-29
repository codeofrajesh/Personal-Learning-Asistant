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

/// The default chapter for files that live directly in the registered root.
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

/// One inferred chapter and the files that belong to it, in discovery order.
#[derive(Debug, Clone)]
pub struct ChapterGroup {
    /// Cleaned chapter name (folder name minus ordering prefix, or `"General"`).
    pub chapter: String,
    /// Files belonging to this chapter.
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

/// Recursively scan `root`, returning files grouped by inferred chapter.
///
/// Groups preserve first-seen order (both of chapters and of files within them) so the
/// library ordering is stable and predictable. Unreadable entries are skipped rather
/// than aborting the whole scan — a single permission error shouldn't lose the folder.
pub fn scan_dir(root: &Path) -> Vec<ChapterGroup> {
    // Preserve insertion order without an extra dependency: a Vec of groups plus a
    // parallel lookup of chapter-name -> index.
    let mut groups: Vec<ChapterGroup> = Vec::new();
    let mut index_of: Vec<(String, usize)> = Vec::new();

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
            None => continue, // no extension -> not a material we understand
        };
        let file_type = match classify_extension(ext) {
            Some(t) => t,
            None => continue,
        };

        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };

        let chapter = chapter_for(root, path);
        let size_bytes = entry.metadata().map(|m| m.len() as i64).unwrap_or(0);

        let file = ScannedFile {
            path: path.to_string_lossy().to_string(),
            name,
            file_type: file_type.to_string(),
            extension: ext.to_ascii_lowercase(),
            size_bytes,
        };

        match index_of.iter().find(|(c, _)| c == &chapter) {
            Some((_, i)) => groups[*i].files.push(file),
            None => {
                index_of.push((chapter.clone(), groups.len()));
                groups.push(ChapterGroup {
                    chapter,
                    files: vec![file],
                });
            }
        }
    }

    groups
}

/// Determine the chapter name for `file_path` under `root`: the cleaned name of the
/// first path segment below `root`, or [`DEFAULT_CHAPTER`] when the file is a direct
/// child of the root.
fn chapter_for(root: &Path, file_path: &Path) -> String {
    let rel = match file_path.strip_prefix(root) {
        Ok(r) => r,
        Err(_) => return DEFAULT_CHAPTER.to_string(),
    };

    // Collect components; the last is the file name itself.
    let comps: Vec<PathBuf> = rel.iter().map(PathBuf::from).collect();
    if comps.len() <= 1 {
        // File sits directly in root.
        return DEFAULT_CHAPTER.to_string();
    }

    let top = comps[0].to_string_lossy();
    strip_chapter_prefix(&top)
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
}
