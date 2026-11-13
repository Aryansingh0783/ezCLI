//! VoiceStudio (github.com/debpalash/voicestudio): a local voice app that serves an MCP endpoint
//! while it is open. ezCLI does not bundle or install it. It only asks whether one is listening on
//! this computer, so Settings can offer to connect it to the agents as a connector.
//!
//! The check is VoiceStudio's own discovery document on loopback; nothing leaves the machine.

/// VoiceStudio's default port (`OMNIVOICE_PORT`).
pub const DEFAULT_PORT: u16 = 3900;

/// A port a local app can listen on. Anything else is refused before a request is made.
pub fn valid_port(port: u16) -> bool {
    port >= 1024
}

pub fn discovery_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/.well-known/voicestudio-speech")
}

/// The address agents are given. The trailing slash is part of it.
pub fn mcp_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/mcp/")
}

/// The discovery document names its protocol `voicestudio.speech.v1`; some other program answering
/// on the same port does not.
pub fn is_discovery(body: &str) -> bool {
    body.contains("voicestudio.speech")
}

/// Is VoiceStudio answering on this computer? Two seconds at most.
pub fn running(port: u16) -> bool {
    valid_port(port) && crate::web_context::get(&discovery_url(port), 2, 64 * 1024).is_some_and(|body| is_discovery(&body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_loopback_addresses_are_built_and_system_ports_are_refused() {
        assert_eq!(discovery_url(3900), "http://127.0.0.1:3900/.well-known/voicestudio-speech");
        assert_eq!(mcp_url(4100), "http://127.0.0.1:4100/mcp/");
        assert!(valid_port(DEFAULT_PORT));
        assert!(!valid_port(80));
        assert!(!running(22), "a refused port is never requested");
    }

    #[test]
    fn the_discovery_document_is_told_apart_from_another_program_on_the_port() {
        assert!(is_discovery(r#"{"protocol":"voicestudio.speech.v1","transcriptions":"/v1/audio/transcriptions"}"#));
        assert!(!is_discovery("<html><title>My dev server</title></html>"));
        assert!(!is_discovery(""));
    }
}

#[cfg(test)]
mod live {
    /// Against a VoiceStudio that is really running: `EZCLI_VOICESTUDIO_PORT=3900 cargo test --lib voicestudio::live -- --ignored`
    #[test]
    #[ignore = "needs VoiceStudio running on this computer"]
    fn a_running_voicestudio_is_found_and_a_silent_port_is_not() {
        let port: u16 = std::env::var("EZCLI_VOICESTUDIO_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(super::DEFAULT_PORT);
        assert!(super::running(port), "VoiceStudio did not answer on {port}");
        assert!(!super::running(port + 1), "nothing listens on the next port, so it must read as not running");
    }
}
