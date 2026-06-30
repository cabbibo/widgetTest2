// Emoji-tassels widget backend: window enumeration + cursor (for the physics),
// settings persistence, and a menubar tray icon that toggles the settings popover.

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager,
};

#[tauri::command]
fn list_windows() -> Vec<widget_core::WinRect> { widget_core::list_windows() }

#[tauri::command]
fn mouse_position() -> (f64, f64) { widget_core::mouse_position() }

#[tauri::command]
fn load_settings(name: String) -> String { widget_core::load_settings(&name) }

#[tauri::command]
fn save_settings(name: String, json: String) { widget_core::save_settings(&name, &json) }

#[tauri::command]
fn quit_app() { std::process::exit(0); }

#[tauri::command]
fn check_permissions() -> widget_core::PermissionsStatus { widget_core::check_permissions() }

#[tauri::command]
fn open_permission_settings(permission: String) { widget_core::open_permission_settings(permission) }

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Register with the widget manager's dock so it can launch/quit us.
            widget_core::dock::register("com.widget.emoji", "Tassels", "✨");
            // Tray menu: widget header, Show/Hide toolbar, Quit.
            let header   = MenuItem::with_id(app, "header", "✨  Tassels", false, None::<&str>)?;
            let toggle_i = MenuItem::with_id(app, "toggletb", "Show / Hide toolbar", true, None::<&str>)?;
            let quit_i   = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let sepa     = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&header, &sepa, &toggle_i, &quit_i])?;

            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => std::process::exit(0),
                    "toggletb" => { let _ = app.emit("toggle-toolbar", ()); }
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_windows, mouse_position, load_settings, save_settings, quit_app,
            check_permissions, open_permission_settings
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // Quit only when the main widget window closes (not the popover).
                if window.label() == "main" { std::process::exit(0); }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
