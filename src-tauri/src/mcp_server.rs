//! Loopback MCP server that exposes PC-control tools to a granted CLI session.
//!
//! One listener on `127.0.0.1:<random port>` serves every session. A session is
//! only reachable if the backend registered a token for its PTY id, which it
//! does solely when the user launched that session with PC control on. The
//! token is 128 random bits and is part of the URL (`/mcp/<token>`), so a
//! session cannot address another session's tools.
//!
//! Transport: MCP "streamable HTTP", JSON responses only. No SSE stream is
//! offered (GET returns 405, which the spec allows). Each request is handled on
//! its own short-lived thread and the connection is closed after the response.
//!
//! Every tool call re-checks `allowed(pty_id)` (grant AND live process), so
//! revocation or process exit takes effect on the very next call.

use crate::capture::Capture;
use crate::input::{self, Action, Button};
use anyhow::{anyhow, Result};
use base64::Engine;
use dashmap::DashMap;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_BODY_BYTES: usize = 1024 * 1024;
const PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

/// What the server may ask the app. Tests supply stubs; the app supplies the
/// real consent guard and screen capture.
pub struct Hooks {
    pub allowed: Box<dyn Fn(&str) -> bool + Send + Sync>,
    pub screenshot: Box<dyn Fn() -> Result<Capture> + Send + Sync>,
    /// Inject one keyboard/mouse action on the primary screen.
    pub control: Box<dyn Fn(&Action) -> Result<String> + Send + Sync>,
}

pub struct McpServer {
    port: u16,
    /// token -> PTY id
    tokens: DashMap<String, String>,
    hooks: Hooks,
}

impl McpServer {
    pub fn start(hooks: Hooks) -> Result<Arc<McpServer>> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        let port = listener.local_addr()?.port();
        let server = Arc::new(McpServer {
            port,
            tokens: DashMap::new(),
            hooks,
        });
        let accept = Arc::clone(&server);
        thread::Builder::new()
            .name("ezcli-mcp".into())
            .spawn(move || {
                for stream in listener.incoming().flatten() {
                    let server = Arc::clone(&accept);
                    let _ = thread::Builder::new()
                        .name("ezcli-mcp-conn".into())
                        .spawn(move || server.serve(stream));
                }
            })?;
        Ok(server)
    }

    #[allow(dead_code)]
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Issue a fresh token for a PTY and return the URL its CLI should use.
    pub fn register(&self, pty_id: &str) -> Result<String> {
        self.unregister(pty_id);
        let mut bytes = [0u8; 16];
        getrandom::getrandom(&mut bytes).map_err(|e| anyhow!("no secure randomness: {e}"))?;
        let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        self.tokens.insert(token.clone(), pty_id.to_string());
        Ok(format!("http://127.0.0.1:{}/mcp/{}", self.port, token))
    }

    /// Forget every token that points at this PTY.
    pub fn unregister(&self, pty_id: &str) {
        self.tokens.retain(|_, pty| pty != pty_id);
    }

    fn serve(&self, mut stream: TcpStream) {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
        let response = match read_request(&stream) {
            Ok(req) => self.route(&req),
            Err(_) => http(400, "text/plain", b"bad request".to_vec(), &[]),
        };
        let _ = stream.write_all(&response);
        let _ = stream.flush();
    }

    fn route(&self, req: &Request) -> Vec<u8> {
        // DNS-rebinding defence: only loopback Host headers are accepted.
        let host = req.header("host").unwrap_or("");
        if !(host.starts_with("127.0.0.1:") || host.starts_with("localhost:")) {
            return http(403, "text/plain", b"forbidden".to_vec(), &[]);
        }
        let Some(token) = req.path.strip_prefix("/mcp/") else {
            return http(404, "text/plain", b"not found".to_vec(), &[]);
        };
        let Some(pty_id) = self.tokens.get(token).map(|e| e.value().clone()) else {
            return http(404, "text/plain", b"not found".to_vec(), &[]);
        };
        match req.method.as_str() {
            "POST" => {}
            _ => return http(405, "text/plain", b"method not allowed".to_vec(), &[("Allow", "POST")]),
        }
        let Ok(body) = serde_json::from_slice::<Value>(&req.body) else {
            let err = rpc_error(Value::Null, -32700, "parse error");
            return http(200, "application/json", err.to_string().into_bytes(), &[]);
        };

        let ctx = Ctx { server: self, pty_id: &pty_id };
        let reply = match body {
            Value::Array(batch) => {
                let out: Vec<Value> = batch.iter().filter_map(|m| handle(m, &ctx)).collect();
                (!out.is_empty()).then_some(Value::Array(out))
            }
            single => handle(&single, &ctx),
        };
        match reply {
            Some(v) => http(200, "application/json", v.to_string().into_bytes(), &[]),
            None => http(202, "text/plain", Vec::new(), &[]),
        }
    }
}

struct Ctx<'a> {
    server: &'a McpServer,
    pty_id: &'a str,
}

/// Handle one JSON-RPC message. Returns `None` for notifications.
fn handle(msg: &Value, ctx: &Ctx) -> Option<Value> {
    let method = msg.get("method").and_then(Value::as_str);
    let id = msg.get("id").cloned();
    let Some(method) = method else {
        // A response or garbage from the client; nothing to answer.
        return id.map(|id| rpc_error(id, -32600, "invalid request"));
    };
    let id = id?; // notifications (no id) get no reply

    let result = match method {
        "initialize" => {
            let asked = msg
                .pointer("/params/protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or(PROTOCOL_VERSIONS[0]);
            let version = if PROTOCOL_VERSIONS.contains(&asked) { asked } else { PROTOCOL_VERSIONS[0] };
            json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "ezcli", "version": env!("CARGO_PKG_VERSION") }
            })
        }
        "ping" => json!({}),
        "tools/list" => json!({ "tools": tool_list() }),
        "tools/call" => return Some(call_tool(id, msg, ctx)),
        _ => return Some(rpc_error(id, -32601, "method not found")),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

/// Tool schemas ride along on every model turn while attached, so keep the
/// descriptions short.
fn tool_list() -> Value {
    // Coordinates are pixels on the user's primary screen, the space the
    // screenshot tool reports its "screen is WxH" size in.
    json!([
        {
            "name": "screenshot",
            "description": "Capture the user's primary screen as a PNG, at most 1280 px wide. Read-only.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "move_mouse",
            "description": "Move the mouse cursor to an absolute screen pixel (x, y).",
            "inputSchema": {
                "type": "object",
                "properties": { "x": { "type": "integer" }, "y": { "type": "integer" } },
                "required": ["x", "y"],
                "additionalProperties": false
            }
        },
        {
            "name": "click",
            "description": "Click the mouse. Give x and y to click at that screen pixel, or omit both to click where the cursor is. button is left/right/middle (default left); set double true for a double-click.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "x": { "type": "integer" },
                    "y": { "type": "integer" },
                    "button": { "type": "string", "enum": ["left", "right", "middle"] },
                    "double": { "type": "boolean" }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "type_text",
            "description": "Type a string of Unicode text at the current focus, as if typed on the keyboard.",
            "inputSchema": {
                "type": "object",
                "properties": { "text": { "type": "string" } },
                "required": ["text"],
                "additionalProperties": false
            }
        },
        {
            "name": "press_key",
            "description": "Press a key or key combo, e.g. \"enter\", \"ctrl+c\", \"alt+tab\", \"ctrl+shift+t\". Modifiers: ctrl, alt, shift, win.",
            "inputSchema": {
                "type": "object",
                "properties": { "keys": { "type": "string" } },
                "required": ["keys"],
                "additionalProperties": false
            }
        },
        {
            "name": "scroll",
            "description": "Scroll the mouse wheel. dy is vertical (positive = up, negative = down) in wheel notches; dx is horizontal. Give x and y to scroll at that point first.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "x": { "type": "integer" },
                    "y": { "type": "integer" },
                    "dx": { "type": "integer" },
                    "dy": { "type": "integer" }
                },
                "additionalProperties": false
            }
        }
    ])
}

/// Parse a `tools/call` arguments object into a control action. Returns `Ok(None)`
/// for `screenshot` (handled separately) and an error string for a bad request.
fn parse_action(name: &str, args: &Value) -> Result<Option<Action>, String> {
    let int = |k: &str| args.get(k).and_then(Value::as_i64).map(|v| v as i32);
    let action = match name {
        "screenshot" => return Ok(None),
        "move_mouse" => {
            let x = int("x").ok_or("move_mouse needs integer x")?;
            let y = int("y").ok_or("move_mouse needs integer y")?;
            Action::Move { x, y }
        }
        "click" => {
            let button = Button::parse(args.get("button").and_then(Value::as_str).unwrap_or(""))
                .map_err(|e| e.to_string())?;
            Action::Click {
                x: int("x"),
                y: int("y"),
                button,
                double: args.get("double").and_then(Value::as_bool).unwrap_or(false),
            }
        }
        "scroll" => Action::Scroll {
            x: int("x"),
            y: int("y"),
            dx: int("dx").unwrap_or(0),
            dy: int("dy").unwrap_or(0),
        },
        "type_text" => {
            let text = args.get("text").and_then(Value::as_str).ok_or("type_text needs a text string")?;
            Action::Type { text: text.to_string() }
        }
        "press_key" => {
            let keys = args.get("keys").and_then(Value::as_str).ok_or("press_key needs a keys string")?;
            Action::Key { combo: input::parse_combo(keys).map_err(|e| e.to_string())? }
        }
        other => return Err(format!("unknown tool: {other}")),
    };
    Ok(Some(action))
}

fn call_tool(id: Value, msg: &Value, ctx: &Ctx) -> Value {
    let name = msg.pointer("/params/name").and_then(Value::as_str).unwrap_or("");
    let args = msg.pointer("/params/arguments").cloned().unwrap_or_else(|| json!({}));
    // Parse the request before the consent check so a malformed call fails the
    // same way whether or not control is granted.
    let action = match parse_action(name, &args) {
        Ok(a) => a,
        Err(e) => return rpc_error(id, -32602, &e),
    };
    if !(ctx.server.hooks.allowed)(ctx.pty_id) {
        return tool_result(id, true, vec![text("PC control is off for this session. Ask the user to turn it on in ezCLI.")]);
    }
    match action {
        None => match (ctx.server.hooks.screenshot)() {
            Ok(cap) => tool_result(
                id,
                false,
                vec![
                    json!({
                        "type": "image",
                        "data": base64::engine::general_purpose::STANDARD.encode(&cap.png),
                        "mimeType": "image/png"
                    }),
                    text(&format!(
                        "{}x{} screenshot (screen is {}x{}).",
                        cap.width, cap.height, cap.source_width, cap.source_height
                    )),
                ],
            ),
            Err(e) => tool_result(id, true, vec![text(&format!("Screenshot failed: {e}"))]),
        },
        Some(action) => match (ctx.server.hooks.control)(&action) {
            Ok(msg) => tool_result(id, false, vec![text(&msg)]),
            Err(e) => tool_result(id, true, vec![text(&format!("Action failed: {e}"))]),
        },
    }
}

fn text(s: &str) -> Value {
    json!({ "type": "text", "text": s })
}

fn tool_result(id: Value, is_error: bool, content: Vec<Value>) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": { "content": content, "isError": is_error } })
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

pub(crate) struct Request {
    pub(crate) method: String,
    pub(crate) path: String,
    headers: Vec<(String, String)>,
    pub(crate) body: Vec<u8>,
}

impl Request {
    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

pub(crate) fn read_request(stream: &TcpStream) -> Result<Request> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    let mut header_bytes = 0;

    reader.read_line(&mut line)?;
    header_bytes += line.len();
    let mut parts = line.split_whitespace();
    let method = parts.next().ok_or_else(|| anyhow!("no method"))?.to_string();
    let path = parts.next().ok_or_else(|| anyhow!("no path"))?.to_string();

    let mut headers = Vec::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line)?;
        header_bytes += n;
        if n == 0 || header_bytes > MAX_HEADER_BYTES {
            return Err(anyhow!("headers too large or truncated"));
        }
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break;
        }
        if let Some((k, v)) = trimmed.split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }

    let len: usize = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    if len > MAX_BODY_BYTES {
        return Err(anyhow!("body too large"));
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;
    Ok(Request { method, path, headers, body })
}

pub(crate) fn http(status: u16, content_type: &str, body: Vec<u8>, extra: &[(&str, &str)]) -> Vec<u8> {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Error",
    };
    let mut head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    for (k, v) in extra {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    let mut out = head.into_bytes();
    out.extend_from_slice(&body);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn fake_capture() -> Result<Capture> {
        Ok(Capture {
            png: vec![0x89, b'P', b'N', b'G'],
            width: 2,
            height: 1,
            source_width: 4,
            source_height: 2,
        })
    }

    fn server(granted: Arc<AtomicBool>) -> Arc<McpServer> {
        McpServer::start(Hooks {
            allowed: Box::new(move |pty| pty == "p1" && granted.load(Ordering::SeqCst)),
            screenshot: Box::new(fake_capture),
            control: Box::new(|action| Ok(format!("stub: {action:?}"))),
        })
        .unwrap()
    }

    /// Real HTTP over loopback, exactly as a CLI would send it.
    fn post(url: &str, body: &str, host: Option<&str>) -> (u16, String) {
        let rest = url.strip_prefix("http://").unwrap();
        let (addr, path) = rest.split_at(rest.find('/').unwrap());
        let mut s = TcpStream::connect(addr).unwrap();
        let host = host.unwrap_or(addr);
        write!(
            s,
            "POST {path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
        let mut resp = String::new();
        s.read_to_string(&mut resp).unwrap();
        let status = resp[9..12].parse().unwrap();
        let body = resp.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default();
        (status, body)
    }

    #[test]
    fn handshake_and_tool_list_over_http() {
        let srv = server(Arc::new(AtomicBool::new(false)));
        let url = srv.register("p1").unwrap();

        let (st, body) = post(&url, r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}"#, None);
        assert_eq!(st, 200);
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(v["result"]["serverInfo"]["name"], "ezcli");

        let (st, _) = post(&url, r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#, None);
        assert_eq!(st, 202);

        let (_, body) = post(&url, r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#, None);
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["result"]["tools"][0]["name"], "screenshot");
        let names: Vec<&str> = v["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        for want in ["move_mouse", "click", "type_text", "press_key", "scroll"] {
            assert!(names.contains(&want), "tool list is missing {want}: {names:?}");
        }
    }

    #[test]
    fn control_tools_dispatch_through_the_hook_behind_the_guard() {
        let granted = Arc::new(AtomicBool::new(true));
        let srv = server(Arc::clone(&granted));
        let url = srv.register("p1").unwrap();

        // A granted call runs the control hook (the stub echoes the action).
        let call = r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"click","arguments":{"x":10,"y":20,"button":"right"}}}"#;
        let (_, body) = post(&url, call, None);
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["result"]["isError"], false);
        assert!(v["result"]["content"][0]["text"].as_str().unwrap().contains("Right"));

        // A malformed request is rejected as an RPC error, not run.
        let bad = r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"move_mouse","arguments":{"x":10}}}"#;
        let (_, body) = post(&url, bad, None);
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["error"]["code"], -32602);

        // The consent guard still gates control tools.
        granted.store(false, Ordering::SeqCst);
        let (_, body) = post(&url, call, None);
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["result"]["isError"], true);
    }

    #[test]
    fn tool_call_obeys_the_consent_guard() {
        let granted = Arc::new(AtomicBool::new(false));
        let srv = server(Arc::clone(&granted));
        let url = srv.register("p1").unwrap();
        let call = r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"screenshot","arguments":{}}}"#;

        let (_, body) = post(&url, call, None);
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["result"]["isError"], true, "must refuse before a grant");

        granted.store(true, Ordering::SeqCst);
        let (_, body) = post(&url, call, None);
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["result"]["isError"], false);
        assert_eq!(v["result"]["content"][0]["type"], "image");
        assert_eq!(v["result"]["content"][0]["mimeType"], "image/png");

        granted.store(false, Ordering::SeqCst);
        let (_, body) = post(&url, call, None);
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["result"]["isError"], true, "revocation applies to the next call");
    }

    #[test]
    fn rejects_unknown_tokens_foreign_hosts_and_unregistered_sessions() {
        let srv = server(Arc::new(AtomicBool::new(true)));
        let url = srv.register("p1").unwrap();
        let ping = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;

        let bad = format!("http://127.0.0.1:{}/mcp/{}", srv.port(), "0".repeat(32));
        assert_eq!(post(&bad, ping, None).0, 404);

        assert_eq!(post(&url, ping, Some("evil.example:80")).0, 403);

        srv.unregister("p1");
        assert_eq!(post(&url, ping, None).0, 404, "token dies with the session");
    }

    /// End to end with the real Claude Code CLI, the real loopback server and a
    /// real screen capture. Spends a little Claude usage, so it is opt-in:
    /// `scripts\test-rust.ps1 --ignored --nocapture live_claude_code`
    /// The capture hook counts invocations, so a model merely *saying* it took
    /// a screenshot cannot pass.
    #[test]
    #[ignore = "spends Claude usage: a live Claude Code session calls the tool"]
    fn live_claude_code_calls_screenshot_through_the_server() {
        use std::sync::atomic::AtomicUsize;
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&calls);
        let srv = McpServer::start(Hooks {
            allowed: Box::new(|pty| pty == "e2e"),
            screenshot: Box::new(move || {
                counted.fetch_add(1, Ordering::SeqCst);
                crate::capture::primary_screen()
            }),
            control: Box::new(|action| crate::input::perform(action)),
        })
        .unwrap();
        let url = srv.register("e2e").unwrap();
        let dir = std::env::temp_dir().join("ezcli-mcp-e2e");
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = dir.join("e2e.json");
        std::fs::write(&cfg, json!({ "mcpServers": { "ezcli": { "type": "http", "url": url } } }).to_string()).unwrap();

        let out = std::process::Command::new("cmd")
            .args([
                "/C",
                "claude",
                "-p",
                "Call the ezcli screenshot tool exactly once. Then reply with only the WIDTHxHEIGHT text it returned.",
                "--mcp-config",
            ])
            .arg(&cfg)
            .args(["--strict-mcp-config", "--allowedTools", "mcp__ezcli__screenshot"])
            .output()
            .expect("claude on PATH");
        let _ = std::fs::remove_dir_all(&dir);

        let stdout = String::from_utf8_lossy(&out.stdout);
        eprintln!("claude exit={:?}\nstdout: {}\nstderr: {}", out.status.code(), stdout.trim(), String::from_utf8_lossy(&out.stderr).trim());
        eprintln!("screenshot hook calls: {}", calls.load(Ordering::SeqCst));
        assert!(calls.load(Ordering::SeqCst) >= 1, "Claude Code never reached the screenshot tool");
    }

    #[test]
    fn tokens_are_unique_per_registration() {
        let srv = server(Arc::new(AtomicBool::new(false)));
        let a = srv.register("p1").unwrap();
        let b = srv.register("p1").unwrap();
        assert_ne!(a, b);
        // Re-registering replaces the old token.
        assert_eq!(post(&a, r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#, None).0, 404);
    }
}
