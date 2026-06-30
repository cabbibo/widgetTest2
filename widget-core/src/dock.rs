// ── Widget dock API ───────────────────────────────────────────────────────────
// A tiny self-registration contract so a "manager" widget can discover, launch,
// and quit its sibling widgets without hard-coding any of them.
//
// Each widget calls `dock::register(...)` once at startup, which drops a small
// manifest file (how to identify and re-launch *this* binary) into a shared
// registry folder. The manager reads that folder to build its pillbox — so a new
// widget appears in the manager automatically the first time it runs. No central
// list to edit. This is the "lib brought in to each widget."

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;

#[derive(Serialize, Deserialize, Clone)]
pub struct WidgetManifest {
    pub id: String,    // stable key — the app's bundle identifier
    pub name: String,  // display name, e.g. "Tassels"
    pub glyph: String, // pill glyph, e.g. "✨"
    pub exec: String,  // absolute path used to launch it (this binary, recorded at register time)
}

#[derive(Serialize, Clone)]
pub struct WidgetStatus {
    #[serde(flatten)]
    pub manifest: WidgetManifest,
    pub running: bool,
}

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

/// Called by each widget at startup. Records how to launch *this* binary so the
/// manager can re-launch it later, even after it has quit. Persists on disk.
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

/// Every registered widget, sorted by display name.
pub fn discover() -> Vec<WidgetManifest> {
    let mut out = vec![];
    if let Ok(entries) = std::fs::read_dir(registry_dir()) {
        for e in entries.flatten() {
            if e.path().extension().and_then(|s| s.to_str()) != Some("json") { continue; }
            if let Ok(txt) = std::fs::read_to_string(e.path()) {
                if let Ok(m) = serde_json::from_str::<WidgetManifest>(&txt) { out.push(m); }
            }
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// Is a process for this manifest's binary currently alive? Matches on the full
/// executable path, so it works the same for a `tauri dev` binary and a bundled
/// `.app` (whose argv0 is the inner Mach-O at that path).
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
    // Inside a `.app` bundle → use `open` so macOS activates it properly.
    if let Some(idx) = m.exec.find(".app/Contents/MacOS/") {
        let app = &m.exec[..idx + 4]; // ".../Foo.app"
        let _ = Command::new("open").arg(app).spawn();
    } else {
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

    // Registry round-trip against an isolated HOME: register() persists a manifest,
    // discover() reads them all back, sorted by name.
    #[test]
    fn register_and_discover() {
        let tmp = std::env::temp_dir().join(format!("widget-dock-test-{}", std::process::id()));
        std::env::set_var("HOME", &tmp);

        register("com.test.alpha", "Alpha", "🅰️");
        register("com.test.beta", "Beta", "🅱️");

        let found = discover();
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].name, "Alpha"); // sorted by name
        assert_eq!(found[1].id, "com.test.beta");
        assert!(!found[0].exec.is_empty(), "exec path should be recorded");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    // running() detects a live process by its exec path, and quit() terminates it.
    // Uses a self-spawned `sleep` rather than the cargo-test binary (whose argv
    // the test harness does not expose to pgrep).
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
        let _ = child.kill(); // belt-and-suspenders if quit() missed
    }
}
