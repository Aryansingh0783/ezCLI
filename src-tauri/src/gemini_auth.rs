//! Connect Gemini CLI with a Gemini API key the user supplies.
//!
//! Google dropped personal Google sign-in for Gemini CLI, so a free key from
//! aistudio.google.com is the simplest way to use it. The user pastes their own key; ezCLI
//! writes it to `~/.gemini/.env` (where Gemini CLI reads it) and sets the CLI's auth type to
//! `gemini-api-key` in `~/.gemini/settings.json`, preserving everything else in both files.
//! ezCLI never sends the key anywhere and never prints it back.

use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

fn gemini_dir() -> Result<PathBuf, String> {
    Ok(dirs::home_dir().ok_or("No home folder")?.join(".gemini"))
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GeminiStatus {
    /// A key is set in the environment or in `~/.gemini/.env`.
    pub has_key: bool,
    /// `oauth-personal`, `gemini-api-key`, `vertex-ai`, or empty when unset.
    pub auth_type: String,
    /// The CLI is ready to run with a key (has a key and is set to use it).
    pub ready: bool,
}

/// Whether `~/.gemini/.env` defines GEMINI_API_KEY (or GOOGLE_API_KEY) with a value.
fn env_file_has_key() -> bool {
    let Ok(dir) = gemini_dir() else { return false };
    let Ok(text) = fs::read_to_string(dir.join(".env")) else { return false };
    text.lines().any(|l| {
        let l = l.trim().strip_prefix("export ").unwrap_or(l.trim());
        for name in ["GEMINI_API_KEY", "GOOGLE_API_KEY"] {
            if let Some(rest) = l.strip_prefix(name) {
                if let Some(val) = rest.trim_start().strip_prefix('=') {
                    return !val.trim().trim_matches(['"', '\'']).is_empty();
                }
            }
        }
        false
    })
}

fn selected_auth_type() -> String {
    let Ok(dir) = gemini_dir() else { return String::new() };
    let Ok(text) = fs::read_to_string(dir.join("settings.json")) else { return String::new() };
    serde_json::from_str::<Value>(&text)
        .ok()
        .as_ref()
        .and_then(|v| v.pointer("/security/auth/selectedType").and_then(Value::as_str))
        .unwrap_or("")
        .to_string()
}

pub fn status() -> GeminiStatus {
    let env = std::env::var("GEMINI_API_KEY").is_ok() || std::env::var("GOOGLE_API_KEY").is_ok();
    let has_key = env || env_file_has_key();
    let auth_type = selected_auth_type();
    GeminiStatus { ready: has_key && auth_type == "gemini-api-key", has_key, auth_type }
}

/// A Gemini API key: Google's keys are `AIza` followed by 35 URL-safe chars, but
/// accept any plausible single-line token so a format change does not lock the user out.
fn looks_like_key(key: &str) -> bool {
    let k = key.trim();
    (20..=200).contains(&k.len()) && k.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
}

/// Write the key into `~/.gemini/.env`, replacing any existing GEMINI_API_KEY line and
/// keeping the rest of the file. Returns the file's other contents untouched.
fn write_env(dir: &std::path::Path, key: &str) -> Result<(), String> {
    let path = dir.join(".env");
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let mut lines: Vec<String> = existing
        .lines()
        .filter(|l| {
            let t = l.trim().strip_prefix("export ").unwrap_or(l.trim());
            !t.starts_with("GEMINI_API_KEY")
        })
        .map(str::to_string)
        .collect();
    lines.push(format!("GEMINI_API_KEY={key}"));
    let mut body = lines.join("\n");
    body.push('\n');
    fs::write(&path, body).map_err(|e| format!("Could not write ~/.gemini/.env: {e}"))
}

/// Set `security.auth.selectedType = "gemini-api-key"` in settings.json, preserving
/// every other setting and writing valid JSON back.
fn set_auth_type(dir: &std::path::Path) -> Result<(), String> {
    let path = dir.join("settings.json");
    let mut root: Value = match fs::read_to_string(&path) {
        Ok(t) if !t.trim().is_empty() => serde_json::from_str(&t).map_err(|e| format!("settings.json is not valid JSON: {e}"))?,
        _ => Value::Object(Default::default()),
    };
    if !root.is_object() {
        return Err("settings.json is not a JSON object".into());
    }
    let obj = root.as_object_mut().unwrap();
    let security = obj.entry("security").or_insert_with(|| Value::Object(Default::default()));
    if !security.is_object() {
        *security = Value::Object(Default::default());
    }
    let auth = security.as_object_mut().unwrap().entry("auth").or_insert_with(|| Value::Object(Default::default()));
    if !auth.is_object() {
        *auth = Value::Object(Default::default());
    }
    auth.as_object_mut().unwrap().insert("selectedType".into(), Value::String("gemini-api-key".into()));
    let body = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    fs::write(&path, body).map_err(|e| format!("Could not write ~/.gemini/settings.json: {e}"))
}

/// Store the user's key and switch Gemini CLI to API-key auth. The key never leaves this PC.
pub fn connect(key: &str) -> Result<GeminiStatus, String> {
    let key = key.trim();
    if !looks_like_key(key) {
        return Err("That does not look like a Gemini API key. Copy the whole key from aistudio.google.com/apikey.".into());
    }
    let dir = gemini_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create ~/.gemini: {e}"))?;
    write_env(&dir, key)?;
    set_auth_type(&dir)?;
    Ok(status())
}

/// Remove the stored key and clear API-key auth, so the next launch asks again.
pub fn disconnect() -> Result<GeminiStatus, String> {
    let dir = gemini_dir()?;
    let path = dir.join(".env");
    if let Ok(existing) = fs::read_to_string(&path) {
        let kept: Vec<&str> = existing
            .lines()
            .filter(|l| {
                let t = l.trim().strip_prefix("export ").unwrap_or(l.trim());
                !t.starts_with("GEMINI_API_KEY")
            })
            .collect();
        if kept.iter().any(|l| !l.trim().is_empty()) {
            fs::write(&path, format!("{}\n", kept.join("\n"))).ok();
        } else {
            fs::remove_file(&path).ok();
        }
    }
    // Leave settings.json's auth type as the user set it; only the key is removed.
    Ok(status())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_shape_is_checked() {
        assert!(looks_like_key("AIzaSyA1234567890_abcdefghijklmnopqrstu"));
        assert!(!looks_like_key("too short"));
        assert!(!looks_like_key("has spaces in it which is wrong here"));
        assert!(!looks_like_key("with\nnewline_padding_to_make_it_long_enough"));
    }

    #[test]
    fn env_write_replaces_only_the_key_line() {
        let dir = std::env::temp_dir().join(format!("ezcli-gem-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(".env"), "OTHER=1\nGEMINI_API_KEY=old\n# note\n").unwrap();
        write_env(&dir, "newkey1234567890_abcdefghij").unwrap();
        let out = fs::read_to_string(dir.join(".env")).unwrap();
        assert!(out.contains("OTHER=1"));
        assert!(out.contains("# note"));
        assert!(out.contains("GEMINI_API_KEY=newkey1234567890_abcdefghij"));
        assert_eq!(out.matches("GEMINI_API_KEY").count(), 1);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn auth_type_is_set_without_losing_other_settings() {
        let dir = std::env::temp_dir().join(format!("ezcli-gem2-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("settings.json"), r#"{"ui":{"theme":"Dark"},"security":{"auth":{"selectedType":"oauth-personal"}}}"#).unwrap();
        set_auth_type(&dir).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(dir.join("settings.json")).unwrap()).unwrap();
        assert_eq!(v.pointer("/security/auth/selectedType").unwrap(), "gemini-api-key");
        assert_eq!(v.pointer("/ui/theme").unwrap(), "Dark");
        fs::remove_dir_all(&dir).ok();
    }
}
