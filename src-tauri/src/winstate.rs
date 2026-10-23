//! Remembers where the main window was (position, size, which monitor,
//! maximized) and puts it back on the next launch. Only the main window is
//! tracked, and a saved position is ignored unless it is still on a connected
//! monitor, so unplugging a screen can never strand the window off-screen.

use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent};

const LABEL: &str = "main";
const MIN_W: u32 = 760;
const MIN_H: u32 = 480;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
struct State {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    maximized: bool,
}

static LAST_SAVE: Mutex<Option<Instant>> = Mutex::new(None);

fn path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("window-state.json"))
}

fn load(app: &AppHandle) -> Option<State> {
    serde_json::from_slice(&std::fs::read(path(app)?).ok()?).ok()
}

/// The window's title strip must land on a real monitor, or the user would
/// have no way to drag it back.
fn grabbable(win: &WebviewWindow, s: &State) -> bool {
    let probe_x = s.x.saturating_add(120);
    let probe_y = s.y.saturating_add(16);
    win.available_monitors().unwrap_or_default().iter().any(|m| {
        let p = m.position();
        let z = m.size();
        probe_x >= p.x && probe_x < p.x + z.width as i32 && probe_y >= p.y && probe_y < p.y + z.height as i32
    })
}

/// Put the main window back where it was, then show it. The window is created
/// hidden so there is no flash at the default position.
pub fn restore_and_show(app: &AppHandle) {
    let Some(win) = app.get_webview_window(LABEL) else { return };
    if let Some(s) = load(app) {
        if grabbable(&win, &s) {
            let (want_w, want_h) = (s.w.max(MIN_W), s.h.max(MIN_H));
            let _ = win.set_position(PhysicalPosition::new(s.x, s.y));
            // On Windows an undecorated window can come back a little bigger than
            // asked (the sizing call counts a title strip that is not drawn), which
            // made it creep taller on every launch. Measure what we got and correct.
            let (mut req_w, mut req_h) = (want_w as i64, want_h as i64);
            for _ in 0..3 {
                let _ = win.set_size(PhysicalSize::new(req_w.max(1) as u32, req_h.max(1) as u32));
                match win.inner_size() {
                    Ok(got) if got.width != want_w || got.height != want_h => {
                        req_w += want_w as i64 - got.width as i64;
                        req_h += want_h as i64 - got.height as i64;
                    }
                    _ => break,
                }
            }
            if s.maximized {
                let _ = win.maximize();
            }
        }
    }
    let _ = win.show();
    let _ = win.set_focus();
}

fn save(app: &AppHandle) {
    let Some(win) = app.get_webview_window(LABEL) else { return };
    // A minimized window reports a parked position far off-screen; keep the last good one.
    if win.is_minimized().unwrap_or(false) {
        return;
    }
    let maximized = win.is_maximized().unwrap_or(false);
    let state = if maximized {
        // Remember the normal-size geometry so un-maximizing lands somewhere sensible.
        match load(app) {
            Some(prev) => State { maximized: true, ..prev },
            None => match (win.outer_position(), win.inner_size()) {
                (Ok(p), Ok(z)) => State { x: p.x, y: p.y, w: z.width, h: z.height, maximized: true },
                _ => return,
            },
        }
    } else {
        match (win.outer_position(), win.inner_size()) {
            (Ok(p), Ok(z)) => State { x: p.x, y: p.y, w: z.width, h: z.height, maximized: false },
            _ => return,
        }
    };
    let Some(file) = path(app) else { return };
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_vec(&state) {
        let _ = std::fs::write(file, json);
    }
}

/// Moves and resizes arrive in bursts; write at most a couple of times a
/// second, and always on close.
pub fn on_event(app: &AppHandle, label: &str, event: &WindowEvent) {
    if label != LABEL {
        return;
    }
    match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            let mut last = LAST_SAVE.lock().unwrap();
            if last.is_some_and(|t| t.elapsed() < Duration::from_millis(500)) {
                return;
            }
            *last = Some(Instant::now());
            drop(last);
            save(app);
        }
        WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed => save(app),
        _ => {}
    }
}
