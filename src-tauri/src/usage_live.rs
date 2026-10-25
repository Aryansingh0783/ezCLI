//! Real usage numbers for a session, read from files the CLIs already keep.
//!
//! Claude Code writes every message's token usage into its session file
//! (`~/.claude/projects/<folder>/<session-id>.jsonl`), so context size and
//! session totals are exact. Codex writes `token_count` events into its rollout
//! file with totals, the context window and plan limits (percent used and when
//! they reset). ezCLI only reads these files; it never reads credentials and
//! makes no network request.

use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Limit {
    pub label: String,
    pub used_percent: f64,
    /// Unix seconds.
    pub resets_at: Option<u64>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct LiveUsage {
    pub source: String,
    pub model: String,
    /// Tokens currently in the conversation's context.
    pub context_tokens: u64,
    pub context_window: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_tokens: u64,
    pub turns: u64,
    pub limits: Vec<Limit>,
    pub credits: Option<String>,
    pub plan: Option<String>,
    /// Money spent in this session, when the CLI records it.
    pub cost: Option<f64>,
}

/* ------------------------------------------------------------ Claude Code */

#[derive(Default)]
struct ClaudeAcc {
    offset: u64,
    /// message id -> (input, output, cache read, cache create). A message is
    /// written more than once while it streams; the last write wins.
    by_message: HashMap<String, [u64; 4]>,
    context: u64,
    model: String,
    turns: HashSet<String>,
}

static CLAUDE: Mutex<Option<HashMap<PathBuf, ClaudeAcc>>> = Mutex::new(None);

pub(crate) fn claude_file(session_id: &str) -> Option<PathBuf> {
    let root = dirs::home_dir()?.join(".claude").join("projects");
    for entry in fs::read_dir(root).ok()?.flatten() {
        let p = entry.path().join(format!("{session_id}.jsonl"));
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn ingest_claude_line(acc: &mut ClaudeAcc, line: &str) {
    let Ok(v) = serde_json::from_str::<Value>(line) else { return };
    let Some(msg) = v.get("message") else { return };
    let Some(u) = msg.get("usage") else { return };
    if msg.get("role").and_then(Value::as_str) != Some("assistant") {
        return;
    }
    let n = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
    let tokens = [n("input_tokens"), n("output_tokens"), n("cache_read_input_tokens"), n("cache_creation_input_tokens")];
    let id = msg
        .get("id")
        .and_then(Value::as_str)
        .or_else(|| v.get("uuid").and_then(Value::as_str))
        .unwrap_or("")
        .to_string();
    if id.is_empty() {
        return;
    }
    acc.context = tokens[0] + tokens[2] + tokens[3];
    if let Some(m) = msg.get("model").and_then(Value::as_str).filter(|m| !m.starts_with('<')) {
        acc.model = m.to_string();
    }
    if let Some(r) = v.get("requestId").and_then(Value::as_str) {
        acc.turns.insert(r.to_string());
    }
    acc.by_message.insert(id, tokens);
}

fn claude_usage(session_id: &str) -> Option<LiveUsage> {
    let path = claude_file(session_id)?;
    let len = fs::metadata(&path).ok()?.len();
    let mut guard = CLAUDE.lock().ok()?;
    let acc = guard.get_or_insert_with(HashMap::new).entry(path.clone()).or_default();
    if len < acc.offset {
        *acc = ClaudeAcc::default(); // the file was replaced
    }
    if len > acc.offset {
        let mut f = fs::File::open(&path).ok()?;
        f.seek(SeekFrom::Start(acc.offset)).ok()?;
        let mut buf = Vec::new();
        f.take(len - acc.offset).read_to_end(&mut buf).ok()?;
        // Only whole lines: a record still being written stays for next time.
        let end = buf.iter().rposition(|&b| b == b'\n').map(|i| i + 1).unwrap_or(0);
        for line in String::from_utf8_lossy(&buf[..end]).lines() {
            ingest_claude_line(acc, line);
        }
        acc.offset += end as u64;
    }
    if acc.by_message.is_empty() {
        return None;
    }
    let sum = |i: usize| acc.by_message.values().map(|t| t[i]).sum::<u64>();
    let window = if acc.model.contains("[1m]") || acc.context > 200_000 { 1_000_000 } else { 200_000 };
    Some(LiveUsage {
        source: "claude-code".into(),
        model: acc.model.clone(),
        context_tokens: acc.context,
        context_window: window,
        input_tokens: sum(0) + sum(3),
        output_tokens: sum(1),
        cached_tokens: sum(2),
        turns: acc.turns.len().max(acc.by_message.len().min(1)) as u64,
        ..Default::default()
    })
}

/* ------------------------------------------------------------ OpenCode */

/// OpenCode keeps sessions in its own database and exposes them through
/// `opencode session list` and `opencode export <id>`. Run those, never read the
/// database directly.
fn opencode_run(args: &[&str]) -> Option<String> {
    opencode_run_in(args, None)
}

/// `session list` shows only the folder it runs in, so the lookup must run in the project.
fn opencode_run_in(args: &[&str], dir: Option<&Path>) -> Option<String> {
    let resolved = crate::agents::resolve_command("opencode")?;
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    crate::run_catalog_in(&resolved, &args, dir).ok()
}

/// The newest OpenCode session in `cwd` created after `since_ms`.
pub fn find_opencode_session(cwd: &str, since_ms: u64) -> Option<String> {
    let dir = Some(Path::new(cwd));
    // OpenCode 2: the same `api` route the chat feed reads through.
    if let Some(out) = opencode_run_in(&["api", "session.list"], dir) {
        if let Some(id) = pick_opencode2_session(&out, cwd, since_ms) {
            return Some(id);
        }
    }
    let out = opencode_run_in(&["session", "list", "--format", "json", "-n", "25"], dir)?;
    pick_opencode_session(&out, cwd, since_ms)
}

/// `api session.list` prints `{ data: [{ id, time: { created, updated }, location: { directory } }] }`.
fn pick_opencode2_session(json: &str, cwd: &str, since_ms: u64) -> Option<String> {
    let v: Value = serde_json::from_str(&json[json.find('{')?..]).ok()?;
    let want = cwd.replace('\\', "/").trim_end_matches('/').to_ascii_lowercase();
    v.get("data")?
        .as_array()?
        .iter()
        .filter(|s| {
            s.pointer("/location/directory")
                .and_then(Value::as_str)
                .is_some_and(|d| d.replace('\\', "/").trim_end_matches('/').to_ascii_lowercase() == want)
        })
        .filter(|s| {
            let t = |k: &str| s.pointer(k).and_then(Value::as_u64).unwrap_or(0);
            t("/time/updated") + 5_000 >= since_ms || t("/time/created") + 5_000 >= since_ms
        })
        .max_by_key(|s| s.pointer("/time/updated").and_then(Value::as_u64).unwrap_or(0))
        .and_then(|s| s.get("id").and_then(Value::as_str))
        .map(str::to_string)
}

/// The first JSON array in `text`, skipping any status line OpenCode prints before it (and
/// ignoring anything after it).
fn first_json_array(text: &str) -> Option<Vec<Value>> {
    for (i, _) in text.match_indices('[') {
        let mut stream = serde_json::Deserializer::from_str(&text[i..]).into_iter::<Value>();
        if let Some(Ok(Value::Array(a))) = stream.next() {
            return Some(a);
        }
    }
    None
}

fn pick_opencode_session(json: &str, cwd: &str, since_ms: u64) -> Option<String> {
    let list = first_json_array(json)?;
    let want = cwd.replace('\\', "/").trim_end_matches('/').to_ascii_lowercase();
    list.iter()
        .filter(|s| s.get("directory").and_then(Value::as_str).is_some_and(|d| d.replace('\\', "/").trim_end_matches('/').to_ascii_lowercase() == want))
        // Created or touched since this tab opened: a continued session was created days ago
        // but is written to as soon as the tab sends a message.
        .filter(|s| s.get("updated").and_then(Value::as_u64).unwrap_or(0) + 5_000 >= since_ms || s.get("created").and_then(Value::as_u64).unwrap_or(0) + 5_000 >= since_ms)
        .max_by_key(|s| s.get("updated").and_then(Value::as_u64).unwrap_or(0))
        .and_then(|s| s.get("id").and_then(Value::as_str))
        .map(str::to_string)
}

fn opencode_from_export(text: &str) -> Option<LiveUsage> {
    let v: Value = serde_json::from_str(&text[text.find('{')?..]).ok()?;
    let mut u = LiveUsage { source: "opencode".into(), ..Default::default() };
    let mut cost = 0.0;
    for m in v.get("messages")?.as_array()? {
        let info = m.get("info")?;
        if info.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(t) = info.get("tokens") else { continue };
        let n = |p: &str| t.pointer(p).and_then(Value::as_u64).unwrap_or(0);
        u.input_tokens += n("/input");
        u.output_tokens += n("/output") + n("/reasoning");
        u.cached_tokens += n("/cache/read");
        u.context_tokens = n("/input") + n("/cache/read") + n("/cache/write");
        u.turns += 1;
        cost += info.get("cost").and_then(Value::as_f64).unwrap_or(0.0);
        if let Some(model) = info.get("modelID").and_then(Value::as_str) {
            u.model = model.to_string();
        }
    }
    u.cost = Some(cost);
    (u.turns > 0).then_some(u)
}

fn opencode_usage(session_id: &str) -> Option<LiveUsage> {
    if !session_id.starts_with("ses_") {
        return None;
    }
    opencode_from_export(&opencode_run(&["export", session_id])?)
}

/* ------------------------------------------------------------ Codex */

fn limit_label(minutes: u64) -> String {
    match minutes {
        300 => "5-hour".into(),
        10_080 => "Weekly".into(),
        m if m >= 40_000 => "Monthly".into(),
        m if m % 1440 == 0 => format!("{}-day", m / 1440),
        m if m % 60 == 0 => format!("{}-hour", m / 60),
        m => format!("{m}-min"),
    }
}

/// Read the newest usage out of the tail of a Codex rollout file.
fn codex_from_text(tail: &str) -> Option<LiveUsage> {
    let mut usage: Option<LiveUsage> = None;
    let mut limits_done = false;
    for line in tail.lines().rev() {
        if !line.contains("token_count") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let Some(p) = v.get("payload").filter(|p| p.get("type").and_then(Value::as_str) == Some("token_count")) else { continue };
        let u = usage.get_or_insert_with(|| LiveUsage { source: "codex".into(), ..Default::default() });
        if let Some(info) = p.get("info").filter(|i| !i.is_null()) {
            if u.context_window == 0 {
                let total = info.get("total_token_usage");
                let last = info.get("last_token_usage");
                let n = |o: Option<&Value>, k: &str| o.and_then(|x| x.get(k)).and_then(Value::as_u64).unwrap_or(0);
                u.input_tokens = n(total, "input_tokens");
                u.output_tokens = n(total, "output_tokens");
                u.cached_tokens = n(total, "cached_input_tokens");
                u.context_tokens = n(last, "input_tokens");
                u.context_window = info.get("model_context_window").and_then(Value::as_u64).unwrap_or(0);
            }
        }
        if !limits_done {
            if let Some(r) = p.get("rate_limits").filter(|r| !r.is_null()) {
                for key in ["primary", "secondary"] {
                    if let Some(l) = r.get(key).filter(|l| !l.is_null()) {
                        u.limits.push(Limit {
                            label: limit_label(l.get("window_minutes").and_then(Value::as_u64).unwrap_or(0)),
                            used_percent: l.get("used_percent").and_then(Value::as_f64).unwrap_or(0.0),
                            resets_at: l.get("resets_at").and_then(Value::as_u64),
                        });
                    }
                }
                u.plan = r.get("plan_type").and_then(Value::as_str).map(str::to_string);
                u.credits = r
                    .pointer("/credits/balance")
                    .and_then(Value::as_str)
                    .filter(|_| r.pointer("/credits/has_credits").and_then(Value::as_bool).unwrap_or(false))
                    .map(str::to_string);
                limits_done = true;
            }
        }
        if u.context_window > 0 && limits_done {
            break;
        }
    }
    usage.filter(|u| u.context_window > 0 || !u.limits.is_empty())
}

fn read_tail(path: &Path, bytes: u64) -> Option<String> {
    let mut f = fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(bytes))).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

fn codex_usage(session_id: &str) -> Option<LiveUsage> {
    let path = crate::import::find_codex_file(session_id)?;
    // A token_count event is written every turn; a few MB always holds the latest.
    codex_from_text(&read_tail(&path, 4 * 1024 * 1024)?)
}

/// Real usage for a live session, when its CLI keeps it where ezCLI can read it.
pub fn read(agent_id: &str, session_id: &str) -> Option<LiveUsage> {
    // These ids reach a command line (a .cmd shim runs through cmd.exe), so
    // accept only the exact shapes: ses_<letters/digits> or a UUID.
    let ok = match session_id.strip_prefix("ses_") {
        Some(rest) => (8..=40).contains(&rest.len()) && rest.chars().all(|c| c.is_ascii_alphanumeric()),
        None => crate::agents::valid_session_id(session_id),
    };
    if !ok {
        return None;
    }
    match agent_id {
        "claude-code" | "claude-chat" => claude_usage(session_id),
        "codex" => codex_usage(session_id),
        "opencode" | "deepseek" => opencode_usage(session_id),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_totals_use_the_last_write_of_each_message_and_the_latest_context() {
        let mut acc = ClaudeAcc::default();
        for line in [
            r#"{"requestId":"r1","message":{"id":"m1","role":"assistant","model":"claude-opus-4-7","usage":{"input_tokens":5,"output_tokens":10,"cache_read_input_tokens":1000,"cache_creation_input_tokens":200}}}"#,
            // The same message again, finished: replaces the partial one.
            r#"{"requestId":"r1","message":{"id":"m1","role":"assistant","model":"claude-opus-4-7","usage":{"input_tokens":5,"output_tokens":50,"cache_read_input_tokens":1000,"cache_creation_input_tokens":200}}}"#,
            r#"{"requestId":"r2","message":{"id":"m2","role":"assistant","model":"claude-opus-4-7","usage":{"input_tokens":7,"output_tokens":20,"cache_read_input_tokens":1500,"cache_creation_input_tokens":0}}}"#,
            r#"{"message":{"id":"u1","role":"user","content":"hi"}}"#,
            "not json",
        ] {
            ingest_claude_line(&mut acc, line);
        }
        let out: u64 = acc.by_message.values().map(|t| t[1]).sum();
        assert_eq!(out, 70);
        assert_eq!(acc.context, 7 + 1500);
        assert_eq!(acc.turns.len(), 2);
        assert_eq!(acc.model, "claude-opus-4-7");
    }

    #[test]
    fn codex_tail_gives_context_totals_and_plan_limits() {
        let tail = concat!(
            "{\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":100,\"cached_input_tokens\":60,\"output_tokens\":9},\"last_token_usage\":{\"input_tokens\":40},\"model_context_window\":258400},\"rate_limits\":{\"primary\":{\"used_percent\":12.5,\"window_minutes\":300,\"resets_at\":1794552102},\"secondary\":{\"used_percent\":3.0,\"window_minutes\":10080,\"resets_at\":1795000000},\"plan_type\":\"plus\",\"credits\":{\"has_credits\":true,\"balance\":\"12.5\"}}}}\n",
            "{\"payload\":{\"type\":\"token_count\",\"info\":null,\"rate_limits\":{\"primary\":{\"used_percent\":99.0,\"window_minutes\":300}}}}\n"
        );
        // The newest line is the null-info one: limits come from it, totals from the earlier one.
        let u = codex_from_text(tail).unwrap();
        assert_eq!((u.input_tokens, u.output_tokens, u.cached_tokens, u.context_tokens, u.context_window), (100, 9, 60, 40, 258400));
        assert_eq!(u.limits.len(), 1);
        assert_eq!(u.limits[0].label, "5-hour");
        assert!((u.limits[0].used_percent - 99.0).abs() < 0.01);
        assert!(codex_from_text("nothing here").is_none());
    }

    #[test]
    fn opencode_export_sums_tokens_and_cost_and_session_pick_matches_the_folder() {
        let export = "Exporting session: ses_x\n{\"info\":{},\"messages\":[{\"info\":{\"role\":\"user\"}},{\"info\":{\"role\":\"assistant\",\"modelID\":\"big-pickle\",\"cost\":0.01,\"tokens\":{\"input\":100,\"output\":10,\"reasoning\":5,\"cache\":{\"read\":50,\"write\":0}}}},{\"info\":{\"role\":\"assistant\",\"cost\":0.02,\"tokens\":{\"input\":120,\"output\":20,\"reasoning\":0,\"cache\":{\"read\":150,\"write\":10}}}}]}";
        let u = opencode_from_export(export).unwrap();
        assert_eq!((u.input_tokens, u.output_tokens, u.cached_tokens, u.turns), (220, 35, 200, 2));
        assert_eq!(u.context_tokens, 120 + 150 + 10);
        assert!((u.cost.unwrap() - 0.03).abs() < 1e-9);
        let list = "[{\"id\":\"ses_old\",\"created\":100,\"updated\":500,\"directory\":\"F:\\\\WORK\\\\a\"},{\"id\":\"ses_new\",\"created\":9000,\"updated\":9500,\"directory\":\"f:/work/a/\"},{\"id\":\"ses_other\",\"created\":9100,\"updated\":9900,\"directory\":\"F:\\\\WORK\\\\b\"}]";
        assert_eq!(pick_opencode_session(list, "F:\\WORK\\a", 8000).as_deref(), Some("ses_new"));
        assert_eq!(pick_opencode_session(list, "F:\\WORK\\a", 20000), None);
    }

    #[test]
    fn limit_labels_read_naturally() {
        assert_eq!(limit_label(300), "5-hour");
        assert_eq!(limit_label(10_080), "Weekly");
        assert_eq!(limit_label(43_200), "Monthly");
        assert_eq!(limit_label(1440), "1-day");
        assert_eq!(limit_label(90), "90-min");
    }

    /// Opt-in: reads the newest real Claude Code and Codex sessions.
    /// `scripts\test-rust.ps1 --ignored --nocapture real_usage`
    #[test]
    #[ignore = "reads real ~/.claude and ~/.codex files"]
    fn real_usage_reads_a_claude_and_a_codex_session() {
        let d = crate::import::discover().unwrap();
        for c in d.catalog.conversations.iter().take(6) {
            let agent = if c.source == "codex" { "codex" } else { "claude-code" };
            eprintln!("{agent} {} -> {:?}", c.session_id, read(agent, &c.session_id).map(|u| (u.context_tokens, u.context_window, u.output_tokens, u.limits.len())));
        }
    }
}

#[cfg(test)]
mod session_pick_tests {
    use super::*;

    #[test]
    fn opencode2_session_list_picks_the_project_session() {
        let out = r#"{"data":[
            {"id":"ses_other0001","time":{"created":1,"updated":9},"location":{"directory":"G:\\Other"}},
            {"id":"ses_mine00001","time":{"created":5,"updated":10},"location":{"directory":"G:\\Unity Game Project"}}],"cursor":{}}"#;
        let dir = r"G:\Unity Game Project";
        assert_eq!(pick_opencode2_session(out, dir, 0).as_deref(), Some("ses_mine00001"));
        assert_eq!(pick_opencode2_session(out, dir, 8).as_deref(), Some("ses_mine00001"));
        assert_eq!(pick_opencode2_session(out, dir, 99_999), None);
    }

    #[test]
    fn a_status_line_before_the_json_does_not_hide_the_session() {
        let out = r#"[service] started in 0.2s
[
  {"id":"ses_abc12345","updated":10,"created":5,"directory":"G:\\Unity Game Project"}
]
"#;
        let dir = r"G:\Unity Game Project";
        let parsed = first_json_array(out);
        assert_eq!(parsed.as_ref().map(Vec::len), Some(1), "array not found in {out:?}");
        assert_eq!(parsed.unwrap()[0].get("directory").and_then(Value::as_str), Some(dir));
        assert_eq!(pick_opencode_session(out, dir, 0).as_deref(), Some("ses_abc12345"));
        // a continued session: created before this tab opened, updated after
        assert_eq!(pick_opencode_session(out, dir, 8).as_deref(), Some("ses_abc12345"));
        assert_eq!(pick_opencode_session(out, r"G:\Other", 0), None);
    }
}
