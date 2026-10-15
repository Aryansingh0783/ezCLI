//! Backend detection.
//!
//! "What can this user actually run?" We probe the machine once at startup so
//! the first-run wizard can recommend a working path instead of letting the
//! user pick something that will fail. We only report presence booleans — we
//! never read credential or key *values*.

use crate::agents;
use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BackendReport {
    /// `claude` resolves on PATH.
    pub claude_cli: bool,
    /// `codex` resolves on PATH.
    pub codex_cli: bool,
    /// `chatgpt` resolves on PATH.
    pub chatgpt_cli: bool,
    /// A Claude sign-in looks present (a credentials file under ~/.claude).
    pub claude_signin: bool,
    /// ANTHROPIC_API_KEY is set in the environment.
    pub anthropic_key: bool,
    /// OPENAI_API_KEY is set in the environment.
    pub openai_key: bool,
    /// The agent id the wizard should default to, if any is usable.
    pub recommended: Option<String>,
    /// True when nothing usable was found (no CLI, no sign-in, no key).
    pub empty: bool,
}

fn home() -> Option<PathBuf> {
    dirs::home_dir()
}

/// Heuristic: does a Claude sign-in exist? Claude Code can keep credentials
/// under ~/.claude or account metadata in ~/.claude.json. We only check that
/// one of those files exists, never its contents.
fn claude_signed_in() -> bool {
    let Some(h) = home() else { return false };
    let base = h.join(".claude");
    [".credentials.json", "credentials.json"]
        .iter()
        .any(|f| base.join(f).is_file())
        || h.join(".claude.json").is_file()
}

fn env_set(key: &str) -> bool {
    std::env::var_os(key).map(|v| !v.is_empty()).unwrap_or(false)
}

/// Detect the environment. `agent_ids` are the ids from agents.json so the
/// recommendation maps back to something the UI can actually select.
pub fn detect(agent_ids: &[(String, String)]) -> BackendReport {
    let claude_cli = agents::resolve_command("claude").is_some();
    let codex_cli = agents::resolve_command("codex").is_some();
    let chatgpt_cli = agents::resolve_command("chatgpt").is_some();
    let claude_signin = claude_signed_in();
    let anthropic_key = env_set("ANTHROPIC_API_KEY");
    let openai_key = env_set("OPENAI_API_KEY");

    let recommended = recommend(
        agent_ids,
        claude_cli || claude_signin || anthropic_key,
        codex_cli || chatgpt_cli || openai_key,
    );

    let empty =
        !(claude_cli || codex_cli || chatgpt_cli || claude_signin || anthropic_key || openai_key);

    BackendReport {
        claude_cli,
        codex_cli,
        chatgpt_cli,
        claude_signin,
        anthropic_key,
        openai_key,
        recommended,
        empty,
    }
}

fn recommend(agent_ids: &[(String, String)], claude_ready: bool, openai_ready: bool) -> Option<String> {
    // Prefer a Claude backend, then an OpenAI one. Map the preference to a
    // real configured agent id; the UI additionally confirms it is launchable.
    let find = |vendor: &str| {
        agent_ids
            .iter()
            .find(|(_, v)| v.eq_ignore_ascii_case(vendor))
            .map(|(id, _)| id.clone())
    };
    if claude_ready {
        find("claude").or_else(|| agent_ids.first().map(|(id, _)| id.clone()))
    } else if openai_ready {
        find("openai").or_else(|| agent_ids.first().map(|(id, _)| id.clone()))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::recommend;

    fn agents() -> Vec<(String, String)> {
        vec![
            ("claude-code".into(), "claude".into()),
            ("codex".into(), "openai".into()),
        ]
    }

    #[test]
    fn recommends_claude_before_openai() {
        assert_eq!(recommend(&agents(), true, true).as_deref(), Some("claude-code"));
    }

    #[test]
    fn recommends_openai_when_only_openai_is_ready() {
        assert_eq!(recommend(&agents(), false, true).as_deref(), Some("codex"));
    }

    #[test]
    fn recommends_nothing_when_no_backend_is_ready() {
        assert_eq!(recommend(&agents(), false, false), None);
    }
}
