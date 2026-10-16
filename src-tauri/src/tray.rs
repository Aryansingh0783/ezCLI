//! System tray icon: show the window, open another window, or quit.
//! "Close to tray" itself is a frontend setting; the window hides instead of
//! closing and this icon brings it back.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, Emitter, Manager};

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn install(app: &App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show ezCLI", true, None::<&str>)?;
    let new_window = MenuItem::with_id(app, "new-window", "New window", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit ezCLI", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &new_window, &sep, &quit])?;

    let mut builder = TrayIconBuilder::with_id("ezcli")
        .tooltip("ezCLI")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "new-window" => {
                let _ = crate::features::open_window(None, app.clone());
            }
            // The main window runs the "processes still running" check, so
            // ask it to quit rather than exiting underneath live sessions.
            "quit" => {
                show_main(app);
                let _ = app.emit_to("main", "tray-quit", ());
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}
