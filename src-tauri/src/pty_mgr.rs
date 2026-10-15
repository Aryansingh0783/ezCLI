//! Pseudo-terminal session management.
//!
//! One `Session` is one running CLI. The reader thread streams every byte
//! the child writes to the frontend as a `pty-data:<id>` event, and the
//! wait thread emits a single `pty-exit:<id>` once the child dies.

use anyhow::{anyhow, Result};
use dashmap::DashMap;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
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

        let mut cmd = CommandBuilder::new(&args.cmd);
        for a in &args.args {
            cmd.arg(a);
        }
        if let Some(cwd) = &args.cwd {
            cmd.cwd(cwd);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("FORCE_COLOR", "3");

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
        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
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
