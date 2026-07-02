// ── Widget dock API ───────────────────────────────────────────────────────────
// Lets a standalone "manager" widget discover, launch, and quit sibling widgets —
// even when the manager is downloaded entirely separately from them.
//
// Discovery has two sources, merged:
//   1. Installed bundles (production): the manager scans the app folders for any
//      `.app` whose Info.plist carries a `WidgetDock` marker, and reads its name,
//      bundle id and glyph straight from the plist. A widget needs only that marker
//      baked into its bundle to show up — nothing has to have run first.
//   2. The runtime registry (dev fallback): when running unbundled via `tauri dev`
//      there's no `.app` to scan, so each widget also drops a manifest file via
//      `register(...)` at startup. Installed bundles win when both exist.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Serialize, Deserialize, Clone)]
pub struct WidgetManifest {
    pub id: String,    // the app's bundle identifier
    pub name: String,  // display name, e.g. "Tassels"
    pub glyph: String, // pill glyph, e.g. "✨"
    pub exec: String,  // path used to launch it — a `.app` bundle (prod) or a binary (dev)
}

#[derive(Serialize, Clone)]
pub struct WidgetStatus {
    #[serde(flatten)]
    pub manifest: WidgetManifest,
    pub running: bool,
}

// ── Source 1: installed `.app` bundles with a WidgetDock marker ────────────────

/// Folders to scan for installed widgets. Overridable via `WIDGET_DOCK_APP_DIRS`
/// (colon-separated) — handy in dev to point at `target/release/bundle/macos`.
fn app_dirs() -> Vec<PathBuf> {
    if let Ok(custom) = std::env::var("WIDGET_DOCK_APP_DIRS") {
        return custom.split(':').filter(|s| !s.is_empty()).map(PathBuf::from).collect();
    }
    let mut v = vec![PathBuf::from("/Applications")];
    if let Ok(home) = std::env::var("HOME") {
        v.push(PathBuf::from(home).join("Applications"));
    }
    v
}

/// Read one scalar value out of a plist via `plutil` (no plist crate needed).
fn plist_value(plist: &Path, key: &str) -> Option<String> {
    let out = Command::new("/usr/bin/plutil")
        .args(["-extract", key, "raw", "-o", "-"])
        .arg(plist)
        .output()
        .ok()?;
    if !out.status.success() { return None; }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// If this `.app` is a dock-able widget, build its manifest from the Info.plist.
fn manifest_from_bundle(app: &Path) -> Option<WidgetManifest> {
    let plist = app.join("Contents/Info.plist");
    // The marker: `WidgetDock` must be present and true.
    if plist_value(&plist, "WidgetDock").as_deref() != Some("true") { return None; }
    let id = plist_value(&plist, "CFBundleIdentifier")?;
    let name = plist_value(&plist, "CFBundleName")
        .or_else(|| plist_value(&plist, "CFBundleDisplayName"))
        .or_else(|| app.file_stem().and_then(|s| s.to_str()).map(String::from))
        .unwrap_or_else(|| id.clone());
    let glyph = plist_value(&plist, "WidgetDockGlyph").unwrap_or_else(|| "🔲".into());
    Some(WidgetManifest { id, name, glyph, exec: app.to_string_lossy().into_owned() })
}

fn scan_installed() -> Vec<WidgetManifest> {
    let mut out = vec![];
    for dir in app_dirs() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) == Some("app") {
                if let Some(m) = manifest_from_bundle(&p) { out.push(m); }
            }
        }
    }
    out
}

// ── Source 2: runtime registry (dev fallback) ─────────────────────────────────

fn registry_dir() -> PathBuf {
    let base = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let dir = PathBuf::from(base).join("Library/Application Support/widgets/registry");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn manifest_path(id: &str) -> PathBuf {
    let safe: String = id
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
        .collect();
    registry_dir().join(format!("{safe}.json"))
}

/// Called by each widget at startup so an unbundled (`tauri dev`) build still shows
/// up in the manager. In a packaged build the Info.plist marker is what matters, but
/// registering is harmless and keeps dev working.
pub fn register(id: &str, name: &str, glyph: &str) {
    let exec = std::env::current_exe()
        .ok()
        .and_then(|p| p.to_str().map(String::from))
        .unwrap_or_default();
    let m = WidgetManifest { id: id.into(), name: name.into(), glyph: glyph.into(), exec };
    if let Ok(json) = serde_json::to_string_pretty(&m) {
        let _ = std::fs::write(manifest_path(id), json);
    }
}

fn scan_registry() -> Vec<WidgetManifest> {
    let mut out = vec![];
    if let Ok(entries) = std::fs::read_dir(registry_dir()) {
        for e in entries.flatten() {
            if e.path().extension().and_then(|s| s.to_str()) != Some("json") { continue; }
            if let Ok(txt) = std::fs::read_to_string(e.path()) {
                if let Ok(m) = serde_json::from_str::<WidgetManifest>(&txt) { out.push(m); }
            }
        }
    }
    out
}

// ── Discovery + control ───────────────────────────────────────────────────────

/// Every dock-able widget, sorted by display name. Installed bundles take priority
/// over registry entries with the same bundle id.
pub fn discover() -> Vec<WidgetManifest> {
    let mut by_id: std::collections::HashMap<String, WidgetManifest> = std::collections::HashMap::new();
    for m in scan_registry() { by_id.insert(m.id.clone(), m); }   // dev fallback first…
    for m in scan_installed() { by_id.insert(m.id.clone(), m); }  // …installed bundle wins
    let mut out: Vec<_> = by_id.into_values().collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// Is a process for this widget alive? Matches the exec path as a substring of the
/// running process's command line, so it works for a `.app` bundle (whose argv0 is
/// `<app>/Contents/MacOS/<bin>`) and for a bare dev binary alike.
pub fn running(m: &WidgetManifest) -> bool {
    if m.exec.is_empty() { return false; }
    Command::new("pgrep")
        .arg("-f")
        .arg(&m.exec)
        .output()
        .map(|o| !o.stdout.is_empty())
        .unwrap_or(false)
}

/// Launch the widget if it isn't already running.
pub fn launch(m: &WidgetManifest) {
    if m.exec.is_empty() || running(m) { return; }
    if m.exec.ends_with(".app") {
        // Installed bundle → let macOS activate it.
        let _ = Command::new("open").arg(&m.exec).spawn();
    } else if let Some(idx) = m.exec.find(".app/Contents/MacOS/") {
        let _ = Command::new("open").arg(&m.exec[..idx + 4]).spawn();
    } else {
        // Bare dev binary.
        let _ = Command::new(&m.exec).spawn();
    }
}

/// Quit a running widget (SIGTERM; widgets exit cleanly when their window closes).
pub fn quit(m: &WidgetManifest) {
    if m.exec.is_empty() { return; }
    let _ = Command::new("pkill").arg("-f").arg(&m.exec).status();
}

/// Discovered widgets, each tagged with its current running state.
pub fn statuses() -> Vec<WidgetStatus> {
    discover()
        .into_iter()
        .map(|m| { let running = running(&m); WidgetStatus { manifest: m, running } })
        .collect()
}

/// Flip a widget by id: quit it if running, launch it if not. Returns the new
/// running state (true = now launching/running).
pub fn toggle(id: &str) -> bool {
    match discover().into_iter().find(|m| m.id == id) {
        Some(m) if running(&m) => { quit(&m); false }
        Some(m) => { launch(&m); true }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Registry round-trip + bundle scanning, both against isolated dirs, then a
    // merged discover(). One test owns all the process-global env so parallel tests
    // don't race on it.
    #[test]
    fn discovery_from_registry_and_bundles() {
        let tmp = std::env::temp_dir().join(format!("widget-dock-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::env::set_var("HOME", &tmp);

        // Source 2: registry (dev fallback)
        register("com.test.alpha", "Alpha", "🅰️");
        let reg = scan_registry();
        assert_eq!(reg.len(), 1);
        assert_eq!(reg[0].name, "Alpha");
        assert!(!reg[0].exec.is_empty());

        // Source 1: a synthetic installed `.app` with the WidgetDock marker
        let apps = tmp.join("apps");
        let app = apps.join("Beta.app/Contents");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(app.join("Info.plist"), r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.test.beta</string>
  <key>CFBundleName</key><string>Beta</string>
  <key>WidgetDock</key><true/>
  <key>WidgetDockGlyph</key><string>🅱️</string>
</dict></plist>"#).unwrap();
        // A second .app WITHOUT the marker must be ignored.
        let plain = apps.join("Plain.app/Contents");
        std::fs::create_dir_all(&plain).unwrap();
        std::fs::write(plain.join("Info.plist"), r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleName</key><string>Plain</string></dict></plist>"#).unwrap();

        std::env::set_var("WIDGET_DOCK_APP_DIRS", apps.to_str().unwrap());
        let installed = scan_installed();
        assert_eq!(installed.len(), 1, "only the marked .app should be found");
        assert_eq!(installed[0].id, "com.test.beta");
        assert_eq!(installed[0].glyph, "🅱️");
        assert!(installed[0].exec.ends_with("Beta.app"));

        // Merged + sorted.
        let all = discover();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].name, "Alpha");
        assert_eq!(all[1].name, "Beta");

        std::env::remove_var("WIDGET_DOCK_APP_DIRS");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // running() detects a live process by exec path, and quit() terminates it.
    #[test]
    fn detect_and_quit_running() {
        let m = WidgetManifest {
            id: "com.test.sleeper".into(),
            name: "Sleeper".into(),
            glyph: "💤".into(),
            exec: "/bin/sleep".into(),
        };
        let mut child = Command::new("/bin/sleep").arg("30").spawn().expect("spawn sleep");
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(running(&m), "spawned sleep should be detected as running");

        quit(&m);
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(!running(&m), "quit() should have terminated it");
        let _ = child.kill();
    }
}
