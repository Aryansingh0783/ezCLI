//! Read-only discovery of the chat history the agent CLIs already keep on this
//! PC: Claude Code (`~/.claude/projects/**/<session>.jsonl`) and Codex
//! (`~/.codex/sessions/**/rollout-*.jsonl`).
//!
//! The picker lists cheap summaries (title, folder, time, session id) built from
//! the head of each file. A conversation's messages are parsed only when it is
//! opened, and the newest ones are kept, because the end of a long chat is what
//! someone continuing the work needs. Files the tools write for themselves
//! (claude-mem observer sessions and similar) are counted but never listed.
//! Webview code only ever sees opaque ids, never file paths.

use anyhow::Result;
use serde::Serialize;
use serde_json::Value;
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

/// Files listed per source, newest first.
const MAX_PER_SOURCE: usize = 250;
/// Head of a file scanned for its title, folder and id.
const HEAD_RECORDS: usize = 600;
const MAX_FILE_BYTES: u64 = 400 * 1024 * 1024;
const MAX_RECORD_BYTES: usize = 2 * 1024 * 1024;
/// Newest messages kept when a conversation is opened.
const KEEP_MESSAGES: usize = 400;
const MAX_MESSAGE_CHARS: usize = 32_000;
const TITLE_CHARS: usize = 96;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportSource {
    pub id: String,
    pub label: String,
    pub available: bool,
    pub detail: String,
    pub count: usize,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub id: String,
    pub source: String,
    pub title: String,
    /// The folder's name, for display.
    pub project: String,
    /// The full working folder the chat ran in, when the file records it.
    pub cwd: String,
    pub updated_at: u64,
    /// The CLI's own id for this conversation; `claude --resume` and
    /// `codex resume` take it.
    pub session_id: String,
    pub size_kb: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportCatalog {
    pub sources: Vec<ImportSource>,
    pub conversations: Vec<ImportSummary>,
    /// Automatic sessions (tool-generated, not typed by the user) left out.
    pub hidden_automatic: usize,
    pub truncated: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportMessage {
    pub role: String,
    pub content: String,
    pub timestamp: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportConversation {
    pub id: String,
    pub source: String,
    pub title: String,
    pub project: String,
    pub cwd: String,
    pub session_id: String,
    pub updated_at: u64,
    pub messages: Vec<ImportMessage>,
    /// How many messages the chat has in total; `messages` holds the newest.
    pub total_messages: usize,
    pub truncated: bool,
}

#[derive(Clone)]
pub struct ImportEntry {
    path: PathBuf,
    source: Source,
    summary: ImportSummary,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Source {
    Claude,
    Codex,
}

impl Source {
    fn id(self) -> &'static str {
        match self {
            Source::Claude => "claude-code",
            Source::Codex => "codex",
        }
    }
}

/// Opaque id -> file, filled by `list_imports`. The webview cannot ask for an
/// arbitrary path, only for an id the last scan produced.
#[derive(Default)]
pub struct ImportStore {
    entries: Mutex<HashMap<String, ImportEntry>>,
}

impl ImportStore {
    pub fn replace(&self, list: Vec<ImportEntry>) {
        *self.entries.lock().unwrap() = list.into_iter().map(|e| (e.summary.id.clone(), e)).collect();
    }

    pub fn get(&self, id: &str) -> Option<ImportEntry> {
        self.entries.lock().unwrap().get(id).cloned()
    }
}

pub struct Discovery {
    pub catalog: ImportCatalog,
    pub entries: Vec<ImportEntry>,
}

fn home() -> Option<PathBuf> {
    dirs::home_dir()
}

fn claude_projects_dir() -> Option<PathBuf> {
    home().map(|h| h.join(".claude").join("projects"))
}

fn codex_sessions_dir() -> Option<PathBuf> {
    home().map(|h| h.join(".codex").join("sessions"))
}

pub fn discover() -> Result<Discovery> {
    let mut entries = Vec::new();
    let mut sources = Vec::new();
    let mut hidden = 0usize;
    let mut truncated = false;

    for (source, root, label) in [
        (Source::Claude, claude_projects_dir(), "Claude Code"),
        (Source::Codex, codex_sessions_dir(), "Codex"),
    ] {
        let Some(root) = root.filter(|r| r.is_dir()) else {
            sources.push(ImportSource {
                id: source.id().into(),
                label: label.into(),
                available: false,
                detail: format!("No {label} history found on this PC."),
                count: 0,
            });
            continue;
        };
        let (files, skipped) = collect_files(&root, source);
        hidden += skipped;
        let mut found = 0;
        for (mtime, size, path) in files.into_iter().take(MAX_PER_SOURCE * 3) {
            if found >= MAX_PER_SOURCE {
                truncated = true;
                break;
            }
            match summarize(&path, source, mtime, size) {
                Some(Summary::Chat(summary)) => {
                    found += 1;
                    entries.push(ImportEntry { path, source, summary });
                }
                Some(Summary::Automatic) => hidden += 1,
                None => {}
            }
        }
        sources.push(ImportSource {
            id: source.id().into(),
            label: label.into(),
            available: true,
            detail: format!("Reads {}", root.display()),
            count: found,
        });
    }
    for (id, label) in [("claude-desktop", "Claude Desktop"), ("chatgpt-desktop", "ChatGPT desktop")] {
        sources.push(ImportSource {
            id: id.into(),
            label: label.into(),
            available: false,
            detail: "Keeps its chats in the cloud or an encrypted store, so they cannot be read from disk.".into(),
            count: 0,
        });
    }

    entries.sort_by(|a, b| b.summary.updated_at.cmp(&a.summary.updated_at));
    let catalog = ImportCatalog {
        sources,
        conversations: entries.iter().map(|e| e.summary.clone()).collect(),
        hidden_automatic: hidden,
        truncated,
    };
    Ok(Discovery { catalog, entries })
}

/// (mtime ms, size, path) for every transcript, newest first. Directories that
/// only hold tool-generated sessions are counted and not walked.
fn collect_files(root: &Path, source: Source) -> (Vec<(u64, u64, PathBuf)>, usize) {
    let mut found = Vec::new();
    let mut skipped = 0usize;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(read) = fs::read_dir(&dir) else { continue };
        for entry in read.flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            let path = entry.path();
            if kind.is_dir() {
                let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                if is_automatic_dir(&name) {
                    skipped += fs::read_dir(&path).map(|d| d.flatten().filter(|e| e.path().extension().is_some_and(|x| x == "jsonl")).count()).unwrap_or(0);
                } else if name != "subagents" {
                    stack.push(path);
                }
                continue;
            }
            let is_jsonl = path.extension().and_then(|e| e.to_str()) == Some("jsonl");
            let wanted_name = match source {
                Source::Claude => true,
                Source::Codex => path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("rollout-")),
            };
            if !kind.is_file() || !is_jsonl || !wanted_name {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if meta.len() > MAX_FILE_BYTES || meta.len() == 0 {
                continue;
            }
            found.push((mtime_ms(&meta), meta.len(), path));
        }
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    (found, skipped)
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Project folders that hold sessions a tool created for itself.
fn is_automatic_dir(lower_name: &str) -> bool {
    lower_name.contains("observer-sessions") || lower_name.contains("claude-mem")
}

/// First messages that mark a session as machine-written.
fn is_automatic_text(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with("Condense the tool payload")
        || t.starts_with("<observed_from_primary_session>")
        || t.starts_with("You are a Claude-Mem")
        || t.contains("claude-mem observer")
}

enum Summary {
    Chat(ImportSummary),
    Automatic,
}

fn summarize(path: &Path, source: Source, mtime: u64, size: u64) -> Option<Summary> {
    let file = fs::File::open(path).ok()?;
    let mut cwd = String::new();
    let mut session_id = String::new();
    let mut title = String::new();
    let mut user_messages = 0;
    for (index, line) in BufReader::new(file).lines().enumerate() {
        if index >= HEAD_RECORDS {
            break;
        }
        let Ok(line) = line else { break };
        if line.len() > MAX_RECORD_BYTES {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(&line) else { continue };
        match source {
            Source::Claude => {
                if cwd.is_empty() {
                    if let Some(c) = record.get("cwd").and_then(Value::as_str).filter(|c| !c.is_empty()) {
                        cwd = c.to_string();
                    }
                }
                if session_id.is_empty() {
                    if let Some(s) = record.get("sessionId").and_then(Value::as_str) {
                        session_id = s.to_string();
                    }
                }
                if record.get("isMeta").and_then(Value::as_bool).unwrap_or(false) || record.get("isSidechain").and_then(Value::as_bool).unwrap_or(false) {
                    continue;
                }
                if let Some(m) = claude_message(&record).filter(|m| m.role == "user") {
                    user_messages += 1;
                    if title.is_empty() && !m.content.trim_start().starts_with('<') {
                        if is_automatic_text(&m.content) {
                            return Some(Summary::Automatic);
                        }
                        title = title_from(&m.content);
                    }
                }
            }
            Source::Codex => {
                if record.get("type").and_then(Value::as_str) == Some("session_meta") {
                    let p = record.get("payload").unwrap_or(&Value::Null);
                    if let Some(c) = p.get("cwd").and_then(Value::as_str) {
                        cwd = c.to_string();
                    }
                    if let Some(id) = p.get("id").and_then(Value::as_str) {
                        session_id = id.to_string();
                    }
                    // `codex exec` runs and subagents are not conversations the user had.
                    if p.get("thread_source").and_then(Value::as_str).is_some_and(|s| s != "user") {
                        return Some(Summary::Automatic);
                    }
                }
                if let Some(m) = codex_message(&record).filter(|m| m.role == "user") {
                    user_messages += 1;
                    if title.is_empty() && !m.content.trim_start().starts_with('<') {
                        if is_automatic_text(&m.content) {
                            return Some(Summary::Automatic);
                        }
                        title = title_from(&m.content);
                    }
                }
            }
        }
        if !title.is_empty() && !cwd.is_empty() && !session_id.is_empty() {
            break;
        }
    }
    if user_messages == 0 || title.is_empty() {
        return None;
    }
    if !looks_like_uuid(&session_id) {
        // Claude names the file after the session; Codex ends the file name with it.
        let stem = path.file_stem()?.to_str()?;
        let tail = stem.get(stem.len().saturating_sub(36)..).unwrap_or(stem);
        session_id = if looks_like_uuid(tail) { tail.to_string() } else { stem.to_string() };
    }
    let project = if cwd.is_empty() {
        path.parent().and_then(|p| p.file_name()).and_then(|n| n.to_str()).unwrap_or("Unknown folder").to_string()
    } else {
        Path::new(&cwd).file_name().and_then(|n| n.to_str()).map(str::to_string).unwrap_or_else(|| cwd.clone())
    };
    Some(Summary::Chat(ImportSummary {
        id: opaque_id(path, source),
        source: source.id().into(),
        title,
        project,
        cwd,
        updated_at: mtime,
        session_id,
        size_kb: size.div_ceil(1024),
    }))
}

fn looks_like_uuid(s: &str) -> bool {
    s.len() == 36 && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// Parse a whole conversation, keeping the newest messages.
pub fn read(entry: &ImportEntry) -> Result<ImportConversation> {
    let file = fs::File::open(&entry.path)?;
    let mut keep: VecDeque<ImportMessage> = VecDeque::new();
    let mut total = 0usize;
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { break };
        if line.len() > MAX_RECORD_BYTES {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(&line) else { continue };
        let message = match entry.source {
            Source::Claude => {
                if record.get("isMeta").and_then(Value::as_bool).unwrap_or(false) || record.get("isSidechain").and_then(Value::as_bool).unwrap_or(false) {
                    continue;
                }
                claude_message(&record)
            }
            Source::Codex => codex_message(&record),
        };
        let Some(m) = message else { continue };
        // Environment dumps and command wrappers are not part of the conversation.
        if m.role == "user" && m.content.trim_start().starts_with('<') {
            continue;
        }
        total += 1;
        keep.push_back(m);
        if keep.len() > KEEP_MESSAGES {
            keep.pop_front();
        }
    }
    let s = &entry.summary;
    Ok(ImportConversation {
        id: s.id.clone(),
        source: s.source.clone(),
        title: s.title.clone(),
        project: s.project.clone(),
        cwd: s.cwd.clone(),
        session_id: s.session_id.clone(),
        updated_at: s.updated_at,
        total_messages: total,
        truncated: total > keep.len(),
        messages: keep.into_iter().collect(),
    })
}

fn claude_message(record: &Value) -> Option<ImportMessage> {
    let message = record.get("message")?;
    let raw_role = message
        .get("role")
        .and_then(Value::as_str)
        .or_else(|| record.get("type").and_then(Value::as_str))?;
    let role = match raw_role.to_ascii_lowercase().as_str() {
        "user" | "human" => "user",
        "assistant" => "assistant",
        _ => return None,
    };
    let content = text_content(message.get("content")?)?;
    if content.trim().is_empty() {
        return None;
    }
    Some(ImportMessage {
        role: role.into(),
        content: truncate_chars(content, MAX_MESSAGE_CHARS),
        timestamp: record.get("timestamp").and_then(Value::as_str).map(ToOwned::to_owned),
    })
}

/// Codex writes each turn as `response_item` records whose payload is a
/// `message` with role user/assistant and `input_text`/`output_text` blocks.
fn codex_message(record: &Value) -> Option<ImportMessage> {
    if record.get("type").and_then(Value::as_str) != Some("response_item") {
        return None;
    }
    let p = record.get("payload")?;
    if p.get("type").and_then(Value::as_str) != Some("message") {
        return None;
    }
    let role = match p.get("role").and_then(Value::as_str)? {
        "user" => "user",
        "assistant" => "assistant",
        _ => return None,
    };
    let parts: Vec<&str> = p
        .get("content")?
        .as_array()?
        .iter()
        .filter(|b| matches!(b.get("type").and_then(Value::as_str), Some("input_text" | "output_text" | "text")))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect();
    let content = parts.join("\n\n");
    if content.trim().is_empty() {
        return None;
    }
    Some(ImportMessage {
        role: role.into(),
        content: truncate_chars(content, MAX_MESSAGE_CHARS),
        timestamp: record.get("timestamp").and_then(Value::as_str).map(ToOwned::to_owned),
    })
}

fn text_content(content: &Value) -> Option<String> {
    match content {
        Value::String(text) => Some(text.clone()),
        Value::Array(blocks) => {
            let parts: Vec<&str> = blocks
                .iter()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect();
            (!parts.is_empty()).then(|| parts.join("\n\n"))
        }
        Value::Object(block) if block.get("type").and_then(Value::as_str) == Some("text") => {
            block.get("text").and_then(Value::as_str).map(ToOwned::to_owned)
        }
        _ => None,
    }
}

fn title_from(content: &str) -> String {
    let single_line = content.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate_chars(single_line, TITLE_CHARS)
}

fn truncate_chars(mut value: String, limit: usize) -> String {
    let Some((index, _)) = value.char_indices().nth(limit) else {
        return value;
    };
    value.truncate(index);
    value.push('…');
    value
}

fn opaque_id(path: &Path, source: Source) -> String {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    format!("{}-{:016x}", source.id(), hasher.finish())
}

/// The newest Codex session recorded for `cwd` that started after `since_ms`.
/// Codex picks its own session id, so ezCLI reads it back from the rollout file
/// to be able to resume exactly that conversation later.
pub fn find_codex_session(cwd: &str, since_ms: u64) -> Option<String> {
    let root = codex_sessions_dir()?;
    let want = normalize_path(cwd);
    let (files, _) = collect_files(&root, Source::Codex);
    for (mtime, _, path) in files.into_iter().take(40) {
        if mtime + 60_000 < since_ms {
            break; // sorted newest first: nothing older can match
        }
        let Ok(file) = fs::File::open(&path) else { continue };
        let Some(Ok(first)) = BufReader::new(file).lines().next() else { continue };
        let Ok(record) = serde_json::from_str::<Value>(&first) else { continue };
        let p = record.get("payload").unwrap_or(&Value::Null);
        if record.get("type").and_then(Value::as_str) != Some("session_meta") {
            continue;
        }
        let same = p.get("cwd").and_then(Value::as_str).is_some_and(|c| normalize_path(c) == want);
        let id = p.get("id").and_then(Value::as_str);
        if same {
            if let Some(id) = id.filter(|i| looks_like_uuid(i)) {
                return Some(id.to_string());
            }
        }
    }
    None
}

/// The Codex rollout file for a session id (the id ends the file name).
pub fn find_codex_file(session_id: &str) -> Option<PathBuf> {
    let root = codex_sessions_dir()?;
    let suffix = format!("-{session_id}.jsonl");
    let (files, _) = collect_files(&root, Source::Codex);
    files.into_iter().map(|(_, _, p)| p).find(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.ends_with(&suffix)))
}

/// Whether the CLI still has a stored conversation with this id. A tab that
/// only ran local commands never created one, so there is nothing to resume.
pub fn provider_session_exists(agent_id: &str, id: &str) -> bool {
    if !crate::agents::valid_session_id(id) {
        return false;
    }
    match agent_id {
        "claude-code" | "claude-chat" => claude_projects_dir()
            .and_then(|root| fs::read_dir(root).ok())
            .map(|dirs| dirs.flatten().any(|d| d.path().join(format!("{id}.jsonl")).is_file()))
            .unwrap_or(false),
        "codex" => codex_sessions_dir()
            .map(|root| collect_files(&root, Source::Codex).0.iter().any(|(_, _, p)| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.contains(id))))
            .unwrap_or(false),
        // OpenCode keeps sessions behind its own service; ask it rather than read its database.
        "opencode" | "deepseek" => {
            let Some(resolved) = crate::agents::resolve_command("opencode") else { return false };
            let args = ["api".to_string(), "session.get".to_string(), "--param".to_string(), format!("sessionID={id}")];
            crate::run_catalog(&resolved, &args).is_ok_and(|out| out.contains(&format!("\"id\":\"{id}\"")))
        }
        _ => false,
    }
}

fn normalize_path(p: &str) -> String {

    p.replace('\\', "/").trim_end_matches('/').to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ezcli import test {tag} {}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn claude_summary_skips_wrappers_and_finds_folder_and_id() {
        let d = temp_dir("claude");
        let f = d.join("3e3778c6-cc28-42f9-932a-a4d0bfb86253.jsonl");
        fs::write(
            &f,
            concat!(
                "{\"type\":\"queue-operation\",\"cwd\":null}\n",
                "{\"type\":\"user\",\"cwd\":\"F:\\\\WORK\\\\cli-gui\",\"sessionId\":\"3e3778c6-cc28-42f9-932a-a4d0bfb86253\",\"isMeta\":true,\"message\":{\"role\":\"user\",\"content\":\"<local-command-caveat>x</local-command-caveat>\"}}\n",
                "{\"type\":\"user\",\"cwd\":\"F:\\\\WORK\\\\cli-gui\",\"sessionId\":\"3e3778c6-cc28-42f9-932a-a4d0bfb86253\",\"message\":{\"role\":\"user\",\"content\":\"  Fix the   login bug \"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"On it.\"}]}}\n"
            ),
        )
        .unwrap();
        let Some(Summary::Chat(s)) = summarize(&f, Source::Claude, 5, 100) else { panic!("expected a chat") };
        assert_eq!(s.title, "Fix the login bug");
        assert_eq!(s.cwd, "F:\\WORK\\cli-gui");
        assert_eq!(s.project, "cli-gui");
        assert_eq!(s.session_id, "3e3778c6-cc28-42f9-932a-a4d0bfb86253");
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn tool_generated_sessions_are_hidden_not_listed() {
        let d = temp_dir("auto");
        let f = d.join("x.jsonl");
        fs::write(&f, "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"Condense the tool payload below to under 12800 characters.\"}}\n").unwrap();
        assert!(matches!(summarize(&f, Source::Claude, 1, 1), Some(Summary::Automatic)));
        assert!(is_automatic_dir("c--users-aryan--claude-mem-observer-sessions"));
        assert!(!is_automatic_dir("f--work"));
        // A file with no user text at all is skipped entirely.
        fs::write(&f, "{\"type\":\"queue-operation\"}\n").unwrap();
        assert!(summarize(&f, Source::Claude, 1, 1).is_none());
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn codex_rollout_gives_session_id_folder_and_messages() {
        let d = temp_dir("codex");
        let f = d.join("rollout-2026-10-16T14-46-35-01a143ff-baf5-7153-a8c9-feca4cba07b8.jsonl");
        fs::write(
            &f,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"01a143ff-baf5-7153-a8c9-feca4cba07b8\",\"cwd\":\"F:\\\\WORK\\\\cli-gui\",\"thread_source\":\"user\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"developer\",\"content\":[{\"type\":\"input_text\",\"text\":\"rules\"}]}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"<environment_context>cwd</environment_context>\"}]}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"Add a dark mode toggle\"}]}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"Done.\"}]}}\n"
            ),
        )
        .unwrap();
        let Some(Summary::Chat(s)) = summarize(&f, Source::Codex, 9, 10) else { panic!("expected a chat") };
        assert_eq!(s.title, "Add a dark mode toggle");
        assert_eq!(s.session_id, "01a143ff-baf5-7153-a8c9-feca4cba07b8");
        assert_eq!(s.project, "cli-gui");
        let entry = ImportEntry { path: f.clone(), source: Source::Codex, summary: s };
        let chat = read(&entry).unwrap();
        // The developer prompt and the environment dump are not part of the chat.
        assert_eq!(chat.messages.iter().map(|m| m.role.as_str()).collect::<Vec<_>>(), vec!["user", "assistant"]);
        assert_eq!(chat.total_messages, 2);
        assert!(!chat.truncated);
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn opening_a_long_chat_keeps_the_newest_messages() {
        let d = temp_dir("long");
        let f = d.join("a.jsonl");
        let mut body = String::new();
        for i in 0..(KEEP_MESSAGES + 25) {
            body.push_str(&format!("{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"message number {i}\"}}}}\n"));
        }
        fs::write(&f, body).unwrap();
        let Some(Summary::Chat(s)) = summarize(&f, Source::Claude, 1, 1) else { panic!("expected a chat") };
        let chat = read(&ImportEntry { path: f, source: Source::Claude, summary: s }).unwrap();
        assert_eq!(chat.messages.len(), KEEP_MESSAGES);
        assert_eq!(chat.total_messages, KEEP_MESSAGES + 25);
        assert!(chat.truncated);
        assert_eq!(chat.messages.last().unwrap().content, format!("message number {}", KEEP_MESSAGES + 24));
        let _ = fs::remove_dir_all(d);
    }

    /// Opt-in check against the developer's real stores:
    /// `scripts\test-rust.ps1 --ignored --nocapture real_stores`.
    #[test]
    #[ignore = "reads the real ~/.claude and ~/.codex stores"]
    fn real_stores_list_real_chats_and_hide_automatic_ones() {
        let d = discover().unwrap();
        eprintln!("{} chats, {} hidden automatic", d.catalog.conversations.len(), d.catalog.hidden_automatic);
        for c in d.catalog.conversations.iter().take(8) {
            eprintln!("{:>11} | {:<18} | {} | {}", c.source, c.project, c.session_id, c.title);
        }
        assert!(!d.catalog.conversations.iter().any(|c| c.title.starts_with("Condense the tool payload")));
    }
}
