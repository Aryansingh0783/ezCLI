//! Backend detection.
//!
//! "What can this user actually run?" We probe the machine once at startup so
//! the first-run wizard can recommend a working path instead of letting the
//! user pick something that will fail. We only report presence booleans; we
//! never read credential or key *values*.
//!
//! Routing rule (Aryan, 2026-10-15): a user without a paid plan must land on a
//! free agent that works, never on a CLI that will refuse to start. Claude Code
//! does not run on the Claude Free plan, so having the `claude` binary is not
//! enough to count as "Claude ready"; a sign-in or API key must exist too.

use crate::agents::{self, AgentDef};
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
    /// A Codex sign-in looks present (~/.codex/auth.json).
    pub codex_signin: bool,
    /// ANTHROPIC_API_KEY is set in the environment.
    pub anthropic_key: bool,
    /// OPENAI_API_KEY is set in the environment.
    pub openai_key: bool,
    /// `ollama` resolves on PATH (local models for Ollama or OpenCode).
    pub ollama: bool,
    /// Ids of free-tier agents whose command is installed.
    pub free_ready: Vec<String>,
    /// Ids of free-tier agents that are NOT installed (the wizard offers them).
    pub free_missing: Vec<String>,
    /// The agent id the wizard should default to, if any is usable.
    pub recommended: Option<String>,
    /// Why that recommendation, in one short user-facing sentence.
    pub reason: String,
    /// True when nothing usable was found.
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

/// Presence of Codex's auth file. Contents are never read.
fn codex_signed_in() -> bool {
    home().is_some_and(|h| h.join(".codex").join("auth.json").is_file())
}

fn env_set(key: &str) -> bool {
    std::env::var_os(key).map(|v| !v.is_empty()).unwrap_or(false)
}

pub fn detect(agent_defs: &[AgentDef]) -> BackendReport {
    let claude_cli = agents::resolve_command("claude").is_some();
    let codex_cli = agents::resolve_command("codex").is_some();
    let chatgpt_cli = agents::resolve_command("chatgpt").is_some();
    let claude_signin = claude_signed_in();
    let codex_signin = codex_signed_in();
    let anthropic_key = env_set("ANTHROPIC_API_KEY");
    let openai_key = env_set("OPENAI_API_KEY");
    let ollama = agents::resolve_command("ollama").is_some();

    let mut free_ready = Vec::new();
    let mut free_missing = Vec::new();
    for a in agent_defs {
        if a.tier.as_deref().is_some_and(|t| t.eq_ignore_ascii_case("free")) {
            if agents::resolve_command(&a.command).is_some() {
                free_ready.push(a.id.clone());
            } else {
                free_missing.push(a.id.clone());
            }
        }
    }

    let ids: Vec<(String, String)> = agent_defs.iter().map(|a| (a.id.clone(), a.vendor.clone())).collect();
    let ready = Ready {
        claude: claude_cli && (claude_signin || anthropic_key),
        openai: (codex_cli && (codex_signin || openai_key)) || (chatgpt_cli && openai_key),
    };
    let (recommended, reason) = recommend(&ids, ready, &free_ready);

    BackendReport {
        claude_cli,
        codex_cli,
        chatgpt_cli,
        claude_signin,
        codex_signin,
        anthropic_key,
        openai_key,
        ollama,
        empty: recommended.is_none(),
        free_ready,
        free_missing,
        recommended,
        reason,
    }
}

#[derive(Clone, Copy)]
struct Ready {
    claude: bool,
    openai: bool,
}

fn recommend(agent_ids: &[(String, String)], ready: Ready, free_ready: &[String]) -> (Option<String>, String) {
    let find = |vendor: &str| {
        agent_ids
            .iter()
            .find(|(_, v)| v.eq_ignore_ascii_case(vendor))
            .map(|(id, _)| id.clone())
    };
    if ready.claude {
        if let Some(id) = find("claude") {
            return (Some(id), "Claude Code is installed and signed in.".into());
        }
    }
    if ready.openai {
        if let Some(id) = find("openai") {
            return (Some(id), "Codex is installed and signed in.".into());
        }
    }
    if let Some(id) = free_ready.first() {
        return (
            Some(id.clone()),
            "No paid plan was detected, so ezCLI starts with a free agent.".into(),
        );
    }
    (None, "No agent is ready yet. Install a free one to start.".into())
}

#[cfg(test)]
mod tests {
    use super::{recommend, Ready};

    fn agents() -> Vec<(String, String)> {
        vec![
            ("claude-code".into(), "claude".into()),
            ("codex".into(), "openai".into()),
            ("opencode".into(), "opencode".into()),
        ]
    }
    fn free() -> Vec<String> {
        vec!["opencode".into()]
    }

    #[test]
    fn recommends_claude_before_openai() {
        let (id, _) = recommend(&agents(), Ready { claude: true, openai: true }, &free());
        assert_eq!(id.as_deref(), Some("claude-code"));
    }

    #[test]
    fn recommends_openai_when_only_openai_is_ready() {
        let (id, _) = recommend(&agents(), Ready { claude: false, openai: true }, &free());
        assert_eq!(id.as_deref(), Some("codex"));
    }

    #[test]
    fn free_user_lands_on_a_free_agent() {
        // e.g. `claude` installed but no paid sign-in: must not pick Claude Code.
        let (id, why) = recommend(&agents(), Ready { claude: false, openai: false }, &free());
        assert_eq!(id.as_deref(), Some("opencode"));
        assert!(why.contains("free"));
    }

    #[test]
    fn antigravity_can_be_the_free_personal_google_route() {
        let free = vec!["antigravity".into()];
        let (id, why) = recommend(&agents(), Ready { claude: false, openai: false }, &free);
        assert_eq!(id.as_deref(), Some("antigravity"));
        assert!(why.contains("free"));
    }

    #[test]
    fn recommends_nothing_when_no_backend_is_ready() {
        let (id, _) = recommend(&agents(), Ready { claude: false, openai: false }, &[]);
        assert_eq!(id, None);
    }
}
