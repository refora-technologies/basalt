//! Basalt on a computer with its window closed: an icon in the tray, and the
//! system's notifications.
//!
//! While the person wants Basalt always ready to receive, closing the window
//! hides it rather than quitting: the line to the host stays open, shares
//! arrive and transfers carry on, and the tray icon brings the window back.
//! Quitting is the tray menu's "Quit Basalt". Notifications say what arrived,
//! with the buttons that answer it; a click brings the window back to it.
//!
//! Windows only for now: Linux desktops differ in what a tray is, and there
//! the window closes as before.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Whether the tray icon is there: only then does closing the window hide it.
static INSTALLED: AtomicBool = AtomicBool::new(false);

pub fn installed() -> bool {
    INSTALLED.load(Ordering::SeqCst)
}

/// Puts Basalt's icon in the tray, with its menu.
pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Basalt", true, None::<&str>)?;
    let inbox = MenuItem::with_id(app, "inbox", "Inbox", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Basalt", true, None::<&str>)?;
    let gap = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &inbox, &gap, &quit])?;
    let mut tray = TrayIconBuilder::with_id("basalt")
        .tooltip("Basalt · ready to receive")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show(app, None),
            "inbox" => show(app, Some("inbox")),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show(tray.app_handle(), None);
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    INSTALLED.store(true, Ordering::SeqCst);
    Ok(())
}

/// Brings the window back, on a page if one is named (`inbox`).
pub fn show<R: Runtime>(app: &AppHandle<R>, page: Option<&str>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        if let Some(page) = page {
            let _ = window.emit("basalt://open", page);
        }
    }
}

/// Whether the window is out of sight: hidden in the tray, minimised, or
/// behind another. Only then is a notification worth showing.
pub fn out_of_sight<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.get_webview_window("main").is_none_or(|w| {
        !w.is_visible().unwrap_or(true)
            || w.is_minimized().unwrap_or(false)
            || !w.is_focused().unwrap_or(true)
    })
}

/// A notification with up to two buttons. What was pressed (`None` for the
/// notification itself) comes back to the page as `basalt://notification`,
/// with `tag`, and the window comes back.
pub fn notify<R: Runtime>(
    app: &AppHandle<R>,
    tag: String,
    title: &str,
    text: &str,
    buttons: &[(String, String)],
) {
    #[cfg(windows)]
    {
        use tauri_winrt_notification::{Duration, Toast};
        if !out_of_sight(app) {
            return;
        }
        // An installed Basalt has its own name on its notifications; a
        // development copy, which Windows doesn't know, borrows PowerShell's.
        let id = if crate::dev_isolated().is_some() {
            Toast::POWERSHELL_APP_ID.to_string()
        } else {
            app.config().identifier.clone()
        };
        let mut toast = Toast::new(&id)
            .title(title)
            .text1(text)
            .duration(Duration::Long);
        for (label, action) in buttons {
            toast = toast.add_button(label, action);
        }
        let handle = app.clone();
        let toast = toast.on_activated(move |action| {
            show(&handle, None);
            let _ = handle.emit(
                "basalt://notification",
                serde_json::json!({ "tag": tag, "action": action }),
            );
            Ok(())
        });
        if let Err(e) = toast.show() {
            eprintln!("basalt: a notification didn't show: {e}");
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (app, tag, title, text, buttons);
    }
}
