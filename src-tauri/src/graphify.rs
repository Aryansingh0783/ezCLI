//! Graphify (https://github.com/safishamsi/graphify, PyPI `graphifyy`): a
//! third-party tool that turns a project into a queryable knowledge graph and
//! installs itself as a skill into coding agents. ezCLI only runs Graphify's
//! own documented commands, chosen from a fixed list here — no user text ever
//! reaches the shell — and the frontend shows each exact command and waits
//! for a confirming click first.

use crate::{agents, install, AppState};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};

/// Run key and event suffix (`install-out:graphify`, `install-done:graphify`).
const KEY: &str = "graphify";

/// Graphify's own per-agent install command for each built-in agent that has one.
fn agent_setup_command(agent_id: &str) -> Option<&'static str> {
    Some(match agent_id {
        // Graphify ships a separate Claude Code target for Windows.
        "claude-code" if cfg!(windows) => "graphify install --platform windows",
        "claude-code" => "graphify install --platform claude",
        "codex" => "graphify install --platform codex",
        "gemini" => "graphify install --platform gemini",
        "opencode" | "deepseek" => "graphify install --platform opencode",
        "antigravity" => "graphify install --platform antigravity",
        _ => return None,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphifyStatus {
    pub installed: bool,
    /// The installer ezCLI would use, if any Python tool installer was found.
    pub installer: Option<String>,
    /// `graphify-out/graph.html` for the given folder, if it exists.
    pub graph_html: Option<String>,
    /// Installed agents Graphify can set itself up in, as display labels.
    pub agents: Vec<String>,
}

fn installer_command() -> Option<String> {
    if agents::resolve_command("uv").is_some() {
        Some("uv tool install graphifyy".into())
    } else if agents::resolve_command("pipx").is_some() {
        Some("pipx install graphifyy".into())
    } else if agents::resolve_command("python").is_some() {
        Some("python -m pip install --user graphifyy".into())
    } else if agents::resolve_command("python3").is_some() {
        Some("python3 -m pip install --user graphifyy".into())
    } else {
        None
    }
}

fn graph_html(folder: &Path) -> PathBuf {
    folder.join("graphify-out").join("graph.html")
}

fn folder_arg(cwd: Option<String>) -> Result<PathBuf, String> {
    let dir = PathBuf::from(cwd.filter(|c| !c.trim().is_empty()).ok_or("Open a project folder first.")?);
    if !dir.is_dir() {
        return Err(format!("{} is not a folder.", dir.display()));
    }
    // Indexing a whole profile or drive would run for hours and graph
    // everything on it; a project graph needs an actual project folder.
    let is_home = dirs::home_dir().is_some_and(|h| h == dir);
    if is_home || dir.parent().is_none() {
        return Err("That's your home folder or a drive root, too big to graph. Open a project folder (or start a session in one) first.".into());
    }
    Ok(dir)
}

/// Installed built-in agents Graphify supports: (label, setup command).
fn setup_targets(state: &AppState) -> Vec<(String, &'static str)> {
    let agents_g = state.agents.lock().unwrap();
    let mut seen = std::collections::HashSet::new();
    agents_g
        .iter()
        .filter_map(|a| {
            let cmd = agent_setup_command(&a.id)?;
            agents::resolve_command(&a.command)?;
            seen.insert(cmd).then(|| (a.label.clone(), cmd))
        })
        .collect()
}

/// The exact command line an action would run. Shown to the user before
/// `graphify_run` executes the very same plan.
fn plan(action: &str, state: &AppState) -> Result<String, String> {
    match action {
        "install" => installer_command().ok_or_else(|| {
            "Graphify needs Python. Install uv (https://docs.astral.sh/uv/) or Python 3, then try again.".to_string()
        }),
        "setup" => {
            let targets = setup_targets(state);
            if targets.is_empty() {
                return Err("None of your installed agents has a Graphify integration.".into());
            }
            Ok(targets.iter().map(|(_, c)| *c).collect::<Vec<_>>().join("; "))
        }
        // Code-only extraction is local (tree-sitter) and needs no API key.
        // extract writes graph.json; cluster-only adds GRAPH_REPORT.md and
        // graph.html. --no-label skips the LLM community-naming pass.
        "build" => Ok(if cfg!(windows) {
            "graphify extract . --code-only; if ($LASTEXITCODE -eq 0) { graphify cluster-only . --no-label }"
        } else {
            "graphify extract . --code-only && graphify cluster-only . --no-label"
        }
        .into()),
        _ => Err(format!("unknown Graphify action {action:?}")),
    }
}

#[tauri::command]
pub fn graphify_status(cwd: Option<String>, state: State<'_, AppState>) -> GraphifyStatus {
    GraphifyStatus {
        installed: agents::resolve_command("graphify").is_some(),
        installer: installer_command(),
        graph_html: cwd
            .map(PathBuf::from)
            .map(|d| graph_html(&d))
            .filter(|p| p.is_file())
            .map(|p| p.to_string_lossy().into_owned()),
        agents: setup_targets(&state).into_iter().map(|(l, _)| l).collect(),
    }
}

/// Open the project's interactive graph in the default browser. The path is
/// always `<folder>/graphify-out/graph.html`, never one the page supplies.
#[tauri::command]
pub fn graphify_open(cwd: Option<String>) -> Result<(), String> {
    let html = graph_html(&folder_arg(cwd)?);
    if !html.is_file() {
        return Err("No graph yet for this folder. Build it first.".into());
    }
    tauri_plugin_opener::open_path(&html, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn graphify_plan(action: String, cwd: Option<String>, state: State<'_, AppState>) -> Result<String, String> {
    if action == "build" {
        folder_arg(cwd)?;
    }
    plan(&action, &state)
}

#[tauri::command]
pub async fn graphify_run(
    action: String,
    cwd: Option<String>,
    state: State<'_, AppState>,
    runs: State<'_, std::sync::Arc<install::InstallRuns>>,
    app: AppHandle,
) -> Result<install::InstallDone, String> {
    let command_line = plan(&action, &state)?;
    let dir = match action.as_str() {
        "build" => Some(folder_arg(cwd)?),
        // Graphify's per-agent installers also write project-level files
        // (.opencode/plugins, GEMINI.md, ...) into the current directory. The
        // skills go to the user profile regardless, so run from a scratch
        // folder rather than the app's install dir or one of the user's repos.
        "setup" => {
            let scratch = std::env::temp_dir().join("ezcli-graphify-setup");
            std::fs::create_dir_all(&scratch).map_err(|e| e.to_string())?;
            Some(scratch)
        }
        _ => None,
    };
    if runs.contains_running(KEY) {
        return Err("A Graphify command is already running.".into());
    }
    let runs = runs.inner().clone();
    let app2 = app.clone();
    let done = tauri::async_runtime::spawn_blocking(move || {
        install::run_in(app2, &runs, KEY.into(), command_line, "graphify".into(), dir.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?;
    let _ = app.emit(&format!("install-done:{KEY}"), done.clone());
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_agents_with_a_graphify_target_get_a_setup_command() {
        assert!(agent_setup_command("codex").is_some());
        assert_eq!(agent_setup_command("deepseek"), agent_setup_command("opencode"));
        assert!(agent_setup_command("ollama").is_none());
        assert!(agent_setup_command("claude-chat").is_none());
    }
}
