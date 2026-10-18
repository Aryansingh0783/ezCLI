//! Group chat turns: run one agent non-interactively on a prompt and stream
//! its reply back.
//!
//! The frontend runs turns one after another (never two at once, so agents
//! that edit files cannot overwrite each other) and builds each prompt from
//! the shared conversation. This module only runs a single turn: it resolves
//! the agent's own headless command from agents.json, pipes the prompt in (or
//! writes it to a file for CLIs that take one), streams stdout as
//! `group-out:<run>` events and finishes with one `group-done:<run>`.

use crate::agents::{self, AgentDef};
use dashmap::DashMap;
use serde::Serialize;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const TURN_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const MAX_PROMPT_BYTES: usize = 400 * 1024;

#[derive(Default)]
pub struct GroupRuns {
    running: DashMap<String, Arc<Mutex<Child>>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TurnDone {
    pub code: Option<i32>,
    pub cancelled: bool,
    pub timed_out: bool,
    /// The end of stderr, for showing why a turn failed.
    pub stderr_tail: String,
    pub command: String,
}

fn safe_run_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn prompt_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(std::env::temp_dir).join(".ezcli").join("group")
}

/// Everything needed to start a turn, prepared while the agent list is locked.
pub struct Prepared {
    program: String,
    args: Vec<String>,
    shown: String,
    prompt_file: Option<PathBuf>,
}

pub fn prepare(
    a: &AgentDef,
    run_id: &str,
    model_id: &str,
    allow_edits: bool,
    catalog: Option<&[String]>,
    prompt: &str,
) -> Result<Prepared, String> {
    if !safe_run_id(run_id) {
        return Err("invalid run id".into());
    }
    if prompt.len() > MAX_PROMPT_BYTES {
        return Err("This conversation is too long to send. Start a new group chat.".into());
    }
    let h = a.headless.as_ref().ok_or_else(|| format!("{} can't join group chats.", a.label))?;
    if !agents::model_selection_is_valid(a, model_id, catalog) {
        return Err(format!("Choose a valid model for {} first.", a.label));
    }
    let resolved = agents::resolve_command(&a.command).ok_or_else(|| format!("\"{}\" is not on PATH", a.command))?;
    let prompt_file = if h.uses_file() {
        let dir = prompt_dir();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let p = dir.join(format!("{run_id}.md"));
        std::fs::write(&p, prompt).map_err(|e| e.to_string())?;
        Some(p)
    } else {
        None
    };
    let file_arg = prompt_file.as_ref().map(|p| p.to_string_lossy().into_owned());
    let argv = agents::headless_argv(a, model_id, allow_edits, catalog, file_arg.as_deref())
        .ok_or_else(|| format!("{} can't join group chats.", a.label))?;
    let launch = agents::launch_command(&resolved, &argv).map_err(|e| e.to_string())?;
    Ok(Prepared {
        program: launch.program,
        args: launch.args,
        shown: format!("{} {}", a.command, argv.join(" ")),
        prompt_file,
    })
}

/// Run a prepared turn to completion on the calling (blocking) thread.
pub fn run(app: AppHandle, runs: &GroupRuns, run_id: String, p: Prepared, prompt: String, cwd: String) -> TurnDone {
    let mut cmd = Command::new(&p.program);
    cmd.args(&p.args)
        .current_dir(&cwd)
        .env("PATH", agents::effective_path())
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0")
        .env("CI", "1")
        .stdin(if p.prompt_file.is_some() { Stdio::null() } else { Stdio::piped() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let done = |code, cancelled, timed_out, stderr_tail: String| TurnDone { code, cancelled, timed_out, stderr_tail, command: p.shown.clone() };

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return done(None, false, false, format!("could not start: {e}")),
    };
    if let Some(mut stdin) = child.stdin.take() {
        // Write on a thread: a CLI that streams output before reading all of
        // its input would otherwise deadlock against a full pipe.
        std::thread::spawn(move || {
            let _ = stdin.write_all(prompt.as_bytes());
        });
    }
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(child));
    runs.running.insert(run_id.clone(), child.clone());

    let app_o = app.clone();
    let id_o = run_id.clone();
    let out_thread = std::thread::spawn(move || {
        let Some(out) = stdout.as_mut() else { return };
        let mut buf = [0u8; 4096];
        let mut carry: Vec<u8> = Vec::new();
        loop {
            match out.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    carry.extend_from_slice(&buf[..n]);
                    // Emit only whole UTF-8 characters; keep a split one for the next read.
                    let valid = match std::str::from_utf8(&carry) {
                        Ok(_) => carry.len(),
                        Err(e) => e.valid_up_to(),
                    };
                    if valid > 0 {
                        let text = String::from_utf8_lossy(&carry[..valid]).into_owned();
                        let _ = app_o.emit(&format!("group-out:{id_o}"), text);
                        carry.drain(..valid);
                    }
                }
            }
        }
        if !carry.is_empty() {
            let _ = app_o.emit(&format!("group-out:{id_o}"), String::from_utf8_lossy(&carry).into_owned());
        }
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
        if started.elapsed() > TURN_TIMEOUT {
            timed_out = true;
            if let Ok(mut c) = child.lock() {
                let _ = c.kill();
            }
        }
        std::thread::sleep(Duration::from_millis(60));
    };
    let _ = out_thread.join();
    let err = err_thread.join().unwrap_or_default();
    let cancelled = runs.running.remove(&run_id).is_none();
    if let Some(f) = &p.prompt_file {
        let _ = std::fs::remove_file(f);
    }
    let tail: String = {
        let chars: Vec<char> = err.chars().collect();
        chars[chars.len().saturating_sub(1500)..].iter().collect()
    };
    done(status.and_then(|s| s.code()), cancelled, timed_out, tail)
}

/// Stop a running turn. The turn finishes with `cancelled: true`.
pub fn cancel(runs: &GroupRuns, run_id: &str) -> bool {
    match runs.running.remove(run_id) {
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

    fn agent(json: &str) -> AgentDef {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn run_ids_are_restricted() {
        assert!(safe_run_id("g1-t3_a"));
        assert!(!safe_run_id("../x"));
        assert!(!safe_run_id(""));
    }

    #[test]
    fn stdin_and_file_recipes_build_the_expected_argv() {
        let codex = agent(
            r#"{"id":"codex","command":"codex","args":["--no-daemon"],"models":[{"id":"default","label":"Default","args":[]}],
                "modelsFrom":{"args":["debug","models"],"flag":"-m","catalog":"codex"},
                "headless":{"args":["exec","--skip-git-repo-check"],"edit":["--approve-for-me"],"readOnly":["-s","read-only"]}}"#,
        );
        let cat = vec!["gpt-6-luna".to_string()];
        assert_eq!(
            agents::headless_argv(&codex, "gpt-6-luna", true, Some(&cat), None).unwrap(),
            ["--no-daemon", "exec", "--skip-git-repo-check", "-m", "gpt-6-luna", "--approve-for-me"]
        );
        assert_eq!(
            agents::headless_argv(&codex, "default", false, Some(&cat), None).unwrap(),
            ["--no-daemon", "exec", "--skip-git-repo-check", "-s", "read-only"]
        );
        // A model the catalog never listed is dropped, never passed through.
        assert_eq!(
            agents::headless_argv(&codex, "--yolo", true, Some(&cat), None).unwrap(),
            ["--no-daemon", "exec", "--skip-git-repo-check", "--approve-for-me"]
        );

        let opencode = agent(
            r#"{"id":"opencode","command":"opencode","modelsFrom":{"args":["models"],"flag":"-m"},
                "headless":{"args":["run","Reply as asked at the end of the attached file."],"readOnly":["--agent","plan"],"input":"file","fileFlag":"-f"}}"#,
        );
        let cat = vec!["opencode/big-pickle".to_string()];
        assert_eq!(
            agents::headless_argv(&opencode, "opencode/big-pickle", false, Some(&cat), Some("C:\\p.md")).unwrap(),
            ["run", "Reply as asked at the end of the attached file.", "-m", "opencode/big-pickle", "--agent", "plan", "-f", "C:\\p.md"]
        );
        assert!(agents::headless_argv(&opencode, "opencode/big-pickle", false, Some(&cat), None).is_none(), "file recipe needs a file");
    }

    #[test]
    fn shipped_agents_with_group_chat_have_sane_recipes() {
        let mut user = vec![];
        crate::agents::merge_builtin(&mut user);
        let with: Vec<_> = user.iter().filter(|a| a.headless.is_some()).map(|a| a.id.as_str()).collect();
        for id in ["claude-code", "codex", "opencode", "gemini", "ollama", "ollama-cloud", "deepseek"] {
            assert!(with.contains(&id), "{id} should support group chat");
        }
        assert!(!with.contains(&"freebuff"), "freebuff has no verified headless mode");
    }
}
