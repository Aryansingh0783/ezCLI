//! Chat feeds for the agents that do not append to a log file: OpenCode (read through
//! `opencode export`, never its database) and Freebuff (a `chat-messages.json` per chat).
//! Both are rewritten whole, so the offset here is a fingerprint of the last read and a
//! change replaces everything the webview has.

use crate::chat_feed::{edit_detail, tool_summary, truncate, ChatEvent, ChatPage, MAX_EVENTS, MAX_RESULT_CHARS, MAX_TEXT_CHARS};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

fn whole(fingerprint: u64, offset: u64, events: Vec<ChatEvent>) -> ChatPage {
    if fingerprint == offset {
        return ChatPage { offset, ..Default::default() };
    }
    let total = events.len();
    let keep = events.into_iter().skip(total.saturating_sub(MAX_EVENTS)).collect();
    ChatPage { events: keep, offset: fingerprint, reset: true, truncated: total > MAX_EVENTS }
}

/// OpenCode: `opencode export <id>` prints `{ messages: [{ info, parts }] }`.
pub fn opencode_events(json: &str, out: &mut Vec<ChatEvent>) {
    let Some(start) = json.find('{') else { return };
    let Ok(v) = serde_json::from_str::<Value>(&json[start..]) else { return };
    let Some(messages) = v.get("messages").and_then(Value::as_array) else { return };
    for m in messages {
        let role = m.pointer("/info/role").and_then(Value::as_str).unwrap_or("");
        let when = m.pointer("/info/time/created").map(|t| t.to_string()).unwrap_or_default();
        let Some(parts) = m.get("parts").and_then(Value::as_array) else { continue };
        for p in parts {
            match p.get("type").and_then(Value::as_str).unwrap_or("") {
                "text" => {
                    let text = p.get("text").and_then(Value::as_str).unwrap_or("");
                    if text.trim().is_empty() || p.get("synthetic").and_then(Value::as_bool).unwrap_or(false) {
                        continue;
                    }
                    let kind = if role == "user" { "user" } else { "assistant" };
                    out.push(ChatEvent { kind: kind.into(), text: truncate(text.to_string(), MAX_TEXT_CHARS), ts: when.clone(), ..Default::default() });
                }
                "tool" => {
                    let id = p.get("callID").and_then(Value::as_str).or_else(|| p.get("id").and_then(Value::as_str)).unwrap_or("").to_string();
                    let state = p.get("state").unwrap_or(&Value::Null);
                    out.push(ChatEvent {
                        kind: "tool".into(),
                        id: id.clone(),
                        tool: p.get("tool").and_then(Value::as_str).unwrap_or("tool").into(),
                        text: tool_summary(state.get("input").unwrap_or(&Value::Null)),
                        detail: edit_detail(state.get("input").unwrap_or(&Value::Null)),
                        ts: when.clone(),
                        ..Default::default()
                    });
                    let status = state.get("status").and_then(Value::as_str).unwrap_or("");
                    if status == "completed" || status == "error" {
                        let body = state.get("output").and_then(Value::as_str).or_else(|| state.get("error").and_then(Value::as_str)).unwrap_or("");
                        out.push(ChatEvent { kind: "result".into(), id, text: truncate(body.to_string(), MAX_RESULT_CHARS), error: status == "error", ts: when.clone(), ..Default::default() });
                    }
                }
                _ => {}
            }
        }
    }
}

/* OpenCode 2 keeps messages behind `opencode api session.message.list`: newest first, each
 * `{ type: user | assistant | compaction | idle, ... }`. A long session is huge (tool output
 * included), so only the newest few messages are read after the first call and merged into a
 * cache; OpenCode 1 still has `opencode export`, kept as the fallback. */

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;

type MessageCache = HashMap<String, BTreeMap<(u64, String), Vec<ChatEvent>>>;
static OC2: Mutex<Option<MessageCache>> = Mutex::new(None);

fn v2_content_text(c: &Value) -> String {
    match c {
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// The chat events one OpenCode 2 message turns into.
pub fn opencode2_message_events(m: &Value, out: &mut Vec<ChatEvent>) {
    let when = m.pointer("/time/created").map(|t| t.to_string()).unwrap_or_default();
    match m.get("type").and_then(Value::as_str).unwrap_or("") {
        "user" => {
            let text = m.get("text").and_then(Value::as_str).unwrap_or("");
            if !text.trim().is_empty() {
                out.push(ChatEvent { kind: "user".into(), text: truncate(text.to_string(), MAX_TEXT_CHARS), ts: when, ..Default::default() });
            }
        }
        "assistant" => {
            if let Some(blocks) = m.get("content").and_then(Value::as_array) {
                for b in blocks {
                    match b.get("type").and_then(Value::as_str).unwrap_or("") {
                        "text" => {
                            let text = b.get("text").and_then(Value::as_str).unwrap_or("");
                            if !text.trim().is_empty() {
                                out.push(ChatEvent { kind: "assistant".into(), text: truncate(text.to_string(), MAX_TEXT_CHARS), ts: when.clone(), ..Default::default() });
                            }
                        }
                        "tool" => {
                            let id = b.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                            let state = b.get("state").unwrap_or(&Value::Null);
                            let input = state.get("input").unwrap_or(&Value::Null);
                            let mut detail = edit_detail(input);
                            if detail.is_empty() {
                                if let Some(patch) = state.pointer("/metadata/files/0/patch") {
                                    detail = edit_detail(patch);
                                }
                            }
                            out.push(ChatEvent {
                                kind: "tool".into(),
                                id: id.clone(),
                                tool: b.get("name").and_then(Value::as_str).unwrap_or("tool").into(),
                                text: tool_summary(input),
                                detail,
                                ts: when.clone(),
                                ..Default::default()
                            });
                            let status = state.get("status").and_then(Value::as_str).unwrap_or("");
                            if status == "completed" || status == "error" {
                                let body = v2_content_text(state.get("content").unwrap_or(&Value::Null));
                                out.push(ChatEvent { kind: "result".into(), id, text: truncate(body, MAX_RESULT_CHARS), error: status == "error", ts: when.clone(), ..Default::default() });
                            }
                        }
                        // the model's thinking is not the answer
                        _ => {}
                    }
                }
            }
            // A turn that ended in an error says why (for example the free quota is used up).
            if let Some(msg) = m.pointer("/error/message").and_then(Value::as_str) {
                out.push(ChatEvent { kind: "assistant".into(), text: format!("**Stopped:** {msg}"), ts: when, ..Default::default() });
            }
        }
        _ => {}
    }
}

fn opencode2_fetch(session_id: &str, limit: u32, dir: Option<&std::path::Path>) -> Option<Vec<Value>> {
    let resolved = crate::agents::resolve_command("opencode")?;
    let args = vec![
        "api".to_string(),
        "session.message.list".to_string(),
        "--param".to_string(),
        format!("sessionID={session_id}"),
        "--param".to_string(),
        format!("limit={limit}"),
    ];
    let text = crate::run_catalog_in(&resolved, &args, dir).ok()?;
    let v: Value = serde_json::from_str(&text[text.find('{')?..]).ok()?;
    v.get("data").and_then(Value::as_array).cloned()
}

fn opencode2_page(session_id: &str, offset: u64, dir: Option<&std::path::Path>) -> Option<ChatPage> {
    let id_of = |m: &Value| (m.pointer("/time/created").and_then(Value::as_u64).unwrap_or(0), m.get("id").and_then(Value::as_str).unwrap_or("").to_string());
    let known = |ids: &[(u64, String)]| -> (bool, bool) {
        // (cache has this session, any fetched message is already known)
        let guard = OC2.lock().ok();
        let cache = guard.as_ref().and_then(|g| g.as_ref()).and_then(|m| m.get(session_id));
        match cache {
            None => (false, false),
            Some(c) => (true, ids.iter().any(|k| c.contains_key(k))),
        }
    };
    let (had, _) = known(&[]);
    let mut data = opencode2_fetch(session_id, if had { 8 } else { 40 }, dir)?;
    if had {
        let ids: Vec<(u64, String)> = data.iter().map(id_of).collect();
        // Nothing fetched is known yet: more happened than a small page holds, so read a bigger
        // page rather than leave a gap.
        if !known(&ids).1 {
            data = opencode2_fetch(session_id, 40, dir)?;
        }
    }
    {
        let mut guard = OC2.lock().ok()?;
        let cache = guard.get_or_insert_with(HashMap::new).entry(session_id.to_string()).or_default();
        for m in &data {
            let mut ev = Vec::new();
            opencode2_message_events(m, &mut ev);
            cache.insert(id_of(m), ev);
        }
        // keep the cache bounded
        while cache.len() > 400 {
            let k = cache.keys().next().cloned();
            if let Some(k) = k {
                cache.remove(&k);
            }
        }
    }
    let guard = OC2.lock().ok()?;
    let cache = guard.as_ref()?.get(session_id)?;
    let events: Vec<ChatEvent> = cache.values().flatten().cloned().collect();
    let fingerprint = events.iter().fold(events.len() as u64, |h, e| h.wrapping_mul(31).wrapping_add(e.text.len() as u64 + e.kind.len() as u64));
    Some(whole(fingerprint, offset, events))
}

pub fn opencode_page(session_id: &str, offset: u64, cwd: Option<&str>) -> Option<ChatPage> {
    let ok = session_id.strip_prefix("ses_").is_some_and(|r| (8..=40).contains(&r.len()) && r.chars().all(|c| c.is_ascii_alphanumeric()));
    if !ok {
        return None;
    }
    let dir = cwd.map(std::path::Path::new);
    if let Some(page) = opencode2_page(session_id, offset, dir) {
        return Some(page);
    }
    // OpenCode 1: the whole conversation through `opencode export`.
    let resolved = crate::agents::resolve_command("opencode")?;
    let text = crate::run_catalog_in(&resolved, &["export".to_string(), session_id.to_string()], dir).ok()?;
    let mut events = Vec::new();
    opencode_events(&text, &mut events);
    Some(whole(text.len() as u64, offset, events))
}

/// Freebuff: a list of `{ variant: "user" | "ai", content, blocks: [{ type, ... }] }`.
pub fn freebuff_events(json: &str, out: &mut Vec<ChatEvent>) {
    let Ok(v) = serde_json::from_str::<Value>(json) else { return };
    let Some(list) = v.as_array() else { return };
    for m in list {
        match m.get("variant").and_then(Value::as_str).unwrap_or("") {
            "user" => {
                let text = m.get("content").and_then(Value::as_str).unwrap_or("");
                if !text.trim().is_empty() {
                    out.push(ChatEvent { kind: "user".into(), text: truncate(text.to_string(), MAX_TEXT_CHARS), ..Default::default() });
                }
            }
            "ai" => {
                if let Some(blocks) = m.get("blocks").and_then(Value::as_array) {
                    for b in blocks {
                        match b.get("type").and_then(Value::as_str).unwrap_or("") {
                            "text" => {
                                // Freebuff marks the model's thinking as `reasoning`; it is not the answer.
                                if b.get("textType").and_then(Value::as_str) == Some("reasoning") {
                                    continue;
                                }
                                let text = b.get("content").and_then(Value::as_str).unwrap_or("");
                                if !text.trim().is_empty() {
                                    out.push(ChatEvent { kind: "assistant".into(), text: truncate(text.to_string(), MAX_TEXT_CHARS), ..Default::default() });
                                }
                            }
                            "tool" => {
                                let id = b.get("toolCallId").and_then(Value::as_str).unwrap_or("").to_string();
                                out.push(ChatEvent {
                                    kind: "tool".into(),
                                    id: id.clone(),
                                    tool: b.get("toolName").and_then(Value::as_str).unwrap_or("tool").into(),
                                    text: tool_summary(b.get("input").unwrap_or(&Value::Null)),
                                    detail: edit_detail(b.get("input").unwrap_or(&Value::Null)),
                                    ..Default::default()
                                });
                                if let Some(o) = b.get("output").and_then(Value::as_str) {
                                    out.push(ChatEvent { kind: "result".into(), id, text: truncate(o.to_string(), MAX_RESULT_CHARS), ..Default::default() });
                                }
                            }
                            _ => {}
                        }
                    }
                } else if let Some(text) = m.get("content").and_then(Value::as_str).filter(|t| !t.trim().is_empty()) {
                    out.push(ChatEvent { kind: "assistant".into(), text: truncate(text.to_string(), MAX_TEXT_CHARS), ..Default::default() });
                }
            }
            _ => {}
        }
    }
}

/// The newest Freebuff chat written since this session started.
fn freebuff_file(since_ms: u64) -> Option<PathBuf> {
    let root = dirs::home_dir()?.join(".config").join("manicode").join("projects");
    let mut best: Option<(u64, PathBuf)> = None;
    let mut stack = vec![(root, 0u8)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                if depth < 4 {
                    stack.push((p, depth + 1));
                }
            } else if p.file_name().and_then(|n| n.to_str()) == Some("chat-messages.json") {
                let m = fs::metadata(&p)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                if m + 5_000 >= since_ms && best.as_ref().map_or(true, |(b, _)| m > *b) {
                    best = Some((m, p));
                }
            }
        }
    }
    best.map(|(_, p)| p)
}

pub fn freebuff_page(since_ms: u64, offset: u64) -> Option<ChatPage> {
    let path = freebuff_file(since_ms)?;
    if fs::metadata(&path).ok()?.len() > 12 * 1024 * 1024 {
        return None;
    }
    let text = fs::read_to_string(&path).ok()?;
    let mut events = Vec::new();
    freebuff_events(&text, &mut events);
    Some(whole((text.len() as u64) ^ ((events.len() as u64) << 40), offset, events))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opencode_export_parts_become_events() {
        let json = r#"{"info":{},"messages":[{"info":{"role":"user"},"parts":[{"type":"text","text":"hi"}]},{"info":{"role":"assistant"},"parts":[{"type":"tool","callID":"c1","tool":"bash","state":{"status":"completed","input":{"command":"ls"},"output":"a"}},{"type":"text","text":"done"}]}]}"#;
        let mut out = Vec::new();
        opencode_events(json, &mut out);
        let kinds: Vec<&str> = out.iter().map(|e| e.kind.as_str()).collect();
        assert_eq!(kinds, ["user", "tool", "result", "assistant"]);
        assert_eq!(out[1].text, "ls");
        assert_eq!(out[2].text, "a");
    }

    #[test]
    fn freebuff_messages_become_events() {
        let json = r#"[{"variant":"user","content":"review"},{"variant":"ai","content":"","blocks":[{"type":"text","content":"thinking","textType":"reasoning"},{"type":"text","content":"ok","textType":"text"},{"type":"tool","toolCallId":"t1","toolName":"read_files","input":{"paths":["a.rs"]},"output":"fn x"}]}]"#;
        let mut out = Vec::new();
        freebuff_events(json, &mut out);
        let kinds: Vec<&str> = out.iter().map(|e| e.kind.as_str()).collect();
        assert_eq!(kinds, ["user", "assistant", "tool", "result"]);
        assert_eq!(out[2].text, "a.rs");
    }

    #[test]
    fn a_rewritten_source_replaces_everything_only_when_it_changed() {
        let ev = vec![ChatEvent { kind: "user".into(), text: "x".into(), ..Default::default() }];
        assert!(whole(7, 7, ev.clone()).events.is_empty());
        let p = whole(8, 7, ev);
        assert!(p.reset);
        assert_eq!(p.events.len(), 1);
    }

    #[test]
    fn opencode2_messages_become_events() {
        let user: Value = serde_json::from_str(r#"{"id":"m1","type":"user","text":"hi","time":{"created":1}}"#).unwrap();
        let asst: Value = serde_json::from_str(
            r#"{"id":"m2","type":"assistant","time":{"created":2},"content":[
                {"type":"reasoning","text":"thinking"},
                {"type":"tool","id":"t1","name":"edit","state":{"status":"completed","input":{"filePath":"a.cs","oldString":"x","newString":"y"},"content":[{"type":"text","text":"Edited a.cs"}]}},
                {"type":"text","text":"Done."}],
               "error":{"message":"Free usage limit reached."}}"#,
        )
        .unwrap();
        let mut out = Vec::new();
        opencode2_message_events(&user, &mut out);
        opencode2_message_events(&asst, &mut out);
        let kinds: Vec<&str> = out.iter().map(|e| e.kind.as_str()).collect();
        assert_eq!(kinds, ["user", "tool", "result", "assistant", "assistant"]);
        assert_eq!(out[1].detail, "-x\n+y");
        assert_eq!(out[2].text, "Edited a.cs");
        assert!(out[4].text.contains("Free usage limit reached."));
    }
}
