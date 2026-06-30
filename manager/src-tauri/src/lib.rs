// Widget manager backend: a thin layer over the shared `widget_core::dock` API.
// It discovers sibling widgets (each self-registers a manifest at startup), reports
// their running state to the pillbox UI, and launches/quits them on request.

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Emitter,
};

#[tauri::command]
fn list_widgets() -> Vec<widget_core::dock::WidgetStatus> { widget_core::dock::statuses() }

#[tauri::command]
fn toggle_widget(id: String) -> bool { widget_core::dock::toggle(&id) }

#[tauri::command]
fn mouse_position() -> (f64, f64) { widget_core::mouse_position() }

#[tauri::command]
fn quit_app() { std::process::exit(0); }

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Tray menu: header + Show/Hide pillbox + Quit.
            let header   = MenuItem::with_id(app, "header", "🎛  Widgets", false, None::<&str>)?;
            let toggle_i = MenuItem::with_id(app, "togglebar", "Show / Hide pillbox", true, None::<&str>)?;
            let quit_i   = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let sepa     = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&header, &sepa, &toggle_i, &quit_i])?;

            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => std::process::exit(0),
                    "togglebar" => { let _ = app.emit("toggle-bar", ()); }
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_widgets, toggle_widget, mouse_position, quit_app
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" { std::process::exit(0); }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
