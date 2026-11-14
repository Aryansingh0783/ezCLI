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
    /// Both ends ezCLI holds on the terminal. `None` once the child has exited
    /// and its last output has been read: keeping them would hold a ConPTY (or a
    /// pts) and a blocked reader thread for every finished tab that stays open.
    master: Option<Box<dyn MasterPty + Send>>,
    writer: Option<Box<dyn Write + Send>>,
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
    /// Extra environment for this session only (e.g. OpenCode's MCP config).
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
}

const MAX_SESSIONS: usize = 24;

/// How long the reader gets to collect a finished child's last output before the
/// terminal is closed under it. On Windows the reader only sees the end of the
/// stream once the ConPTY is closed, so without this it would wait for ever.
const DRAIN_AFTER_EXIT: std::time::Duration = std::time::Duration::from_millis(400);

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
    for (k, v) in &args.env {
        cmd.env(k, v);
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
        let (data_event, exit_event) = (format!("pty-data:{}", args.id), format!("pty-exit:{}", args.id));
        let (app_d, app_x) = (app.clone(), app);
        let exited_id = args.id.clone();
        self.spawn_with(
            args,
            crate::agents::effective_path(),
            move |chunk| app_d.emit(&data_event, chunk).is_ok(),
            move |code| {
                // An Antigravity session's entries leave its folder's config as soon as the process ends.
                crate::agy_mcp::detach(&exited_id);
                let _ = app_x.emit(&exit_event, code);
            },
        )
    }

    /// `spawn` without the Tauri handle: output and the exit code go to the two
    /// callbacks, so the whole life of a session can be tested.
    fn spawn_with(
        &self,
        args: SpawnArgs,
        child_path: OsString,
        on_data: impl Fn(String) -> bool + Send + 'static,
        on_exit: impl FnOnce(u32) + Send + 'static,
    ) -> Result<u32> {
        // A finished session that is still open in a tab holds no process, so it does not use a slot.
        if self.live_count() >= MAX_SESSIONS {
            return Err(anyhow!(
                "session limit reached ({}). Close a tab and try again.",
                MAX_SESSIONS
            ));
        }
        if self.is_live(&args.id) {
            return Err(anyhow!("session id already in use"));
        }
        // The same id again after its process ended: let go of the old record first.
        self.sessions.remove(&args.id);

        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows: args.rows.max(2),
            cols: args.cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let cmd = session_command(&args, child_path);

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
                        if !on_data(s) {
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
        let session = Arc::new(Mutex::new(Session {
            master: Some(pair.master),
            writer: Some(writer),
            killer,
            alive,
            tail,
        }));
        let weak = Arc::downgrade(&session);
        thread::spawn(move || {
            let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
            alive_w.store(false, Ordering::SeqCst);
            on_exit(code);
            // Let the reader take what the child printed last, then close our side
            // of the terminal. The record stays (its tail is still readable) until
            // the tab is closed; only the handles go.
            thread::sleep(DRAIN_AFTER_EXIT);
            if let Some(s) = weak.upgrade() {
                if let Ok(mut s) = s.lock() {
                    s.writer = None;
                    s.master = None;
                }
            }
        });

        self.sessions.insert(args.id, session);
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
        let writer = sess.writer.as_mut().ok_or_else(|| anyhow!("session has exited"))?;
        writer.write_all(data)?;
        writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        let entry = self
            .sessions
            .get(id)
            .ok_or_else(|| anyhow!("unknown session"))?;
        let sess = entry.lock().map_err(|_| anyhow!("session lock poisoned"))?;
        let master = sess.master.as_ref().ok_or_else(|| anyhow!("session has exited"))?;
        master.resize(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    pub fn kill(&self, id: &str) -> Result<()> {
        if let Some((_, s)) = self.sessions.remove(id) {
            // A poisoned lock must not leave the process running: take the session anyway.
            let mut sess = s.lock().unwrap_or_else(|e| e.into_inner());
            if sess.alive.load(Ordering::SeqCst) {
                let _ = sess.killer.kill();
            }
            // Closing our side now ends the reader thread instead of leaving it to the wait thread.
            sess.writer = None;
            sess.master = None;
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

#[cfg(all(test, unix))]
mod lifecycle_tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    fn args(id: &str, script: &str) -> SpawnArgs {
        SpawnArgs { id: id.into(), cmd: "/bin/sh".into(), args: vec!["-c".into(), script.into()], cwd: None, env: vec![], cols: 80, rows: 24 }
    }

    fn path() -> OsString {
        std::env::var_os("PATH").unwrap_or_default()
    }

    /// Start `script`; returns the channel its exit code arrives on and the output collected so far.
    fn start(store: &SessionStore, id: &str, script: &str) -> (mpsc::Receiver<u32>, Arc<Mutex<String>>) {
        let (tx, rx) = mpsc::channel();
        let out = Arc::new(Mutex::new(String::new()));
        let sink = out.clone();
        store
            .spawn_with(
                args(id, script),
                path(),
                move |chunk| {
                    sink.lock().unwrap().push_str(&chunk);
                    true
                },
                move |code| {
                    let _ = tx.send(code);
                },
            )
            .expect("spawn");
        (rx, out)
    }

    fn handles_released(store: &SessionStore, id: &str) -> bool {
        let entry = store.sessions.get(id).expect("the record stays until the tab closes");
        let s = entry.lock().unwrap();
        s.master.is_none() && s.writer.is_none()
    }

    fn wait_until(what: &str, mut ok: impl FnMut() -> bool) {
        for _ in 0..200 {
            if ok() {
                return;
            }
            thread::sleep(Duration::from_millis(25));
        }
        panic!("timed out waiting until {what}");
    }

    #[test]
    fn a_finished_session_reports_its_code_keeps_its_output_and_lets_go_of_the_terminal() {
        let store = SessionStore::new();
        let (exit, out) = start(&store, "a", "printf 'last words'; exit 7");
        assert_eq!(exit.recv_timeout(Duration::from_secs(10)).unwrap(), 7);
        wait_until("the terminal handles are released", || handles_released(&store, "a"));
        assert!(out.lock().unwrap().contains("last words"), "output printed just before exit must not be lost");
        assert!(store.tail("a", 0).unwrap().1.contains("last words"), "the tail stays readable after exit");
        assert!(!store.is_live("a"));
        assert_eq!(store.live_count(), 0);
        assert!(store.write("a", b"x").unwrap_err().to_string().contains("exited"));
        assert!(store.resize("a", 100, 30).is_err());
        store.kill("a").expect("closing a finished session is not an error");
        assert!(store.kill("a").is_err(), "and it is gone afterwards");
    }

    #[test]
    fn killing_a_running_session_ends_the_process_and_removes_the_record() {
        let store = SessionStore::new();
        let (exit, _) = start(&store, "k", "sleep 60");
        assert!(store.is_live("k"));
        store.kill("k").unwrap();
        exit.recv_timeout(Duration::from_secs(10)).expect("the child must die when its session is killed");
        assert!(store.sessions.is_empty());
    }

    #[test]
    fn finished_sessions_free_their_slot_and_their_id() {
        let store = SessionStore::new();
        let mut exits = Vec::new();
        for i in 0..MAX_SESSIONS {
            exits.push(start(&store, &format!("s{i}"), "exit 0").0);
        }
        for e in &exits {
            e.recv_timeout(Duration::from_secs(20)).unwrap();
        }
        // every slot is taken by a finished session that was never closed; a new one must still start
        let (exit, _) = start(&store, "fresh", "exit 3");
        assert_eq!(exit.recv_timeout(Duration::from_secs(10)).unwrap(), 3);
        // and an id whose process ended can be used again (a restart keeps its id)
        let (again, _) = start(&store, "s0", "exit 4");
        assert_eq!(again.recv_timeout(Duration::from_secs(10)).unwrap(), 4);
    }

    #[test]
    fn a_running_id_cannot_be_started_twice_and_live_sessions_are_capped() {
        let store = SessionStore::new();
        start(&store, "l0", "sleep 60");
        let dup = store.spawn_with(args("l0", "exit 0"), path(), |_| true, |_| {});
        assert!(dup.unwrap_err().to_string().contains("already in use"));
        for i in 1..MAX_SESSIONS {
            start(&store, &format!("l{i}"), "sleep 60");
        }
        let over = store.spawn_with(args("extra", "exit 0"), path(), |_| true, |_| {});
        assert!(over.unwrap_err().to_string().contains("session limit"));
        for i in 0..MAX_SESSIONS {
            store.kill(&format!("l{i}")).unwrap();
        }
        assert_eq!(store.live_count(), 0);
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
            env: Vec::new(),
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
