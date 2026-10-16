//! Tauri commands for the v2 features: transcripts, health, git actions,
//! updates, remote view, windows, web chat, dictation and notifications.
//! Session plumbing stays in lib.rs; these commands only call into it.

use crate::{git_api, health, remote, transcripts, updater, AppState};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

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
#[tauri::command]
pub fn open_window(handoff: Option<String>, app: AppHandle) -> Result<String, String> {
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
pub fn open_web_chat(provider: String, app: AppHandle) -> Result<(), String> {
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
        .title(format!("{title} — ezCLI web chat"))
        .inner_size(1100.0, 820.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/* ------------------------------------------------------------ desktop */

/// Show a system notification.
#[tauri::command]
pub fn notify(title: String, body: String, app: AppHandle) -> Result<(), String> {
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
