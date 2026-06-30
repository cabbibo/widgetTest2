// Confetti Butt widget backend. Audio-reactivity (system audio FFT) and global keypress
// monitoring live here because they are butt-specific; everything reusable
// (permissions, screen capture) comes from the shared `widget_core` crate.

#[cfg(target_os = "macos")]
mod mac_audio {
    use screencapturekit::prelude::*;
    use tauri::Emitter;
    use rustfft::{FftPlanner, num_complex::Complex};
    use std::sync::Mutex;

    const FFT_SIZE: usize = 1024;
    const EMIT_BINS: usize = 1024;

    struct Inner {
        buffer: Vec<f32>,
        fft_input: Vec<Complex<f32>>,
        planner: FftPlanner<f32>,
    }

    struct AudioHandler {
        app: tauri::AppHandle,
        inner: Mutex<Inner>,
    }

    impl SCStreamOutputTrait for AudioHandler {
        fn did_output_sample_buffer(&self, sample: CMSampleBuffer, of_type: SCStreamOutputType) {
            if !matches!(of_type, SCStreamOutputType::Audio) { return; }
            let Some(buf_list) = sample.audio_buffer_list() else { return };

            let mut st = self.inner.lock().unwrap();

            for audio_buf in buf_list.iter() {
                let bytes = audio_buf.data();
                let samples: &[f32] = unsafe {
                    std::slice::from_raw_parts(bytes.as_ptr() as *const f32, bytes.len() / 4)
                };
                for chunk in samples.chunks(2) {
                    let mono = if chunk.len() >= 2 { (chunk[0] + chunk[1]) * 0.5 } else { chunk[0] };
                    st.buffer.push(mono);
                }
            }

            while st.buffer.len() >= FFT_SIZE {
                let chunk: Vec<f32> = st.buffer.drain(..FFT_SIZE).collect();

                st.fft_input.clear();
                st.fft_input.extend(chunk.iter().map(|&s| Complex { re: s, im: 0.0 }));

                let fft = st.planner.plan_fft_forward(FFT_SIZE);
                fft.process(&mut st.fft_input);

                let scale = 1.0 / FFT_SIZE as f32;
                let bins: Vec<f32> = st.fft_input[..EMIT_BINS].iter()
                    .map(|c| ((c.re * c.re + c.im * c.im).sqrt() * scale * 20.0).min(1.0))
                    .collect();

                let _ = self.app.emit("audio-freq", bins);
            }
        }
    }

    pub fn start(app: tauri::AppHandle) {
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(3));
            let content = match SCShareableContent::get() {
                Ok(c) => c,
                Err(e) => { eprintln!("SCShareableContent error: {e:?}"); return; }
            };
            let displays = content.displays();
            let display = match displays.first() {
                Some(d) => d,
                None => { eprintln!("No display found"); return; }
            };

            let filter = SCContentFilter::create()
                .with_display(display)
                .with_excluding_windows(&[])
                .build();

            let config = SCStreamConfiguration::new()
                .with_captures_audio(true)
                .with_sample_rate(48000)
                .with_channel_count(2);

            let mut stream = SCStream::new(&filter, &config);
            stream.add_output_handler(
                AudioHandler {
                    app,
                    inner: Mutex::new(Inner {
                        buffer: Vec::new(),
                        fft_input: Vec::with_capacity(FFT_SIZE),
                        planner: FftPlanner::new(),
                    }),
                },
                SCStreamOutputType::Audio,
            );

            if let Err(e) = stream.start_capture() {
                eprintln!("Start capture error: {e:?}");
                return;
            }

            loop { std::thread::park(); }
        });
    }
}

#[cfg(target_os = "macos")]
fn start_key_monitor(app: tauri::AppHandle) {
    use std::ffi::c_void;
    use tauri::Emitter;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventTapCreate(
            tap: u32, place: u32, options: u32, events_of_interest: u64,
            callback: extern "C" fn(*const c_void, u32, *const c_void, *mut c_void) -> *const c_void,
            user_info: *mut c_void,
        ) -> *mut c_void;
        fn CGEventGetIntegerValueField(event: *const c_void, field: u32) -> i64;
        fn CFMachPortCreateRunLoopSource(alloc: *const c_void, tap: *mut c_void, order: isize) -> *mut c_void;
        fn CFRunLoopGetCurrent() -> *mut c_void;
        fn CFRunLoopAddSource(rl: *mut c_void, source: *mut c_void, mode: *const c_void);
        fn CFRunLoopRun();
        fn CFRelease(cf: *const c_void);
    }

    let (tx, rx) = std::sync::mpsc::channel::<char>();
    let tx_box = Box::new(tx);
    let tx_ptr = Box::into_raw(tx_box);

    extern "C" fn tap_cb(
        _proxy: *const c_void, _type: u32, event: *const c_void, user_info: *mut c_void,
    ) -> *const c_void {
        unsafe {
            let keycode = CGEventGetIntegerValueField(event, 9) as u16;
            let tx = &*(user_info as *const std::sync::mpsc::Sender<char>);
            if let Some(c) = match keycode {
                 0 => Some('A'),  1 => Some('S'),  2 => Some('D'),  3 => Some('F'),
                 4 => Some('H'),  5 => Some('G'),  6 => Some('Z'),  7 => Some('X'),
                 8 => Some('C'),  9 => Some('V'), 11 => Some('B'), 12 => Some('Q'),
                13 => Some('W'), 14 => Some('E'), 15 => Some('R'), 16 => Some('Y'),
                17 => Some('T'), 31 => Some('O'), 32 => Some('U'), 34 => Some('I'),
                35 => Some('P'), 37 => Some('L'), 38 => Some('J'), 40 => Some('K'),
                45 => Some('N'), 46 => Some('M'),
                18 => Some('1'), 19 => Some('2'), 20 => Some('3'), 21 => Some('4'),
                22 => Some('6'), 23 => Some('5'), 25 => Some('9'), 26 => Some('7'),
                28 => Some('8'), 29 => Some('0'),
                _ => None,
            } { let _ = tx.send(c); }
        }
        event
    }

    std::thread::spawn(move || {
        for c in rx {
            let _ = app.emit("keypress", c.to_string());
        }
    });

    let tx_ptr_addr = tx_ptr as usize;

    std::thread::spawn(move || {
        let tx_ptr = tx_ptr_addr as *mut std::sync::mpsc::Sender<char>;
        unsafe {
            let tap = CGEventTapCreate(0, 0, 1, 1 << 10, tap_cb, tx_ptr as *mut c_void);
            if tap.is_null() {
                eprintln!("CGEventTapCreate failed — Input Monitoring permission not granted");
                let _ = Box::from_raw(tx_ptr);
                return;
            }
            #[link(name = "CoreFoundation", kind = "framework")]
            extern "C" { static kCFRunLoopDefaultMode: *const c_void; }
            let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
            let rl = CFRunLoopGetCurrent();
            CFRunLoopAddSource(rl, source, kCFRunLoopDefaultMode);
            CFRelease(source);
            CFRunLoopRun();
        }
    });
}

// ── Thin command wrappers over widget_core ────────────────────────────────────
#[tauri::command]
fn check_permissions() -> widget_core::PermissionsStatus { widget_core::check_permissions() }

#[tauri::command]
fn open_permission_settings(permission: String) { widget_core::open_permission_settings(permission) }

#[tauri::command]
fn mouse_position() -> (f64, f64) { widget_core::mouse_position() }

#[tauri::command]
fn capture_bg_region(title: String, win_x: f64, win_y: f64, rel_x: f64, rel_y: f64, rel_w: f64, rel_h: f64) -> Option<String> {
    widget_core::capture_bg_region(title, win_x, win_y, rel_x, rel_y, rel_w, rel_h)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Manager;
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                mac_audio::start(app.handle().clone());
                start_key_monitor(app.handle().clone());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            check_permissions, open_permission_settings, mouse_position, capture_bg_region
        ])
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
