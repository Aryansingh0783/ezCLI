//! One report of what is installed: every agent CLI and the tools ezCLI uses.
//!
//! Each version comes from running `<command> --version` with a hidden
//! console and a timeout. Sign-in is a presence check of the CLI's own auth
//! file or API-key variable; contents are never read. Anything ezCLI cannot
//! check honestly is reported as "unknown", not guessed.

use crate::agents::{self, AgentDef};
use serde::Serialize;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const VERSION_TIMEOUT: Duration = Duration::from_secs(12);

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentHealth {
    pub id: String,
    pub label: String,
    pub command: String,
    pub path: Option<String>,
    pub version: Option<String>,
    /// "yes", "no" or "unknown".
    pub signed_in: &'static str,
    pub sign_in_hint: Option<String>,
    pub install: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ToolHealth {
    pub name: String,
    pub purpose: String,
    pub path: Option<String>,
    pub version: Option<String>,
    pub install: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HealthReport {
    pub app_version: String,
    pub os: String,
    pub agents: Vec<AgentHealth>,
    pub tools: Vec<ToolHealth>,
}

/// First non-empty line of `<resolved> --version`, trimmed to 120 chars.
fn version_of(resolved: &str) -> Option<String> {
    let launch = agents::launch_command(resolved, &["--version".to_string()]).ok()?;
    let mut cmd = Command::new(&launch.program);
    cmd.args(&launch.args)
        .env("PATH", agents::effective_path())
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let mut stderr = child.stderr.take()?;
    let out = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::Read::read_to_string(&mut stdout, &mut s);
        s
    });
    let err = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::Read::read_to_string(&mut stderr, &mut s);
        s
    });
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() > VERSION_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(40)),
            Err(_) => return None,
        }
    }
    let text = format!("{}\n{}", out.join().unwrap_or_default(), err.join().unwrap_or_default());
    first_version_line(&text)
}

/// Strip ANSI and pick the first line that looks like a version.
fn first_version_line(text: &str) -> Option<String> {
    let clean: String = strip_ansi(text);
    clean
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && l.chars().any(|c| c.is_ascii_digit()))
        .map(|l| l.chars().take(120).collect())
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for n in chars.by_ref() {
                    if n.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

fn home_file(parts: &[&str]) -> bool {
    let Some(mut p) = dirs::home_dir() else { return false };
    for part in parts {
        p.push(part);
    }
    p.exists()
}

fn env_set(key: &str) -> bool {
    std::env::var_os(key).is_some_and(|v| !v.is_empty())
}

/// Presence-only sign-in checks, per built-in agent id.
fn sign_in(a: &AgentDef) -> (&'static str, Option<String>) {
    let yes_no = |b: bool| if b { "yes" } else { "no" };
    match a.id.as_str() {
        "claude-code" | "claude-chat" => (
            yes_no(crate::backends::claude_signed_in() || env_set("ANTHROPIC_API_KEY")),
            Some("Run `claude` once and follow its sign-in, or set ANTHROPIC_API_KEY.".into()),
        ),
        "codex" => (
            yes_no(crate::backends::codex_signed_in() || env_set("OPENAI_API_KEY")),
            Some("Run `codex login`, or set OPENAI_API_KEY.".into()),
        ),
        "gemini" => (
            yes_no(env_set("GEMINI_API_KEY") || env_set("GOOGLE_API_KEY") || home_file(&[".gemini", "oauth_creds.json"])),
            Some("Set GEMINI_API_KEY, or configure Vertex AI. Personal Google sign-in moved to Antigravity.".into()),
        ),
        "ollama-cloud" => (
            "unknown",
            Some("Run `ollama signin` in a terminal. ezCLI cannot see whether it succeeded.".into()),
        ),
        // OpenCode, Ollama Local and Freebuff work without a sign-in, or
        // finish their own setup inside the CLI on first run.
        "opencode" | "ollama" | "freebuff" => ("yes", None),
        _ => ("unknown", None),
    }
}

pub fn report(defs: &[AgentDef]) -> HealthReport {
    // Resolve paths up front, then read every version in parallel so the
    // whole report takes as long as the slowest CLI, not the sum.
    let agent_jobs: Vec<_> = defs
        .iter()
        .map(|a| {
            let path = agents::resolve_command(&a.command);
            let p = path.clone();
            let handle = std::thread::spawn(move || p.as_deref().and_then(version_of));
            (a.clone(), path, handle)
        })
        .collect();

    let tool_specs: &[(&str, &str, &str)] = &[
        ("git", "Changes pane and git actions", "winget install Git.Git"),
        ("node", "Runs npm-installed agents such as Claude Code and Codex", "winget install OpenJS.NodeJS.LTS"),
        ("npm", "Installs and updates npm-based agents", "Installed with Node.js"),
        ("ffmpeg", "Turns videos into frames for agents that cannot read video", "winget install Gyan.FFmpeg"),
        ("ollama", "Runs Ollama Local and Ollama Cloud models", "irm https://ollama.com/install.ps1 | iex"),
    ];
    let tool_jobs: Vec<_> = tool_specs
        .iter()
        .map(|(name, purpose, install)| {
            let path = agents::resolve_command(name);
            let p = path.clone();
            let handle = std::thread::spawn(move || p.as_deref().and_then(version_of));
            (*name, *purpose, *install, path, handle)
        })
        .collect();

    let agents_out = agent_jobs
        .into_iter()
        .map(|(a, path, handle)| {
            let version = handle.join().ok().flatten();
            let (signed_in, sign_in_hint) = if path.is_some() { sign_in(&a) } else { ("unknown", None) };
            AgentHealth {
                id: a.id.clone(),
                label: a.label.clone(),
                command: a.command.clone(),
                path,
                version,
                signed_in,
                sign_in_hint,
                install: a.install.clone(),
            }
        })
        .collect();
    let tools = tool_jobs
        .into_iter()
        .map(|(name, purpose, install, path, handle)| ToolHealth {
            name: name.into(),
            purpose: purpose.into(),
            version: handle.join().ok().flatten(),
            path,
            install: install.into(),
        })
        .collect();

    HealthReport {
        app_version: env!("CARGO_PKG_VERSION").into(),
        os: format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        agents: agents_out,
        tools,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_line_skips_banners_and_ansi() {
        let raw = "\x1b[1m\x1b[32m\n  \nclaude 2.1.282 (Claude Code)\nextra";
        assert_eq!(first_version_line(raw).as_deref(), Some("claude 2.1.282 (Claude Code)"));
        assert_eq!(first_version_line("no digits here"), None);
    }

    #[test]
    #[ignore = "runs the installed git"]
    fn real_git_reports_a_version() {
        let git = agents::resolve_command("git").expect("git on PATH");
        let v = version_of(&git).expect("version");
        assert!(v.contains("git version"), "{v}");
    }
}
