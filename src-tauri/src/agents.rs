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
    /// How this CLI attaches ezCLI's PC-control MCP server: "claude", "codex"
    /// or "none". Omitted = inferred from the command name, so configs written
    /// before this field existed keep working.
    #[serde(default)]
    pub mcp: Option<String>,
}

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
    pub available: bool,
    pub resolved: Option<String>,
    /// Whether ezCLI knows how to attach PC control to this CLI.
    pub pc_control: bool,
}

#[derive(Deserialize)]
struct AgentsFile {
    agents: Vec<AgentDef>,
}

pub fn load_agents(path: &Path) -> Result<Vec<AgentDef>> {
    let txt = std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let file: AgentsFile = serde_json::from_str(&txt).context("parse agents.json")?;

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
                available: resolved.is_some(),
                resolved,
                pc_control: a.mcp_style().is_some(),
            }
        })
        .collect()
}

/// Build the launch argument list for a given mode/model selection.
pub fn build_argv(a: &AgentDef, mode_id: &str, model_id: &str) -> Vec<String> {
    let mut out = a.args.clone();
    if let Some(m) = a.modes.iter().find(|v| v.id == mode_id) {
        out.extend(m.args.clone());
    }
    if let Some(m) = a.models.iter().find(|v| v.id == model_id) {
        out.extend(m.args.clone());
    }
    out
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
            mcp: mcp.map(Into::into),
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
}
