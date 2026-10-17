//! An in-app browser the model can drive over MCP.
//!
//! One extra webview window (label `pc-browser`) loads real sites. Its label is
//! deliberately outside the capabilities manifest (which lists only `main` and
//! `win-*`), so the page it loads has **no** ezCLI command access — it cannot
//! call back into the app. The model therefore works the way a person would:
//! it navigates, reads a screenshot, and clicks or types by coordinate.
//!
//! Like `capture` and `input`, this module does no permission checks; the MCP
//! server gates every call behind the same PC-control consent guard.

use crate::capture::{self, Capture};
use crate::input::{self, Action, Button};
use anyhow::{anyhow, Result};
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "pc-browser";

/// One thing the model asked the in-app browser to do.
#[derive(Debug, Clone)]
pub enum Cmd {
    Navigate(String),
    Screenshot,
    Click { x: i32, y: i32, button: Button, double: bool },
    Type(String),
    Key(Vec<String>),
    Scroll { dx: i32, dy: i32 },
    Back,
    Forward,
    Reload,
}

pub enum Reply {
    Text(String),
    Image(Capture),
}

/// Only ordinary web pages. This mirrors the intent of the provider web-chat
/// windows: a plain browser, never a file:// or app:// surface.
fn validate_url(url: &str) -> Result<tauri::Url> {
    let parsed = tauri::Url::parse(url.trim()).map_err(|_| anyhow!("not a valid URL: {url:?}"))?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        other => Err(anyhow!("only http and https pages are allowed, not {other}:")),
    }
}

pub fn run(app: &AppHandle, cmd: Cmd) -> Result<Reply> {
    match cmd {
        Cmd::Navigate(url) => {
            let parsed = validate_url(&url)?;
            open_or_navigate(app, parsed)?;
            Ok(Reply::Text(format!("Opened {url}. Take a screenshot to see it.")))
        }
        Cmd::Screenshot => {
            let hwnd = require_window(app)?.0;
            // Give a just-issued navigation a moment to paint.
            std::thread::sleep(Duration::from_millis(400));
            Ok(Reply::Image(capture::window_client(hwnd)?))
        }
        Cmd::Click { x, y, button, double } => {
            let (hwnd, win) = require_window(app)?;
            focus(&win)?;
            let (sx, sy) = client_to_screen(hwnd, x, y)?;
            input::perform(&Action::Click { x: Some(sx), y: Some(sy), button, double })?;
            Ok(Reply::Text(format!("Clicked the page at {x},{y}.")))
        }
        Cmd::Type(text) => {
            let (_, win) = require_window(app)?;
            focus(&win)?;
            input::perform(&Action::Type { text: text.clone() })?;
            Ok(Reply::Text(format!("Typed {} characters into the page.", text.chars().count())))
        }
        Cmd::Key(combo) => {
            let (_, win) = require_window(app)?;
            focus(&win)?;
            input::perform(&Action::Key { combo: combo.clone() })?;
            Ok(Reply::Text(format!("Pressed {} in the page.", combo.join("+"))))
        }
        Cmd::Scroll { dx, dy } => {
            let (_, win) = require_window(app)?;
            // A wheel notch is ~100 px; scroll the document directly so it works
            // without moving the user's real cursor into the window.
            // Positive dy scrolls down, matching browser_scroll's description.
            win.eval(format!("window.scrollBy({{left:{},top:{},behavior:'instant'}});", dx * 100, dy * 100))
                .map_err(|e| anyhow!("could not scroll: {e}"))?;
            Ok(Reply::Text(format!("Scrolled (dx={dx}, dy={dy}).")))
        }
        Cmd::Back => eval_nav(app, "history.back()", "Went back."),
        Cmd::Forward => eval_nav(app, "history.forward()", "Went forward."),
        Cmd::Reload => eval_nav(app, "location.reload()", "Reloaded the page."),
    }
}

fn eval_nav(app: &AppHandle, js: &str, ok: &str) -> Result<Reply> {
    let (_, win) = require_window(app)?;
    win.eval(js).map_err(|e| anyhow!("navigation failed: {e}"))?;
    Ok(Reply::Text(ok.to_string()))
}

/// The browser window and its raw HWND, or an error telling the model to open a
/// page first.
fn require_window(app: &AppHandle) -> Result<(isize, tauri::WebviewWindow)> {
    let win = app
        .get_webview_window(LABEL)
        .ok_or_else(|| anyhow!("no page is open yet; call browser_navigate first"))?;
    let hwnd = hwnd_of(&win)?;
    Ok((hwnd, win))
}

#[cfg(windows)]
fn hwnd_of(win: &tauri::WebviewWindow) -> Result<isize> {
    let h = win.hwnd().map_err(|e| anyhow!("no window handle: {e}"))?;
    Ok(h.0 as isize)
}

#[cfg(not(windows))]
fn hwnd_of(_win: &tauri::WebviewWindow) -> Result<isize> {
    Err(anyhow!("the in-app browser is only implemented on Windows so far"))
}

fn focus(win: &tauri::WebviewWindow) -> Result<()> {
    let _ = win.unminimize();
    let _ = win.show();
    win.set_focus().map_err(|e| anyhow!("could not focus the browser: {e}"))?;
    // Let the focus change land before input is injected into it.
    std::thread::sleep(Duration::from_millis(120));
    Ok(())
}

/// Map a client-area pixel to an absolute screen pixel for input injection.
#[cfg(windows)]
fn client_to_screen(hwnd: isize, x: i32, y: i32) -> Result<(i32, i32)> {
    use windows::Win32::Foundation::{HWND, POINT, RECT};
    use windows::Win32::Graphics::Gdi::ClientToScreen;
    use windows::Win32::UI::WindowsAndMessaging::GetClientRect;
    let hwnd = HWND(hwnd as *mut std::ffi::c_void);
    // SAFETY: reads window geometry; the handle is from a live WebviewWindow.
    unsafe {
        let mut rect = RECT::default();
        GetClientRect(hwnd, &mut rect).map_err(|e| anyhow!("window is not measurable: {e}"))?;
        let cx = x.clamp(0, (rect.right - rect.left - 1).max(0));
        let cy = y.clamp(0, (rect.bottom - rect.top - 1).max(0));
        let mut pt = POINT { x: cx, y: cy };
        if !ClientToScreen(hwnd, &mut pt).as_bool() {
            return Err(anyhow!("could not locate the browser on screen"));
        }
        Ok((pt.x, pt.y))
    }
}

#[cfg(not(windows))]
fn client_to_screen(_hwnd: isize, _x: i32, _y: i32) -> Result<(i32, i32)> {
    Err(anyhow!("the in-app browser is only implemented on Windows so far"))
}

/// Create the browser window (first use) or navigate the existing one. Window
/// creation runs on the main thread; on Windows building a webview off the main
/// thread can deadlock.
fn open_or_navigate(app: &AppHandle, url: tauri::Url) -> Result<()> {
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        return win.navigate(url).map_err(|e| anyhow!("could not navigate: {e}"));
    }
    let for_closure = app.clone();
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let built = WebviewWindowBuilder::new(&for_closure, LABEL, WebviewUrl::External(url))
            .title("ezCLI browser (agent-controlled)")
            .inner_size(1200.0, 820.0)
            .min_inner_size(640.0, 480.0)
            .build();
        let _ = tx.send(built.map(|_| ()).map_err(|e| e.to_string()));
    })
    .map_err(|e| anyhow!("could not reach the UI thread: {e}"))?;
    rx.recv_timeout(Duration::from_secs(10))
        .map_err(|_| anyhow!("the browser window did not open in time"))?
        .map_err(|e| anyhow!("could not open the browser window: {e}"))?;
    // The webview needs a moment before its first navigation/screenshot.
    std::thread::sleep(Duration::from_millis(300));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_http_urls_are_accepted() {
        assert!(validate_url("https://example.com").is_ok());
        assert!(validate_url("http://localhost:3000/x").is_ok());
        assert!(validate_url("file:///C:/secret.txt").is_err());
        assert!(validate_url("javascript:alert(1)").is_err());
        assert!(validate_url("not a url").is_err());
    }
}
