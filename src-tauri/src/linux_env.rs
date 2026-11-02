//! What the Linux desktop looks like (Wayland or X11, KDE, Hyprland, an NVIDIA GPU) and the WebKitGTK
//! settings that suit it. The window is a WebKitGTK view, and the same build is blank or slow on one
//! GPU/compositor pair and fine on another, so the settings are chosen at start-up from what is
//! detected instead of one list for everyone.
//!
//! Anything the user has already exported is left alone, and `EZCLI_WEBKIT_SAFE=1` / `=0` forces the
//! safe set on or off.

use std::path::Path;

#[derive(Debug, Default, PartialEq, Eq, Clone)]
pub struct LinuxEnv {
    pub wayland: bool,
    /// Lower-cased `XDG_CURRENT_DESKTOP`, e.g. `kde` or `hyprland`.
    pub desktop: String,
    pub hyprland: bool,
    pub nvidia: bool,
}

/// Work out the environment from variables and one GPU fact. Pure, so it can be tested.
pub fn classify(var: &dyn Fn(&str) -> Option<String>, nvidia: bool) -> LinuxEnv {
    let has = |k: &str| var(k).is_some_and(|v| !v.is_empty());
    let session = var("XDG_SESSION_TYPE").unwrap_or_default().to_lowercase();
    let desktop = var("XDG_CURRENT_DESKTOP").unwrap_or_default().to_lowercase();
    LinuxEnv {
        wayland: session == "wayland" || has("WAYLAND_DISPLAY"),
        hyprland: desktop.contains("hyprland") || has("HYPRLAND_INSTANCE_SIGNATURE"),
        desktop,
        nvidia,
    }
}

/// The NVIDIA proprietary driver is loaded, or a display adapter with NVIDIA's PCI vendor id exists.
pub fn nvidia_present() -> bool {
    if Path::new("/proc/driver/nvidia/version").exists() {
        return true;
    }
    let Ok(cards) = std::fs::read_dir("/sys/class/drm") else { return false };
    cards.flatten().any(|c| {
        std::fs::read_to_string(c.path().join("device/vendor")).is_ok_and(|v| v.trim().eq_ignore_ascii_case("0x10de"))
    })
}

pub fn detect() -> LinuxEnv {
    classify(&|k| std::env::var(k).ok(), nvidia_present())
}

/// The WebKitGTK variables that suit this machine.
///
/// - NVIDIA: WebKitGTK's DMA-BUF renderer gives a blank or very slow window with the proprietary
///   driver (worst on Wayland), so it is turned off.
/// - Anything else (Mesa on AMD or Intel): left on, since it is the faster path there.
/// - `force_safe` turns the NVIDIA set on for any machine.
pub fn webkit_vars(e: &LinuxEnv, force_safe: Option<bool>) -> Vec<(&'static str, &'static str)> {
    let safe = force_safe.unwrap_or(e.nvidia);
    if safe {
        vec![("WEBKIT_DISABLE_DMABUF_RENDERER", "1")]
    } else {
        Vec::new()
    }
}

/// Apply the settings for this machine before the window (and so WebKit) starts.
pub fn apply() -> LinuxEnv {
    let e = detect();
    let force = match std::env::var("EZCLI_WEBKIT_SAFE").ok().as_deref() {
        Some("1") => Some(true),
        Some("0") => Some(false),
        _ => None,
    };
    for (k, v) in webkit_vars(&e, force) {
        if std::env::var_os(k).is_none() {
            std::env::set_var(k, v);
        }
    }
    e
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let m: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k| m.get(k).cloned()
    }

    #[test]
    fn kde_on_wayland_with_nvidia() {
        let e = classify(&env_of(&[("XDG_SESSION_TYPE", "wayland"), ("XDG_CURRENT_DESKTOP", "KDE")]), true);
        assert!(e.wayland && e.nvidia && !e.hyprland);
        assert_eq!(e.desktop, "kde");
        assert_eq!(webkit_vars(&e, None), vec![("WEBKIT_DISABLE_DMABUF_RENDERER", "1")]);
    }

    #[test]
    fn hyprland_is_found_from_either_variable() {
        let a = classify(&env_of(&[("XDG_CURRENT_DESKTOP", "Hyprland"), ("WAYLAND_DISPLAY", "wayland-1")]), false);
        assert!(a.hyprland && a.wayland);
        let b = classify(&env_of(&[("HYPRLAND_INSTANCE_SIGNATURE", "abc")]), false);
        assert!(b.hyprland);
    }

    #[test]
    fn mesa_machines_keep_the_fast_renderer_unless_forced() {
        let e = classify(&env_of(&[("XDG_SESSION_TYPE", "x11")]), false);
        assert!(!e.wayland);
        assert!(webkit_vars(&e, None).is_empty());
        assert_eq!(webkit_vars(&e, Some(true)).len(), 1);
        let n = classify(&env_of(&[]), true);
        assert!(webkit_vars(&n, Some(false)).is_empty());
    }
}
