//! Path text helpers that do not depend on which OS the app runs on. Configs and transcripts can carry a
//! Windows path (`C:\npm\claude.cmd`) on Linux and the other way round, and `std::path::Path` only splits
//! on its own platform's separator.

/// The last folder or file name of `p`, splitting on both `/` and `\`. Trailing separators are ignored.
pub fn last_component(p: &str) -> &str {
    p.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or("")
}

/// The file name of `p` without its extension (`C:\npm\claude.cmd` gives `claude`).
pub fn stem(p: &str) -> &str {
    let name = last_component(p);
    match name.rfind('.') {
        Some(i) if i > 0 => &name[..i],
        _ => name,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_separators_are_understood_on_every_platform() {
        assert_eq!(last_component(r"F:\WORK\cli-gui"), "cli-gui");
        assert_eq!(last_component("/home/u/cli-gui/"), "cli-gui");
        assert_eq!(last_component("plain"), "plain");
        assert_eq!(last_component(""), "");
        assert_eq!(stem(r"C:\npm\claude.cmd"), "claude");
        assert_eq!(stem("/usr/bin/opencode"), "opencode");
        assert_eq!(stem(r"C:\npm\opencode.CMD"), "opencode");
        assert_eq!(stem(".hidden"), ".hidden");
    }
}
