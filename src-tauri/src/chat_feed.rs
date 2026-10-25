//! A live, readable feed of a session's conversation, for the chat view.
//!
//! Claude Code and Codex already write every turn to a file as they go
//! (`~/.claude/projects/<folder>/<session>.jsonl` and
//! `~/.codex/sessions/**/rollout-*-<session>.jsonl`). This module reads those files
//! incrementally by byte offset and turns each record into a small event: a user
//! message, an assistant message, a tool call or a tool result. ezCLI only reads the
//! files; it never writes to them, never reads credentials and makes no network request.
//! The webview gets text and an offset, never a file path.

use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// The most this reads from the end of a file the first time it is opened.
const FIRST_READ_BYTES: u64 = 6 * 1024 * 1024;
/// The most this reads in one call.
const MAX_READ_BYTES: u64 = 4 * 1024 * 1024;
pub(crate) const MAX_EVENTS: usize = 1500;
pub(crate) const MAX_TEXT_CHARS: usize = 60_000;
pub(crate) const MAX_RESULT_CHARS: usize = 1_200;

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatEvent {
    /// `user`, `assistant`, `tool` or `result`.
    pub kind: String,
    /// A tool call's id, shared by the call and its result.
    pub id: String,
    pub text: String,
    /// The tool's name, for `tool`.
    pub tool: String,
    pub error: bool,
    pub ts: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChatPage {
    pub events: Vec<ChatEvent>,
    /// Pass this back next time to get only what is new.
    pub offset: u64,
    /// The file was replaced or shortened: drop what you have and start again.
    pub reset: bool,
    /// Earlier turns were left out because the file is large.
    pub truncated: bool,
}

pub(crate) fn truncate(mut s: String, limit: usize) -> String {
    if s.chars().count() > limit {
        s = s.chars().take(limit).collect::<String>() + "...";
    }
    s
}

/// Text a CLI wraps around the conversation (environment dumps, command echoes,
/// system reminders) is not something the person said.
fn is_wrapper(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with('<') || t.starts_with("[Request interrupted") || t.starts_with("Caveat:")
}

fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|b| matches!(b.get("type").and_then(Value::as_str), Some("text" | "input_text" | "output_text")))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n\n"),
        _ => String::new(),
    }
}

/// One line that says what a tool call is about to do.
pub(crate) fn tool_summary(input: &Value) -> String {
    const KEYS: [&str; 11] = ["command", "file_path", "path", "paths", "pattern", "url", "query", "description", "prompt", "cmd", "filePath"];
    if let Some(obj) = input.as_object() {
        for k in KEYS {
            match obj.get(k) {
                Some(Value::String(s)) if !s.trim().is_empty() => return truncate(s.trim().replace('\n', " "), 220),
                Some(Value::Array(a)) if !a.is_empty() => {
                    let joined = a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ");
                    if !joined.is_empty() {
                        return truncate(joined, 220);
                    }
                }
                _ => {}
            }
        }
    }
    String::new()
}

fn ts(record: &Value) -> String {
    record.get("timestamp").and_then(Value::as_str).unwrap_or("").to_string()
}

pub fn claude_events(line: &str, out: &mut Vec<ChatEvent>) {
    let Ok(v) = serde_json::from_str::<Value>(line) else { return };
    if v.get("isMeta").and_then(Value::as_bool).unwrap_or(false) || v.get("isSidechain").and_then(Value::as_bool).unwrap_or(false) {
        return;
    }
    let Some(msg) = v.get("message") else { return };
    let role = msg.get("role").and_then(Value::as_str).unwrap_or("");
    let Some(content) = msg.get("content") else { return };
    let when = ts(&v);
    match (role, content) {
        ("user", Value::String(s)) => {
            if !s.trim().is_empty() && !is_wrapper(s) {
                out.push(ChatEvent { kind: "user".into(), text: truncate(s.clone(), MAX_TEXT_CHARS), ts: when, ..Default::default() });
            }
        }
        (_, Value::Array(blocks)) => {
            for b in blocks {
                match (role, b.get("type").and_then(Value::as_str).unwrap_or("")) {
                    ("user", "text") => {
                        let t = b.get("text").and_then(Value::as_str).unwrap_or("");
                        if !t.trim().is_empty() && !is_wrapper(t) {
                            out.push(ChatEvent { kind: "user".into(), text: truncate(t.to_string(), MAX_TEXT_CHARS), ts: when.clone(), ..Default::default() });
                        }
                    }
                    ("user", "tool_result") => {
                        let body = match b.get("content") {
                            Some(c) => text_of(c),
                            None => String::new(),
                        };
                        out.push(ChatEvent {
                            kind: "result".into(),
                            id: b.get("tool_use_id").and_then(Value::as_str).unwrap_or("").into(),
                            text: truncate(body, MAX_RESULT_CHARS),
                            error: b.get("is_error").and_then(Value::as_bool).unwrap_or(false),
                            ts: when.clone(),
                            ..Default::default()
                        });
                    }
                    ("assistant", "text") => {
                        let t = b.get("text").and_then(Value::as_str).unwrap_or("");
                        if !t.trim().is_empty() {
                            out.push(ChatEvent { kind: "assistant".into(), text: truncate(t.to_string(), MAX_TEXT_CHARS), ts: when.clone(), ..Default::default() });
                        }
                    }
                    ("assistant", "tool_use") => {
                        out.push(ChatEvent {
                            kind: "tool".into(),
                            id: b.get("id").and_then(Value::as_str).unwrap_or("").into(),
                            tool: b.get("name").and_then(Value::as_str).unwrap_or("tool").into(),
                            text: tool_summary(b.get("input").unwrap_or(&Value::Null)),
                            ts: when.clone(),
                            ..Default::default()
                        });
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
}

pub fn codex_events(line: &str, out: &mut Vec<ChatEvent>) {
    let Ok(v) = serde_json::from_str::<Value>(line) else { return };
    if v.get("type").and_then(Value::as_str) != Some("response_item") {
        return;
    }
    let Some(p) = v.get("payload") else { return };
    let when = ts(&v);
    match p.get("type").and_then(Value::as_str).unwrap_or("") {
        "message" => {
            let role = match p.get("role").and_then(Value::as_str) {
                Some("user") => "user",
                Some("assistant") => "assistant",
                _ => return,
            };
            let text = text_of(p.get("content").unwrap_or(&Value::Null));
            if text.trim().is_empty() || (role == "user" && is_wrapper(&text)) {
                return;
            }
            out.push(ChatEvent { kind: role.into(), text: truncate(text, MAX_TEXT_CHARS), ts: when, ..Default::default() });
        }
        "function_call" | "custom_tool_call" | "local_shell_call" => {
            let args = p
                .get("arguments")
                .and_then(Value::as_str)
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .or_else(|| p.get("action").cloned())
                .unwrap_or(Value::Null);
            let name = p.get("name").and_then(Value::as_str).unwrap_or("shell");
            out.push(ChatEvent {
                kind: "tool".into(),
                id: p.get("call_id").and_then(Value::as_str).unwrap_or("").into(),
                tool: name.into(),
                text: tool_summary(&args),
                ts: when,
                ..Default::default()
            });
        }
        "function_call_output" | "custom_tool_call_output" => {
            let raw = p.get("output").cloned().unwrap_or(Value::Null);
            // Codex wraps shell output as {"output": "...", "metadata": {...}} in a string.
            let body = match &raw {
                Value::String(s) => serde_json::from_str::<Value>(s)
                    .ok()
                    .and_then(|j| j.get("output").and_then(Value::as_str).map(ToOwned::to_owned))
                    .unwrap_or_else(|| s.clone()),
                other => text_of(other),
            };
            out.push(ChatEvent {
                kind: "result".into(),
                id: p.get("call_id").and_then(Value::as_str).unwrap_or("").into(),
                text: truncate(body, MAX_RESULT_CHARS),
                ts: when,
                ..Default::default()
            });
        }
        _ => {}
    }
}

fn file_for(agent_id: &str, session_id: &str) -> Option<(PathBuf, bool)> {
    match agent_id {
        "claude-code" | "claude-chat" => crate::usage_live::claude_file(session_id).map(|p| (p, false)),
        "codex" => crate::import::find_codex_file(session_id).map(|p| (p, true)),
        _ => None,
    }
}

/// Whether a chat feed exists for this agent at all.
pub fn supported(agent_id: &str) -> bool {
    matches!(agent_id, "claude-code" | "claude-chat" | "codex" | "opencode" | "deepseek" | "freebuff")
}

fn read_from(path: &Path, codex: bool, offset: u64) -> Option<ChatPage> {
    let len = fs::metadata(path).ok()?.len();
    let mut page = ChatPage { offset, ..Default::default() };
    let mut start = offset;
    if len < offset {
        page.reset = true;
        start = 0;
    }
    let first = start == 0;
    if first && len > FIRST_READ_BYTES {
        start = len - FIRST_READ_BYTES;
        page.truncated = true;
    }
    if len <= start {
        page.offset = start.min(len);
        return Some(page);
    }
    let take = (len - start).min(MAX_READ_BYTES);
    let mut f = fs::File::open(path).ok()?;
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    f.take(take).read_to_end(&mut buf).ok()?;
    let mut begin = 0usize;
    if start > 0 && (first || page.reset) {
        // Landed in the middle of a record: skip to the next whole line.
        begin = buf.iter().position(|&b| b == b'\n').map(|i| i + 1).unwrap_or(buf.len());
    }
    // Only whole lines; a record still being written is read next time.
    let end = buf.iter().rposition(|&b| b == b'\n').map(|i| i + 1).unwrap_or(0);
    if end > begin {
        for line in String::from_utf8_lossy(&buf[begin..end]).lines() {
            if page.events.len() >= MAX_EVENTS {
                // Stop on a line boundary and resume here next time.
                break;
            }
            if codex {
                codex_events(line, &mut page.events);
            } else {
                claude_events(line, &mut page.events);
            }
        }
    }
    page.offset = start + end.max(begin) as u64;
    Some(page)
}

/// New events for a session since `offset`.
pub fn read(agent_id: &str, session_id: &str, offset: u64, since_ms: u64) -> Option<ChatPage> {
    match agent_id {
        "freebuff" => crate::chat_sources::freebuff_page(since_ms, offset),
        "opencode" | "deepseek" => crate::chat_sources::opencode_page(session_id, offset),
        _ => {
            // The id reaches the file system, so accept only a UUID.
            if !crate::agents::valid_session_id(session_id) {
                return None;
            }
            let (path, codex) = file_for(agent_id, session_id)?;
            read_from(&path, codex, offset)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_user_text_assistant_text_and_tools_become_events() {
        let mut out = Vec::new();
        claude_events(r#"{"type":"user","timestamp":"t1","message":{"role":"user","content":"Fix the header"}}"#, &mut out);
        claude_events(r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"On it."},{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"git status"}}]}}"#, &mut out);
        claude_events(r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":"clean","is_error":false}]}}"#, &mut out);
        let kinds: Vec<&str> = out.iter().map(|e| e.kind.as_str()).collect();
        assert_eq!(kinds, ["user", "assistant", "tool", "result"]);
        assert_eq!(out[2].tool, "Bash");
        assert_eq!(out[2].text, "git status");
        assert_eq!(out[3].id, "tu1");
        assert_eq!(out[3].text, "clean");
    }

    #[test]
    fn wrappers_meta_and_sidechain_records_are_not_conversation() {
        let mut out = Vec::new();
        claude_events(r#"{"type":"user","message":{"role":"user","content":"<command-name>/clear</command-name>"}}"#, &mut out);
        claude_events(r#"{"isMeta":true,"type":"user","message":{"role":"user","content":"hidden"}}"#, &mut out);
        claude_events(r#"{"isSidechain":true,"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"sub"}]}}"#, &mut out);
        claude_events(r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"}]}}"#, &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn codex_messages_calls_and_outputs_become_events() {
        let mut out = Vec::new();
        codex_events(r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"List files"}]}}"#, &mut out);
        codex_events(r#"{"type":"response_item","payload":{"type":"function_call","name":"shell","call_id":"c1","arguments":"{\"command\":[\"ls\",\"-la\"]}"}}"#, &mut out);
        codex_events(r#"{"type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"{\"output\":\"a\\nb\",\"metadata\":{}}"}}"#, &mut out);
        codex_events(r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Two files."}]}}"#, &mut out);
        let kinds: Vec<&str> = out.iter().map(|e| e.kind.as_str()).collect();
        assert_eq!(kinds, ["user", "tool", "result", "assistant"]);
        assert_eq!(out[1].text, "ls -la");
        assert_eq!(out[2].text, "a\nb");
    }

    #[test]
    fn reading_by_offset_returns_only_whole_new_lines() {
        let dir = std::env::temp_dir().join(format!("ezcli-chat-feed-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.jsonl");
        let a = r#"{"type":"user","message":{"role":"user","content":"one"}}"#;
        let b = r#"{"type":"user","message":{"role":"user","content":"two"}}"#;
        fs::write(&path, format!("{a}\n{}", &b[..20])).unwrap();
        let first = read_from(&path, false, 0).unwrap();
        assert_eq!(first.events.len(), 1);
        assert_eq!(first.offset as usize, a.len() + 1);
        fs::write(&path, format!("{a}\n{b}\n")).unwrap();
        let next = read_from(&path, false, first.offset).unwrap();
        assert_eq!(next.events.len(), 1);
        assert_eq!(next.events[0].text, "two");
        let shorter = read_from(&path, false, 99_999).unwrap();
        assert!(shorter.reset);
        fs::remove_dir_all(&dir).ok();
    }
}
