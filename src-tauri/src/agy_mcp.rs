//! Antigravity CLI (`agy`) has no flag or environment variable for extra MCP servers: it reads
//! them only from the global `~/.gemini/config/mcp_config.json` or from the workspace file
//! `<folder>/.agents/mcp_config.json`. The owner chose the workspace file, so while an Antigravity
//! session runs, ezCLI adds its own entries (each `{ "serverUrl": … }`) to that file and takes them
//! out again when the session ends.
//!
//! Rules: entries the user wrote are never changed (a clashing name or a `mcpServers` that is not
//! an object means the session goes without the tools); a symlinked file or folder is refused;
//! writes go to a temporary file that then replaces the config, so a failed write cannot leave it
//! half written; when two sessions share a folder, the one that ends hands the entry back to the
//! one still running; a file or folder ezCLI had to create is removed once nothing else is in it.
//! One lock covers every read-modify-write, so sessions starting or ending together cannot drop
//! each other's entries.

use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

type Servers = Vec<(String, String)>;

#[derive(Default)]
struct Folder {
    created_file: bool,
    created_dir: bool,
    /// Sessions in the order they started, each with the (name, URL) pairs it added.
    sessions: Vec<(String, Servers)>,
}

#[derive(Default)]
struct State {
    folders: HashMap<PathBuf, Folder>,
    owner: HashMap<String, PathBuf>,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

pub fn config_file(folder: &Path) -> PathBuf {
    folder.join(".agents").join("mcp_config.json")
}

fn is_symlink(p: &Path) -> bool {
    std::fs::symlink_metadata(p).map(|m| m.file_type().is_symlink()).unwrap_or(false)
}

/// Read the workspace file as a JSON object; `None` when it does not exist. A file that is not a
/// JSON object is the user's and is never overwritten.
fn read(file: &Path) -> Result<Option<Map<String, Value>>, String> {
    match std::fs::read_to_string(file) {
        Ok(text) if text.trim().is_empty() => Ok(Some(Map::new())),
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(m)) => Ok(Some(m)),
            _ => Err(format!("{} is not a JSON object; ezCLI left it alone", file.display())),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Write through a temporary file in the same folder, then replace: the config is never half written.
fn write(file: &Path, config: &Map<String, Value>) -> Result<(), String> {
    let text = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    let tmp = file.with_extension(format!("json.ezcli-{}", std::process::id()));
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // The URLs carry session tokens: readable by the owner only.
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, file).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// The URL ezCLI's sessions in this folder would leave under `name`: the newest one still running.
fn newest(folder: &Folder, name: &str) -> Option<String> {
    folder.sessions.iter().rev().find_map(|(_, s)| s.iter().find(|(n, _)| n == name).map(|(_, u)| u.clone()))
}

/// `http://127.0.0.1:<port>/mcp/<32 hex digits>`: the address ezCLI's own tool server hands out.
pub fn looks_like_ezcli(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://127.0.0.1:") else { return false };
    let Some((port, token)) = rest.split_once("/mcp/") else { return false };
    !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) && token.len() == 32 && token.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Check that ezCLI may write `servers` into `config`: `mcpServers` absent or an object, and no
/// name taken by an entry that is not one of ezCLI's (`ours` tells whether a URL is ezCLI's).
pub fn check(config: &Map<String, Value>, servers: &Servers, ours: impl Fn(&str, &str) -> bool) -> Result<(), String> {
    match config.get("mcpServers") {
        None => Ok(()),
        Some(Value::Object(list)) => {
            for (name, _) in servers {
                if let Some(entry) = list.get(name) {
                    let url = entry.get("serverUrl").and_then(Value::as_str).unwrap_or("");
                    if !ours(name, url) {
                        return Err(format!("the folder's .agents/mcp_config.json already has a server named \"{name}\""));
                    }
                }
            }
            Ok(())
        }
        Some(_) => Err("the folder's .agents/mcp_config.json has an mcpServers value that is not an object".into()),
    }
}

/// Set (`Some`) or remove (`None`) one of ezCLI's entries.
pub fn set(config: &mut Map<String, Value>, name: &str, url: Option<&str>) {
    let list = config.entry("mcpServers").or_insert_with(|| json!({}));
    let Some(list) = list.as_object_mut() else { return };
    match url {
        Some(u) => {
            list.insert(name.to_string(), json!({ "serverUrl": u }));
        }
        None => {
            list.remove(name);
        }
    }
    if list.is_empty() {
        config.remove("mcpServers");
    }
}

/// Add ezCLI's servers to `<folder>/.agents/mcp_config.json` for the session `pty_id`.
pub fn attach(folder: &Path, pty_id: &str, servers: Servers) -> Result<(), String> {
    let mut guard = STATE.lock().map_err(|_| "busy".to_string())?;
    let state = guard.get_or_insert_with(State::default);
    let file = config_file(folder);
    let dir = file.parent().expect("has a parent").to_path_buf();
    if is_symlink(&dir) || is_symlink(&file) {
        return Err(format!("{} is a link; ezCLI does not write through links", file.display()));
    }
    let existing = read(&file)?;
    let known = state.folders.get(&file);
    // ezCLI's own entry is recognised by its URL shape, including one left by an ezCLI that did not
    // close normally (a crash), so a dead entry is replaced rather than blocking the tools forever.
    let ours = |name: &str, url: &str| {
        looks_like_ezcli(url) || known.is_some_and(|f| f.sessions.iter().any(|(_, s)| s.iter().any(|(n, u)| n == name && u == url)))
    };
    let mut config = existing.clone().unwrap_or_default();
    check(&config, &servers, ours)?;
    let created_dir = !dir.exists();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for (name, url) in &servers {
        set(&mut config, name, Some(url));
    }
    if let Err(e) = write(&file, &config) {
        if created_dir {
            let _ = std::fs::remove_dir(&dir);
        }
        return Err(e);
    }
    let entry = state.folders.entry(file.clone()).or_insert_with(|| Folder { created_file: existing.is_none(), created_dir, ..Folder::default() });
    entry.sessions.push((pty_id.to_string(), servers));
    state.owner.insert(pty_id.to_string(), file);
    Ok(())
}

/// Take a session's servers out again (or hand them to another session in the same folder).
/// Does nothing for a session that added none. If the file cannot be updated, the record is kept
/// so a later call (ezCLI closing) tries again.
pub fn detach(pty_id: &str) {
    let Ok(mut guard) = STATE.lock() else { return };
    let Some(state) = guard.as_mut() else { return };
    let Some(file) = state.owner.get(pty_id).cloned() else { return };
    let Some(folder) = state.folders.get_mut(&file) else {
        state.owner.remove(pty_id);
        return;
    };
    let Some(at) = folder.sessions.iter().position(|(id, _)| id == pty_id) else {
        state.owner.remove(pty_id);
        return;
    };
    let (_, mine) = folder.sessions.remove(at);
    let done = match read(&file) {
        Ok(None) => true,
        Ok(Some(mut config)) if !is_symlink(&file) => {
            for (name, url) in &mine {
                let current = config.get("mcpServers").and_then(|l| l.get(name)).and_then(|e| e.get("serverUrl")).and_then(Value::as_str);
                if current == Some(url.as_str()) {
                    let next = newest(folder, name);
                    set(&mut config, name, next.as_deref());
                }
            }
            if config.is_empty() && folder.sessions.is_empty() && folder.created_file {
                let removed = std::fs::remove_file(&file).is_ok();
                if removed && folder.created_dir {
                    if let Some(dir) = file.parent() {
                        let _ = std::fs::remove_dir(dir); // only succeeds when empty
                    }
                }
                removed
            } else {
                write(&file, &config).is_ok()
            }
        }
        _ => true, // no longer a file ezCLI may touch: nothing to clean
    };
    if !done {
        folder.sessions.insert(at, (pty_id.to_string(), mine));
        return;
    }
    state.owner.remove(pty_id);
    if folder.sessions.is_empty() {
        state.folders.remove(&file);
    }
}

/// Take out every session's servers (ezCLI is closing).
pub fn detach_all() {
    let ids: Vec<String> = STATE.lock().ok().and_then(|g| g.as_ref().map(|s| s.owner.keys().cloned().collect())).unwrap_or_default();
    for id in ids {
        detach(&id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(n: &str, u: &str) -> (String, String) {
        (n.to_string(), u.to_string())
    }

    fn temp(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("ezcli-agy-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    fn load(base: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(config_file(base)).unwrap()).unwrap()
    }

    #[test]
    fn a_users_servers_are_kept_and_clashes_refused() {
        let base = temp("user");
        std::fs::create_dir_all(base.join(".agents")).unwrap();
        std::fs::write(config_file(&base), r#"{"mcpServers":{"mine":{"command":"node"}},"x":1}"#).unwrap();
        attach(&base, "u1", vec![pair("ezcli", "http://127.0.0.1:5/mcp/a")]).unwrap();
        assert_eq!(load(&base)["mcpServers"]["mine"]["command"], "node");
        detach("u1");
        assert_eq!(load(&base), json!({ "mcpServers": { "mine": { "command": "node" } }, "x": 1 }));

        // a server of the user's own named "ezcli" is never replaced
        std::fs::write(config_file(&base), r#"{"mcpServers":{"ezcli":{"command":"mine"}}}"#).unwrap();
        assert!(attach(&base, "u2", vec![pair("ezcli", "http://127.0.0.1:5/mcp/b")]).is_err());
        assert_eq!(load(&base), json!({ "mcpServers": { "ezcli": { "command": "mine" } } }));

        for bad in ["not json", r#"{"mcpServers":[1]}"#] {
            std::fs::write(config_file(&base), bad).unwrap();
            assert!(attach(&base, "u3", vec![pair("ezcli", "x")]).is_err());
            assert_eq!(std::fs::read_to_string(config_file(&base)).unwrap(), bad);
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn two_sessions_in_one_folder_hand_over_and_clean_up() {
        let base = temp("two");
        attach(&base, "s1", vec![pair("ezcli", "http://127.0.0.1:5/mcp/a")]).unwrap();
        attach(&base, "s2", vec![pair("ezcli", "http://127.0.0.1:5/mcp/b")]).unwrap();
        assert_eq!(load(&base)["mcpServers"]["ezcli"]["serverUrl"], "http://127.0.0.1:5/mcp/b");
        detach("s2");
        assert_eq!(load(&base)["mcpServers"]["ezcli"]["serverUrl"], "http://127.0.0.1:5/mcp/a", "the running session gets it back");
        attach(&base, "s3", vec![pair("ezcli", "http://127.0.0.1:5/mcp/c")]).unwrap();
        detach("s1");
        assert_eq!(load(&base)["mcpServers"]["ezcli"]["serverUrl"], "http://127.0.0.1:5/mcp/c", "an older session ending leaves the newer one's");
        detach("s3");
        assert!(!base.join(".agents").exists(), "the file and folder ezCLI made are gone");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn an_entry_left_by_a_crashed_ezcli_is_replaced() {
        let base = temp("crash");
        std::fs::create_dir_all(base.join(".agents")).unwrap();
        let dead = format!("http://127.0.0.1:51234/mcp/{}", "ab".repeat(16));
        std::fs::write(config_file(&base), json!({ "mcpServers": { "ezcli": { "serverUrl": dead } } }).to_string()).unwrap();
        attach(&base, "c1", vec![pair("ezcli", "http://127.0.0.1:5/mcp/new")]).unwrap();
        assert_eq!(load(&base)["mcpServers"]["ezcli"]["serverUrl"], "http://127.0.0.1:5/mcp/new");
        detach("c1");
        assert!(looks_like_ezcli(&dead));
        assert!(!looks_like_ezcli("https://example.com/mcp/abababababababababababababababab"));
        assert!(!looks_like_ezcli("http://127.0.0.1:80/mcp/short"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn links_are_not_written_through() {
        let base = temp("link");
        let target = base.join("target.json");
        std::fs::write(&target, r#"{"keep":true}"#).unwrap();
        std::fs::create_dir_all(base.join(".agents")).unwrap();
        std::os::unix::fs::symlink(&target, config_file(&base)).unwrap();
        assert!(attach(&base, "l1", vec![pair("ezcli", "x")]).is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), r#"{"keep":true}"#);
        let _ = std::fs::remove_dir_all(&base);
    }
}
