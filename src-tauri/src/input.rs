//! Native keyboard and mouse injection for the PC-control tools.
//!
//! Like `capture.rs`, this module performs no permission checks: every caller
//! must already have passed `lib.rs::pc_control_allowed`. Coordinates are
//! absolute pixels on the primary monitor, the same space the `screenshot`
//! tool reports its `source` dimensions in, so a model can click where it saw
//! something.

use anyhow::{anyhow, Result};

/// One thing a model asked ezCLI to do on the machine. Parsed from the MCP
/// tool call before any input is injected, so a malformed request fails loudly
/// instead of half-executing.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Move { x: i32, y: i32 },
    Click { x: Option<i32>, y: Option<i32>, button: Button, double: bool },
    Scroll { x: Option<i32>, y: Option<i32>, dx: i32, dy: i32 },
    Type { text: String },
    Key { combo: Vec<String> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button {
    Left,
    Right,
    Middle,
}

impl Button {
    pub fn parse(s: &str) -> Result<Button> {
        match s.trim().to_ascii_lowercase().as_str() {
            "" | "left" | "l" => Ok(Button::Left),
            "right" | "r" => Ok(Button::Right),
            "middle" | "mid" | "m" => Ok(Button::Middle),
            other => Err(anyhow!("unknown mouse button: {other}")),
        }
    }
}

/// Split a key combo such as `"ctrl+shift+a"` into its parts, rejecting empty
/// segments so `"ctrl+"` is an error rather than a silent single press.
pub fn parse_combo(s: &str) -> Result<Vec<String>> {
    let parts: Vec<String> = s.split('+').map(|p| p.trim().to_string()).collect();
    if parts.is_empty() || parts.iter().any(|p| p.is_empty()) {
        return Err(anyhow!("empty key in combo: {s:?}"));
    }
    Ok(parts)
}

/// Run an action and return a short human-readable confirmation for the model.
pub fn perform(action: &Action) -> Result<String> {
    imp::perform(action)
}

#[cfg(windows)]
mod imp {
    use super::{Action, Button};
    use anyhow::{anyhow, Result};
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS,
        KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
        MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
        MOUSEEVENTF_WHEEL, MOUSE_EVENT_FLAGS, MOUSEINPUT, VIRTUAL_KEY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SetCursorPos, SM_CXSCREEN, SM_CYSCREEN,
    };

    const WHEEL_DELTA: i32 = 120;

    fn send(inputs: &[INPUT]) -> Result<()> {
        // SAFETY: `inputs` is a valid slice of fully-initialised INPUT records.
        let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent as usize != inputs.len() {
            return Err(anyhow!("input was blocked (sent {sent} of {})", inputs.len()));
        }
        Ok(())
    }

    fn primary_size() -> Result<(i32, i32)> {
        // SAFETY: GetSystemMetrics has no preconditions.
        let (w, h) = unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) };
        if w <= 0 || h <= 0 {
            return Err(anyhow!("no primary display"));
        }
        Ok((w, h))
    }

    fn move_to(x: i32, y: i32) -> Result<(i32, i32)> {
        let (w, h) = primary_size()?;
        let cx = x.clamp(0, w - 1);
        let cy = y.clamp(0, h - 1);
        // SAFETY: plain cursor positioning.
        unsafe { SetCursorPos(cx, cy).map_err(|e| anyhow!("could not move cursor: {e}"))? };
        Ok((cx, cy))
    }

    fn mouse_event(flags: MOUSE_EVENT_FLAGS, data: i32) -> INPUT {
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: 0,
                    dy: 0,
                    mouseData: data as u32,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn click(button: Button, double: bool) -> Result<()> {
        let (down, up) = match button {
            Button::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
            Button::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
            Button::Middle => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
        };
        let times = if double { 2 } else { 1 };
        let mut inputs = Vec::with_capacity(times * 2);
        for _ in 0..times {
            inputs.push(mouse_event(down, 0));
            inputs.push(mouse_event(up, 0));
        }
        send(&inputs)
    }

    fn key_input(vk: u16, up: bool) -> INPUT {
        let mut flags = KEYBD_EVENT_FLAGS(0);
        if up {
            flags |= KEYEVENTF_KEYUP;
        }
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(vk),
                    wScan: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn unicode_input(unit: u16, up: bool) -> INPUT {
        let mut flags = KEYEVENTF_UNICODE;
        if up {
            flags |= KEYEVENTF_KEYUP;
        }
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0),
                    wScan: unit,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn type_text(text: &str) -> Result<()> {
        if text.is_empty() {
            return Ok(());
        }
        let mut inputs = Vec::new();
        for unit in text.encode_utf16() {
            inputs.push(unicode_input(unit, false));
            inputs.push(unicode_input(unit, true));
        }
        // SendInput tolerates large batches, but keep chunks modest so a very
        // long paste can't exceed the per-call limit.
        for chunk in inputs.chunks(256) {
            send(chunk)?;
        }
        Ok(())
    }

    fn press_combo(combo: &[String]) -> Result<()> {
        let vks: Vec<u16> = combo.iter().map(|k| super::vk_for(k)).collect::<Result<_>>()?;
        let mut inputs = Vec::with_capacity(vks.len() * 2);
        for &vk in &vks {
            inputs.push(key_input(vk, false));
        }
        for &vk in vks.iter().rev() {
            inputs.push(key_input(vk, true));
        }
        send(&inputs)
    }

    pub fn perform(action: &Action) -> Result<String> {
        match action {
            Action::Move { x, y } => {
                let (cx, cy) = move_to(*x, *y)?;
                Ok(format!("Moved cursor to {cx},{cy}."))
            }
            Action::Click { x, y, button, double } => {
                let at = match (x, y) {
                    (Some(x), Some(y)) => Some(move_to(*x, *y)?),
                    _ => None,
                };
                click(*button, *double)?;
                let kind = if *double { "Double-clicked" } else { "Clicked" };
                Ok(match at {
                    Some((cx, cy)) => format!("{kind} {button:?} at {cx},{cy}."),
                    None => format!("{kind} {button:?} at the current cursor position."),
                })
            }
            Action::Scroll { x, y, dx, dy } => {
                if let (Some(x), Some(y)) = (x, y) {
                    move_to(*x, *y)?;
                }
                if *dy != 0 {
                    // Positive dy means scroll down; the wheel's own convention
                    // is the opposite (forward = up), so negate.
                    send(&[mouse_event(MOUSEEVENTF_WHEEL, -dy * WHEEL_DELTA)])?;
                }
                if *dx != 0 {
                    use windows::Win32::UI::Input::KeyboardAndMouse::MOUSEEVENTF_HWHEEL;
                    send(&[mouse_event(MOUSEEVENTF_HWHEEL, dx * WHEEL_DELTA)])?;
                }
                Ok(format!("Scrolled (dx={dx}, dy={dy})."))
            }
            Action::Type { text } => {
                type_text(text)?;
                Ok(format!("Typed {} characters.", text.chars().count()))
            }
            Action::Key { combo } => {
                press_combo(combo)?;
                Ok(format!("Pressed {}.", combo.join("+")))
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::Action;
    use anyhow::{anyhow, Result};
    pub fn perform(_action: &Action) -> Result<String> {
        Err(anyhow!("input injection is only implemented on Windows so far"))
    }
}

/// Map a key name to a Win32 virtual-key code. Names are case-insensitive. A
/// single printable character maps through its uppercase ASCII where possible;
/// everything else must be a known named key.
#[cfg(windows)]
pub fn vk_for(name: &str) -> Result<u16> {
    use windows::Win32::UI::Input::KeyboardAndMouse as k;
    let n = name.trim().to_ascii_lowercase();
    let vk = match n.as_str() {
        "ctrl" | "control" => k::VK_CONTROL,
        "alt" | "menu" => k::VK_MENU,
        "shift" => k::VK_SHIFT,
        "win" | "super" | "meta" | "cmd" => k::VK_LWIN,
        "enter" | "return" => k::VK_RETURN,
        "tab" => k::VK_TAB,
        "esc" | "escape" => k::VK_ESCAPE,
        "space" | "spacebar" => k::VK_SPACE,
        "backspace" | "back" => k::VK_BACK,
        "delete" | "del" => k::VK_DELETE,
        "insert" | "ins" => k::VK_INSERT,
        "home" => k::VK_HOME,
        "end" => k::VK_END,
        "pageup" | "pgup" => k::VK_PRIOR,
        "pagedown" | "pgdn" => k::VK_NEXT,
        "up" => k::VK_UP,
        "down" => k::VK_DOWN,
        "left" => k::VK_LEFT,
        "right" => k::VK_RIGHT,
        "capslock" => k::VK_CAPITAL,
        "printscreen" | "prtsc" => k::VK_SNAPSHOT,
        "f1" => k::VK_F1,
        "f2" => k::VK_F2,
        "f3" => k::VK_F3,
        "f4" => k::VK_F4,
        "f5" => k::VK_F5,
        "f6" => k::VK_F6,
        "f7" => k::VK_F7,
        "f8" => k::VK_F8,
        "f9" => k::VK_F9,
        "f10" => k::VK_F10,
        "f11" => k::VK_F11,
        "f12" => k::VK_F12,
        _ => {
            let bytes = n.as_bytes();
            if bytes.len() == 1 {
                let c = bytes[0].to_ascii_uppercase();
                if c.is_ascii_alphanumeric() {
                    return Ok(c as u16);
                }
            }
            return Err(anyhow!("unknown key: {name}"));
        }
    };
    Ok(vk.0)
}

#[cfg(not(windows))]
pub fn vk_for(_name: &str) -> Result<u16> {
    Err(anyhow!("key mapping is only implemented on Windows so far"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buttons_parse_with_aliases_and_reject_junk() {
        assert_eq!(Button::parse("").unwrap(), Button::Left);
        assert_eq!(Button::parse("Left").unwrap(), Button::Left);
        assert_eq!(Button::parse("R").unwrap(), Button::Right);
        assert_eq!(Button::parse("middle").unwrap(), Button::Middle);
        assert!(Button::parse("scroll").is_err());
    }

    #[test]
    fn combos_split_and_reject_empty_segments() {
        assert_eq!(parse_combo("ctrl+c").unwrap(), vec!["ctrl", "c"]);
        assert_eq!(parse_combo(" Ctrl + Shift + A ").unwrap(), vec!["Ctrl", "Shift", "A"]);
        assert!(parse_combo("ctrl+").is_err());
        assert!(parse_combo("").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn key_names_map_and_unknowns_fail() {
        assert_eq!(vk_for("a").unwrap(), b'A' as u16);
        assert_eq!(vk_for("Z").unwrap(), b'Z' as u16);
        assert_eq!(vk_for("5").unwrap(), b'5' as u16);
        assert!(vk_for("enter").is_ok());
        assert!(vk_for("ctrl").is_ok());
        assert!(vk_for("f12").is_ok());
        assert!(vk_for("nope").is_err());
        assert!(vk_for("ab").is_err());
    }
}
