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
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(cwd)
        // A git installed after login is still found, like the agent CLIs.
        .env("PATH", crate::agents::effective_path());
    #[cfg(windows)]
    {
        // The release build is a GUI process; without this every refresh of
        // the Changes pane would flash a console window.
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().map_err(|e| {
        anyhow!(if e.kind() == std::io::ErrorKind::NotFound {
            "git is not installed or not on PATH.".to_string()
        } else {
            e.to_string()
        })
    })?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(anyhow!(stderr.lines().next().unwrap_or("git failed").to_string()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Parse `git status --porcelain=v1 -z`. NUL separation means paths with
/// spaces or non-ASCII names arrive verbatim instead of C-quoted, and a
/// rename's source path is its own record right after the entry.
fn parse_porcelain(porcelain: &str) -> Vec<GitFile> {
    let mut out = Vec::new();
    let mut records = porcelain.split('\0');
    while let Some(rec) = records.next() {
        if rec.len() < 4 {
            continue;
        }
        let code = rec[..2].to_string();
        if code.starts_with('R') || code.starts_with('C') {
            records.next(); // the original path; keep the destination
        }
        out.push(GitFile {
            untracked: code == "??",
            code,
            file: rec[3..].to_string(),
            added: None,
            removed: None,
        });
    }
    out
}

/// Fill in per-file line counts from `git diff --numstat -z` output
/// (`<added>\t<removed>\t<path>\0`, with `-` for binary files).
fn apply_numstat(files: &mut [GitFile], numstat: &str) {
    for line in numstat.split('\0') {
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

    // `-unormal` lists a new folder once instead of every file inside it; a
    // repo with an untracked build or asset folder otherwise reports thousands.
    let porcelain = git(cwd, &["status", "--porcelain=v1", "-z", "-unormal"]).unwrap_or_default();
    let mut files = parse_porcelain(&porcelain);

    // Against HEAD so staged and unstaged edits are counted together. A repo
    // with no commits has no HEAD; fall back to the unstaged diff there.
    let numstat = git(cwd, &["diff", "HEAD", "--numstat", "-z", "--no-renames"])
        .or_else(|_| git(cwd, &["diff", "--numstat", "-z", "--no-renames"]))
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
        if abs.is_dir() {
            let count = walk_count(&abs, 10_000);
            let more = if count >= 10_000 { "+" } else { "" };
            return Ok(DiffOut {
                diff: String::new(),
                note: Some(format!("New folder with {count}{more} files. Browse it in the Files pane.")),
            });
        }
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

/// A repo-relative path from the Changes list. Absolute paths, parent
/// segments and option-looking names are refused so an action can only
/// touch a file inside this repository.
fn repo_path(file: &str) -> Result<&str> {
    let f = file.trim();
    let bad = f.is_empty()
        || f.starts_with('-')
        || f.starts_with('/')
        || f.starts_with('\\')
        || f.contains(':')
        || f.split(['/', '\\']).any(|part| part == "..");
    if bad {
        return Err(anyhow!("not a path inside this repository"));
    }
    Ok(f)
}

fn root_of(cwd: &str) -> Result<String> {
    Ok(git(cwd, &["rev-parse", "--show-toplevel"])?.trim().to_string())
}

/// `git add` one path (a file or an untracked folder).
pub fn stage(cwd: &str, file: &str) -> Result<()> {
    let root = root_of(cwd)?;
    git(&root, &["add", "--", repo_path(file)?])?;
    Ok(())
}

/// Take one path out of the index, keeping the working-tree edits.
pub fn unstage(cwd: &str, file: &str) -> Result<()> {
    let root = root_of(cwd)?;
    let f = repo_path(file)?;
    // `restore --staged` needs a HEAD; a repo with no commits yet uses the
    // index-only removal instead.
    if git(&root, &["restore", "--staged", "--", f]).is_err() {
        git(&root, &["rm", "--cached", "-r", "-q", "--", f])?;
    }
    Ok(())
}

/// Throw away the changes to one path. Tracked files return to HEAD;
/// untracked files and folders are deleted. The UI confirms first.
pub fn discard(cwd: &str, file: &str, untracked: bool) -> Result<()> {
    let root = root_of(cwd)?;
    let f = repo_path(file)?;
    if untracked {
        git(&root, &["clean", "-f", "-d", "-q", "--", f])?;
    } else {
        git(&root, &["restore", "--staged", "--worktree", "--source=HEAD", "--", f])?;
    }
    Ok(())
}

/// Commit what is staged, or every tracked change when `all` is set.
/// Returns the new commit's short hash and subject.
pub fn commit(cwd: &str, message: &str, all: bool) -> Result<String> {
    let msg = message.trim();
    if msg.is_empty() {
        return Err(anyhow!("Write a commit message first."));
    }
    let root = root_of(cwd)?;
    // `git commit` reports "nothing to commit" on stdout, which `git()` does
    // not surface, so check first. `diff --quiet` exits 1 when there is a diff.
    let nothing = if all {
        git(&root, &["diff", "HEAD", "--quiet"]).is_ok()
    } else {
        git(&root, &["diff", "--cached", "--quiet"]).is_ok()
    };
    if nothing {
        return Err(anyhow!(if all {
            "There are no changes to tracked files to commit."
        } else {
            "Nothing is staged. Stage files first, or commit all changes."
        }));
    }
    let mut args = vec!["commit", "-q"];
    if all {
        args.push("-a");
    }
    args.extend(["-m", msg]);
    git(&root, &args).map_err(|e| {
        let text = e.to_string();
        if text.contains("Please tell me who you are") || text.contains("user.email") || text.contains("identity") {
            anyhow!("git needs your name and email first: git config --global user.name and user.email.")
        } else {
            e
        }
    })?;
    Ok(git(&root, &["log", "-1", "--format=%h %s"])?.trim().to_string())
}

/// Count files under a folder, stopping at `cap` so a huge tree stays cheap.
fn walk_count(dir: &std::path::Path, cap: usize) -> usize {
    let mut n = 0;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else { continue };
        for e in entries.flatten() {
            match e.file_type() {
                Ok(t) if t.is_dir() => stack.push(e.path()),
                Ok(_) => n += 1,
                Err(_) => {}
            }
            if n >= cap {
                return n;
            }
        }
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nul_porcelain_keeps_spaces_and_rename_destinations() {
        let raw = " M src/my file.rs\0R  new name.txt\0old name.txt\0?? build out/\0A  café.md\0";
        let files = parse_porcelain(raw);
        let names: Vec<_> = files.iter().map(|f| (f.code.as_str(), f.file.as_str(), f.untracked)).collect();
        assert_eq!(
            names,
            vec![
                (" M", "src/my file.rs", false),
                ("R ", "new name.txt", false),
                ("??", "build out/", true),
                ("A ", "café.md", false),
            ]
        );
    }

    #[test]
    fn nul_numstat_matches_paths_with_spaces() {
        let mut files = parse_porcelain(" M src/my file.rs\0");
        apply_numstat(&mut files, "3\t1\tsrc/my file.rs\0-\t-\tlogo.png\0");
        assert_eq!((files[0].added, files[0].removed), (Some(3), Some(1)));
    }

    #[test]
    fn action_paths_stay_inside_the_repo() {
        assert!(repo_path("src/my file.rs").is_ok());
        assert!(repo_path("new folder/").is_ok());
        for bad in ["", "-rf", "../x", "a/../../x", "C:\\x", "/etc/passwd", "\\\\server\\x"] {
            assert!(repo_path(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn real_repo_stage_commit_discard_cycle() {
        let dir = std::env::temp_dir().join(format!("ezcli git actions {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let d = dir.to_string_lossy().into_owned();
        if git(&d, &["init", "-q"]).is_err() {
            return;
        }
        git(&d, &["config", "user.email", "test@example.com"]).unwrap();
        git(&d, &["config", "user.name", "ezCLI test"]).unwrap();
        std::fs::write(dir.join("a file.txt"), "one\n").unwrap();
        stage(&d, "a file.txt").unwrap();
        unstage(&d, "a file.txt").unwrap(); // no HEAD yet: index-only path
        assert!(commit(&d, "first", false).is_err(), "nothing staged");
        stage(&d, "a file.txt").unwrap();
        let head = commit(&d, "first", false).unwrap();
        assert!(head.ends_with(" first"), "{head}");
        std::fs::write(dir.join("a file.txt"), "two\n").unwrap();
        stage(&d, "a file.txt").unwrap();
        unstage(&d, "a file.txt").unwrap();
        discard(&d, "a file.txt", false).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("a file.txt")).unwrap().trim(), "one");
        std::fs::write(dir.join("a file.txt"), "three\n").unwrap();
        assert!(commit(&d, "all", true).unwrap().ends_with(" all"));
        std::fs::write(dir.join("scratch.txt"), "x").unwrap();
        discard(&d, "scratch.txt", true).unwrap();
        assert!(!dir.join("scratch.txt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn real_repo_status_reports_a_spaced_file_and_folder() {
        let dir = std::env::temp_dir().join(format!("ezcli git test {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("new folder")).unwrap();
        let d = dir.to_string_lossy().into_owned();
        if git(&d, &["init", "-q"]).is_err() {
            return; // git not installed on this machine
        }
        std::fs::write(dir.join("new folder").join("a.txt"), "a").unwrap();
        std::fs::write(dir.join("new folder").join("b.txt"), "b").unwrap();
        std::fs::write(dir.join("my notes.md"), "hello\n").unwrap();
        let GitStatus::Repo(status) = git_status(&d) else { panic!("not a repo") };
        let mut names: Vec<_> = status.files.iter().map(|f| f.file.clone()).collect();
        names.sort();
        assert_eq!(names, vec!["my notes.md".to_string(), "new folder/".to_string()]);
        let diff = git_diff(&d, "my notes.md", true).unwrap();
        assert!(diff.diff.contains("+hello"), "{}", diff.diff);
        let folder = git_diff(&d, "new folder/", true).unwrap();
        assert_eq!(folder.note.as_deref(), Some("New folder with 2 files. Browse it in the Files pane."));
        let _ = std::fs::remove_dir_all(&dir);
    }
}