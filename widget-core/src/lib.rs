pub mod dock;

#[derive(serde::Serialize, Clone)]
pub struct WinRect {
    x: f64, y: f64, w: f64, h: f64,
    app: String, name: String,
}

// ── Window enumeration (macOS) ────────────────────────────────────────────────
#[cfg(target_os = "macos")]
mod cg_windows {
    use std::ffi::{c_void, CString, CStr};
    pub type CFTypeRef = *const c_void;
    pub type CFIndex   = isize;
    pub const UTF8: u32 = 0x08000100;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        pub fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> CFTypeRef;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        pub fn CFArrayGetCount(arr: CFTypeRef) -> CFIndex;
        pub fn CFArrayGetValueAtIndex(arr: CFTypeRef, idx: CFIndex) -> CFTypeRef;
        pub fn CFDictionaryGetValue(dict: CFTypeRef, key: CFTypeRef) -> CFTypeRef;
        pub fn CFStringCreateWithCString(alloc: CFTypeRef, c: *const i8, enc: u32) -> CFTypeRef;
        pub fn CFStringGetLength(s: CFTypeRef) -> CFIndex;
        pub fn CFStringGetCString(s: CFTypeRef, buf: *mut i8, buf_len: CFIndex, enc: u32) -> bool;
        pub fn CFNumberGetValue(n: CFTypeRef, ty: u32, val: *mut c_void) -> bool;
        pub fn CFRelease(cf: CFTypeRef);
    }

    pub unsafe fn cfkey(s: &str) -> CFTypeRef {
        let c = CString::new(s).unwrap();
        CFStringCreateWithCString(std::ptr::null(), c.as_ptr(), UTF8)
    }

    pub unsafe fn cf_to_string(cf: CFTypeRef) -> String {
        if cf.is_null() { return String::new(); }
        let n = (CFStringGetLength(cf) * 4 + 1) as usize;
        let mut buf = vec![0i8; n];
        CFStringGetCString(cf, buf.as_mut_ptr(), n as CFIndex, UTF8);
        CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned()
    }

    pub unsafe fn dict_str(dict: CFTypeRef, key: &str) -> String {
        let k = cfkey(key); let v = CFDictionaryGetValue(dict, k); CFRelease(k); cf_to_string(v)
    }

    pub unsafe fn dict_f64(dict: CFTypeRef, key: &str) -> f64 {
        let k = cfkey(key); let v = CFDictionaryGetValue(dict, k); CFRelease(k);
        if v.is_null() { return 0.0; }
        let mut val: f64 = 0.0;
        CFNumberGetValue(v, 13, &mut val as *mut f64 as *mut c_void); // kCFNumberFloat64Type = 13
        val
    }

    pub unsafe fn dict_i32(dict: CFTypeRef, key: &str) -> i32 {
        let k = cfkey(key); let v = CFDictionaryGetValue(dict, k); CFRelease(k);
        if v.is_null() { return 0; }
        let mut val: i32 = 0;
        CFNumberGetValue(v, 3, &mut val as *mut i32 as *mut c_void); // kCFNumberSInt32Type = 3
        val
    }
}

// Returns the CGWindowID of our own process's window (0 if not found).
// Used to capture everything *below* our widget via kCGWindowListOptionOnScreenBelowWindow.
#[cfg(target_os = "macos")]
pub fn find_own_window_id() -> u32 {
    use cg_windows::*;
    let our_pid = std::process::id() as i32;
    unsafe {
        let arr = CGWindowListCopyWindowInfo(1 | (1 << 4), 0); // ON_SCREEN | EXCL_DESK
        if arr.is_null() { return 0; }
        let count = CFArrayGetCount(arr);
        let mut result = 0u32;
        for i in 0..count {
            let dict = CFArrayGetValueAtIndex(arr, i);
            if dict.is_null() { continue; }
            if dict_i32(dict, "kCGWindowOwnerPID") == our_pid {
                result = dict_i32(dict, "kCGWindowNumber") as u32;
                break;
            }
        }
        CFRelease(arr);
        result
    }
}

#[cfg(target_os = "macos")]
pub fn list_windows_mac() -> Vec<WinRect> {
    use cg_windows::*;
    const ON_SCREEN: u32 = 1;       // kCGWindowListOptionOnScreenOnly
    const EXCL_DESK: u32 = 1 << 4; // kCGWindowListExcludeDesktopElements
    unsafe {
        let arr = CGWindowListCopyWindowInfo(ON_SCREEN | EXCL_DESK, 0);
        if arr.is_null() { return vec![]; }
        let count = CFArrayGetCount(arr);
        let mut result = Vec::new();
        for i in 0..count {
            let dict = CFArrayGetValueAtIndex(arr, i);
            if dict.is_null() { continue; }
            let layer = dict_i32(dict, "kCGWindowLayer");
            if !(0..=8).contains(&layer) { continue; } // skip menu bar, dock, desktop
            let bk = cfkey("kCGWindowBounds");
            let bounds = CFDictionaryGetValue(dict, bk);
            CFRelease(bk);
            if bounds.is_null() { continue; }
            let x = dict_f64(bounds, "X");
            let y = dict_f64(bounds, "Y");
            let w = dict_f64(bounds, "Width");
            let h = dict_f64(bounds, "Height");
            if w < 10.0 || h < 10.0 { continue; }
            let app  = dict_str(dict, "kCGWindowOwnerName");
            let name = dict_str(dict, "kCGWindowName");
            result.push(WinRect { x, y, w, h, app, name });
        }
        CFRelease(arr);
        result
    }
}

pub fn list_windows() -> Vec<WinRect> {
    #[cfg(target_os = "macos")]
    { return list_windows_mac(); }
    #[cfg(not(target_os = "macos"))]
    { vec![] }
}

#[derive(serde::Serialize)]
pub struct PermissionsStatus {
    platform: String,
    screen_capture: bool,
    input_monitoring: bool,
}

pub fn check_permissions() -> PermissionsStatus {
    #[cfg(target_os = "macos")]
    {
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" { fn CGPreflightScreenCaptureAccess() -> bool; }

        #[link(name = "IOKit", kind = "framework")]
        extern "C" { fn IOHIDCheckAccess(request_type: u32) -> u32; }

        let screen_capture = unsafe { CGPreflightScreenCaptureAccess() };
        // IOHIDCheckAccess returns 0=granted, 1=denied, 2=unknown
        let input_monitoring = unsafe { IOHIDCheckAccess(1) == 0 };

        return PermissionsStatus {
            platform: "macos".into(),
            screen_capture,
            input_monitoring,
        };
    }
    #[cfg(target_os = "windows")]
    {
        return PermissionsStatus {
            platform: "windows".into(),
            screen_capture: true,
            input_monitoring: true,
        };
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    PermissionsStatus {
        platform: "other".into(),
        screen_capture: true,
        input_monitoring: true,
    }
}

pub fn open_permission_settings(permission: String) {
    #[cfg(target_os = "macos")]
    {
        let url = match permission.as_str() {
            "screen_capture" => "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
            "input_monitoring" => "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
            _ => return,
        };
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
    #[cfg(target_os = "windows")]
    {
        // No special permissions needed on Windows for current feature set
        let _ = permission;
    }
}

// ── OCR via macOS Vision (Swift binary compiled once on first use) ────────────
use std::sync::OnceLock;
static OCR_READY: OnceLock<bool> = OnceLock::new();

// Compile a Swift helper to /tmp/<name>, shared across widgets. Skips if it already
// exists, and compiles via a per-pid source + temp binary then renames into place,
// so two widgets building at once never touch the same file ("input modified during
// build"). Returns whether the shared binary exists afterward.
fn ensure_swift_binary(name: &str, script: &str) -> bool {
    let bin = format!("/tmp/{name}");
    if std::path::Path::new(&bin).exists() { return true; }
    let pid = std::process::id();
    let src = format!("/tmp/{name}_{pid}.swift");
    let tmp = format!("/tmp/{name}_{pid}.build");
    if std::fs::write(&src, script).is_err() { return false; }
    let ok = std::process::Command::new("/usr/bin/swiftc")
        .args([src.as_str(), "-o", tmp.as_str()])
        .status().map(|s| s.success()).unwrap_or(false);
    let _ = std::fs::remove_file(&src);
    if ok { let _ = std::fs::rename(&tmp, &bin); }
    else { let _ = std::fs::remove_file(&tmp); }
    std::path::Path::new(&bin).exists()
}

pub fn ensure_ocr_binary() -> bool {
    *OCR_READY.get_or_init(|| {
        let script = r#"import Foundation
import Vision
let args = CommandLine.arguments
guard args.count > 1, let data = try? Data(contentsOf: URL(fileURLWithPath: args[1])) else { exit(1) }
let handler = VNImageRequestHandler(data: data, options: [:])
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = true
try? handler.perform([req])
let text = (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
print(text)
"#;
        ensure_swift_binary("widget_ocr", script)
    })
}

pub fn rgba_to_png(rgba: &[u8], w: u32, h: u32) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut enc = png::Encoder::new(&mut out, w, h);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    let mut wr = enc.write_header().ok()?;
    wr.write_image_data(rgba).ok()?;
    drop(wr);
    Some(out)
}

// Capture a screen rect compositing ONLY windows that aren't ours, scaled to out_w×out_h.
// We must exclude *all* our widget windows: a transparent fullscreen sibling would
// otherwise composite as black in a below-window capture and black out the result.
#[cfg(target_os = "macos")]
pub fn capture_bounds_excluding_ours(x: f64, y: f64, w: f64, h: f64, out_w: usize, out_h: usize) -> Option<Vec<u8>> {
    use std::ffi::c_void;
    use cg_windows::{CGWindowListCopyWindowInfo, CFArrayGetCount, CFArrayGetValueAtIndex, dict_i32, dict_str};
    #[repr(C)] struct CGPoint { x: f64, y: f64 }
    #[repr(C)] struct CGSize  { w: f64, h: f64 }
    #[repr(C)] struct CGRect  { o: CGPoint, s: CGSize }
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWindowListCreateImageFromArray(b: CGRect, windows: *const c_void, img_opt: u32) -> *const c_void;
        fn CGImageGetWidth(image: *const c_void) -> usize;
        fn CGImageGetHeight(image: *const c_void) -> usize;
        fn CGImageGetBytesPerRow(image: *const c_void) -> usize;
        fn CGImageGetDataProvider(image: *const c_void) -> *const c_void;
        fn CGDataProviderCopyData(provider: *const c_void) -> *const c_void;
        fn CFDataGetBytePtr(data: *const c_void) -> *const u8;
        fn CFDataGetLength(data: *const c_void) -> isize;
        fn CFRelease(cf: *const c_void);
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFArrayCreate(allocator: *const c_void, values: *const *const c_void, num: isize, callbacks: *const c_void) -> *const c_void;
    }
    let our_pid = std::process::id() as i32;
    // Collect on-screen window IDs that aren't widgets. Each widget is its own
    // process now, so excluding by PID isn't enough — exclude any "widget-*" title
    // too, or a transparent sibling widget would composite as black in the capture.
    let mut ids: Vec<*const c_void> = Vec::new();
    unsafe {
        let arr = CGWindowListCopyWindowInfo(1 | (1 << 4), 0); // ON_SCREEN | EXCL_DESK
        if !arr.is_null() {
            let count = CFArrayGetCount(arr);
            for i in 0..count {
                let dict = CFArrayGetValueAtIndex(arr, i);
                if dict.is_null() { continue; }
                let is_widget = dict_i32(dict, "kCGWindowOwnerPID") == our_pid
                    || dict_str(dict, "kCGWindowName").starts_with("widget-");
                if !is_widget {
                    let num = dict_i32(dict, "kCGWindowNumber") as usize;
                    if num != 0 { ids.push(num as *const c_void); }
                }
            }
            CFRelease(arr);
        }
    }
    if ids.is_empty() { return None; }
    let bounds = CGRect { o: CGPoint { x, y }, s: CGSize { w, h } };
    let mut dst = vec![0u8; out_w * out_h * 4];
    unsafe {
        // CFArray of raw window-id pointers (NULL callbacks: they're not CF objects).
        let win_arr = CFArrayCreate(std::ptr::null(), ids.as_ptr(), ids.len() as isize, std::ptr::null());
        if win_arr.is_null() { return None; }
        let img = CGWindowListCreateImageFromArray(bounds, win_arr, 0);
        CFRelease(win_arr);
        if img.is_null() { return None; }
        let sw  = CGImageGetWidth(img);
        let sh  = CGImageGetHeight(img);
        let bpr = CGImageGetBytesPerRow(img);
        let provider = CGImageGetDataProvider(img);
        let data = CGDataProviderCopyData(provider);
        if data.is_null() || sw == 0 || sh == 0 { CFRelease(img); return None; }
        let src_len = CFDataGetLength(data) as usize;
        let src = std::slice::from_raw_parts(CFDataGetBytePtr(data), src_len);
        for dy in 0..out_h {
            for dx in 0..out_w {
                let sx = (dx * sw / out_w).min(sw.saturating_sub(1));
                let sy = (dy * sh / out_h).min(sh.saturating_sub(1));
                let si = sy * bpr + sx * 4;
                let di = (dy * out_w + dx) * 4;
                if si + 3 < src.len() {
                    dst[di]   = src[si + 2]; // BGRA → RGBA
                    dst[di+1] = src[si + 1];
                    dst[di+2] = src[si];
                    dst[di+3] = 255;
                }
            }
        }
        CFRelease(data);
        CFRelease(img);
    }
    Some(dst)
}

// Capture a square region centered at (cx, cy) in logical px, scaled to out_size².
#[cfg(target_os = "macos")]
pub fn capture_region_rgba(cx: f64, cy: f64, region: u32, out_size: u32) -> Option<Vec<u8>> {
    let half = region as f64 / 2.0;
    capture_bounds_excluding_ours(cx - half, cy - half, region as f64, region as f64,
                                  out_size as usize, out_size as usize)
}

#[cfg(target_os = "macos")]
pub fn capture_region(_title: String, cx: f64, cy: f64, region: u32, out_size: u32) -> Option<String> {
    Some(encode_b64(&capture_region_rgba(cx, cy, region, out_size)?))
}
#[cfg(not(target_os = "macos"))]
pub fn capture_region(_title: String, _cx: f64, _cy: f64, _region: u32, _out_size: u32) -> Option<String> { None }

// Raw RGBA bytes of the region (no base64) — returned over IPC as an ArrayBuffer,
// which is far cheaper to decode per frame than base64 + a char-by-char loop.
#[cfg(target_os = "macos")]
pub fn capture_region_bytes(cx: f64, cy: f64, region: u32, out_size: u32) -> Vec<u8> {
    capture_region_rgba(cx, cy, region, out_size).unwrap_or_default()
}
#[cfg(not(target_os = "macos"))]
pub fn capture_region_bytes(_cx: f64, _cy: f64, _region: u32, _out_size: u32) -> Vec<u8> { Vec::new() }

#[cfg(target_os = "macos")]
pub fn ocr_region(_title: String, cx: f64, cy: f64, region: u32) -> String {
    if !ensure_ocr_binary() { return String::new(); }
    let rgba = match capture_region_rgba(cx, cy, region, region) {
        Some(r) => r, None => return String::new(),
    };
    let png = match rgba_to_png(&rgba, region, region) {
        Some(p) => p, None => return String::new(),
    };
    let in_png = format!("/tmp/widget_ocr_{}_in.png", std::process::id());
    if std::fs::write(&in_png, &png).is_err() { return String::new(); }
    std::process::Command::new("/tmp/widget_ocr")
        .arg(&in_png)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}
#[cfg(not(target_os = "macos"))]
pub fn ocr_region(_title: String, _cx: f64, _cy: f64, _region: u32) -> String { String::new() }

// ── Word-level OCR: returns each recognized word with its bounding box ─────────
// JSON array of {t, x, y, w, h}; box coords are normalized 0..1 over the captured
// region with a top-left origin, so the frontend can map them straight onto the lens.
static OCR_WORDS_READY: OnceLock<bool> = OnceLock::new();

pub fn ensure_ocr_words_binary() -> bool {
    *OCR_WORDS_READY.get_or_init(|| {
        let script = r#"import Foundation
import Vision
let args = CommandLine.arguments
guard args.count > 1, let data = try? Data(contentsOf: URL(fileURLWithPath: args[1])) else { print("[]"); exit(0) }
let handler = VNImageRequestHandler(data: data, options: [:])
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = true
try? handler.perform([req])
var words: [[String: Any]] = []
for obs in (req.results ?? []) {
    guard let cand = obs.topCandidates(1).first else { continue }
    let s = cand.string
    s.enumerateSubstrings(in: s.startIndex..<s.endIndex, options: .byWords) { (sub, range, _, _) in
        guard let sub = sub, sub.count > 1 else { return }
        if let box = try? cand.boundingBox(for: range) {
            let bb = box.boundingBox
            words.append(["t": sub, "x": bb.origin.x, "y": 1.0 - (bb.origin.y + bb.size.height), "w": bb.size.width, "h": bb.size.height])
        }
    }
}
if let d = try? JSONSerialization.data(withJSONObject: words), let str = String(data: d, encoding: .utf8) { print(str) } else { print("[]") }
"#;
        ensure_swift_binary("widget_ocr_words", script)
    })
}

#[cfg(target_os = "macos")]
pub fn ocr_words_region(_title: String, cx: f64, cy: f64, region: u32, out_px: u32) -> String {
    if !ensure_ocr_words_binary() { return "[]".into(); }
    let rgba = match capture_region_rgba(cx, cy, region, out_px) {
        Some(r) => r, None => return "[]".into(),
    };
    let png = match rgba_to_png(&rgba, out_px, out_px) {
        Some(p) => p, None => return "[]".into(),
    };
    let in_png = format!("/tmp/widget_ocr_words_{}_in.png", std::process::id());
    if std::fs::write(&in_png, &png).is_err() { return "[]".into(); }
    std::process::Command::new("/tmp/widget_ocr_words")
        .arg(&in_png)
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "[]".into())
}
#[cfg(not(target_os = "macos"))]
pub fn ocr_words_region(_title: String, _cx: f64, _cy: f64, _region: u32, _out_px: u32) -> String { "[]".into() }

// ── Dictionary lookup via macOS DictionaryServices (offline) ──────────────────
// Returns JSON {word, definition, synonyms[], etymology}. Definition + etymology
// come from the default dictionary; synonyms are harvested from the Oxford Thesaurus.
static LOOKUP_READY: OnceLock<bool> = OnceLock::new();

pub fn ensure_lookup_binary() -> bool {
    *LOOKUP_READY.get_or_init(|| {
        let script = r#"import Foundation
import CoreServices
@_silgen_name("DCSCopyAvailableDictionaries") func DCSCopyAvailableDictionaries() -> CFSet
@_silgen_name("DCSDictionaryGetName") func DCSDictionaryGetName(_ d: DCSDictionary) -> CFString
let word = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
func lookup(_ dict: DCSDictionary?, _ w: String) -> String {
    let r = CFRange(location: 0, length: w.utf16.count)
    if let def = DCSCopyTextDefinition(dict, w as CFString, r)?.takeRetainedValue() { return def as String }
    return ""
}
var thes: DCSDictionary? = nil
let dicts = DCSCopyAvailableDictionaries() as NSSet
for d in dicts {
    let ref = unsafeBitCast(d as AnyObject, to: DCSDictionary.self)
    let name = (DCSDictionaryGetName(ref) as String)
    if name == "Oxford Thesaurus of English" { thes = ref; break }
    if thes == nil && name.lowercased().contains("thesaurus") { thes = ref }
}
let full = lookup(nil, word)
let thesText = thes != nil ? lookup(thes, word) : ""
var defn = full
for marker in ["PHRASES","DERIVATIVES","ORIGIN"] { if let r = defn.range(of: marker) { defn = String(defn[..<r.lowerBound]) } }
let pipes = defn.components(separatedBy: "|")
if pipes.count >= 3 { defn = pipes[2...].joined(separator: "|") }
defn = defn.trimmingCharacters(in: .whitespacesAndNewlines)
var etym = ""
if let r = full.range(of: "ORIGIN") { etym = String(full[r.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines) }
var syns: [String] = []
var seen = Set<String>()
var t1 = thesText
if let r = t1.range(of: "ANTONYMS") { t1 = String(t1[..<r.lowerBound]) }
let labels = ["informal","formal","British","literary","archaic","dated","French","Latin","rare","humorous","derogatory","technical","chiefly"]
for tok in t1.components(separatedBy: CharacterSet(charactersIn: ",;")) {
    var s = tok.trimmingCharacters(in: .whitespacesAndNewlines)
    s = s.trimmingCharacters(in: CharacterSet(charactersIn: ". "))
    for lbl in labels { if s.hasPrefix(lbl + " ") { s = String(s.dropFirst(lbl.count+1)) } }
    let lc = s.lowercased()
    let okChars = s.allSatisfy { $0.isLetter || $0 == " " || $0 == "-" }
    if okChars && s.count > 2 && s.count < 22 && lc != word.lowercased() && s == lc && !seen.contains(lc) { seen.insert(lc); syns.append(s) }
    if syns.count >= 14 { break }
}
let out: [String: Any] = ["word": word, "definition": defn, "synonyms": syns, "etymology": etym]
if let d = try? JSONSerialization.data(withJSONObject: out), let str = String(data: d, encoding: .utf8) { print(str) } else { print("{}") }
"#;
        ensure_swift_binary("widget_lookup", script)
    })
}

#[cfg(target_os = "macos")]
pub fn define_word(word: String) -> String {
    if word.trim().is_empty() || !ensure_lookup_binary() { return "{}".into(); }
    std::process::Command::new("/tmp/widget_lookup")
        .arg(word.trim())
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "{}".into())
}
#[cfg(not(target_os = "macos"))]
pub fn define_word(_word: String) -> String { "{}".into() }

pub fn encode_b64(data: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let n = chunk.len();
        let b0 = chunk[0] as u32;
        let b1 = if n > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if n > 2 { chunk[2] as u32 } else { 0 };
        let b  = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((b >> 18) & 63) as usize] as char);
        out.push(T[((b >> 12) & 63) as usize] as char);
        out.push(if n > 1 { T[((b >> 6) & 63) as usize] as char } else { '=' });
        out.push(if n > 2 { T[(b & 63) as usize] as char } else { '=' });
    }
    out
}

#[cfg(target_os = "macos")]
pub fn capture_bg_region(_title: String, win_x: f64, win_y: f64, rel_x: f64, rel_y: f64, rel_w: f64, rel_h: f64) -> Option<String> {
    if rel_w < 8.0 || rel_h < 8.0 { return None; }
    let dst = capture_bounds_excluding_ours(win_x + rel_x, win_y + rel_y, rel_w, rel_h, 64, 64)?;
    Some(encode_b64(&dst))
}

#[cfg(not(target_os = "macos"))]
pub fn capture_bg_region(_title: String, _win_x: f64, _win_y: f64, _rel_x: f64, _rel_y: f64, _rel_w: f64, _rel_h: f64) -> Option<String> {
    None
}

// Shared capture: full display (minus our widget window) scaled to out_w × out_h.
// Uses kCGWindowListOptionOnScreenBelowWindow so the widget is never in the screenshot.
#[cfg(target_os = "macos")]
pub fn capture_display_rgba(out_w: u32, out_h: u32) -> Option<Vec<u8>> {
    use std::ffi::c_void;
    #[repr(C)] struct CGPoint { x: f64, y: f64 }
    #[repr(C)] struct CGSize  { w: f64, h: f64 }
    #[repr(C)] struct CGRect  { o: CGPoint, s: CGSize }
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGMainDisplayID() -> u32;
        fn CGDisplayPixelsWide(display: u32) -> usize;
        fn CGDisplayPixelsHigh(display: u32) -> usize;
        // option: kCGWindowListOptionOnScreenBelowWindow=2 | kCGWindowListExcludeDesktopElements=16
        // image_option: kCGWindowImageDefault=0
        fn CGWindowListCreateImage(bounds: CGRect, option: u32, window_id: u32, image_option: u32) -> *const c_void;
        fn CGColorSpaceCreateDeviceRGB() -> *const c_void;
        fn CGBitmapContextCreate(
            data: *mut c_void, w: usize, h: usize,
            bits: usize, bpr: usize, cs: *const c_void, info: u32,
        ) -> *const c_void;
        fn CGContextDrawImage(ctx: *const c_void, rect: CGRect, img: *const c_void);
        fn CFRelease(cf: *const c_void);
    }
    if out_w == 0 || out_h == 0 || out_w > 4096 || out_h > 4096 { return None; }
    let dw = out_w as usize;
    let dh = out_h as usize;
    let mut pixels = vec![0u8; dw * dh * 4];
    let own_wid = find_own_window_id();
    unsafe {
        let display = CGMainDisplayID();
        let sw = CGDisplayPixelsWide(display) as f64;
        let sh = CGDisplayPixelsHigh(display) as f64;
        let bounds = CGRect { o: CGPoint { x: 0.0, y: 0.0 }, s: CGSize { w: sw, h: sh } };
        // Capture everything below/behind our window; fall back to all on-screen windows
        let (opt, wid) = if own_wid > 0 { (2u32 | 16, own_wid) } else { (1u32 | 16, 0u32) };
        let image = CGWindowListCreateImage(bounds, opt, wid, 0);
        if image.is_null() { return None; }
        let cs  = CGColorSpaceCreateDeviceRGB();
        let ctx = CGBitmapContextCreate(
            pixels.as_mut_ptr() as *mut c_void, dw, dh, 8, dw * 4, cs, 2,
        );
        CFRelease(cs);
        if ctx.is_null() { CFRelease(image); return None; }
        CGContextDrawImage(ctx, CGRect { o: CGPoint { x: 0.0, y: 0.0 }, s: CGSize { w: dw as f64, h: dh as f64 } }, image);
        CFRelease(ctx);
        CFRelease(image);
        // Flip rows: CG origin is bottom-left, we want top-left
        let row = dw * 4;
        for y in 0..(dh / 2) {
            for x in 0..row { pixels.swap(y * row + x, (dh - 1 - y) * row + x); }
        }
        for i in (0..pixels.len()).step_by(4) { pixels[i + 3] = 255; }
    }
    Some(pixels)
}

#[cfg(target_os = "macos")]
pub fn capture_display(out_w: u32, out_h: u32) -> Option<String> {
    Some(encode_b64(&capture_display_rgba(out_w, out_h)?))
}
#[cfg(not(target_os = "macos"))]
pub fn capture_display(_out_w: u32, _out_h: u32) -> Option<String> { None }

// Sobel edge detection on RGBA pixels → 8-bit magnitude per pixel.
// Runs in compiled Rust so we can afford full-res inputs without JS CPU cost.
pub fn sobel_u8(rgba: &[u8], w: usize, h: usize) -> Vec<u8> {
    const KX: [i32; 9] = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
    const KY: [i32; 9] = [-1,-2,-1,  0, 0, 0,  1, 2, 1];
    let mut out = vec![0u8; w * h];
    for y in 1..(h - 1) {
        for x in 1..(w - 1) {
            let mut gx = 0i32;
            let mut gy = 0i32;
            for ky in 0..3i32 {
                for kx in 0..3i32 {
                    let pi = ((y as i32 + ky - 1) as usize * w + (x as i32 + kx - 1) as usize) * 4;
                    let gray = (rgba[pi] as i32 * 299 + rgba[pi+1] as i32 * 587 + rgba[pi+2] as i32 * 114) / 1000;
                    let ki   = (ky * 3 + kx) as usize;
                    gx += KX[ki] * gray;
                    gy += KY[ki] * gray;
                }
            }
            out[y * w + x] = (((gx*gx + gy*gy) as f32).sqrt() as u32).min(255) as u8;
        }
    }
    out
}

// Returns base64-encoded 8-bit edge magnitudes (1 byte/pixel) — 4× smaller than RGBA.
#[cfg(target_os = "macos")]
pub fn compute_edges(out_w: u32, out_h: u32) -> Option<String> {
    let rgba  = capture_display_rgba(out_w, out_h)?;
    let edges = sobel_u8(&rgba, out_w as usize, out_h as usize);
    Some(encode_b64(&edges))
}
#[cfg(not(target_os = "macos"))]
pub fn compute_edges(_out_w: u32, _out_h: u32) -> Option<String> { None }

pub fn mouse_position() -> (f64, f64) {
    #[cfg(target_os = "macos")]
    {
        #[repr(C)]
        struct CGPoint { x: f64, y: f64 }

        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGEventCreate(source: *const std::ffi::c_void) -> *mut std::ffi::c_void;
            fn CGEventGetLocation(event: *mut std::ffi::c_void) -> CGPoint;
            fn CFRelease(cf: *const std::ffi::c_void);
        }

        unsafe {
            let event = CGEventCreate(std::ptr::null());
            if event.is_null() { return (0.0, 0.0); }
            let pt = CGEventGetLocation(event);
            CFRelease(event as *const _);
            return (pt.x, pt.y);
        }
    }
    #[cfg(not(target_os = "macos"))]
    (0.0, 0.0)
}

// ── Settings persistence ──────────────────────────────────────────────────────
// Each widget stores its tunables as a JSON blob in a shared config folder.
fn settings_path(name: &str) -> std::path::PathBuf {
    let base = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let dir = std::path::Path::new(&base).join("Library/Application Support/widgets");
    let _ = std::fs::create_dir_all(&dir);
    let safe: String = name.chars().filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_').collect();
    dir.join(format!("{safe}.json"))
}

pub fn load_settings(name: &str) -> String {
    std::fs::read_to_string(settings_path(name)).unwrap_or_default()
}

pub fn save_settings(name: &str, json: &str) {
    let _ = std::fs::write(settings_path(name), json);
}

