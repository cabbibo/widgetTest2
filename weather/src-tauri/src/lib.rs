// Weather widget backend. There's nothing native to do here — the frontend
// fetches location + conditions over https — so this just opens the transparent,
// always-on-top window and quits when its last window closes.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Manager;
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|_app| {
            // Register with the widget manager's dock so it can launch/quit us.
            widget_core::dock::register("com.widget.weather", "Weather", "🌤️");
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if window.app_handle().webview_windows().len() <= 1 {
                    std::process::exit(0);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
