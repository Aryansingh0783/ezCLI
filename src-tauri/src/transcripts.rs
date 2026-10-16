//! Searchable session transcripts, stored only on this PC.
//!
//! The frontend saves a tab's plain terminal text when the process exits or
//! the tab closes. Each transcript is one JSON file in
//! `~/.ezcli/transcripts`. Nothing here is uploaded or sent to a CLI.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

/// Text kept per transcript. Terminal UIs redraw a lot; the tail is what
/// people search for.
const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;
const MAX_TRANSCRIPTS: usize = 300;
const KEEP_FOR: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const MAX_HITS: usize = 60;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub id: String,
    pub title: String,
    pub agent_id: String,
    pub agent_label: String,
    pub model: String,
    pub cwd: String,
    /// Milliseconds since the Unix epoch.
    pub started_at: u64,
    pub ended_at: u64,
}

#[derive(Serialize, Deserialize)]
struct Stored {
    meta: Meta,
    text: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub meta: Meta,
    /// Up to three short excerpts around matches.
    pub snippets: Vec<String>,
    pub matches: usize,
}

pub fn dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(".ezcli")
        .join("transcripts")
}

/// File names come from the session id, so restrict it to a safe charset.
fn file_for(id: &str) -> Result<PathBuf, String> {
    let ok = !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !ok {
        return Err("invalid transcript id".into());
    }
    Ok(dir().join(format!("{id}.json")))
}

/// Keep the end of the text, cut on a char boundary.
fn clip(text: &str) -> &str {
    if text.len() <= MAX_TEXT_BYTES {
        return text;
    }
    let mut start = text.len() - MAX_TEXT_BYTES;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

pub fn save(meta: Meta, text: &str) -> Result<(), String> {
    let path = file_for(&meta.id)?;
    if text.trim().is_empty() {
        return Ok(());
    }
    std::fs::create_dir_all(dir()).map_err(|e| e.to_string())?;
    let stored = Stored { meta, text: clip(text).to_string() };
    let json = serde_json::to_vec(&stored).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())?;
    prune();
    Ok(())
}

fn load_all() -> Vec<Stored> {
    let Ok(entries) = std::fs::read_dir(dir()) else { return Vec::new() };
    entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| std::fs::read(e.path()).ok())
        .filter_map(|b| serde_json::from_slice::<Stored>(&b).ok())
        .collect()
}

/// Drop transcripts older than 30 days, then the oldest beyond the cap.
pub fn prune() {
    let Ok(entries) = std::fs::read_dir(dir()) else { return };
    let mut files: Vec<(SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    for (i, (modified, path)) in files.iter().enumerate() {
        let old = modified.elapsed().is_ok_and(|age| age > KEEP_FOR);
        if old || i >= MAX_TRANSCRIPTS {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Case-insensitive search over every saved transcript, newest first. An
/// empty query lists recent transcripts without snippets.
pub fn search(query: &str) -> Vec<Hit> {
    let q = query.trim().to_lowercase();
    let mut all = load_all();
    all.sort_by(|a, b| b.meta.ended_at.cmp(&a.meta.ended_at));
    let mut hits = Vec::new();
    for s in all {
        if q.is_empty() {
            hits.push(Hit { meta: s.meta, snippets: Vec::new(), matches: 0 });
        } else {
            let lower = s.text.to_lowercase();
            let in_meta = s.meta.title.to_lowercase().contains(&q) || s.meta.cwd.to_lowercase().contains(&q);
            let positions: Vec<usize> = lower.match_indices(&q).map(|(i, _)| i).collect();
            if positions.is_empty() && !in_meta {
                continue;
            }
            let snippets = positions.iter().take(3).map(|&i| excerpt(&s.text, &lower, i, q.len())).collect();
            hits.push(Hit { meta: s.meta, snippets, matches: positions.len() });
        }
        if hits.len() >= MAX_HITS {
            break;
        }
    }
    hits
}

/// About 70 characters either side of a match, on one line. `lower` has the
/// same byte layout as `text` for ASCII; for other scripts the boundaries are
/// re-checked against `text` so slicing can never panic.
fn excerpt(text: &str, lower: &str, at: usize, len: usize) -> String {
    let src = if lower.len() == text.len() { text } else { lower };
    let mut start = at.saturating_sub(70);
    while start > 0 && !src.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (at + len + 70).min(src.len());
    while end < src.len() && !src.is_char_boundary(end) {
        end += 1;
    }
    let body: String = src[start..end].split_whitespace().collect::<Vec<_>>().join(" ");
    format!("{}{}{}", if start > 0 { "…" } else { "" }, body, if end < src.len() { "…" } else { "" })
}

pub fn read(id: &str) -> Result<(Meta, String), String> {
    let bytes = std::fs::read(file_for(id)?).map_err(|_| "That transcript no longer exists.".to_string())?;
    let s: Stored = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    Ok((s.meta, s.text))
}

pub fn delete(id: &str) -> Result<(), String> {
    let path = file_for(id)?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Remove every saved transcript. Returns how many were deleted.
pub fn clear() -> usize {
    let Ok(entries) = std::fs::read_dir(dir()) else { return 0 };
    entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter(|e| std::fs::remove_file(e.path()).is_ok())
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_cannot_escape_the_transcript_folder() {
        assert!(file_for("t12-p3").is_ok());
        assert!(file_for("../evil").is_err());
        assert!(file_for("a/b").is_err());
        assert!(file_for("").is_err());
    }

    #[test]
    fn clip_keeps_the_end_on_a_char_boundary() {
        let text = format!("{}é{}", "a".repeat(10), "b".repeat(MAX_TEXT_BYTES));
        let c = clip(&text);
        assert!(c.len() <= MAX_TEXT_BYTES);
        assert!(c.ends_with('b'));
    }

    #[test]
    fn excerpt_is_one_line_with_ellipses() {
        let text = format!("{}\nneedle here\n{}", "x".repeat(200), "y".repeat(200));
        let lower = text.to_lowercase();
        let at = lower.find("needle").unwrap();
        let e = excerpt(&text, &lower, at, 6);
        assert!(e.starts_with('…') && e.ends_with('…'));
        assert!(e.contains("needle here"));
        assert!(!e.contains('\n'));
    }
}
