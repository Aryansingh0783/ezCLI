//! ezCLI backend — Tauri commands and session state.
//!
//! The frontend (public/) calls these via `window.__TAURI__.core.invoke`
//! and listens to pty-data/pty-exit events. No HTTP server, no WebSocket.

mod agents;
mod backends;
mod capture;
mod files_api;
mod git_api;
mod import;
mod mcp_server;
mod open_in;
mod pc_control;
mod pty_mgr;

use agents::{AgentDef, AgentOut};
use pty_mgr::{SessionStore, SpawnArgs};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};

pub struct AppState {
    agents: Mutex<Vec<AgentDef>>,
    agents_path: PathBuf,
    sessions: SessionStore,
    imports: import::ImportStore,
    pc_control: pc_control::PcControlStore,
    /// Model catalogs fetched from agents that declare `modelsFrom`, keyed by
    /// agent id. `start_session` only accepts catalog models found here.
    catalogs: Mutex<std::collections::HashMap<String, Vec<String>>>,
}

#[derive(Serialize)]
struct AgentsResponse {
    cwd: String,
    home: String,
    platform: String,
    sep: String,
    config_path: String,
    agents: Vec<AgentOut>,
}

#[tauri::command]
fn list_agents(state: State<AppState>) -> AgentsResponse {
    let a = state.agents.lock().unwrap();
    AgentsResponse {
        // Launched-from-Start-Menu puts the process cwd in Program Files,
        // which is not where anyone wants to start a coding session. Default
        // to the user's home instead so new sessions open somewhere useful.
        cwd: default_start_dir(),
        home: dirs::home_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
        platform: std::env::consts::OS.to_string(),
        sep: std::path::MAIN_SEPARATOR.to_string(),
        config_path: state.agents_path.to_string_lossy().into_owned(),
        agents: agents::describe(&a),
    }
}

#[tauri::command]
fn reload_agents(state: State<AppState>) -> Result<Vec<AgentOut>, String> {
    let next = agents::load_agents(&state.agents_path).map_err(|e| e.to_string())?;
    let out = agents::describe(&next);
    *state.agents.lock().unwrap() = next;
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartResult {
    pid: u32,
    cwd: String,
    command: String,
    /// True only when the session was launched with PC control attached.
    pc_control: bool,
}

/// Where per-session Claude Code MCP config files live. They contain the
/// session's secret URL, so they are deleted on revoke/kill and the whole
/// directory is cleared at startup in case a previous run crashed.
fn mcp_config_dir() -> PathBuf {
    std::env::temp_dir().join("ezcli-mcp")
}

fn mcp_config_file(pty_id: &str) -> PathBuf {
    mcp_config_dir().join(format!("{pty_id}.json"))
}

/// Tear down everything that lets a PTY reach PC control.
fn detach_pc_control(state: &AppState, mcp: &mcp_server::McpServer, pty_id: &str) {
    state.pc_control.revoke(pty_id);
    mcp.unregister(pty_id);
    let _ = std::fs::remove_file(mcp_config_file(pty_id));
}

/// Build the CLI arguments that attach ezCLI's MCP server, plus a redacted
/// form for display. Only the backend calls this, only with a URL it minted.
fn mcp_attach_args(style: agents::McpStyle, pty_id: &str, url: &str) -> Result<(Vec<String>, Vec<String>), String> {
    match style {
        agents::McpStyle::Claude => {
            let dir = mcp_config_dir();
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let path = mcp_config_file(pty_id);
            let config = serde_json::json!({
                "mcpServers": { "ezcli": { "type": "http", "url": url } }
            });
            std::fs::write(&path, config.to_string()).map_err(|e| e.to_string())?;
            Ok((
                vec!["--mcp-config".into(), path.to_string_lossy().into_owned()],
                vec!["--mcp-config".into(), "<ezcli PC control>".into()],
            ))
        }
        agents::McpStyle::Codex => Ok((
            vec!["-c".into(), format!("mcp_servers.ezcli.url={url}")],
            vec!["-c".into(), "mcp_servers.ezcli.url=<ezcli PC control>".into()],
        )),
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn start_session(
    id: String,
    agent_id: String,
    model_id: String,
    mode_id: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    pc_control: Option<bool>,
    state: State<AppState>,
    mcp: State<Arc<mcp_server::McpServer>>,
    app: AppHandle,
) -> Result<StartResult, String> {
    let want_pc = pc_control.unwrap_or(false);
    let (cmd, argv_for_log, final_args, resolved_cwd) = {
        let agents_g = state.agents.lock().unwrap();
        let a = agents_g
            .iter()
            .find(|x| x.id == agent_id)
            .ok_or_else(|| "unknown agent".to_string())?;

        let resolved = agents::resolve_command(&a.command)
            .ok_or_else(|| format!("\"{}\" is not on PATH", a.command))?;
        let catalogs = state.catalogs.lock().unwrap();
        let mut argv = agents::build_argv(a, &mode_id, &model_id, catalogs.get(&a.id).map(Vec::as_slice));
        drop(catalogs);
        let mut shown = argv.clone();

        if want_pc {
            let style = a
                .mcp_style()
                .ok_or_else(|| format!("PC control isn't supported for {} yet.", a.label))?;
            let url = mcp.register(&id).map_err(|e| e.to_string())?;
            let (attach, attach_shown) = match mcp_attach_args(style, &id, &url) {
                Ok(v) => v,
                Err(e) => {
                    detach_pc_control(&state, &mcp, &id);
                    return Err(e);
                }
            };
            // Global options go right after the agent's base args, before any
            // mode subcommand (e.g. `codex --no-daemon -c … resume --last`).
            let at = a.args.len().min(argv.len());
            argv.splice(at..at, attach);
            shown.splice(at..at, attach_shown);
        }

        // A .ps1 shim can't be exec'd directly; hand it to PowerShell.
        let (cmd, final_args) = if cfg!(windows) && resolved.to_lowercase().ends_with(".ps1") {
            let mut v = vec![
                "-NoLogo".to_string(),
                "-NoProfile".to_string(),
                "-ExecutionPolicy".to_string(),
                "Bypass".to_string(),
                "-File".to_string(),
                resolved.clone(),
            ];
            v.extend(argv.iter().cloned());
            ("powershell.exe".to_string(), v)
        } else {
            (resolved.clone(), argv.clone())
        };

        let resolved_cwd = cwd
            .filter(|c| std::path::Path::new(c).is_dir())
            .unwrap_or_else(default_start_dir);

        let argv_for_log = format!("{} {}", a.command, shown.join(" "));
        (cmd, argv_for_log, final_args, resolved_cwd)
    };

    let spawned = state.sessions.spawn(
        app,
        SpawnArgs {
            id: id.clone(),
            cmd,
            args: final_args,
            cwd: Some(resolved_cwd.clone()),
            cols,
            rows,
        },
    );
    let pid = match spawned {
        Ok(pid) => pid,
        Err(e) => {
            if want_pc {
                detach_pc_control(&state, &mcp, &id);
            }
            return Err(e.to_string());
        }
    };
    // Grant only once the process exists, so the grant is tied to a live PTY.
    if want_pc {
        state.pc_control.set(&id, true);
    }

    Ok(StartResult {
        pid,
        cwd: resolved_cwd,
        command: argv_for_log.trim().to_string(),
        pc_control: want_pc,
    })
}

#[tauri::command]
fn send_input(id: String, data: String, state: State<AppState>) -> Result<(), String> {
    state
        .sessions
        .write(&id, data.as_bytes())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn resize_session(id: String, cols: u16, rows: u16, state: State<AppState>) -> Result<(), String> {
    state
        .sessions
        .resize(&id, cols, rows)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn kill_session(
    id: String,
    state: State<AppState>,
    mcp: State<Arc<mcp_server::McpServer>>,
) -> Result<(), String> {
    // Detach first so there is no window where a dying session still holds a grant.
    detach_pc_control(&state, &mcp, &id);
    state.sessions.kill(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_dir(path: String) -> Result<files_api::DirListing, String> {
    files_api::list_dir(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_file(path: String) -> Result<files_api::FileContent, String> {
    files_api::read_file(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn git_status(path: String) -> git_api::GitStatus {
    git_api::git_status(&path)
}

#[tauri::command]
fn git_diff(
    path: String,
    file: String,
    untracked: Option<bool>,
) -> Result<git_api::DiffOut, String> {
    git_api::git_diff(&path, &file, untracked.unwrap_or(false)).map_err(|e| e.to_string())
}

/// Run an agent's own model-listing command with a hidden console and a hard
/// timeout. Used only for agents that declare `modelsFrom` in agents.json.
fn run_catalog(resolved: &str, args: &[String]) -> Result<String, String> {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let mut cmd = if cfg!(windows) && resolved.to_lowercase().ends_with(".ps1") {
        let mut c = Command::new("powershell.exe");
        c.args(["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolved]);
        c
    } else {
        Command::new(resolved)
    };
    cmd.args(args)
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| format!("could not run the model list: {e}"))?;
    let mut stdout = child.stdout.take().ok_or("no output pipe")?;
    // Read on a thread so a chatty child can't block on a full pipe while we wait.
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::Read::read_to_string(&mut stdout, &mut s);
        s
    });
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() > Duration::from_secs(30) => {
                let _ = child.kill();
                return Err("listing models took longer than 30 s".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(e.to_string()),
        }
    }
    reader.join().map_err(|_| "model list reader failed".to_string())
}

/// Fetch the models an agent can use right now (for OpenCode: every key-free
/// model plus any provider the user connected). Triggered by the user opening
/// the Model menu or pressing refresh, never per turn.
#[tauri::command]
async fn agent_models(agent_id: String, state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let (resolved, args) = {
        let agents_g = state.agents.lock().unwrap();
        let a = agents_g
            .iter()
            .find(|x| x.id == agent_id)
            .ok_or_else(|| "unknown agent".to_string())?;
        let from = a
            .models_from
            .as_ref()
            .ok_or_else(|| format!("{} doesn't publish a model list.", a.label))?;
        let resolved = agents::resolve_command(&a.command)
            .ok_or_else(|| format!("\"{}\" is not on PATH", a.command))?;
        (resolved, from.args.clone())
    };
    let stdout = tauri::async_runtime::spawn_blocking(move || run_catalog(&resolved, &args))
        .await
        .map_err(|e| e.to_string())??;
    let list = agents::parse_catalog(&stdout);
    state.catalogs.lock().unwrap().insert(agent_id, list.clone());
    Ok(list)
}

#[tauri::command]
fn detect_backends(state: State<AppState>) -> backends::BackendReport {
    let defs = state.agents.lock().unwrap().clone();
    backends::detect(&defs)
}

/// Scan local transcript stores off the command thread, then hold recognized
/// conversations in memory under opaque ids for the picker.
#[tauri::command]
async fn list_imports(state: State<'_, AppState>) -> Result<import::ImportCatalog, String> {
    let discovery = tauri::async_runtime::spawn_blocking(import::discover)
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    state.imports.replace(discovery.conversations);
    Ok(discovery.catalog)
}

/// Return only a conversation discovered by the immediately preceding scan;
/// callers cannot use this command as an arbitrary local-file reader.
#[tauri::command]
fn read_imported_chat(id: String, state: State<AppState>) -> Result<import::ImportConversation, String> {
    state
        .imports
        .get(&id)
        .ok_or_else(|| "Import is no longer available. Refresh local chats and try again.".into())
}

/// Revoke PC control for a PTY. Granting happens only through
/// `start_session(pc_control: true)`, because the CLI must be launched with
/// the MCP server attached for the grant to mean anything.
#[tauri::command]
fn set_pc_control(
    session_id: String,
    enabled: bool,
    state: State<AppState>,
    mcp: State<Arc<mcp_server::McpServer>>,
) -> Result<bool, String> {
    if enabled {
        return Err("Turn PC control on by relaunching the session with it.".into());
    }
    detach_pc_control(&state, &mcp, &session_id);
    Ok(false)
}

/// The one guard every native PC-control action must call. Both conditions are
/// required: an explicit user grant AND a still-running process. The second
/// check is what makes revocation hold when the frontend can't revoke (webview
/// reload or crash), because a dead or killed PTY is never "live".
fn pc_control_allowed(state: &AppState, session_id: &str) -> bool {
    state.pc_control.allowed(session_id) && state.sessions.is_live(session_id)
}

#[tauri::command]
fn open_targets() -> Vec<open_in::OpenTarget> {
    open_in::detect()
}

#[tauri::command]
fn open_in(target: String, path: String) -> Result<(), String> {
    open_in::open(&target, &path).map_err(|e| e.to_string())
}

/// How many sessions still have a live process. The window's close guard
/// asks this before quitting so it never kills work without a prompt.
#[tauri::command]
fn running_sessions(state: State<AppState>) -> usize {
    state.sessions.live_count()
}

/// A sensible default working folder for a new session. The process cwd
/// comes from wherever the installer launched the exe (Program Files on
/// Windows), so we only trust it when it is clearly a user folder.
fn default_start_dir() -> String {
    let home = dirs::home_dir();

    if let Ok(cwd) = std::env::current_dir() {
        let cwd_s = cwd.to_string_lossy().to_lowercase();
        let looks_like_install =
            cwd_s.contains("program files")
                || cwd_s.contains("programdata")
                || cwd_s.contains("appdata")
                || cwd_s.contains("system32")
                || cwd_s.ends_with("\\ezcli")
                || cwd_s.ends_with("/ezcli");
        if !looks_like_install {
            if let Some(h) = &home {
                // Trust the cwd when it is inside the user's home tree.
                if cwd.starts_with(h) {
                    return cwd.to_string_lossy().into_owned();
                }
            }
        }
    }

    home.map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| {
            std::env::current_dir()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        })
}

/// Resolve the editable agents.json location.
///
/// We embed a copy at compile time and, on first run, write it to
/// `~/.ezcli/agents.json` so the user can edit it without touching
/// the installed program files.
fn resolve_agents_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    let config_dir = home.join(".ezcli");
    let config_file = config_dir.join("agents.json");
    if !config_file.exists() {
        let _ = std::fs::create_dir_all(&config_dir);
        let default = agents::BUILTIN;
        let _ = std::fs::write(&config_file, default);
    }
    config_file
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let agents_path = resolve_agents_path();
    let loaded = agents::load_agents(&agents_path).unwrap_or_else(|e| {
        eprintln!("agents.json load error: {}", e);
        Vec::new()
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            agents: Mutex::new(loaded),
            agents_path,
            sessions: SessionStore::new(),
            imports: import::ImportStore::default(),
            pc_control: pc_control::PcControlStore::default(),
            catalogs: Mutex::new(Default::default()),
        })
        .setup(|app| {
            // Stale per-session config files from a crashed run hold dead tokens.
            let _ = std::fs::remove_dir_all(mcp_config_dir());
            let handle = app.handle().clone();
            let server = mcp_server::McpServer::start(mcp_server::Hooks {
                allowed: Box::new(move |pty_id| pc_control_allowed(&handle.state::<AppState>(), pty_id)),
                screenshot: Box::new(capture::primary_screen),
            })?;
            app.manage(server);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_agents,
            reload_agents,
            start_session,
            send_input,
            resize_session,
            kill_session,
            list_dir,
            read_file,
            git_status,
            git_diff,
            detect_backends,
            agent_models,
            list_imports,
            read_imported_chat,
            set_pc_control,
            open_targets,
            open_in,
            running_sessions
        ])
        .run(tauri::generate_context!())
        .expect("ezCLI failed to launch");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Opt-in: asks the installed OpenCode for its live model list. Free (no
    /// model is called), but needs opencode on PATH and network access.
    /// `scripts\test-rust.ps1 --ignored --nocapture real_opencode`
    #[test]
    #[ignore = "runs the installed opencode CLI"]
    fn real_opencode_catalog_lists_free_models() {
        let resolved = agents::resolve_command("opencode").expect("opencode on PATH");
        let out = run_catalog(&resolved, &["models".to_string()]).unwrap();
        let list = agents::parse_catalog(&out);
        eprintln!("{} models via {resolved}: {:?}", list.len(), list);
        assert!(!list.is_empty());
    }
}
