//! Tauri commands for the v2 features: transcripts, health, git actions,
//! updates, remote view, windows, web chat, dictation and notifications.
//! Session plumbing stays in lib.rs; these commands only call into it.

use crate::{git_api, group, health, install, remote, transcripts, updater, AppState};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

/* ------------------------------------------------------------ files */

/// Write text to a path the user picked in a Save dialog (session export).
#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if !["md", "markdown", "html", "htm", "txt"].contains(&ext.as_str()) {
        return Err("Exports are saved as .md, .html or .txt files.".into());
    }
    if contents.len() > 64 * 1024 * 1024 {
        return Err("That export is too large.".into());
    }
    std::fs::write(&p, contents).map_err(|e| e.to_string())
}

/* ------------------------------------------------------------ transcripts */

#[tauri::command]
pub fn save_transcript(meta: transcripts::Meta, text: String) -> Result<(), String> {
    transcripts::save(meta, &text)
}

/// Every saved session's metadata, newest first (no text, so it is fast).
#[tauri::command]
pub fn list_saved_sessions() -> Vec<transcripts::Meta> {
    transcripts::list()
}

#[tauri::command]
pub async fn search_transcripts(query: String) -> Result<Vec<transcripts::Hit>, String> {
    tauri::async_runtime::spawn_blocking(move || transcripts::search(&query))
        .await
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct TranscriptOut {
    meta: transcripts::Meta,
    text: String,
}

#[tauri::command]
pub fn read_transcript(id: String) -> Result<TranscriptOut, String> {
    let (meta, text) = transcripts::read(&id)?;
    Ok(TranscriptOut { meta, text })
}

#[tauri::command]
pub fn delete_transcript(id: String) -> Result<(), String> {
    transcripts::delete(&id)
}

#[tauri::command]
pub fn clear_transcripts() -> usize {
    transcripts::clear()
}

/* ------------------------------------------------------------ team chats */

const MAX_TEAM_BYTES: usize = 8 * 1024 * 1024;

fn teams_dir() -> std::path::PathBuf {
    dirs::home_dir().unwrap_or_else(std::env::temp_dir).join(".ezcli").join("teams")
}

fn team_path(id: &str) -> Result<std::path::PathBuf, String> {
    transcripts::safe_id(id)?;
    Ok(teams_dir().join(format!("{id}.json")))
}

/// Save a team chat (the whole conversation as JSON) on this PC.
#[tauri::command]
pub fn team_save(id: String, json: String) -> Result<(), String> {
    if json.len() > MAX_TEAM_BYTES {
        return Err("This team chat is too large to save. Start a new one.".into());
    }
    serde_json::from_str::<serde_json::Value>(&json).map_err(|_| "Team chat data was not valid.".to_string())?;
    let path = team_path(&id)?;
    std::fs::create_dir_all(teams_dir()).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn team_load(id: String) -> Result<String, String> {
    std::fs::read_to_string(team_path(&id)?).map_err(|_| "That team chat no longer exists.".to_string())
}

#[tauri::command]
pub fn team_delete(id: String) -> Result<(), String> {
    let p = team_path(&id)?;
    if p.exists() {
        std::fs::remove_file(p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/* ------------------------------------------------------------ health */

#[tauri::command]
pub async fn health_report(state: State<'_, AppState>) -> Result<health::HealthReport, String> {
    let defs = state.agents.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || health::report(&defs))
        .await
        .map_err(|e| e.to_string())
}

/* ------------------------------------------------------------ git actions */

#[tauri::command]
pub fn git_stage(path: String, file: String) -> Result<(), String> {
    git_api::stage(&path, &file).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn git_unstage(path: String, file: String) -> Result<(), String> {
    git_api::unstage(&path, &file).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn git_discard(path: String, file: String, untracked: bool) -> Result<(), String> {
    git_api::discard(&path, &file, untracked).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn git_commit(path: String, message: String, all: bool) -> Result<String, String> {
    git_api::commit(&path, &message, all).map_err(|e| e.to_string())
}

/* ------------------------------------------------------------ updates */

#[tauri::command]
pub async fn check_update() -> Result<updater::UpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(updater::check)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn download_update(installer_url: String, checksum_url: String, name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || updater::download(&installer_url, &checksum_url, &name))
        .await
        .map_err(|e| e.to_string())?
}

/// Launch the verified installer, then quit so it can replace the app.
#[tauri::command]
pub fn install_update(path: String, app: AppHandle) -> Result<(), String> {
    updater::install(&path)?;
    app.exit(0);
    Ok(())
}

/* ------------------------------------------------------------ remote view */

#[tauri::command]
pub fn remote_status(remote: State<remote::Remote>) -> remote::RemoteStatus {
    remote.status()
}

#[tauri::command]
pub fn remote_start(remote: State<remote::Remote>, state: State<AppState>) -> Result<remote::RemoteStatus, String> {
    remote.start(state.sessions.clone())
}

#[tauri::command]
pub fn remote_stop(remote: State<remote::Remote>) -> remote::RemoteStatus {
    remote.stop();
    remote.status()
}

#[tauri::command]
pub fn remote_allow_input(allow: bool, remote: State<remote::Remote>) -> remote::RemoteStatus {
    remote.set_allow_input(allow);
    remote.status()
}

#[tauri::command]
pub fn remote_set_sessions(sessions: Vec<remote::RemoteSession>, remote: State<remote::Remote>) {
    remote.set_sessions(sessions);
}

/// Recent output of a PTY, for a window that adopts a moved tab.
#[derive(Serialize)]
pub struct TailOut {
    seq: u64,
    data: String,
}

#[tauri::command]
pub fn pty_tail(id: String, since: Option<u64>, state: State<AppState>) -> Result<TailOut, String> {
    let (seq, data) = state.sessions.tail(&id, since.unwrap_or(0)).ok_or("unknown session")?;
    Ok(TailOut { seq, data })
}

/* ------------------------------------------------------------ windows */

/// Session handoffs for "Move to new window": the source window parks a
/// JSON description here, the new window takes it once by id.
#[derive(Default)]
pub struct Handoffs {
    next: AtomicU32,
    items: Mutex<HashMap<String, String>>,
}

#[tauri::command]
pub fn stash_handoff(json: String, handoffs: State<Handoffs>) -> Result<String, String> {
    if json.len() > 64 * 1024 {
        return Err("handoff too large".into());
    }
    let id = format!("h{}", handoffs.next.fetch_add(1, Ordering::SeqCst) + 1);
    let mut items = handoffs.items.lock().unwrap();
    if items.len() > 32 {
        items.clear();
    }
    items.insert(id.clone(), json);
    Ok(id)
}

#[tauri::command]
pub fn take_handoff(id: String, handoffs: State<Handoffs>) -> Option<String> {
    handoffs.items.lock().unwrap().remove(&id)
}

static WINDOW_SEQ: AtomicU32 = AtomicU32::new(1);

/// Open another ezCLI window. `handoff` names a stashed tab to adopt.
/// Async on purpose: creating a window from a synchronous command blocks the
/// main thread on Windows and the call never returns.
#[tauri::command]
pub async fn open_window(handoff: Option<String>, app: AppHandle) -> Result<String, String> {
    let n = WINDOW_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let label = format!("win-{n}");
    let query = match handoff.filter(|h| h.chars().all(|c| c.is_ascii_alphanumeric())) {
        Some(h) => format!("index.html?window={n}&handoff={h}"),
        None => format!("index.html?window={n}"),
    };
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(query.into()))
        .title("ezCLI")
        .inner_size(1180.0, 760.0)
        .min_inner_size(760.0, 480.0)
        .decorations(false)
        .background_color(tauri::window::Color(10, 10, 11, 255))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(label)
}

/// Provider web chats, for people whose plan has no CLI access. These are
/// the providers' own sites in a separate window with no ezCLI permissions;
/// ezCLI does not read, script or relay anything in them.
const WEB_CHATS: &[(&str, &str, &str)] = &[
    ("claude", "Claude", "https://claude.ai/new"),
    ("chatgpt", "ChatGPT", "https://chatgpt.com/"),
    ("gemini", "Gemini", "https://gemini.google.com/app"),
    ("copilot", "Copilot", "https://copilot.microsoft.com/"),
];

#[tauri::command]
pub async fn open_web_chat(provider: String, app: AppHandle) -> Result<(), String> {
    let (id, title, url) = WEB_CHATS
        .iter()
        .find(|(id, _, _)| *id == provider)
        .ok_or("unknown web chat")?;
    let label = format!("web-{id}");
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.unminimize();
        let _ = w.show();
        return w.set_focus().map_err(|e| e.to_string());
    }
    let parsed = tauri::Url::parse(url).map_err(|e| e.to_string())?;
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed))
        .title(format!("{title}: ezCLI web chat"))
        .inner_size(1100.0, 820.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/* ------------------------------------------------------------ group chat */

/// Run one group-chat turn. Output streams as `group-out:<run_id>` events;
/// the result is also emitted as `group-done:<run_id>` and returned.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn group_turn(
    run_id: String,
    agent_id: String,
    model_id: String,
    prompt: String,
    cwd: String,
    allow_edits: bool,
    state: State<'_, AppState>,
    runs: State<'_, std::sync::Arc<group::GroupRuns>>,
    app: AppHandle,
) -> Result<group::TurnDone, String> {
    let prepared = {
        let agents_g = state.agents.lock().unwrap();
        let a = agents_g.iter().find(|x| x.id == agent_id).ok_or("unknown agent")?;
        let catalogs = state.catalogs.lock().unwrap();
        group::prepare(a, &run_id, &model_id, allow_edits, catalogs.get(&a.id).map(Vec::as_slice), &prompt)?
    };
    if !std::path::Path::new(&cwd).is_dir() {
        return Err("The chat's folder no longer exists.".into());
    }
    let runs = runs.inner().clone();
    let app2 = app.clone();
    let id = run_id.clone();
    let done = tauri::async_runtime::spawn_blocking(move || group::run(app2, &runs, id, prepared, prompt, cwd))
        .await
        .map_err(|e| e.to_string())?;
    let _ = app.emit(&format!("group-done:{run_id}"), done.clone());
    Ok(done)
}

#[tauri::command]
pub fn group_cancel(run_id: String, runs: State<std::sync::Arc<group::GroupRuns>>) -> bool {
    group::cancel(&runs, &run_id)
}

/// Run an agent's documented install command (exactly the string already
/// shown in the UI) and stream its output as `install-out:<agent_id>`
/// events. The frontend must have shown that literal command and gotten an
/// explicit click before calling this, this function does not ask again.
#[tauri::command]
pub async fn install_agent(
    agent_id: String,
    state: State<'_, AppState>,
    runs: State<'_, std::sync::Arc<install::InstallRuns>>,
    app: AppHandle,
) -> Result<install::InstallDone, String> {
    let (command_line, target_command, label) = {
        let agents_g = state.agents.lock().unwrap();
        let a = agents_g.iter().find(|x| x.id == agent_id).ok_or("unknown agent")?;
        let install = a.install.clone().ok_or_else(|| format!("No install command is configured for {}.", a.label))?;
        (install, a.command.clone(), a.label.clone())
    };
    if runs.contains_running(&agent_id) {
        return Err(format!("An install for {label} is already running."));
    }
    let runs = runs.inner().clone();
    let app2 = app.clone();
    let id = agent_id.clone();
    let done = tauri::async_runtime::spawn_blocking(move || install::run(app2, &runs, id, command_line, target_command))
        .await
        .map_err(|e| e.to_string())?;
    let _ = app.emit(&format!("install-done:{agent_id}"), done.clone());
    Ok(done)
}

#[tauri::command]
pub fn cancel_install(agent_id: String, runs: State<std::sync::Arc<install::InstallRuns>>) -> bool {
    install::cancel(&runs, &agent_id)
}

/* ------------------------------------------------------------ desktop */

/// Show a system notification.
#[tauri::command]
pub async fn notify(title: String, body: String, app: AppHandle) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    let title: String = title.chars().take(120).collect();
    let body: String = body.chars().take(400).collect();
    app.notification().builder().title(title).body(body).show().map_err(|e| e.to_string())
}

/// Open Windows voice typing (Win+H) for the focused text box. Windows does
/// the speech recognition; ezCLI only presses the shortcut.
#[tauri::command]
pub fn dictate() -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_LWIN,
        };
        let key = |vk: VIRTUAL_KEY, up: bool| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        let h = VIRTUAL_KEY(0x48);
        let inputs = [key(VK_LWIN, false), key(h, false), key(h, true), key(VK_LWIN, true)];
        // SAFETY: a fixed array of fully initialised keyboard INPUT structs.
        let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent as usize != inputs.len() {
            return Err("Windows did not accept the voice typing shortcut.".into());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("Voice typing uses your system's dictation shortcut on this platform.".into())
    }
}

/// A folder passed on the command line (`ezcli.exe C:\project`).
#[tauri::command]
pub fn launch_folder() -> Option<String> {
    folder_arg(std::env::args().skip(1))
}

pub fn folder_arg(args: impl Iterator<Item = String>) -> Option<String> {
    args.filter(|a| !a.starts_with('-'))
        .find(|a| std::path::Path::new(a).is_dir())
        .map(|a| a.trim_end_matches(['\\', '/']).to_string())
        .filter(|a| !a.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn team_chats_round_trip_and_reject_bad_ids_or_data() {
        let id = format!("team-test-{}", std::process::id());
        team_save(id.clone(), r#"{"messages":[]}"#.into()).unwrap();
        assert_eq!(team_load(id.clone()).unwrap(), r#"{"messages":[]}"#);
        assert!(team_save(id.clone(), "not json".into()).is_err());
        assert!(team_save("../evil".into(), "{}".into()).is_err());
        team_delete(id.clone()).unwrap();
        assert!(team_load(id).is_err());
    }

    #[test]
    fn folder_arg_takes_the_first_existing_directory() {
        let tmp = std::env::temp_dir().to_string_lossy().into_owned();
        let args = vec!["--flag".to_string(), "C:\\definitely\\missing".to_string(), tmp.clone()];
        assert_eq!(folder_arg(args.into_iter()), Some(tmp.trim_end_matches(['\\', '/']).to_string()));
        assert_eq!(folder_arg(Vec::<String>::new().into_iter()), None);
    }

    #[test]
    fn exports_only_write_document_extensions() {
        let dir = std::env::temp_dir();
        assert!(write_text_file(dir.join("x.exe").to_string_lossy().into(), "x".into()).is_err());
        let ok = dir.join(format!("ezcli-export-{}.md", std::process::id()));
        write_text_file(ok.to_string_lossy().into(), "# hi".into()).unwrap();
        assert_eq!(std::fs::read_to_string(&ok).unwrap(), "# hi");
        let _ = std::fs::remove_file(ok);
    }
}
