//! Agent definitions and PATH resolution.
//!
//! An agent is a CLI the app can launch (claude, codex, …) with a set of
//! model and mode variants whose args are appended to the launch line.
//! Arguments only ever come from this file, never the frontend, so a
//! compromised page cannot talk the backend into running an arbitrary
//! command line.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Variant {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct AgentDef {
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub vendor: String,
    #[serde(default)]
    pub icon: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub modes: Vec<Variant>,
    #[serde(default)]
    pub models: Vec<Variant>,
    /// Per-session reasoning effort choices supported by this CLI. Empty means
    /// the agent does not expose a portable effort control.
    #[serde(default)]
    pub efforts: Vec<Variant>,
    /// How this CLI attaches ezCLI's PC-control MCP server: "claude", "codex"
    /// or "none". Omitted = inferred from the command name, so configs written
    /// before this field existed keep working.
    #[serde(default)]
    pub mcp: Option<String>,
    /// "free" marks agents usable without any paid plan; the wizard routes
    /// users without a paid backend to these.
    #[serde(default)]
    pub tier: Option<String>,
    /// Ask the agent itself which models are usable instead of hardcoding a
    /// list that goes stale. See `parse_catalog`.
    #[serde(default, rename = "modelsFrom")]
    pub models_from: Option<ModelsFrom>,
    /// Shell command shown to users who don't have this agent yet. Display
    /// only; ezCLI never runs it.
    #[serde(default)]
    pub install: Option<String>,
}

/// Run `<command> <args>` to list models (one `provider/model` per line), then
/// launch a chosen one with `<flag> <model>`.
#[derive(Deserialize, Clone, Debug)]
pub struct ModelsFrom {
    pub args: Vec<String>,
    pub flag: String,
}

/// The agents.json shipped with the app. New built-in agents are merged into a
/// user's existing config so people who installed earlier still get them.
pub const BUILTIN: &str = include_str!("../../agents.json");

/// The two attach mechanisms verified against the installed CLIs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum McpStyle {
    /// `claude --mcp-config <file.json>`
    Claude,
    /// `codex -c mcp_servers.<name>.url=<url>`
    Codex,
}

impl AgentDef {
    pub fn mcp_style(&self) -> Option<McpStyle> {
        // Both built-in Claude entries launch the same executable, but only
        // the coding-agent preset is allowed to receive PC-control tools.
        // Keep this guard in Rust so an older ~/.ezcli/agents.json cannot
        // accidentally turn the chat preset into a privileged backend.
        if self.id == "claude-chat" {
            return None;
        }
        let named = match self.mcp.as_deref().map(str::to_ascii_lowercase).as_deref() {
            Some("claude") => return Some(McpStyle::Claude),
            Some("codex") => return Some(McpStyle::Codex),
            Some(_) => return None, // "none" or anything unrecognised
            None => Path::new(&self.command)
                .file_stem()
                .and_then(|s| s.to_str())
                .map(str::to_ascii_lowercase),
        };
        match named.as_deref() {
            Some("claude") => Some(McpStyle::Claude),
            Some("codex") => Some(McpStyle::Codex),
            _ => None,
        }
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct AgentOut {
    pub id: String,
    pub label: String,
    pub vendor: String,
    pub icon: String,
    pub command: String,
    pub args: Vec<String>,
    pub modes: Vec<Variant>,
    pub models: Vec<Variant>,
    pub efforts: Vec<Variant>,
    pub available: bool,
    pub resolved: Option<String>,
    /// Whether ezCLI knows how to attach PC control to this CLI.
    pub pc_control: bool,
    /// Usable without any paid plan.
    pub free: bool,
    /// The Model pill can be filled from the agent's own catalog.
    pub dynamic_models: bool,
    pub install: Option<String>,
}

#[derive(Deserialize)]
struct AgentsFile {
    agents: Vec<AgentDef>,
}

pub fn load_agents(path: &Path) -> Result<Vec<AgentDef>> {
    let txt = std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let mut file: AgentsFile = serde_json::from_str(&txt).context("parse agents.json")?;
    merge_builtin(&mut file.agents);

    let mut seen = std::collections::HashSet::new();
    let mut agents = Vec::with_capacity(file.agents.len());
    for mut a in file.agents {
        if a.id.trim().is_empty() {
            anyhow::bail!("agent entry has empty id");
        }
        if !seen.insert(a.id.clone()) {
            anyhow::bail!("duplicate agent id: {}", a.id);
        }
        if a.command.trim().is_empty() {
            anyhow::bail!("agent {} has empty command", a.id);
        }
        if a.label.is_empty() {
            a.label = a.id.clone();
        }
        if a.icon.is_empty() {
            a.icon = "term".into();
        }
        if a.modes.is_empty() {
            a.modes.push(default_variant());
        }
        if a.models.is_empty() {
            a.models.push(default_variant());
        }
        agents.push(a);
    }
    Ok(agents)
}

/// Append built-in agents whose id the user's file doesn't have. The user's
/// own entries always win, including deliberately edited built-ins; removing a
/// built-in is done with an entry whose command is set to something absent.
fn merge_builtin(user: &mut Vec<AgentDef>) {
    let Ok(builtin) = serde_json::from_str::<AgentsFile>(BUILTIN) else {
        return;
    };
    for builtin_agent in builtin.agents {
        if let Some(existing) = user.iter_mut().find(|u| u.id == builtin_agent.id) {
            // Existing configurations are authoritative, but a missing effort
            // list is a safe additive capability for an unchanged built-in
            // command. That lets old first-run configs receive this UI feature
            // without overwriting a custom command or its launch flags.
            if existing.efforts.is_empty()
                && !builtin_agent.efforts.is_empty()
                && existing.command.eq_ignore_ascii_case(&builtin_agent.command)
            {
                existing.efforts = builtin_agent.efforts.clone();
            }
            // This explicit value makes the built-in boundary visible in the
            // runtime config too; mcp_style() enforces it independently.
            if existing.id == "claude-chat" {
                existing.mcp = Some("none".into());
            }
        } else {
            user.push(builtin_agent);
        }
    }
}

/// Parse a model catalog printed one `provider/model` per line. Anything else
/// (banners, blank lines, log noise) is ignored, so a catalog command can never
/// smuggle arbitrary text into a launch argument.
pub fn parse_catalog(stdout: &str) -> Vec<String> {
    let mut out: Vec<String> = stdout
        .lines()
        .map(str::trim)
        .filter(|l| {
            let mut parts = l.splitn(2, '/');
            let (Some(p), Some(m)) = (parts.next(), parts.next()) else { return false };
            let ok = |s: &str, extra: &str| {
                !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c) || extra.contains(c))
            };
            // Must start alphanumeric: an id like `--x/y` would be read as an
            // option by the agent's own argument parser.
            let starts_ok = l.chars().next().is_some_and(|c| c.is_ascii_alphanumeric());
            l.len() <= 200 && starts_ok && ok(p, "") && ok(m, ":/@")
        })
        .map(str::to_string)
        .collect();
    out.sort();
    out.dedup();
    out.truncate(1000);
    out
}

fn default_variant() -> Variant {
    Variant {
        id: "default".into(),
        label: "Default".into(),
        args: vec![],
    }
}

/// Walks PATH (and PATHEXT on Windows, so a `.cmd` npm shim resolves the
/// same as an `.exe`) and returns the absolute path of the first match.
pub fn resolve_command(cmd: &str) -> Option<String> {
    let as_path = Path::new(cmd);
    if as_path.components().count() > 1 {
        return if as_path.is_file() {
            Some(cmd.to_string())
        } else {
            None
        };
    }

    let path_env = std::env::var_os("PATH")?;
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
            .split(';')
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect()
    } else {
        vec![String::new()]
    };

    for dir in std::env::split_paths(&path_env) {
        for ext in &exts {
            let candidate: PathBuf = dir.join(format!("{}{}", cmd, ext));
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    None
}

pub fn describe(agents: &[AgentDef]) -> Vec<AgentOut> {
    agents
        .iter()
        .map(|a| {
            let resolved = resolve_command(&a.command);
            AgentOut {
                id: a.id.clone(),
                label: a.label.clone(),
                vendor: a.vendor.clone(),
                icon: a.icon.clone(),
                command: a.command.clone(),
                args: a.args.clone(),
                modes: a.modes.clone(),
                models: a.models.clone(),
                efforts: a.efforts.clone(),
                available: resolved.is_some(),
                resolved,
                pc_control: a.mcp_style().is_some(),
                free: a.tier.as_deref().is_some_and(|t| t.eq_ignore_ascii_case("free")),
                dynamic_models: a.models_from.is_some(),
                install: a.install.clone(),
            }
        })
        .collect()
}

/// Build the launch argument list for a given effort/model/mode selection.
/// A model id that isn't one of the static variants is accepted only if it
/// appears in the catalog the backend itself fetched from the agent, so the
/// frontend still cannot inject an arbitrary argument. Global effort and model
/// flags deliberately precede a mode subcommand such as `codex resume`.
pub fn build_argv(
    a: &AgentDef,
    mode_id: &str,
    model_id: &str,
    effort_id: &str,
    catalog: Option<&[String]>,
) -> Vec<String> {
    let mut out = a.args.clone();
    if let Some(e) = a.efforts.iter().find(|v| v.id == effort_id) {
        out.extend(e.args.clone());
    }
    if let Some(m) = a.models.iter().find(|v| v.id == model_id) {
        out.extend(m.args.clone());
    } else if let (Some(from), Some(cat)) = (&a.models_from, catalog) {
        if cat.iter().any(|c| c == model_id) {
            out.push(from.flag.clone());
            out.push(model_id.to_string());
        }
    }
    if let Some(m) = a.modes.iter().find(|v| v.id == mode_id) {
        out.extend(m.args.clone());
    }
    out
}

/// portable-pty calls CreateProcessW directly on Windows, which cannot launch
/// a `.cmd`/`.bat` shim as an executable. npm installs its global CLIs as those
/// shims, so route them through cmd.exe while keeping the generated arguments
/// separate. The arguments are still constrained to agents.json or a
/// backend-validated model catalog.
pub fn launch_command(resolved: &str, args: &[String]) -> (String, Vec<String>) {
    let lower = resolved.to_ascii_lowercase();
    if cfg!(windows) && lower.ends_with(".ps1") {
        let mut wrapped = vec![
            "-NoLogo".to_string(),
            "-NoProfile".to_string(),
            "-ExecutionPolicy".to_string(),
            "Bypass".to_string(),
            "-File".to_string(),
            resolved.to_string(),
        ];
        wrapped.extend(args.iter().cloned());
        ("powershell.exe".to_string(), wrapped)
    } else if cfg!(windows) && (lower.ends_with(".cmd") || lower.ends_with(".bat")) {
        let mut wrapped = vec![
            "/d".to_string(),
            "/s".to_string(),
            "/c".to_string(),
            resolved.to_string(),
        ];
        wrapped.extend(args.iter().cloned());
        ("cmd.exe".to_string(), wrapped)
    } else {
        (resolved.to_string(), args.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn def(command: &str, mcp: Option<&str>) -> AgentDef {
        AgentDef {
            id: "x".into(),
            label: "X".into(),
            vendor: String::new(),
            icon: String::new(),
            command: command.into(),
            args: vec![],
            modes: vec![],
            models: vec![],
            efforts: vec![],
            mcp: mcp.map(Into::into),
            tier: None,
            models_from: None,
            install: None,
        }
    }

    #[test]
    fn catalog_parsing_keeps_only_provider_model_lines() {
        let out = "banner text\n\nopencode/deepseek-v4.1-flash-free\nopenrouter/meta-llama/llama-4:free\n  ollama/qwen3:8b  \nrm -rf /\n--flag/x\nhttp://evil/x\nopencode/deepseek-v4.1-flash-free\n";
        assert_eq!(
            parse_catalog(out),
            vec![
                "ollama/qwen3:8b".to_string(),
                "opencode/deepseek-v4.1-flash-free".to_string(),
                "openrouter/meta-llama/llama-4:free".to_string(),
            ]
        );
    }

    #[test]
    fn catalog_models_are_only_used_when_the_backend_fetched_them() {
        let mut a = def("opencode", Some("none"));
        a.models_from = Some(ModelsFrom { args: vec!["models".into()], flag: "-m".into() });
        let cat = vec!["opencode/free-model".to_string()];
        assert_eq!(build_argv(&a, "x", "opencode/free-model", "default", Some(&cat)), vec!["-m", "opencode/free-model"]);
        // Not in the fetched catalog: ignored rather than passed through.
        assert!(build_argv(&a, "x", "--dangerous", "default", Some(&cat)).is_empty());
        assert!(build_argv(&a, "x", "opencode/free-model", "default", None).is_empty());
    }

    #[test]
    fn global_effort_and_model_flags_precede_a_mode_subcommand() {
        let mut a = def("codex", Some("codex"));
        a.args = vec!["--no-daemon".into()];
        a.efforts = vec![Variant { id: "high".into(), label: "High".into(), args: vec!["-c".into(), "model_reasoning_effort=\"high\"".into()] }];
        a.models = vec![Variant { id: "gpt".into(), label: "GPT".into(), args: vec!["-m".into(), "gpt-5".into()] }];
        a.modes = vec![Variant { id: "resume".into(), label: "Resume".into(), args: vec!["resume".into(), "--last".into()] }];
        assert_eq!(
            build_argv(&a, "resume", "gpt", "high", None),
            vec!["--no-daemon", "-c", "model_reasoning_effort=\"high\"", "-m", "gpt-5", "resume", "--last"]
        );
    }

    #[test]
    fn builtin_agents_are_merged_without_overriding_user_entries() {
        let mut user = vec![def("my-claude", None)];
        user[0].id = "claude-code".into();
        merge_builtin(&mut user);
        assert_eq!(user.iter().filter(|a| a.id == "claude-code").count(), 1);
        assert_eq!(user[0].command, "my-claude", "user's edit wins");
        for id in ["opencode", "gemini", "freebuff"] {
            assert!(user.iter().any(|a| a.id == id), "missing built-in {id}");
        }
    }

    #[test]
    fn mcp_style_is_inferred_from_the_command_for_older_configs() {
        assert_eq!(def("claude", None).mcp_style(), Some(McpStyle::Claude));
        assert_eq!(def(r"C:\npm\claude.cmd", None).mcp_style(), Some(McpStyle::Claude));
        assert_eq!(def("codex", None).mcp_style(), Some(McpStyle::Codex));
        assert_eq!(def("chatgpt", None).mcp_style(), None);
    }

    #[test]
    fn explicit_mcp_field_wins_including_opt_out() {
        assert_eq!(def("claude", Some("none")).mcp_style(), None);
        assert_eq!(def("my-wrapper", Some("codex")).mcp_style(), Some(McpStyle::Codex));
    }

    #[test]
    fn claude_chat_never_inherits_claude_code_pc_control() {
        let mut chat = def("claude", Some("claude"));
        chat.id = "claude-chat".into();
        assert_eq!(chat.mcp_style(), None);
    }

    #[test]
    fn old_builtin_entries_receive_effort_options_without_replacing_commands() {
        let mut user = vec![def("claude", None)];
        user[0].id = "claude-code".into();
        merge_builtin(&mut user);
        assert!(user[0].efforts.iter().any(|e| e.id == "high"));
        assert_eq!(user[0].command, "claude");
    }

    #[cfg(windows)]
    #[test]
    fn cmd_shims_are_wrapped_for_the_native_pty() {
        let args = vec!["-m".into(), "opencode/free-model".into()];
        assert_eq!(
            launch_command(r"C:\\npm\\opencode.cmd", &args),
            (
                "cmd.exe".into(),
                vec!["/d", "/s", "/c", r"C:\\npm\\opencode.cmd", "-m", "opencode/free-model"]
                    .into_iter()
                    .map(str::to_string)
                    .collect()
            )
        );
    }

    #[cfg(windows)]
    fn run_in_native_pty(program: String, args: Vec<String>) -> (portable_pty::ExitStatus, String) {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize, PtySystem, SlavePty};
        use std::io::Read;

        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new(program);
        for arg in args {
            command.arg(arg);
        }
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env_remove("NO_COLOR");
        command.env("FORCE_COLOR", "3");
        let mut child = pair.slave.spawn_command(command).unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        drop(pair.slave);
        let reader = std::thread::spawn(move || {
            let mut output = String::new();
            reader.read_to_string(&mut output).unwrap();
            output
        });
        let status = child.wait().unwrap();
        // Keep the ConPTY master alive until its child completes. Dropping it
        // before wait tears down the pseudo console and makes cmd.exe fail to
        // initialize; dropping it now lets the reader observe EOF.
        drop(pair.master);
        let output = reader.join().unwrap();
        (status, output)
    }

    #[cfg(windows)]
    #[test]
    fn batch_shim_runs_in_the_same_native_pty_as_an_agent() {
        let path = std::env::temp_dir().join(format!("ezcli-pty-shim-{}.cmd", std::process::id()));
        std::fs::write(&path, "@echo off\r\necho ezcli-pty-shim-ok\r\n").unwrap();
        let (program, args) = launch_command(&path.to_string_lossy(), &[]);
        let (status, output) = run_in_native_pty(program, args);
        let _ = std::fs::remove_file(&path);
        assert!(status.success(), "batch shim exited with {}: {output}", status.exit_code());
        assert!(output.contains("ezcli-pty-shim-ok"), "unexpected output: {output}");
    }

    /// Opt-in integration check for the exact Windows path the app uses.
    /// `scripts\test-rust.ps1 --ignored --nocapture real_opencode_pty`
    /// launches npm's opencode.cmd through a native ConPTY, but does not call
    /// a model or consume provider usage.
    #[cfg(windows)]
    #[test]
    #[ignore = "runs the installed OpenCode npm shim in a real native PTY"]
    fn real_opencode_cmd_shim_starts_in_native_pty() {
        let resolved = resolve_command("opencode").expect("opencode on PATH");
        assert!(resolved.to_ascii_lowercase().ends_with(".cmd"));
        let (program, args) = launch_command(&resolved, &["--version".into()]);
        let (status, output) = run_in_native_pty(program, args);
        assert!(status.success(), "opencode exited with {}: {output}", status.exit_code());
        assert!(output.chars().any(|c| c.is_ascii_digit()), "unexpected output: {output}");
    }
}
