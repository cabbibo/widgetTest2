// Magnifier widget backend. Screen capture + OCR come from widget_core.

#[tauri::command]
fn capture_region(title: String, cx: f64, cy: f64, region: u32, out_size: u32) -> Option<String> {
    widget_core::capture_region(title, cx, cy, region, out_size)
}

// Raw RGBA bytes → arrives in JS as an ArrayBuffer (no base64 decode per frame).
#[tauri::command]
fn capture_region_raw(cx: f64, cy: f64, region: u32, out_size: u32) -> tauri::ipc::Response {
    tauri::ipc::Response::new(widget_core::capture_region_bytes(cx, cy, region, out_size))
}

#[tauri::command]
fn ocr_region(title: String, cx: f64, cy: f64, region: u32) -> String {
    widget_core::ocr_region(title, cx, cy, region)
}

// Word-level OCR of the region under the lens → JSON [{t,x,y,w,h}] (boxes normalized 0..1).
#[tauri::command]
fn ocr_words(title: String, cx: f64, cy: f64, region: u32, out_px: u32) -> String {
    widget_core::ocr_words_region(title, cx, cy, region, out_px)
}

// Offline dictionary lookup → JSON {word, definition, synonyms[], etymology}.
#[tauri::command]
fn define_word(word: String) -> String {
    widget_core::define_word(word)
}

// Global cursor position (logical px, top-left origin) for click-through hit-testing.
#[tauri::command]
fn mouse_position() -> (f64, f64) {
    widget_core::mouse_position()
}

#[tauri::command]
fn check_permissions() -> widget_core::PermissionsStatus {
    widget_core::check_permissions()
}

#[tauri::command]
fn open_permission_settings(permission: String) {
    widget_core::open_permission_settings(permission)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Manager;
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|_app| {
            // Register with the widget manager's dock so it can launch/quit us.
            widget_core::dock::register("com.widget.magnifier", "Lens", "🔍");
            // Pre-compile the Vision OCR + dictionary binaries so the first lookup is fast.
            #[cfg(target_os = "macos")]
            std::thread::spawn(|| {
                widget_core::ensure_ocr_words_binary();
                widget_core::ensure_lookup_binary();
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![capture_region, capture_region_raw, ocr_region, ocr_words, define_word, mouse_position, check_permissions, open_permission_settings])
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
