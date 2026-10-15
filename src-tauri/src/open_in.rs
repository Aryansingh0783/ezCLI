//! "Open in" targets: hand a session's folder to an editor, the file
//! manager or a fresh terminal.
//!
//! Targets are detected from well-known install locations so the menu only
//! lists what is actually on this machine. The frontend passes a target id
//! and a folder; it never supplies an executable path.

use anyhow::{anyhow, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Serialize, Clone)]
pub struct OpenTarget {
    pub id: String,
    pub label: String,
}

struct Editor {
    id: &'static str,
    label: &'static str,
}

const EDITORS: &[Editor] = &[
    Editor { id: "vscode", label: "VS Code" },
    Editor { id: "cursor", label: "Cursor" },
    Editor { id: "zed", label: "Zed" },
];

#[cfg(windows)]
fn editor_candidates(id: &str) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(local).join("Programs"));
    }
    for key in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(p) = std::env::var_os(key) {
            roots.push(PathBuf::from(p));
        }
    }
    let rel: &[&str] = match id {
        "vscode" => &["Microsoft VS Code", "Code.exe"],
        "cursor" => &["cursor", "Cursor.exe"],
        "zed" => &["Zed", "Zed.exe"],
        _ => return Vec::new(),
    };
    roots
        .into_iter()
        .map(|r| r.join(rel[0]).join(rel[1]))
        .collect()
}

#[cfg(target_os = "macos")]
fn editor_candidates(id: &str) -> Vec<PathBuf> {
    let app = match id {
        "vscode" => "Visual Studio Code.app/Contents/Resources/app/bin/code",
        "cursor" => "Cursor.app/Contents/Resources/app/bin/cursor",
        "zed" => "Zed.app/Contents/MacOS/cli",
        _ => return Vec::new(),
    };
    let mut v = vec![PathBuf::from("/Applications").join(app)];
    if let Some(home) = dirs::home_dir() {
        v.push(home.join("Applications").join(app));
    }
    v
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn editor_candidates(id: &str) -> Vec<PathBuf> {
    let bin = match id {
        "vscode" => "code",
        "cursor" => "cursor",
        "zed" => "zed",
        _ => return Vec::new(),
    };
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).map(|d| d.join(bin)).collect())
        .unwrap_or_default()
}

fn find_editor(id: &str) -> Option<PathBuf> {
    editor_candidates(id).into_iter().find(|p| p.is_file())
}

fn file_manager_label() -> &'static str {
    if cfg!(windows) {
        "File Explorer"
    } else if cfg!(target_os = "macos") {
        "Finder"
    } else {
        "File manager"
    }
}

pub fn detect() -> Vec<OpenTarget> {
    let mut out: Vec<OpenTarget> = EDITORS
        .iter()
        .filter(|e| find_editor(e.id).is_some())
        .map(|e| OpenTarget {
            id: e.id.to_string(),
            label: e.label.to_string(),
        })
        .collect();
    out.push(OpenTarget {
        id: "files".into(),
        label: file_manager_label().into(),
    });
    out.push(OpenTarget {
        id: "terminal".into(),
        label: "Terminal".into(),
    });
    out
}

pub fn open(target: &str, dir: &str) -> Result<()> {
    let dir = Path::new(dir)
        .canonicalize()
        .map_err(|_| anyhow!("folder does not exist"))?;
    if !dir.is_dir() {
        return Err(anyhow!("not a folder"));
    }
    let dir_s = strip_verbatim(&dir);

    match target {
        "files" => spawn_file_manager(&dir_s),
        "terminal" => spawn_terminal(&dir_s),
        id => {
            let exe = find_editor(id).ok_or_else(|| anyhow!("{} is not installed", id))?;
            Command::new(exe).arg(&dir_s).spawn()?;
            Ok(())
        }
    }
}

/// `canonicalize` on Windows returns `\\?\C:\…`, which some programs
/// (Explorer in particular) refuse. Drop the prefix for plain drive paths.
fn strip_verbatim(p: &Path) -> String {
    let s = p.to_string_lossy().into_owned();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => rest.to_string(),
        _ => s,
    }
}

#[cfg(windows)]
fn spawn_file_manager(dir: &str) -> Result<()> {
    Command::new("explorer.exe").arg(dir).spawn()?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn spawn_file_manager(dir: &str) -> Result<()> {
    Command::new("open").arg(dir).spawn()?;
    Ok(())
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn spawn_file_manager(dir: &str) -> Result<()> {
    Command::new("xdg-open").arg(dir).spawn()?;
    Ok(())
}

#[cfg(windows)]
fn spawn_terminal(dir: &str) -> Result<()> {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

    // Prefer Windows Terminal; fall back to a plain PowerShell console.
    if Command::new("wt.exe").args(["-d", dir]).spawn().is_ok() {
        return Ok(());
    }
    Command::new("powershell.exe")
        .arg("-NoExit")
        .current_dir(dir)
        .creation_flags(CREATE_NEW_CONSOLE)
        .spawn()?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn spawn_terminal(dir: &str) -> Result<()> {
    Command::new("open").args(["-a", "Terminal", dir]).spawn()?;
    Ok(())
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn spawn_terminal(dir: &str) -> Result<()> {
    Command::new("x-terminal-emulator")
        .current_dir(dir)
        .spawn()?;
    Ok(())
}
