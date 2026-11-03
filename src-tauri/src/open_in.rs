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
    // a desktop-launched app does not get the shell's PATH: use the fuller search path the rest of ezCLI uses
    std::env::split_paths(&crate::agents::effective_path()).map(|d| d.join(bin)).collect()
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

/// The terminal programs to try, in order, each with the option that makes it start in `dir`. `x-terminal-emulator`
/// exists only on Debian-style systems; Arch, KDE and Hyprland users have konsole, kitty, foot, alacritty and so on.
#[cfg(all(not(windows), not(target_os = "macos")))]
fn terminal_candidates(dir: &str, preferred: Option<&str>) -> Vec<(String, Vec<String>)> {
    let own = |prog: &str, args: &[&str]| (prog.to_string(), args.iter().map(|a| a.to_string()).collect::<Vec<String>>());
    let mut v: Vec<(String, Vec<String>)> = Vec::new();
    // $TERMINAL is the user's own choice (a single program name; one with options is ignored)
    if let Some(t) = preferred.map(str::trim).filter(|t| !t.is_empty() && !t.contains(char::is_whitespace)) {
        v.push((t.to_string(), Vec::new()));
    }
    let flag = |name: &str| vec![format!("{name}={dir}")];
    v.extend([
        own("konsole", &["--workdir", dir]),
        own("kitty", &["--directory", dir]),
        own("foot", &["--working-directory", dir]),
        own("alacritty", &["--working-directory", dir]),
        own("wezterm", &["start", "--cwd", dir]),
        ("gnome-terminal".to_string(), flag("--working-directory")),
        ("xfce4-terminal".to_string(), flag("--working-directory")),
        ("tilix".to_string(), flag("--working-directory")),
        own("x-terminal-emulator", &[]),
        own("xterm", &[]),
    ]);
    v
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn spawn_terminal(dir: &str) -> Result<()> {
    let preferred = std::env::var("TERMINAL").ok();
    for (prog, args) in terminal_candidates(dir, preferred.as_deref()) {
        let Some(exe) = crate::agents::resolve_command(&prog) else { continue };
        // started in the folder either by its own option or, for the plain ones, by inheriting it
        if Command::new(exe).args(&args).current_dir(dir).spawn().is_ok() {
            return Ok(());
        }
    }
    Err(anyhow!("No terminal program was found. Install one (konsole, kitty, foot, alacritty, gnome-terminal, xterm) or set the TERMINAL environment variable."))
}

#[cfg(all(test, not(windows), not(target_os = "macos")))]
mod linux_tests {
    use super::*;

    #[test]
    fn a_terminal_that_exists_on_arch_is_tried_and_each_starts_in_the_folder() {
        let c = terminal_candidates("/home/u/my project", None);
        let names: Vec<&str> = c.iter().map(|(n, _)| n.as_str()).collect();
        assert!(names.contains(&"konsole") && names.contains(&"kitty") && names.contains(&"foot") && names.contains(&"alacritty"));
        let get = |n: &str| c.iter().find(|(p, _)| p == n).unwrap().1.clone();
        assert_eq!(get("konsole"), ["--workdir", "/home/u/my project"]);
        assert_eq!(get("kitty"), ["--directory", "/home/u/my project"]);
        assert_eq!(get("wezterm"), ["start", "--cwd", "/home/u/my project"]);
        assert_eq!(get("gnome-terminal"), ["--working-directory=/home/u/my project"]);
        // the Debian-only name is no longer the only choice
        assert!(names.iter().position(|n| *n == "konsole") < names.iter().position(|n| *n == "x-terminal-emulator"));
    }

    #[test]
    fn the_users_own_terminal_comes_first_and_odd_values_are_ignored() {
        assert_eq!(terminal_candidates("/d", Some("ghostty"))[0], ("ghostty".to_string(), Vec::new()));
        assert_eq!(terminal_candidates("/d", Some("  foot ")).first().map(|c| c.0.as_str()), Some("foot"));
        assert_ne!(terminal_candidates("/d", Some("kitty -1"))[0].0, "kitty -1");
        assert_ne!(terminal_candidates("/d", Some(""))[0].0, "");
        assert_eq!(terminal_candidates("/d", None)[0].0, "konsole");
    }
}
