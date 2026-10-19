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

/// extract writes graph.json; cluster-only adds GRAPH_REPORT.md and graph.html.
/// --no-label skips the LLM community-naming pass; --code-only needs no API key.
fn build_command() -> &'static str {
    if cfg!(windows) {
        "graphify extract . --code-only; if ($LASTEXITCODE -eq 0) { graphify cluster-only . --no-label }"
    } else {
        "graphify extract . --code-only && graphify cluster-only . --no-label"
    }
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
        "build" => Ok(build_command().into()),
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

/// Show a graph.html in an ezCLI window, so it doesn't depend on whatever the
/// system opens `.html` files with. The window label is outside the
/// capabilities manifest, so the page has no ezCLI access.
async fn show_graph(app: &AppHandle, html: &Path, title: &str) -> Result<(), String> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
    if !html.is_file() {
        return Err("No graph yet. Build it first.".into());
    }
    let url = tauri::Url::from_file_path(html).map_err(|_| "Could not open that path.".to_string())?;
    if let Some(win) = app.get_webview_window("graph-view") {
        let _ = win.set_title(title);
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        return win.navigate(url).map_err(|e| e.to_string());
    }
    WebviewWindowBuilder::new(app, "graph-view", WebviewUrl::External(url))
        .title(title)
        .inner_size(1200.0, 820.0)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Open the project's interactive graph. The path is always
/// `<folder>/graphify-out/graph.html`, never one the page supplies.
#[tauri::command]
pub async fn graphify_open(cwd: Option<String>, app: AppHandle) -> Result<(), String> {
    let html = graph_html(&folder_arg(cwd)?);
    show_graph(&app, &html, "Graphify: project graph").await
}

/* ------------------------------------------------------------ second brain */

/// Where the merged graph, its Obsidian vault and its viewer live.
fn brain_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(std::env::temp_dir).join(".ezcli").join("second-brain")
}

/// Project folders (from the app's own list of spaces) that already have a
/// graph. Paths that could break out of a quoted shell string are skipped.
fn graphs_of(paths: &[String]) -> Vec<PathBuf> {
    paths
        .iter()
        .filter(|p| !p.chars().any(|c| matches!(c, '\'' | '"' | '`' | '$' | '\n' | '\r' | ';' | '&' | '|' | '<' | '>')))
        .map(|p| PathBuf::from(p).join("graphify-out").join("graph.json"))
        .filter(|g| g.is_file())
        .collect()
}

fn quote(p: &Path) -> String {
    format!("'{}'", p.to_string_lossy())
}

/// Merge every project graph, export an Obsidian vault, and render the merged
/// graph's viewer, all with Graphify's own commands, run inside the brain
/// folder so nothing is written into a project.
fn brain_plan(paths: &[String]) -> Result<String, String> {
    let graphs = graphs_of(paths);
    if graphs.is_empty() {
        return Err("No project has a graph yet. One is built automatically when you start a session in a project folder.".into());
    }
    let dir = brain_dir();
    let merged = dir.join("merged-graph.json");
    let vault = dir.join("vault");
    let win = cfg!(windows);
    let and = if win { "; if ($LASTEXITCODE -eq 0) { " } else { " && " };
    let close = if win { " }" } else { "" };
    let first = if graphs.len() == 1 {
        format!("{} {} {}", if win { "Copy-Item" } else { "cp" }, quote(&graphs[0]), quote(&merged))
    } else {
        format!(
            "graphify merge-graphs {} --out {}",
            graphs.iter().map(|g| quote(g)).collect::<Vec<_>>().join(" "),
            quote(&merged)
        )
    };
    Ok(format!(
        "{first}{and}graphify export obsidian --graph {m} --dir {v}{and}graphify export html --graph {m}{close}{close}",
        m = quote(&merged),
        v = quote(&vault),
    ))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrainStatus {
    pub projects: usize,
    pub built: bool,
    pub vault: String,
    pub obsidian: bool,
}

#[cfg(windows)]
fn obsidian_installed() -> bool {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("reg")
        .args(["query", r"HKCU\Software\Classes\obsidian"])
        .creation_flags(0x0800_0000)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn obsidian_installed() -> bool {
    false
}

#[tauri::command]
pub fn brain_status(paths: Vec<String>) -> BrainStatus {
    let dir = brain_dir();
    BrainStatus {
        projects: graphs_of(&paths).len(),
        built: dir.join("graph.html").is_file(),
        vault: dir.join("vault").to_string_lossy().into_owned(),
        obsidian: obsidian_installed(),
    }
}

#[tauri::command]
pub fn brain_plan_cmd(paths: Vec<String>) -> Result<String, String> {
    brain_plan(&paths)
}

#[tauri::command]
pub async fn brain_run(
    paths: Vec<String>,
    runs: State<'_, std::sync::Arc<install::InstallRuns>>,
    app: AppHandle,
) -> Result<install::InstallDone, String> {
    let command_line = brain_plan(&paths)?;
    let dir = brain_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let key = "graphify-brain";
    if runs.contains_running(key) {
        return Err("The second brain is already updating.".into());
    }
    let runs = runs.inner().clone();
    let app2 = app.clone();
    let done = tauri::async_runtime::spawn_blocking(move || {
        install::run_in(app2, &runs, key.into(), command_line, "graphify".into(), Some(&dir))
    })
    .await
    .map_err(|e| e.to_string())?;
    let _ = app.emit(&format!("install-done:{key}"), done.clone());
    Ok(done)
}

/// `what`: "graph" (in-app window), "vault" (the folder), or "obsidian".
#[tauri::command]
pub async fn brain_open(what: String, app: AppHandle) -> Result<(), String> {
    let dir = brain_dir();
    match what.as_str() {
        "graph" => show_graph(&app, &dir.join("graph.html"), "Second brain: all projects").await,
        "vault" | "obsidian" => {
            let vault = dir.join("vault");
            if !vault.is_dir() {
                return Err("Update the second brain first.".into());
            }
            if what == "obsidian" && obsidian_installed() {
                let url = format!("obsidian://open?path={}", vault.to_string_lossy().replace('\\', "/").replace(' ', "%20"));
                return tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string());
            }
            tauri_plugin_opener::open_path(&vault, None::<&str>).map_err(|e| e.to_string())
        }
        _ => Err("unknown second-brain target".into()),
    }
}

/* ------------------------------------------------------------ automatic per-project graphs */

/// Build or refresh one project's graph in the background. Only runs when
/// Graphify is already installed, never on a home folder or drive root, and
/// keeps `graphify-out/` out of the project's git status locally (via
/// `.git/info/exclude`, which is never committed).
#[tauri::command]
pub async fn graphify_auto(
    cwd: String,
    runs: State<'_, std::sync::Arc<install::InstallRuns>>,
    app: AppHandle,
) -> Result<String, String> {
    if agents::resolve_command("graphify").is_none() {
        return Ok("skipped: Graphify isn't installed".into());
    }
    let dir = match folder_arg(Some(cwd)) {
        Ok(d) => d,
        Err(e) => return Ok(format!("skipped: {e}")),
    };
    let key = "graphify-auto";
    if runs.contains_running(key) {
        return Ok("skipped: another graph is building".into());
    }
    let git = dir.join(".git");
    if git.is_dir() {
        let exclude = git.join("info").join("exclude");
        let cur = std::fs::read_to_string(&exclude).unwrap_or_default();
        if !cur.lines().any(|l| l.trim() == "graphify-out/") {
            let _ = std::fs::create_dir_all(git.join("info"));
            let sep = if cur.is_empty() || cur.ends_with('\n') { "" } else { "\n" };
            let _ = std::fs::write(&exclude, format!("{cur}{sep}graphify-out/\n"));
        }
    }
    let has_graph = dir.join("graphify-out").join("graph.json").is_file();
    let command_line = if has_graph { "graphify update .".to_string() } else { build_command().to_string() };
    let runs = runs.inner().clone();
    let app2 = app.clone();
    let done = tauri::async_runtime::spawn_blocking(move || {
        install::run_in(app2, &runs, key.into(), command_line, "graphify".into(), Some(&dir))
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(if done.code == Some(0) {
        "built".into()
    } else {
        format!("failed: {}", done.output_tail.lines().last().unwrap_or(""))
    })
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
