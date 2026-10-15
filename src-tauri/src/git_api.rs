//! Thin shell over the `git` CLI for the Changes pane.

use anyhow::{anyhow, Result};
use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;

const MAX_UNTRACKED_PREVIEW: u64 = 256 * 1024;

#[derive(Serialize)]
#[serde(untagged)]
pub enum GitStatus {
    Repo(RepoStatus),
    NotRepo { repo: bool, reason: String },
}

#[derive(Serialize)]
pub struct RepoStatus {
    pub repo: bool,
    pub root: String,
    pub branch: String,
    pub files: Vec<GitFile>,
}

#[derive(Serialize)]
pub struct GitFile {
    pub code: String,
    pub file: String,
    pub untracked: bool,
    /// Lines added / removed against HEAD; None for binaries and untracked files.
    pub added: Option<u64>,
    pub removed: Option<u64>,
}

#[derive(Serialize)]
pub struct DiffOut {
    pub diff: String,
    pub note: Option<String>,
}

fn git(cwd: &str, args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| anyhow!(if e.kind() == std::io::ErrorKind::NotFound {
            "git is not installed or not on PATH.".to_string()
        } else {
            e.to_string()
        }))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(anyhow!(stderr.lines().next().unwrap_or("git failed").to_string()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn parse_porcelain(porcelain: &str) -> Vec<GitFile> {
    porcelain
        .lines()
        .filter(|line| line.len() > 3)
        .map(|line| {
            let code = line[..2].to_string();
            let rest = &line[3..];
            // Renames show as "old -> new"; keep the destination.
            let name = match rest.find(" -> ") {
                Some(i) => rest[i + 4..].to_string(),
                None => rest.to_string(),
            };
            let untracked = code == "??";
            GitFile {
                code,
                file: name,
                untracked,
                added: None,
                removed: None,
            }
        })
        .collect()
}

/// Fill in per-file line counts from `git diff --numstat` output
/// (`<added>\t<removed>\t<path>`, with `-` for binary files).
fn apply_numstat(files: &mut [GitFile], numstat: &str) {
    for line in numstat.lines() {
        let mut parts = line.splitn(3, '\t');
        let (Some(a), Some(r), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        if let Some(f) = files.iter_mut().find(|f| f.file == path) {
            f.added = a.parse().ok();
            f.removed = r.parse().ok();
        }
    }
}

pub fn git_status(cwd: &str) -> GitStatus {
    let root = match git(cwd, &["rev-parse", "--show-toplevel"]) {
        Ok(s) => s.trim().to_string(),
        Err(e) => {
            let msg = e.to_string();
            let reason = if msg.to_lowercase().contains("not a git repository") {
                "This folder is not a git repository.".to_string()
            } else {
                msg
            };
            return GitStatus::NotRepo {
                repo: false,
                reason,
            };
        }
    };

    let branch_raw = git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "HEAD".to_string());
    let branch = if branch_raw == "HEAD" {
        "detached HEAD".into()
    } else {
        branch_raw
    };

    let porcelain = git(cwd, &["status", "--porcelain=v1", "-uall"]).unwrap_or_default();
    let mut files = parse_porcelain(&porcelain);

    // Against HEAD so staged and unstaged edits are counted together. A repo
    // with no commits has no HEAD; fall back to the unstaged diff there.
    let numstat = git(cwd, &["diff", "HEAD", "--numstat", "--no-renames"])
        .or_else(|_| git(cwd, &["diff", "--numstat", "--no-renames"]))
        .unwrap_or_default();
    apply_numstat(&mut files, &numstat);

    GitStatus::Repo(RepoStatus {
        repo: true,
        root,
        branch,
        files,
    })
}

pub fn git_diff(cwd: &str, file: &str, untracked: bool) -> Result<DiffOut> {
    let root = git(cwd, &["rev-parse", "--show-toplevel"])?.trim().to_string();
    let abs = PathBuf::from(&root).join(file);

    if untracked {
        if !abs.is_file() {
            return Ok(DiffOut {
                diff: String::new(),
                note: Some("File no longer exists.".into()),
            });
        }
        let md = abs.metadata()?;
        if md.len() > MAX_UNTRACKED_PREVIEW {
            return Ok(DiffOut {
                diff: String::new(),
                note: Some("New file is too large to preview.".into()),
            });
        }
        let body = std::fs::read(&abs)?;
        if body.iter().take(8192).any(|&b| b == 0) {
            return Ok(DiffOut {
                diff: String::new(),
                note: Some("New binary file.".into()),
            });
        }
        let text = String::from_utf8_lossy(&body);
        let added: Vec<String> = text.lines().map(|l| format!("+{}", l)).collect();
        return Ok(DiffOut {
            diff: format!("--- /dev/null\n+++ b/{}\n{}", file, added.join("\n")),
            note: None,
        });
    }

    let mut out = git(cwd, &["diff", "--", file])?;
    if out.trim().is_empty() {
        out = git(cwd, &["diff", "--cached", "--", file]).unwrap_or_default();
    }
    let note = if out.trim().is_empty() {
        Some("No textual changes to show.".into())
    } else {
        None
    };
    Ok(DiffOut { diff: out, note })
}
