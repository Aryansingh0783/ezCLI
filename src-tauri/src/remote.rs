//! Remote view: watch (and optionally type into) sessions from a phone on the
//! same network.
//!
//! Off until the user turns it on. While on, a small HTTP server listens on
//! all interfaces at a random port, and every route sits under a 128-bit
//! random token, so only someone given the URL (or QR code) can connect.
//! Typing is a second, separate switch. Turning the view off stops the
//! listener and invalidates the token. Traffic is plain HTTP on the local
//! network; the settings screen says so.

use crate::mcp_server::{http, read_request, Request};
use crate::pty_mgr::SessionStore;
use serde::{Deserialize, Serialize};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const PAGE: &str = include_str!("remote_page.html");
const XTERM_JS: &str = include_str!("../../public/vendor/xterm/lib/xterm.js");
const XTERM_CSS: &str = include_str!("../../public/vendor/xterm/css/xterm.css");

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RemoteSession {
    /// The PTY id.
    pub id: String,
    pub title: String,
    pub agent: String,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub enabled: bool,
    pub allow_input: bool,
    pub url: Option<String>,
    /// SVG QR code for `url`.
    pub qr_svg: Option<String>,
}

struct Running {
    // Read only by tests; the live check uses the copy held by the server thread.
    #[cfg_attr(not(test), allow(dead_code))]
    token: String,
    url: String,
    stop: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct Remote {
    running: Mutex<Option<Running>>,
    allow_input: Arc<AtomicBool>,
    sessions: Arc<Mutex<Vec<RemoteSession>>>,
}

fn token() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|e| format!("no secure randomness: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// The address other devices on this network reach us at. Connecting a UDP
/// socket only picks a route; no packet is sent.
fn lan_ip() -> String {
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| {
            s.connect("192.0.2.1:80")?;
            s.local_addr()
        })
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|_| "127.0.0.1".into())
}

fn qr_svg(url: &str) -> Option<String> {
    let code = qrcode::QrCode::new(url.as_bytes()).ok()?;
    Some(
        code.render::<qrcode::render::svg::Color>()
            .min_dimensions(180, 180)
            .dark_color(qrcode::render::svg::Color("#0b0c0e"))
            .light_color(qrcode::render::svg::Color("#ffffff"))
            .build(),
    )
}

impl Remote {
    pub fn status(&self) -> RemoteStatus {
        let running = self.running.lock().unwrap();
        RemoteStatus {
            enabled: running.is_some(),
            allow_input: self.allow_input.load(Ordering::SeqCst),
            url: running.as_ref().map(|r| r.url.clone()),
            qr_svg: running.as_ref().and_then(|r| qr_svg(&r.url)),
        }
    }

    pub fn set_sessions(&self, list: Vec<RemoteSession>) {
        *self.sessions.lock().unwrap() = list.into_iter().take(64).collect();
    }

    pub fn set_allow_input(&self, allow: bool) {
        self.allow_input.store(allow, Ordering::SeqCst);
    }

    pub fn stop(&self) {
        if let Some(r) = self.running.lock().unwrap().take() {
            r.stop.store(true, Ordering::SeqCst);
        }
        // Typing permission never carries over to the next time it is enabled.
        self.allow_input.store(false, Ordering::SeqCst);
    }

    pub fn start(&self, store: Arc<SessionStore>) -> Result<RemoteStatus, String> {
        if self.running.lock().unwrap().is_some() {
            return Ok(self.status());
        }
        let listener = TcpListener::bind(("0.0.0.0", 0)).map_err(|e| e.to_string())?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let tok = token()?;
        let url = format!("http://{}:{port}/r/{tok}/", lan_ip());
        let stop = Arc::new(AtomicBool::new(false));

        let ctx = Arc::new(Ctx {
            token: tok.clone(),
            store,
            allow_input: self.allow_input.clone(),
            sessions: self.sessions.clone(),
        });
        let stop_t = stop.clone();
        thread::Builder::new()
            .name("ezcli-remote".into())
            .spawn(move || {
                while !stop_t.load(Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            let ctx = ctx.clone();
                            let stop_c = stop_t.clone();
                            let _ = thread::Builder::new()
                                .name("ezcli-remote-conn".into())
                                .spawn(move || serve(stream, &ctx, &stop_c));
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(80));
                        }
                        Err(_) => thread::sleep(Duration::from_millis(200)),
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        *self.running.lock().unwrap() = Some(Running { token: tok, url, stop });
        Ok(self.status())
    }

    #[cfg(test)]
    fn token_for_test(&self) -> Option<String> {
        self.running.lock().unwrap().as_ref().map(|r| r.token.clone())
    }
}

struct Ctx {
    token: String,
    store: Arc<SessionStore>,
    allow_input: Arc<AtomicBool>,
    sessions: Arc<Mutex<Vec<RemoteSession>>>,
}

fn serve(mut stream: TcpStream, ctx: &Ctx, stop: &AtomicBool) {
    use std::io::Write;
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
    let response = if stop.load(Ordering::SeqCst) {
        http(404, "text/plain", b"not found".to_vec(), &[])
    } else {
        match read_request(&stream) {
            Ok(req) => route(&req, ctx),
            Err(_) => http(400, "text/plain", b"bad request".to_vec(), &[]),
        }
    };
    let _ = stream.write_all(&response);
    let _ = stream.flush();
}

/// Constant-time comparison so the token cannot be guessed byte by byte.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn query<'a>(path: &'a str, key: &str) -> Option<&'a str> {
    path.split_once('?')?.1.split('&').find_map(|kv| kv.strip_prefix(key)?.strip_prefix('='))
}

const NO_STORE: &[(&str, &str)] = &[("Cache-Control", "no-store"), ("X-Content-Type-Options", "nosniff"), ("Referrer-Policy", "no-referrer")];

fn route(req: &Request, ctx: &Ctx) -> Vec<u8> {
    let not_found = || http(404, "text/plain", b"not found".to_vec(), NO_STORE);
    let Some(rest) = req.path.strip_prefix("/r/") else { return not_found() };
    let (tok, sub) = rest.split_once('/').unwrap_or((rest, ""));
    if !same(tok, &ctx.token) {
        return not_found();
    }
    let sub_path = sub.split('?').next().unwrap_or("");
    let json = |v: serde_json::Value| http(200, "application/json", v.to_string().into_bytes(), NO_STORE);
    match (req.method.as_str(), sub_path) {
        ("GET", "") => http(200, "text/html; charset=utf-8", PAGE.as_bytes().to_vec(), NO_STORE),
        ("GET", "xterm.js") => http(200, "text/javascript", XTERM_JS.as_bytes().to_vec(), NO_STORE),
        ("GET", "xterm.css") => http(200, "text/css", XTERM_CSS.as_bytes().to_vec(), NO_STORE),
        ("GET", "api/sessions") => {
            let list = ctx.sessions.lock().unwrap().clone();
            let live: Vec<_> = list
                .into_iter()
                .map(|s| {
                    let alive = ctx.store.is_live(&s.id);
                    serde_json::json!({ "id": s.id, "title": s.title, "agent": s.agent, "alive": alive })
                })
                .collect();
            json(serde_json::json!({ "sessions": live, "allowInput": ctx.allow_input.load(Ordering::SeqCst) }))
        }
        ("GET", "api/output") => {
            let id = query(&req.path, "id").unwrap_or("");
            let known = ctx.sessions.lock().unwrap().iter().any(|s| s.id == id);
            let since = query(&req.path, "since").and_then(|s| s.parse().ok()).unwrap_or(0);
            match known.then(|| ctx.store.tail(id, since)).flatten() {
                Some((seq, data)) => json(serde_json::json!({ "seq": seq, "data": data, "alive": ctx.store.is_live(id) })),
                None => not_found(),
            }
        }
        ("POST", "api/input") => {
            if !ctx.allow_input.load(Ordering::SeqCst) {
                return http(403, "text/plain", b"typing is turned off in ezCLI".to_vec(), NO_STORE);
            }
            #[derive(Deserialize)]
            struct Input {
                id: String,
                data: String,
            }
            let Ok(input) = serde_json::from_slice::<Input>(&req.body) else {
                return http(400, "text/plain", b"bad request".to_vec(), NO_STORE);
            };
            let known = ctx.sessions.lock().unwrap().iter().any(|s| s.id == input.id);
            if !known || input.data.len() > 8192 {
                return http(400, "text/plain", b"bad request".to_vec(), NO_STORE);
            }
            match ctx.store.write(&input.id, input.data.as_bytes()) {
                Ok(()) => json(serde_json::json!({ "ok": true })),
                Err(_) => not_found(),
            }
        }
        _ => not_found(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    fn get(port: u16, path: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "GET {path} HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        out
    }

    fn post(port: u16, path: &str, body: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "POST {path} HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        out
    }

    #[test]
    fn token_gates_every_route_and_typing_needs_its_own_switch() {
        let remote = Remote::default();
        let status = remote.start(Arc::new(SessionStore::new())).unwrap();
        let url = status.url.unwrap();
        let port: u16 = url.rsplit(':').next().unwrap().split('/').next().unwrap().parse().unwrap();
        let tok = remote.token_for_test().unwrap();
        assert!(status.qr_svg.unwrap().starts_with("<?xml"));

        assert!(get(port, "/r/wrong/").starts_with("HTTP/1.1 404"));
        assert!(get(port, "/").starts_with("HTTP/1.1 404"));
        let page = get(port, &format!("/r/{tok}/"));
        assert!(page.starts_with("HTTP/1.1 200") && page.contains("no-store"));
        assert!(get(port, &format!("/r/{tok}/api/sessions")).contains("\"allowInput\":false"));

        remote.set_sessions(vec![RemoteSession { id: "p1".into(), title: "t".into(), agent: "a".into() }]);
        let body = r#"{"id":"p1","data":"ls\r"}"#;
        assert!(post(port, &format!("/r/{tok}/api/input"), body).starts_with("HTTP/1.1 403"));
        remote.set_allow_input(true);
        // Allowed now, but the PTY does not exist in this test store.
        assert!(post(port, &format!("/r/{tok}/api/input"), body).starts_with("HTTP/1.1 404"));
        // An id the app did not list is refused before touching the store.
        assert!(post(port, &format!("/r/{tok}/api/input"), r#"{"id":"p9","data":"x"}"#).starts_with("HTTP/1.1 400"));

        remote.stop();
        assert!(!remote.status().enabled);
        assert!(!remote.status().allow_input, "typing resets when the view stops");
    }

    #[test]
    fn query_values_are_read_by_exact_key() {
        assert_eq!(query("/x?id=p3&since=10", "id"), Some("p3"));
        assert_eq!(query("/x?id=p3&since=10", "since"), Some("10"));
        assert_eq!(query("/x?idx=1", "id"), None);
        assert!(same("abc", "abc") && !same("abc", "abd") && !same("abc", "ab"));
    }
}
