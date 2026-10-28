//! Tools for local models, which have none of their own: the user's skills (read on request) and a
//! PowerShell command that runs only after the user clicks Run on that exact command.

use serde::Serialize;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Skill {
    pub name: String,
    pub description: String,
}

fn skill_roots() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else { return Vec::new() };
    vec![home.join(".claude").join("skills"), home.join(".agents").join("skills")]
}

/// Value of a `key:` line in a SKILL.md front matter block.
fn front_value(text: &str, key: &str) -> String {
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return String::new();
    }
    for l in lines {
        if l.trim() == "---" {
            break;
        }
        if let Some(v) = l.strip_prefix(&format!("{key}:")) {
            return v.trim().trim_matches(['"', '\'']).to_string();
        }
    }
    String::new()
}

pub fn list_skills() -> Vec<Skill> {
    let mut out: Vec<Skill> = Vec::new();
    for root in skill_roots() {
        let Ok(rd) = std::fs::read_dir(&root) else { continue };
        for e in rd.flatten() {
            let md = e.path().join("SKILL.md");
            let Ok(text) = std::fs::read_to_string(&md) else { continue };
            let dir_name = e.file_name().to_string_lossy().into_owned();
            let name = Some(front_value(&text, "name")).filter(|n| !n.is_empty()).unwrap_or(dir_name);
            if out.iter().any(|s| s.name == name) {
                continue;
            }
            let description: String = front_value(&text, "description").chars().take(160).collect();
            out.push(Skill { name, description });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn safe_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 80 && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':')) && !name.contains("..")
}

/// The text of one skill, found by its name (or the closest name).
pub fn read_skill(wanted: &str) -> Option<(String, String)> {
    let wanted = wanted.trim().trim_start_matches('/').to_ascii_lowercase();
    let skills = list_skills();
    let pick = skills
        .iter()
        .find(|s| s.name.to_ascii_lowercase() == wanted)
        .or_else(|| skills.iter().find(|s| s.name.to_ascii_lowercase().contains(&wanted) || wanted.contains(&s.name.to_ascii_lowercase())))?;
    let dir_name = pick.name.replace(':', "-");
    if !safe_name(&dir_name) {
        return None;
    }
    for root in skill_roots() {
        for candidate in [pick.name.as_str(), dir_name.as_str()] {
            if !safe_name(candidate) {
                continue;
            }
            if let Ok(text) = std::fs::read_to_string(root.join(candidate).join("SKILL.md")) {
                return Some((pick.name.clone(), text.chars().take(14_000).collect()));
            }
        }
    }
    None
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub output: String,
    pub exit: Option<i32>,
    pub timed_out: bool,
}

/// Run one PowerShell command in `cwd` and capture what it prints. Called only after the user approved
/// this exact command in the chat. Stops after `limit_secs`.
pub fn run_command(command: &str, cwd: &str, limit_secs: u64) -> CommandResult {
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("powershell.exe");
        c.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command]);
        c.creation_flags(0x0800_0000);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("sh");
        c.args(["-c", command]);
        c
    };
    if !cwd.is_empty() && std::path::Path::new(cwd).is_dir() {
        cmd.current_dir(cwd);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let Ok(mut child) = cmd.spawn() else {
        return CommandResult { output: "Could not start the shell.".into(), ..Default::default() };
    };
    // read both pipes on their own threads so a chatty command cannot fill a pipe and stall
    let mut so = child.stdout.take();
    let mut se = child.stderr.take();
    let t1 = std::thread::spawn(move || {
        let mut b = Vec::new();
        if let Some(s) = so.as_mut() {
            let _ = std::io::Read::read_to_end(s, &mut b);
        }
        b
    });
    let t2 = std::thread::spawn(move || {
        let mut b = Vec::new();
        if let Some(s) = se.as_mut() {
            let _ = std::io::Read::read_to_end(s, &mut b);
        }
        b
    });
    let start = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) if start.elapsed() > Duration::from_secs(limit_secs) => {
                let _ = child.kill();
                timed_out = true;
                break child.wait().ok();
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(60)),
            Err(_) => break None,
        }
    };
    let out = String::from_utf8_lossy(&t1.join().unwrap_or_default()).into_owned();
    let err = String::from_utf8_lossy(&t2.join().unwrap_or_default()).into_owned();
    let mut text = out;
    if !err.trim().is_empty() {
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&err);
    }
    let text = text.trim().to_string();
    let output = if text.chars().count() > 6000 {
        let head: String = text.chars().take(6000).collect();
        format!("{head}\n[output cut at 6000 characters]")
    } else {
        text
    };
    CommandResult { output, exit: status.and_then(|s| s.code()), timed_out }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn front_matter_values_are_read() {
        let t = "---\nname: graphify\ndescription: \"Use for code\"\n---\n# body";
        assert_eq!(front_value(t, "name"), "graphify");
        assert_eq!(front_value(t, "description"), "Use for code");
        assert_eq!(front_value("no front matter", "name"), "");
    }

    #[test]
    fn skill_names_cannot_escape_the_folder() {
        assert!(!safe_name("../secrets"));
        assert!(!safe_name("a/b"));
        assert!(safe_name("agents:health".replace(':', "-").as_str()));
    }

    #[test]
    fn a_command_returns_its_output_and_stops_on_time() {
        let r = run_command("Write-Output hello", "", 20);
        assert!(r.output.contains("hello"));
        assert_eq!(r.exit, Some(0));
        let r = run_command("Start-Sleep 30", "", 1);
        assert!(r.timed_out);
    }
}
