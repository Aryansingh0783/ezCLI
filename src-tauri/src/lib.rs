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
mod open_in;
mod pc_control;
mod pty_mgr;

use agents::{AgentDef, AgentOut};
use pty_mgr::{SessionStore, SpawnArgs};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, State};

pub struct AppState {
    agents: Mutex<Vec<AgentDef>>,
    agents_path: PathBuf,
    sessions: SessionStore,
    imports: import::ImportStore,
    pc_control: pc_control::PcControlStore,
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
    state: State<AppState>,
    app: AppHandle,
) -> Result<StartResult, String> {
    let (cmd, argv_for_log, final_args, resolved_cwd) = {
        let agents_g = state.agents.lock().unwrap();
        let a = agents_g
            .iter()
            .find(|x| x.id == agent_id)
            .ok_or_else(|| "unknown agent".to_string())?;

        let resolved = agents::resolve_command(&a.command)
            .ok_or_else(|| format!("\"{}\" is not on PATH", a.command))?;
        let argv = agents::build_argv(a, &mode_id, &model_id);

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

        let argv_for_log = format!("{} {}", a.command, argv.join(" "));
        (cmd, argv_for_log, final_args, resolved_cwd)
    };

    let pid = state
        .sessions
        .spawn(
            app,
            SpawnArgs {
                id,
                cmd,
                args: final_args,
                cwd: Some(resolved_cwd.clone()),
                cols,
                rows,
            },
        )
        .map_err(|e| e.to_string())?;

    Ok(StartResult {
        pid,
        cwd: resolved_cwd,
        command: argv_for_log.trim().to_string(),
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
fn kill_session(id: String, state: State<AppState>) -> Result<(), String> {
    // Revoke first so there is no window where a dying session still holds a grant.
    state.pc_control.revoke(&id);
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

#[tauri::command]
fn detect_backends(state: State<AppState>) -> backends::BackendReport {
    let agents_g = state.agents.lock().unwrap();
    let ids: Vec<(String, String)> = agents_g
        .iter()
        .map(|a| (a.id.clone(), a.vendor.clone()))
        .collect();
    drop(agents_g);
    backends::detect(&ids)
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

/// Grant or revoke PC control for one live PTY. A grant is refused unless the
/// PTY's process is running, so permission can only attach to a real session.
#[tauri::command]
fn set_pc_control(session_id: String, enabled: bool, state: State<AppState>) -> Result<bool, String> {
    if enabled && !state.sessions.is_live(&session_id) {
        state.pc_control.revoke(&session_id);
        return Err("PC control can only be granted to a running session.".into());
    }
    Ok(state.pc_control.set(&session_id, enabled))
}

/// The one guard every native PC-control action must call. Both conditions are
/// required: an explicit user grant AND a still-running process. The second
/// check is what makes revocation hold when the frontend can't revoke (webview
/// reload or crash), because a dead or killed PTY is never "live".
#[allow(dead_code)]
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
        let default = include_str!("../../agents.json");
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
