//! Read-only local transcript discovery and normalization.
//!
//! Import is deliberately conservative: a file must contain recognizable
//! Claude Code user/assistant records before it appears in the picker. Invalid
//! JSONL records, tool payloads, and unrelated files are ignored rather than
//! being guessed into a conversation.

use anyhow::Result;
use serde::Serialize;
use serde_json::Value;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

const MAX_DISCOVERED_FILES: usize = 600;
const MAX_CONVERSATIONS: usize = 150;
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_RECORDS_PER_FILE: usize = 4_000;
const MAX_RECORD_BYTES: usize = 512 * 1024;
const MAX_MESSAGES_PER_CHAT: usize = 400;
const MAX_MESSAGE_CHARS: usize = 32_000;
const TITLE_CHARS: usize = 96;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportSource {
    pub id: String,
    pub label: String,
    pub available: bool,
    pub detail: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub id: String,
    pub source: String,
    pub title: String,
    pub project: String,
    pub updated_at: u64,
    pub message_count: usize,
    pub truncated: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportCatalog {
    pub sources: Vec<ImportSource>,
    pub conversations: Vec<ImportSummary>,
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
    pub updated_at: u64,
    pub messages: Vec<ImportMessage>,
    pub truncated: bool,
}

impl ImportConversation {
    fn summary(&self) -> ImportSummary {
        ImportSummary {
            id: self.id.clone(),
            source: self.source.clone(),
            title: self.title.clone(),
            project: self.project.clone(),
            updated_at: self.updated_at,
            message_count: self.messages.len(),
            truncated: self.truncated,
        }
    }
}

/// In-memory cache populated by `list_imports`. The webview receives opaque
/// ids rather than source file paths, so it cannot ask the import endpoint to
/// read an arbitrary local file.
#[derive(Default)]
pub struct ImportStore {
    conversations: Mutex<HashMap<String, ImportConversation>>,
}

impl ImportStore {
    pub fn replace(&self, conversations: Vec<ImportConversation>) {
        let next = conversations
            .into_iter()
            .map(|conversation| (conversation.id.clone(), conversation))
            .collect();
        *self.conversations.lock().unwrap() = next;
    }

    pub fn get(&self, id: &str) -> Option<ImportConversation> {
        self.conversations.lock().unwrap().get(id).cloned()
    }
}

pub struct Discovery {
    pub catalog: ImportCatalog,
    pub conversations: Vec<ImportConversation>,
}

/// Discover only the one source whose on-disk format this project has verified:
/// Claude Code's `~/.claude/projects/**/*.jsonl`. Other products are shown as
/// unavailable until their local stores can be verified without guesswork.
pub fn discover() -> Result<Discovery> {
    let root = claude_projects_dir();
    let Some(root) = root else {
        return Ok(empty_discovery(false, "Claude Code store was not found."));
    };
    if !root.is_dir() {
        return Ok(empty_discovery(false, "Claude Code store was not found."));
    }

    let (files, scan_truncated) = collect_jsonl_files(&root)?;
    let mut conversations = Vec::new();
    let mut parse_truncated = false;

    for file in files {
        if conversations.len() >= MAX_CONVERSATIONS {
            parse_truncated = true;
            break;
        }
        match parse_claude_file(&file) {
            Ok(Some(conversation)) => {
                parse_truncated |= conversation.truncated;
                conversations.push(conversation);
            }
            Ok(None) => {}
            // A source transcript must never make every other import unusable.
            Err(_) => {}
        }
    }
    conversations.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    let catalog = ImportCatalog {
        sources: source_statuses(true, format!("Scans local Claude Code transcripts in {}.", root.display())),
        conversations: conversations.iter().map(ImportConversation::summary).collect(),
        truncated: scan_truncated || parse_truncated,
    };
    Ok(Discovery {
        catalog,
        conversations,
    })
}

fn empty_discovery(available: bool, detail: &str) -> Discovery {
    Discovery {
        catalog: ImportCatalog {
            sources: source_statuses(available, detail.to_string()),
            conversations: Vec::new(),
            truncated: false,
        },
        conversations: Vec::new(),
    }
}

fn source_statuses(claude_available: bool, claude_detail: String) -> Vec<ImportSource> {
    vec![
        ImportSource {
            id: "claude-code".into(),
            label: "Claude Code".into(),
            available: claude_available,
            detail: claude_detail,
        },
        ImportSource {
            id: "claude-desktop".into(),
            label: "Claude Desktop".into(),
            available: false,
            detail: "Unavailable until its local store format is verified.".into(),
        },
        ImportSource {
            id: "chatgpt-desktop".into(),
            label: "ChatGPT desktop".into(),
            available: false,
            detail: "Unavailable until its local store format is verified.".into(),
        },
        ImportSource {
            id: "codex".into(),
            label: "Codex".into(),
            available: false,
            detail: "Unavailable until its local store format is verified.".into(),
        },
    ]
}

fn claude_projects_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".claude").join("projects"))
}

/// Walk the whole store collecting (mtime, path) for every eligible transcript,
/// then keep the newest `MAX_DISCOVERED_FILES`. Capping during the walk would
/// keep an arbitrary subset in directory order and could drop the user's most
/// recent chats once the store grows past the cap (real stores reach thousands).
fn collect_jsonl_files(root: &Path) -> Result<(Vec<PathBuf>, bool)> {
    let mut stack = vec![root.to_path_buf()];
    let mut found: Vec<(u64, PathBuf)> = Vec::new();

    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let kind = match entry.file_type() {
                Ok(kind) => kind,
                Err(_) => continue,
            };
            if kind.is_dir() {
                stack.push(entry.path());
                continue;
            }
            if !kind.is_file() || entry.path().extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if meta.len() > MAX_FILE_BYTES {
                continue;
            }
            let mtime = meta
                .modified()
                .ok()
                .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or(0);
            found.push((mtime, entry.path()));
        }
    }

    found.sort_by(|a, b| b.0.cmp(&a.0));
    let truncated = found.len() > MAX_DISCOVERED_FILES;
    found.truncate(MAX_DISCOVERED_FILES);
    Ok((found.into_iter().map(|(_, path)| path).collect(), truncated))
}

fn parse_claude_file(path: &Path) -> Result<Option<ImportConversation>> {
    let metadata = fs::metadata(path)?;
    if metadata.len() > MAX_FILE_BYTES {
        return Ok(None);
    }
    let updated_at = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let project = path
        .parent()
        .and_then(|parent| parent.file_name())
        .and_then(|name| name.to_str())
        .unwrap_or("Unknown project")
        .to_string();
    let id = opaque_id(path);
    let file = fs::File::open(path)?;
    parse_claude_reader(BufReader::new(file), id, project, updated_at)
}

fn parse_claude_reader<R: BufRead>(
    reader: R,
    id: String,
    project: String,
    updated_at: u64,
) -> Result<Option<ImportConversation>> {
    let mut messages = Vec::new();
    let mut truncated = false;

    for (index, line) in reader.lines().enumerate() {
        if index >= MAX_RECORDS_PER_FILE {
            truncated = true;
            break;
        }
        let line = line?;
        if line.len() > MAX_RECORD_BYTES {
            truncated = true;
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(message) = claude_message(&record) else {
            continue;
        };
        messages.push(message);
        if messages.len() >= MAX_MESSAGES_PER_CHAT {
            truncated = true;
            break;
        }
    }

    if messages.is_empty() {
        return Ok(None);
    }
    let title = messages
        .iter()
        .find(|message| message.role == "user")
        .map(|message| title_from(&message.content))
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| "Claude Code conversation".into());
    Ok(Some(ImportConversation {
        id,
        source: "claude-code".into(),
        title,
        project,
        updated_at,
        messages,
        truncated,
    }))
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
        timestamp: record
            .get("timestamp")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
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

fn opaque_id(path: &Path) -> String {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    format!("claude-code-{:016x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_user_and_assistant_text_only() {
        let input = br#"{"type":"queue-operation","content":"not a chat"}
{"type":"user","timestamp":"2026-10-15T10:00:00Z","message":{"role":"user","content":"  Plan   this  import  "}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"First answer"},{"type":"tool_use","name":"shell"},{"type":"text","text":"Second answer"}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"shell"}]}}
"#;
        let conversation = parse_claude_reader(&input[..], "test-id".into(), "Project".into(), 42)
            .unwrap()
            .unwrap();

        assert_eq!(conversation.title, "Plan this import");
        assert_eq!(conversation.messages.len(), 2);
        assert_eq!(conversation.messages[0].role, "user");
        assert_eq!(conversation.messages[1].content, "First answer\n\nSecond answer");
    }

    #[test]
    fn rejects_malformed_or_non_conversation_records() {
        let input = b"not json\n{\"type\":\"queue-operation\"}\n";
        assert!(parse_claude_reader(&input[..], "test-id".into(), "Project".into(), 0)
            .unwrap()
            .is_none());
    }
}
