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
fn build_command() -> String {
    // Folders that are caches, build output or vendored copies rather than the
    // project's own code. Without these a Unity project alone indexes ~66,000
    // package-cache symbols and the graph becomes unreadable.
    const SKIP: [&str; 17] = [
        "Library", "Temp", "Obj", "Logs", "UserSettings", "node_modules", "target", "dist", "build", ".venv", "venv", "__pycache__", "Pods", ".gradle", "vendor", "_vendor",
        "third_party",
    ];
    let excludes: String = SKIP.iter().map(|d| format!(" --exclude \"{d}/**\"")).collect();
    let extract = format!("graphify extract . --code-only{excludes}");
    if cfg!(windows) {
        format!("{extract}; if ($LASTEXITCODE -eq 0) {{ graphify cluster-only . --no-label }}")
    } else {
        format!("{extract} && graphify cluster-only . --no-label")
    }
}

/// Obsidian's own documented package-manager installs; nothing is downloaded
/// from anywhere else, and the user confirms the exact command first.
fn obsidian_install_command() -> Option<&'static str> {
    if cfg!(windows) && agents::resolve_command("winget").is_some() {
        Some("winget install --id Obsidian.Obsidian -e --accept-package-agreements --accept-source-agreements")
    } else if cfg!(target_os = "macos") && agents::resolve_command("brew").is_some() {
        Some("brew install --cask obsidian")
    } else if cfg!(target_os = "linux") && agents::resolve_command("flatpak").is_some() {
        Some("flatpak install -y flathub md.obsidian.Obsidian")
    } else {
        None
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
        "build" => Ok(build_command()),
        "obsidian" => obsidian_install_command().map(String::from).ok_or_else(|| {
            "No supported package manager found (winget, Homebrew or Flatpak). Download Obsidian from https://obsidian.md instead.".to_string()
        }),
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

/// Where the second brain's viewer and Obsidian notes live.
fn brain_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(std::env::temp_dir).join(".ezcli").join("second-brain")
}

/// Project folders (from the app's own list of spaces) that already have a
/// graph, with a unique display name each. Paths that could break out of a
/// quoted shell string are skipped.
fn project_graphs(paths: &[String]) -> Vec<(String, PathBuf, PathBuf)> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for p in paths {
        if p.chars().any(|c| matches!(c, '\'' | '"' | '`' | '$' | '\n' | '\r' | ';' | '&' | '|' | '<' | '>')) {
            continue;
        }
        let dir = PathBuf::from(p);
        let graph = dir.join("graphify-out").join("graph.json");
        if !graph.is_file() || !seen.insert(dir.clone()) {
            continue;
        }
        let base = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "project".into());
        let mut name = base.clone();
        let mut n = 2;
        while out.iter().any(|(existing, _, _): &(String, PathBuf, PathBuf)| existing == &name) {
            name = format!("{base} {n}");
            n += 1;
        }
        out.push((name, dir, graph));
    }
    out
}

fn quote(p: &Path) -> String {
    format!("'{}'", p.to_string_lossy())
}

/// A graph this big (a vendored package cache, say) can't be drawn legibly
/// and would take a long time to read; the user is told to exclude it instead.
const MAX_GRAPH_BYTES: u64 = 150 * 1024 * 1024;
/// The biggest clusters per project that the viewer draws.
const MAX_CLUSTERS: usize = 110;

#[derive(Serialize)]
struct BComm {
    id: i64,
    name: String,
    size: usize,
    top: Vec<[String; 3]>,
    files: Vec<(String, usize)>,
}

#[derive(Serialize)]
struct BProject {
    name: String,
    path: String,
    nodes: usize,
    edges: usize,
    comms: Vec<BComm>,
    links: Vec<(i64, i64, u32)>,
}

#[derive(Serialize)]
struct BData {
    projects: Vec<BProject>,
    skipped: Vec<String>,
}

fn is_placeholder(name: &str) -> bool {
    name.strip_prefix("Community ").is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
}

fn pretty_label(label: &str) -> String {
    label.trim().trim_end_matches("()").to_string()
}

/// Reduce one project's graph to named clusters, their most connected members
/// and the links between clusters.
fn summarize_graph(name: &str, dir: &Path, graph: &Path) -> Result<BProject, String> {
    let text = std::fs::read_to_string(graph).map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("unreadable graph: {e}"))?;
    let nodes = v.get("nodes").and_then(|n| n.as_array()).ok_or("graph has no nodes")?;
    let links = v.get("links").or_else(|| v.get("edges")).and_then(|l| l.as_array()).map(|l| l.as_slice()).unwrap_or(&[]);
    let str_of = |x: &serde_json::Value, k: &str| x.get(k).and_then(|s| s.as_str()).unwrap_or("").to_string();

    let mut degree: std::collections::HashMap<&str, u32> = std::collections::HashMap::new();
    for l in links {
        for end in ["source", "target"] {
            if let Some(id) = l.get(end).and_then(|s| s.as_str()) {
                *degree.entry(id).or_default() += 1;
            }
        }
    }
    let mut comm_of: std::collections::HashMap<&str, i64> = std::collections::HashMap::new();
    struct Group {
        name: String,
        members: Vec<(u32, String, String, String)>,
    }
    let mut groups: std::collections::BTreeMap<i64, Group> = std::collections::BTreeMap::new();
    for n in nodes {
        let id = n.get("id").and_then(|s| s.as_str()).unwrap_or("");
        let c = n.get("community").and_then(|c| c.as_i64()).unwrap_or(-1);
        comm_of.insert(id, c);
        let g = groups.entry(c).or_insert_with(|| Group { name: String::new(), members: Vec::new() });
        let cname = str_of(n, "community_name");
        if g.name.is_empty() && !cname.is_empty() && !is_placeholder(&cname) {
            g.name = cname;
        }
        let label = pretty_label(&str_of(n, "label"));
        g.members.push((degree.get(id).copied().unwrap_or(0), label, str_of(n, "source_file"), str_of(n, "source_location")));
    }
    let mut ranked: Vec<(i64, Group)> = groups.into_iter().collect();
    ranked.sort_by_key(|(_, g)| std::cmp::Reverse(g.members.len()));
    ranked.truncate(MAX_CLUSTERS);
    let kept: std::collections::HashSet<i64> = ranked.iter().map(|(c, _)| *c).collect();

    let comms: Vec<BComm> = ranked
        .into_iter()
        .map(|(id, mut g)| {
            g.members.sort_by_key(|m| std::cmp::Reverse(m.0));
            let mut per_file: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
            for m in &g.members {
                if !m.2.is_empty() {
                    *per_file.entry(m.2.as_str()).or_default() += 1;
                }
            }
            let mut files: Vec<(String, usize)> = per_file.into_iter().map(|(f, n)| (f.to_string(), n)).collect();
            files.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            // File nodes are labelled with their file name, which the name already says.
            let is_file_label = |l: &str| !l.contains('(') && l.rsplit_once('.').is_some_and(|(stem, ext)| !stem.is_empty() && (1..=5).contains(&ext.len()) && ext.chars().all(|c| c.is_ascii_alphanumeric()));
            let tops: Vec<&str> = g.members.iter().map(|m| m.1.as_str()).filter(|l| !l.is_empty() && !is_file_label(l)).take(2).collect();
            // A real name from Graphify if it has one; otherwise say what the cluster
            // is made of: its main file plus its most connected symbols.
            let name = if !g.name.is_empty() {
                g.name.clone()
            } else if let Some((main, n)) = files.first() {
                let base = main.rsplit(['/', '\\']).next().unwrap_or(main);
                let more = if *n * 2 < g.members.len() { format!(" +{} files", files.len() - 1) } else { String::new() };
                if tops.is_empty() { format!("{base}{more}") } else { format!("{base}{more}: {}", tops.join(", ")) }
            } else if tops.is_empty() {
                format!("Cluster {id}")
            } else {
                tops.join(", ")
            };
            files.truncate(8);
            BComm {
                id,
                name,
                size: g.members.len(),
                top: g.members.iter().take(40).map(|m| [m.1.clone(), m.2.clone(), m.3.clone()]).collect(),
                files,
            }
        })
        .collect();

    let mut weight: std::collections::HashMap<(i64, i64), u32> = std::collections::HashMap::new();
    for l in links {
        let (Some(a), Some(b)) = (l.get("source").and_then(|s| s.as_str()), l.get("target").and_then(|s| s.as_str())) else { continue };
        let (Some(&ca), Some(&cb)) = (comm_of.get(a), comm_of.get(b)) else { continue };
        if ca != cb && kept.contains(&ca) && kept.contains(&cb) {
            *weight.entry((ca.min(cb), ca.max(cb))).or_default() += 1;
        }
    }
    let mut cl: Vec<(i64, i64, u32)> = weight.into_iter().map(|((a, b), w)| (a, b, w)).collect();
    cl.sort_by_key(|x| std::cmp::Reverse(x.2));
    cl.truncate(500);

    Ok(BProject { name: name.to_string(), path: dir.to_string_lossy().into_owned(), nodes: nodes.len(), edges: links.len(), comms, links: cl })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrainBuilt {
    pub projects: usize,
    pub skipped: Vec<String>,
}

/// Write the second brain's viewer: one self-contained page (no network, no
/// Graphify viewer) holding every project's named clusters.
fn build_brain(paths: &[String]) -> Result<BrainBuilt, String> {
    let graphs = project_graphs(paths);
    if graphs.is_empty() {
        return Err("No project has a graph yet. One is built automatically when you start a session in a project folder.".into());
    }
    let mut data = BData { projects: Vec::new(), skipped: Vec::new() };
    for (name, dir, graph) in &graphs {
        let size = std::fs::metadata(graph).map(|m| m.len()).unwrap_or(0);
        if size > MAX_GRAPH_BYTES {
            data.skipped.push(format!("{name} ({} MB, too large: add a .graphifyignore for vendored folders)", size / 1_000_000));
            continue;
        }
        match summarize_graph(name, dir, graph) {
            Ok(p) => data.projects.push(p),
            Err(e) => data.skipped.push(format!("{name} ({e})")),
        }
    }
    if data.projects.is_empty() {
        return Err(format!("Nothing to show: {}", data.skipped.join("; ")));
    }
    let json = serde_json::to_string(&data)
        .map_err(|e| e.to_string())?
        .replace("</", "<\\/")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    let html = BRAIN_VIEWER.replacen("/*DATA*/null", &json, 1);
    let dir = brain_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("graph.html"), html).map_err(|e| e.to_string())?;
    // An earlier version merged every graph into one huge file; it is no longer used.
    let _ = std::fs::remove_file(dir.join("merged-graph.json"));
    Ok(BrainBuilt { projects: data.projects.len(), skipped: data.skipped })
}

const BRAIN_VIEWER: &str = include_str!("brain.html");

/// Obsidian notes, one folder per project, using Graphify's own exporter.
/// Large graphs are left out: tens of thousands of notes help no one.
fn vault_plan(paths: &[String]) -> Result<String, String> {
    let vault = brain_dir().join("vault");
    let cmds: Vec<String> = project_graphs(paths)
        .into_iter()
        .filter(|(_, _, g)| std::fs::metadata(g).map(|m| m.len() <= 30 * 1024 * 1024).unwrap_or(false))
        .map(|(name, _, g)| format!("graphify export obsidian --graph {} --dir {}", quote(&g), quote(&vault.join(name))))
        .collect();
    if cmds.is_empty() {
        return Err("No project has a graph small enough to export as notes yet.".into());
    }
    Ok(cmds.join("; "))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrainStatus {
    pub projects: usize,
    pub built: bool,
    pub has_vault: bool,
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
        projects: project_graphs(&paths).len(),
        built: dir.join("graph.html").is_file(),
        has_vault: dir.join("vault").is_dir(),
        vault: dir.join("vault").to_string_lossy().into_owned(),
        obsidian: obsidian_installed(),
    }
}

#[tauri::command]
pub fn brain_vault_plan(paths: Vec<String>) -> Result<String, String> {
    vault_plan(&paths)
}

#[tauri::command]
pub async fn brain_vault_run(
    paths: Vec<String>,
    runs: State<'_, std::sync::Arc<install::InstallRuns>>,
    app: AppHandle,
) -> Result<install::InstallDone, String> {
    let command_line = vault_plan(&paths)?;
    let dir = brain_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let key = "graphify-vault";
    if runs.contains_running(key) {
        return Err("The notes are already being exported.".into());
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

/// Rebuild the second brain's viewer from every project graph.
#[tauri::command]
pub async fn brain_run(paths: Vec<String>) -> Result<BrainBuilt, String> {
    tauri::async_runtime::spawn_blocking(move || build_brain(&paths)).await.map_err(|e| e.to_string())?
}

/// `what`: "graph" (in-app window), "vault" (the folder), or "obsidian".
#[tauri::command]
pub async fn brain_open(what: String, app: AppHandle) -> Result<(), String> {
    let dir = brain_dir();
    match what.as_str() {
        "graph" => show_graph(&app, &dir.join("graph.html"), "Second brain").await,
        "vault" | "obsidian" => {
            let vault = dir.join("vault");
            if !vault.is_dir() {
                return Err("Export the notes first.".into());
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
    // extract is incremental, so the same command builds and refreshes.
    let command_line = build_command();
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
