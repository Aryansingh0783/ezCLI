//! Explicit, per-live-session PC-control consent.
//!
//! This module does not perform input injection, capture, or shell execution.
//! It is the deny-by-default guard those future actions must use.

use dashmap::DashSet;

#[derive(Default)]
pub struct PcControlStore {
    granted: DashSet<String>,
}

impl PcControlStore {
    pub fn set(&self, session_id: &str, enabled: bool) -> bool {
        if enabled {
            self.granted.insert(session_id.to_string());
        } else {
            self.granted.remove(session_id);
        }
        self.granted.contains(session_id)
    }

    pub fn revoke(&self, session_id: &str) {
        self.granted.remove(session_id);
    }

    #[allow(dead_code)]
    pub fn allowed(&self, session_id: &str) -> bool {
        self.granted.contains(session_id)
    }
}

#[cfg(test)]
mod tests {
    use super::PcControlStore;

    #[test]
    fn permission_is_off_until_an_explicit_grant_and_revocable() {
        let store = PcControlStore::default();
        assert!(!store.allowed("p1"));
        assert!(store.set("p1", true));
        assert!(store.allowed("p1"));
        assert!(!store.set("p1", false));
        assert!(!store.allowed("p1"));
    }
}
