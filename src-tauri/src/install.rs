//! Runs an agent's documented install command (the same string shown in the
//! UI and in README's install column) and streams its output back live.
//!
//! Only `agents.json`'s own `install` field reaches this module — never
//! arbitrary user text — but the command itself is still a real download and
//! execution of a third-party installer (npm, or a vendor's own script), so
//! every run is explicit: the frontend shows the literal command and asks for
//! a confirming click before calling `install_agent`.

use crate::agents;
use dashmap::DashMap;
use serde::Serialize;
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// Generous: npm can be slow on a cold cache, and a vendor installer may
/// download a few hundred MB.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Default)]
pub struct InstallRuns {
    running: DashMap<String, Arc<Mutex<Child>>>,
}

impl InstallRuns {
    pub fn contains_running(&self, agent_id: &str) -> bool {
        self.running.contains_key(agent_id)
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InstallDone {
    pub code: Option<i32>,
    pub cancelled: bool,
    pub timed_out: bool,
    /// Combined stdout+stderr tail, for showing why an install failed.
    pub output_tail: String,
    /// Re-checked after the command finishes: is the agent's CLI now
    /// resolvable? This is the real success signal, not just exit code 0 —
    /// some installers (notably Antigravity's) exit 0 when already installed
    /// and also exit 0 after a successful fresh install, but a model's exit
    /// code conventions can't always be trusted either way.
    pub resolved: bool,
}

#[cfg(windows)]
fn shell_command(command_line: &str) -> Command {
    let root = std::env::var_os("SystemRoot").map(std::path::PathBuf::from);
    let ps = root.map(|r| r.join("System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe"));
    let program = match &ps {
        Some(p) if p.is_file() => p.to_string_lossy().into_owned(),
        _ => "powershell.exe".to_string(),
    };
    let mut cmd = Command::new(program);
    cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command_line]);
    cmd
}

#[cfg(not(windows))]
fn shell_command(command_line: &str) -> Command {
    let mut cmd = Command::new("/bin/sh");
    cmd.args(["-c", command_line]);
    cmd
}

/// Run one install to completion on the calling (blocking) thread. `agent_id`
/// doubles as the run key (one install per agent at a time) and the event
/// name suffix (`install-out:<agent_id>`).
pub fn run(app: AppHandle, runs: &InstallRuns, agent_id: String, command_line: String, target_command: String) -> InstallDone {
    run_in(app, runs, agent_id, command_line, target_command, None)
}

/// [`run`], optionally inside a working directory.
pub fn run_in(
    app: AppHandle,
    runs: &InstallRuns,
    agent_id: String,
    command_line: String,
    target_command: String,
    cwd: Option<&std::path::Path>,
) -> InstallDone {
    let mut cmd = shell_command(&command_line);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.env("PATH", agents::effective_path())
        .env("NO_COLOR", "1")
        .env("CI", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let done = |code, cancelled, timed_out, output_tail: String| InstallDone {
        code,
        cancelled,
        timed_out,
        output_tail,
        resolved: agents::resolve_command(&target_command).is_some(),
    };

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return done(None, false, false, format!("could not start the installer: {e}")),
    };
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(child));
    runs.running.insert(agent_id.clone(), child.clone());

    let app_o = app.clone();
    let id_o = agent_id.clone();
    let mut tail = String::new();
    let out_thread = std::thread::spawn(move || {
        let Some(out) = stdout.as_mut() else { return String::new() };
        let mut buf = [0u8; 4096];
        let mut carry: Vec<u8> = Vec::new();
        let mut all = String::new();
        loop {
            match out.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    carry.extend_from_slice(&buf[..n]);
                    let valid = match std::str::from_utf8(&carry) {
                        Ok(_) => carry.len(),
                        Err(e) => e.valid_up_to(),
                    };
                    if valid > 0 {
                        let text = String::from_utf8_lossy(&carry[..valid]).into_owned();
                        let _ = app_o.emit(&format!("install-out:{id_o}"), &text);
                        all.push_str(&text);
                        carry.drain(..valid);
                    }
                }
            }
        }
        if !carry.is_empty() {
            let text = String::from_utf8_lossy(&carry).into_owned();
            let _ = app_o.emit(&format!("install-out:{id_o}"), &text);
            all.push_str(&text);
        }
        all
    });
    let err_thread = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(e) = stderr.as_mut() {
            let _ = e.read_to_string(&mut s);
        }
        s
    });

    let started = Instant::now();
    let mut timed_out = false;
    let status = loop {
        let polled = child.lock().map(|mut c| c.try_wait());
        match polled {
            Ok(Ok(Some(status))) => break Some(status),
            Ok(Ok(None)) => {}
            _ => break None,
        }
        if started.elapsed() > INSTALL_TIMEOUT {
            timed_out = true;
            if let Ok(mut c) = child.lock() {
                let _ = c.kill();
            }
        }
        std::thread::sleep(Duration::from_millis(150));
    };
    let out = out_thread.join().unwrap_or_default();
    let err = err_thread.join().unwrap_or_default();
    tail.push_str(&out);
    if !err.trim().is_empty() {
        if !tail.is_empty() {
            tail.push('\n');
        }
        tail.push_str(&err);
    }
    let cancelled = runs.running.remove(&agent_id).is_none();
    let chars: Vec<char> = tail.chars().collect();
    let tail: String = chars[chars.len().saturating_sub(4000)..].iter().collect();
    done(status.and_then(|s| s.code()), cancelled, timed_out, tail)
}

/// Stop a running install. It finishes with `cancelled: true`.
pub fn cancel(runs: &InstallRuns, agent_id: &str) -> bool {
    match runs.running.remove(agent_id) {
        Some((_, child)) => {
            if let Ok(mut c) = child.lock() {
                let _ = c.kill();
            }
            true
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn echoed_output_is_captured_and_agent_resolves_after() {
        let runs = InstallRuns::default();
        // "cmd" itself is always resolvable, so this exercises the success
        // path without needing a fake AppHandle: resolved should be true
        // for a command that's trivially on PATH.
        #[cfg(windows)]
        let (cmd_line, target) = ("Write-Output hello-install", "powershell");
        #[cfg(not(windows))]
        let (cmd_line, target) = ("echo hello-install", "sh");
        // Building a real AppHandle without a running app isn't possible from
        // a unit test; exercise the pure parts instead via shell_command and
        // a manual spawn+wait, matching what `run` does minus the event emit.
        let mut cmd = shell_command(cmd_line);
        cmd.stdout(Stdio::piped());
        let mut child = cmd.spawn().expect("spawn");
        let mut out = String::new();
        child.stdout.take().unwrap().read_to_string(&mut out).unwrap();
        let status = child.wait().unwrap();
        assert!(status.success());
        assert!(out.contains("hello-install"));
        assert!(agents::resolve_command(target).is_some());
        let _ = runs; // runs/cancel wiring is covered by the live app smoke test
    }

    #[test]
    fn cancel_on_an_unknown_run_is_a_harmless_false() {
        let runs = InstallRuns::default();
        assert!(!cancel(&runs, "no-such-agent"));
    }
}
