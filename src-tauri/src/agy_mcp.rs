//! Antigravity CLI (`agy`) has no flag or environment variable for extra MCP servers: it reads
//! them only from the global `~/.gemini/config/mcp_config.json` or from the workspace file
//! `<folder>/.agents/mcp_config.json`. The owner chose the workspace file, so while an Antigravity
//! session runs, ezCLI adds its own entries (each `{ "serverUrl": … }`) to that file and takes them
//! out again when the session ends. Entries the user wrote are never touched, and a file or folder
//! ezCLI had to create is removed again once nothing else is in it.

use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

struct Added {
    file: PathBuf,
    /// Server name -> the URL ezCLI wrote, so only an entry still pointing there is removed.
    servers: Vec<(String, String)>,
    created_file: bool,
    created_dir: bool,
}

static ADDED: Mutex<Option<HashMap<String, Added>>> = Mutex::new(None);

pub fn config_file(folder: &Path) -> PathBuf {
    folder.join(".agents").join("mcp_config.json")
}

/// Read the workspace file as a JSON object. A file that exists but is not a JSON object is the
/// user's and is never overwritten.
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

/// Merge `servers` (name, URL) into the config object.
pub fn merged(mut config: Map<String, Value>, servers: &[(String, String)]) -> Map<String, Value> {
    let list = config.entry("mcpServers").or_insert_with(|| json!({}));
    if !list.is_object() {
        *list = json!({});
    }
    let list = list.as_object_mut().expect("made an object above");
    for (name, url) in servers {
        list.insert(name.clone(), json!({ "serverUrl": url }));
    }
    config
}

/// Take out the entries that still point at the URL ezCLI wrote. Returns the remaining object.
pub fn removed(mut config: Map<String, Value>, servers: &[(String, String)]) -> Map<String, Value> {
    let mut now_empty = false;
    if let Some(Value::Object(list)) = config.get_mut("mcpServers") {
        for (name, url) in servers {
            if list.get(name).and_then(|v| v.get("serverUrl")).and_then(Value::as_str) == Some(url.as_str()) {
                list.remove(name);
            }
        }
        now_empty = list.is_empty();
    }
    if now_empty {
        config.remove("mcpServers");
    }
    config
}

/// Add ezCLI's servers to `<folder>/.agents/mcp_config.json` for the session `pty_id`.
pub fn attach(folder: &Path, pty_id: &str, servers: Vec<(String, String)>) -> Result<(), String> {
    let file = config_file(folder);
    let dir = file.parent().expect("has a parent").to_path_buf();
    let created_dir = !dir.exists();
    let existing = read(&file)?;
    let created_file = existing.is_none();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let config = merged(existing.unwrap_or_default(), &servers);
    let text = serde_json::to_string_pretty(&Value::Object(config)).map_err(|e| e.to_string())?;
    std::fs::write(&file, text).map_err(|e| e.to_string())?;
    if let Ok(mut g) = ADDED.lock() {
        g.get_or_insert_with(HashMap::new).insert(pty_id.to_string(), Added { file, servers, created_file, created_dir });
    }
    Ok(())
}

/// Take a session's servers out again. Does nothing for a session that added none.
pub fn detach(pty_id: &str) {
    let Some(added) = ADDED.lock().ok().and_then(|mut g| g.as_mut().and_then(|m| m.remove(pty_id))) else {
        return;
    };
    let Ok(Some(config)) = read(&added.file) else {
        return;
    };
    let left = removed(config, &added.servers);
    if left.is_empty() && added.created_file {
        let _ = std::fs::remove_file(&added.file);
        if added.created_dir {
            if let Some(dir) = added.file.parent() {
                // Only succeeds when the folder is empty.
                let _ = std::fs::remove_dir(dir);
            }
        }
    } else if let Ok(text) = serde_json::to_string_pretty(&Value::Object(left)) {
        let _ = std::fs::write(&added.file, text);
    }
}

/// Take out every session's servers (ezCLI is closing).
pub fn detach_all() {
    let ids: Vec<String> = ADDED.lock().ok().and_then(|g| g.as_ref().map(|m| m.keys().cloned().collect())).unwrap_or_default();
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

    #[test]
    fn adds_beside_the_users_servers_and_removes_only_its_own() {
        let users = json!({ "mcpServers": { "mine": { "command": "node" } }, "other": 1 });
        let Value::Object(users) = users else { unreachable!() };
        let ours = vec![pair("ezcli", "http://127.0.0.1:5/mcp/a")];
        let with = merged(users.clone(), &ours);
        assert_eq!(with["mcpServers"]["ezcli"]["serverUrl"], "http://127.0.0.1:5/mcp/a");
        assert_eq!(with["mcpServers"]["mine"]["command"], "node");
        assert_eq!(removed(with, &ours), users);
    }

    #[test]
    fn an_entry_another_session_replaced_is_left_in_place() {
        let first = vec![pair("ezcli", "http://127.0.0.1:5/mcp/a")];
        let second = vec![pair("ezcli", "http://127.0.0.1:5/mcp/b")];
        let both = merged(merged(Map::new(), &first), &second);
        let after_first_ends = removed(both, &first);
        assert_eq!(after_first_ends["mcpServers"]["ezcli"]["serverUrl"], "http://127.0.0.1:5/mcp/b");
        assert!(removed(after_first_ends, &second).is_empty());
    }

    #[test]
    fn a_file_and_folder_ezcli_made_are_removed_and_a_users_file_is_kept() {
        let base = std::env::temp_dir().join(format!("ezcli-agy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        attach(&base, "t1", vec![pair("ezcli", "http://127.0.0.1:5/mcp/a")]).unwrap();
        assert!(config_file(&base).exists());
        detach("t1");
        assert!(!base.join(".agents").exists(), "folder ezCLI made is gone");

        std::fs::create_dir_all(base.join(".agents")).unwrap();
        std::fs::write(config_file(&base), r#"{"mcpServers":{"mine":{"command":"node"}}}"#).unwrap();
        attach(&base, "t2", vec![pair("ezcli", "http://127.0.0.1:5/mcp/b")]).unwrap();
        detach("t2");
        let left: Value = serde_json::from_str(&std::fs::read_to_string(config_file(&base)).unwrap()).unwrap();
        assert_eq!(left, json!({ "mcpServers": { "mine": { "command": "node" } } }));

        std::fs::write(config_file(&base), "not json").unwrap();
        assert!(attach(&base, "t3", vec![pair("ezcli", "x")]).is_err());
        assert_eq!(std::fs::read_to_string(config_file(&base)).unwrap(), "not json");
        let _ = std::fs::remove_dir_all(&base);
    }
}
