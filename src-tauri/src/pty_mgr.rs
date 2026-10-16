//! Pseudo-terminal session management.
//!
//! One `Session` is one running CLI. The reader thread streams every byte
//! the child writes to the frontend as a `pty-data:<id>` event, and the
//! wait thread emits a single `pty-exit:<id>` once the child dies.

use anyhow::{anyhow, Result};
use dashmap::DashMap;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::ffi::OsString;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

pub struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// Cleared by the wait thread once the child exits.
    alive: Arc<AtomicBool>,
    /// Recent output, for the remote view and for moving a tab to a new window.
    tail: Arc<Mutex<Tail>>,
}

/// The last `TAIL_BYTES` of a session's output plus a running byte count.
/// `seq` only grows, so a reader asks "what came after seq N" and gets either
/// the missing bytes or, if it fell too far behind, everything still held.
#[derive(Default)]
pub struct Tail {
    buf: std::collections::VecDeque<u8>,
    seq: u64,
}

pub const TAIL_BYTES: usize = 256 * 1024;

impl Tail {
    pub fn push(&mut self, bytes: &[u8]) {
        self.seq += bytes.len() as u64;
        self.buf.extend(bytes);
        let excess = self.buf.len().saturating_sub(TAIL_BYTES);
        self.buf.drain(..excess);
    }

    /// Bytes after `since`, and the new sequence number to ask from next.
    pub fn since(&self, since: u64) -> (u64, Vec<u8>) {
        let start_seq = self.seq - self.buf.len() as u64;
        let from = since.clamp(start_seq, self.seq);
        let skip = (from - start_seq) as usize;
        (self.seq, self.buf.iter().skip(skip).copied().collect())
    }
}

#[derive(Default)]
pub struct SessionStore {
    sessions: DashMap<String, Arc<Mutex<Session>>>,
}

pub struct SpawnArgs {
    pub id: String,
    pub cmd: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

const MAX_SESSIONS: usize = 24;

/// Build the command exactly as an interactive agent session receives it.
/// Keeping this separate makes the PATH contract testable without a Tauri
/// `AppHandle`: the executable ezCLI resolves and the child it launches must
/// see the same refreshed PATH.
fn session_command(args: &SpawnArgs, child_path: OsString) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(&args.cmd);
    for a in &args.args {
        cmd.arg(a);
    }
    if let Some(cwd) = &args.cwd {
        cmd.cwd(cwd);
    }
    // Same merged PATH used to find the CLI, so a shim such as claude.cmd can
    // also find `node` when ezCLI was started with a stale PATH.
    cmd.env("PATH", child_path);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // An inherited NO_COLOR conflicts with FORCE_COLOR in Node-based CLIs
    // (including OpenCode) and prints a warning into the user's terminal.
    cmd.env_remove("NO_COLOR");
    cmd.env("FORCE_COLOR", "3");
    // When ezCLI itself was started from inside a Claude Code session, these
    // markers make a launched `claude` think it is a nested child of that
    // session (no transcript saving, the host's session ids and messaging
    // socket). ezCLI's tabs are independent sessions, so drop them. User
    // configuration such as CLAUDE_CODE_USE_BEDROCK is left alone.
    for var in NESTED_SESSION_VARS {
        cmd.env_remove(var);
    }
    cmd
}

const NESTED_SESSION_VARS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_HOST_SESSION_ID",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDE_PID",
];

impl SessionStore {
    pub fn new() -> Self {
        Self {
            sessions: DashMap::new(),
        }
    }

    pub fn spawn(&self, app: AppHandle, args: SpawnArgs) -> Result<u32> {
        if self.sessions.len() >= MAX_SESSIONS {
            return Err(anyhow!(
                "session limit reached ({}). Close a tab and try again.",
                MAX_SESSIONS
            ));
        }
        if self.sessions.contains_key(&args.id) {
            return Err(anyhow!("session id already in use"));
        }

        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows: args.rows.max(2),
            cols: args.cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let cmd = session_command(&args, crate::agents::effective_path());

        let mut child = pair.slave.spawn_command(cmd)?;
        let killer = child.clone_killer();
        let pid = child.process_id().unwrap_or(0);

        // Drop the slave so the only end of the pty we keep is the master.
        // Without this the reader never sees EOF when the child exits.
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;

        // Reader thread: pump raw bytes to the frontend as UTF-8 chunks.
        // from_utf8_lossy preserves ANSI escapes verbatim (they are 7-bit)
        // and only touches bytes that would be invalid UTF-8 anyway.
        let id_r = args.id.clone();
        let app_r = app.clone();
        let tail = Arc::new(Mutex::new(Tail::default()));
        let tail_r = tail.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if let Ok(mut t) = tail_r.lock() {
                            t.push(&buf[..n]);
                        }
                        let s = String::from_utf8_lossy(&buf[..n]).into_owned();
                        if app_r.emit(&format!("pty-data:{}", id_r), s).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        // Wait thread: fire a single exit event once the child dies.
        let alive = Arc::new(AtomicBool::new(true));
        let alive_w = alive.clone();
        let id_w = args.id.clone();
        let app_w = app.clone();
        thread::spawn(move || {
            let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
            alive_w.store(false, Ordering::SeqCst);
            let _ = app_w.emit(&format!("pty-exit:{}", id_w), code);
        });

        self.sessions.insert(
            args.id,
            Arc::new(Mutex::new(Session {
                master: pair.master,
                writer,
                killer,
                alive,
                tail,
            })),
        );
        Ok(pid)
    }

    /// Whether `id` names a session whose process is still running. The
    /// PC-control guard uses this so a grant can never outlive its process,
    /// even if the frontend never gets to revoke it (webview reload, crash).
    pub fn is_live(&self, id: &str) -> bool {
        self.sessions
            .get(id)
            .map(|e| e.value().lock().map(|s| s.alive.load(Ordering::SeqCst)).unwrap_or(false))
            .unwrap_or(false)
    }

    /// Output after `since` (see `Tail::since`), lossily decoded. A chunk can
    /// start mid-UTF-8 sequence; the replacement character is acceptable for
    /// a viewer, and ANSI escapes are 7-bit so they survive intact.
    pub fn tail(&self, id: &str, since: u64) -> Option<(u64, String)> {
        let entry = self.sessions.get(id)?;
        let tail = entry.lock().ok()?.tail.clone();
        let t = tail.lock().ok()?;
        let (seq, bytes) = t.since(since);
        Some((seq, String::from_utf8_lossy(&bytes).into_owned()))
    }

    /// Sessions whose process is still running.
    pub fn live_count(&self) -> usize {
        self.sessions
            .iter()
            .filter(|e| e.value().lock().map(|s| s.alive.load(Ordering::SeqCst)).unwrap_or(false))
            .count()
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<()> {
        let entry = self
            .sessions
            .get(id)
            .ok_or_else(|| anyhow!("unknown session"))?;
        let mut sess = entry.lock().map_err(|_| anyhow!("session lock poisoned"))?;
        sess.writer.write_all(data)?;
        sess.writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        let entry = self
            .sessions
            .get(id)
            .ok_or_else(|| anyhow!("unknown session"))?;
        let sess = entry.lock().map_err(|_| anyhow!("session lock poisoned"))?;
        sess.master.resize(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    pub fn kill(&self, id: &str) -> Result<()> {
        if let Some((_, s)) = self.sessions.remove(id) {
            let mut sess = s.lock().map_err(|_| anyhow!("session lock poisoned"))?;
            let _ = sess.killer.kill();
            Ok(())
        } else {
            Err(anyhow!("unknown session"))
        }
    }
}

#[cfg(test)]
mod tail_tests {
    use super::*;

    #[test]
    fn tail_keeps_the_newest_bytes_and_resumes_by_sequence() {
        let mut t = Tail::default();
        t.push(b"hello ");
        let (seq, first) = t.since(0);
        assert_eq!((seq, first.as_slice()), (6, &b"hello "[..]));
        t.push(b"world");
        assert_eq!(t.since(seq).1, b"world");
        assert_eq!(t.since(999).1, b"");
        let big = vec![b'x'; TAIL_BYTES + 10];
        t.push(&big);
        let (seq2, all) = t.since(0);
        assert_eq!(seq2, 11 + TAIL_BYTES as u64 + 10);
        assert_eq!(all.len(), TAIL_BYTES);
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::agents;
    use portable_pty::{native_pty_system, PtySize};
    use std::io::Read;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct TempTree(PathBuf);

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn temp_tree() -> TempTree {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "ezcli-path-pty-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).unwrap();
        TempTree(root)
    }

    #[test]
    fn refreshed_path_finds_and_launches_a_cmd_shim_with_its_dependency() {
        let root = temp_tree();
        // This has spaces and deliberately runs through a `.cmd` shim, the
        // hard case that fails when CreateProcessW launches it directly.
        let cli_dir = root.0.join("fresh cli shim");
        let node_dir = root.0.join("fresh node dependency");
        let stale_dir = root.0.join("stale inherited path");
        std::fs::create_dir_all(&cli_dir).unwrap();
        std::fs::create_dir_all(&node_dir).unwrap();
        std::fs::create_dir_all(&stale_dir).unwrap();
        std::fs::write(
            cli_dir.join("fake-agent.cmd"),
            "@echo off\r\ncall node-like.cmd\r\necho EZCLI_SHIM_OK [%1] [%2]\r\n",
        )
        .unwrap();
        std::fs::write(node_dir.join("node-like.cmd"), "@echo off\r\necho EZCLI_DEPENDENCY_OK\r\n").unwrap();

        // The stale parent location deliberately has neither executable. The
        // two following folders stand in for fresh registry/install sources.
        let merged = agents::merge_path_dirs(vec![stale_dir, cli_dir.clone(), node_dir]);
        let resolved = agents::resolve_command_on_path("fake-agent", &merged).expect("fresh CLI discovery");
        assert!(
            resolved.eq_ignore_ascii_case(&cli_dir.join("fake-agent.cmd").to_string_lossy()),
            "resolved {resolved:?} from an unexpected folder"
        );

        let launch = agents::launch_command(
            &resolved,
            &["--config".to_string(), r"C:\Users\Jane Smith\ezcli.json".to_string()],
        )
        .unwrap();
        let args = SpawnArgs {
            id: "test".to_string(),
            cmd: launch.program,
            args: launch.args,
            cwd: None,
            cols: 120,
            rows: 24,
        };
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut child = pair.slave.spawn_command(session_command(&args, merged)).unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        drop(pair.slave);
        let output = std::thread::spawn(move || {
            let mut text = String::new();
            reader.read_to_string(&mut text).unwrap();
            text
        });
        let status = child.wait().unwrap();
        drop(pair.master);
        let output = output.join().unwrap();

        assert!(status.success(), "shim exited with {}: {output}", status.exit_code());
        assert!(output.contains("EZCLI_DEPENDENCY_OK"), "dependency was not found through the child PATH: {output}");
        assert!(output.contains("EZCLI_SHIM_OK [--config] [\"C:\\Users\\Jane Smith\\ezcli.json\"]"), "arguments were not preserved: {output}");
    }
}
