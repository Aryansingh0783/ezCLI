//! Saved sessions: ezCLI's own local memory of every tab, kept on this PC.
//!
//! Each saved session is two files in `~/.ezcli/transcripts`:
//!   `<id>.meta.json`  small: title, agent, model, folder, times, the CLI's own
//!                     session id and the last things you typed
//!   `<id>.txt`        the terminal text, newest 2 MB
//! Listing reads only the small files. Sessions older than the two-file layout
//! (`<id>.json`, written by 2.0) are still read and are converted the next time
//! they are saved. Nothing is deleted by age: sessions stay until you delete
//! them, and only the oldest are pruned if the store grows past a size budget.
//! Nothing here is uploaded; GitHub sync is a separate, opt-in feature.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Text kept per session. Terminal UIs redraw a lot; the end is what matters.
const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;
/// Oldest sessions are pruned beyond these.
const MAX_SESSIONS: usize = 3000;
const MAX_STORE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_HITS: usize = 80;
const MAX_PROMPTS: usize = 30;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
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
    /// The CLI's own id for this conversation (Claude Code, Codex), so the
    /// session can be resumed with its real context.
    #[serde(default)]
    pub provider_session_id: String,
    #[serde(default)]
    pub model_id: String,
    #[serde(default)]
    pub mode_id: String,
    #[serde(default)]
    pub effort_id: String,
    /// What was typed into the composer, newest last.
    #[serde(default)]
    pub prompts: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct Legacy {
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
fn safe_id(id: &str) -> Result<&str, String> {
    let ok = !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(id)
    } else {
        Err("invalid session id".into())
    }
}

fn meta_path(id: &str) -> Result<PathBuf, String> {
    Ok(dir().join(format!("{}.meta.json", safe_id(id)?)))
}
fn text_path(id: &str) -> Result<PathBuf, String> {
    Ok(dir().join(format!("{}.txt", safe_id(id)?)))
}
fn legacy_path(id: &str) -> Result<PathBuf, String> {
    Ok(dir().join(format!("{}.json", safe_id(id)?)))
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

pub fn save(mut meta: Meta, text: &str) -> Result<(), String> {
    safe_id(&meta.id)?;
    if text.trim().is_empty() {
        return Ok(());
    }
    let keep = meta.prompts.len().saturating_sub(MAX_PROMPTS);
    meta.prompts.drain(..keep);
    std::fs::create_dir_all(dir()).map_err(|e| e.to_string())?;
    write_atomic(&text_path(&meta.id)?, clip(text).as_bytes())?;
    write_atomic(&meta_path(&meta.id)?, &serde_json::to_vec(&meta).map_err(|e| e.to_string())?)?;
    // A 2.0-format file for the same id is now superseded.
    let _ = std::fs::remove_file(legacy_path(&meta.id)?);
    prune();
    Ok(())
}

/// Write to a temp file then rename, so a crash mid-save never corrupts a session.
fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Every saved session's metadata, newest first.
pub fn list() -> Vec<Meta> {
    let Ok(entries) = std::fs::read_dir(dir()) else { return Vec::new() };
    let mut out: Vec<Meta> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut legacy: Vec<PathBuf> = Vec::new();
    for e in entries.flatten() {
        let path = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if name.ends_with(".meta.json") {
            if let Some(meta) = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice::<Meta>(&b).ok()) {
                seen.insert(meta.id.clone());
                out.push(meta);
            }
        } else if name.ends_with(".json") {
            legacy.push(path);
        }
    }
    for path in legacy {
        if let Some(l) = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice::<Legacy>(&b).ok()) {
            if seen.insert(l.meta.id.clone()) {
                out.push(l.meta);
            }
        }
    }
    out.sort_by(|a, b| b.ended_at.cmp(&a.ended_at));
    out
}

fn read_text(id: &str) -> Option<String> {
    if let Ok(t) = std::fs::read_to_string(text_path(id).ok()?) {
        return Some(t);
    }
    let l: Legacy = serde_json::from_slice(&std::fs::read(legacy_path(id).ok()?).ok()?).ok()?;
    Some(l.text)
}

/// Case-insensitive search over saved sessions, newest first. An empty query
/// lists recent sessions without snippets.
pub fn search(query: &str) -> Vec<Hit> {
    let q = query.trim().to_lowercase();
    let mut hits = Vec::new();
    for meta in list() {
        if q.is_empty() {
            hits.push(Hit { meta, snippets: Vec::new(), matches: 0 });
        } else {
            let in_meta = meta.title.to_lowercase().contains(&q)
                || meta.cwd.to_lowercase().contains(&q)
                || meta.prompts.iter().any(|p| p.to_lowercase().contains(&q));
            let text = read_text(&meta.id).unwrap_or_default();
            let lower = text.to_lowercase();
            let positions: Vec<usize> = lower.match_indices(&q).map(|(i, _)| i).collect();
            if positions.is_empty() && !in_meta {
                continue;
            }
            let snippets = positions.iter().take(3).map(|&i| excerpt(&text, &lower, i, q.len())).collect();
            hits.push(Hit { meta, snippets, matches: positions.len() });
        }
        if hits.len() >= MAX_HITS {
            break;
        }
    }
    hits
}

/// About 70 characters either side of a match, on one line. `lower` has the
/// same byte layout as `text` for ASCII; otherwise the boundaries are re-checked
/// so slicing can never panic.
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
    safe_id(id)?;
    let meta = list()
        .into_iter()
        .find(|m| m.id == id)
        .ok_or_else(|| "That saved session no longer exists.".to_string())?;
    let text = read_text(id).unwrap_or_default();
    Ok((meta, text))
}

pub fn delete(id: &str) -> Result<(), String> {
    for p in [meta_path(id)?, text_path(id)?, legacy_path(id)?] {
        if p.exists() {
            std::fs::remove_file(p).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Remove every saved session. Returns how many were deleted.
pub fn clear() -> usize {
    let ids: Vec<String> = list().into_iter().map(|m| m.id).collect();
    ids.iter().filter(|id| delete(id).is_ok()).count()
}

/// Keep the store inside its budget by dropping the oldest sessions. Age alone
/// never deletes anything.
pub fn prune() {
    let metas = list(); // newest first
    let size_of = |id: &str| -> u64 {
        [meta_path(id), text_path(id), legacy_path(id)]
            .into_iter()
            .flatten()
            .filter_map(|p| std::fs::metadata(p).ok())
            .map(|m| m.len())
            .sum()
    };
    let mut total: u64 = 0;
    for (i, m) in metas.iter().enumerate() {
        total += size_of(&m.id);
        if i >= MAX_SESSIONS || total > MAX_STORE_BYTES {
            let _ = delete(&m.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_home<T>(f: impl FnOnce() -> T) -> T {
        // Tests use unique ids and clean up after themselves; the store is the
        // real per-user folder, so never touch ids that are not ours.
        f()
    }

    fn meta(id: &str) -> Meta {
        Meta {
            id: id.into(),
            title: "Fix login".into(),
            agent_id: "claude-code".into(),
            agent_label: "Claude Code".into(),
            cwd: "F:/WORK/app".into(),
            started_at: 1,
            ended_at: 2,
            provider_session_id: "3e3778c6-cc28-42f9-932a-a4d0bfb86253".into(),
            prompts: vec!["first".into(), "second".into()],
            ..Default::default()
        }
    }

    #[test]
    fn ids_cannot_escape_the_store() {
        assert!(safe_id("t12-p3").is_ok());
        assert!(safe_id("../evil").is_err());
        assert!(safe_id("a/b").is_err());
        assert!(safe_id("").is_err());
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
        assert!(e.contains("needle here") && !e.contains('\n'));
    }

    #[test]
    fn a_saved_session_round_trips_with_its_provider_id_and_prompts() {
        with_home(|| {
            let id = format!("unit-test-{}", std::process::id());
            save(meta(&id), "hello world\nthe zebra-needle is here\nbye").unwrap();
            let hits = search("zebra-needle");
            let mine: Vec<_> = hits.iter().filter(|h| h.meta.id == id).collect();
            assert_eq!(mine.len(), 1);
            assert!(mine[0].snippets[0].contains("zebra-needle"));
            let (m, text) = read(&id).unwrap();
            assert_eq!(m.provider_session_id, "3e3778c6-cc28-42f9-932a-a4d0bfb86253");
            assert_eq!(m.prompts, vec!["first", "second"]);
            assert!(text.contains("bye"));
            // Matching on what was typed finds it even when the text does not.
            assert!(search("second").iter().any(|h| h.meta.id == id));
            delete(&id).unwrap();
            assert!(read(&id).is_err());
        });
    }

    #[test]
    fn two_point_oh_files_are_still_listed_and_readable() {
        with_home(|| {
            let id = format!("legacy-test-{}", std::process::id());
            std::fs::create_dir_all(dir()).unwrap();
            let old = Legacy { meta: meta(&id), text: "old format text".into() };
            std::fs::write(legacy_path(&id).unwrap(), serde_json::to_vec(&old).unwrap()).unwrap();
            assert!(list().iter().any(|m| m.id == id));
            assert_eq!(read(&id).unwrap().1, "old format text");
            // Saving again converts it to the two-file layout.
            save(meta(&id), "new text").unwrap();
            assert!(!legacy_path(&id).unwrap().exists());
            assert!(meta_path(&id).unwrap().exists());
            delete(&id).unwrap();
        });
    }
}
