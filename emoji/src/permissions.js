// ── Shared permission gate ────────────────────────────────────────────────────
// Pops up a blocking overlay ONLY when a required permission is missing, and
// removes itself automatically once everything is granted. If a widget needs no
// permissions, pass [] and nothing ever shows.
//
// While the overlay is visible it sets `window.__permOverlayActive = true`; each
// widget's cursor-loop checks that flag and keeps the window clickable so the
// "Open Settings" buttons work even though widgets are normally click-through.

const META = {
  screen_capture: {
    label: 'Screen Recording',
    mac:   'System Settings → Privacy & Security → Screen Recording → enable this app',
    win:   'Settings → Privacy & security → Screen capture',
  },
  input_monitoring: {
    label: 'Input Monitoring',
    mac:   'System Settings → Privacy & Security → Input Monitoring → enable this app',
    win:   'Not required on Windows',
  },
};

async function setCursor(on) {
  try { await window.__TAURI__.window.getCurrentWindow().setIgnoreCursorEvents(!on); }
  catch (_) {}
}

function buildOverlay() {
  const el = document.createElement('div');
  el.id = 'perm-overlay';
  el.style.cssText = `
    position:fixed; inset:0; z-index:99999;
    display:flex; align-items:center; justify-content:center;
    background:rgba(0,0,0,0.82); backdrop-filter:blur(12px);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  `;
  const box = document.createElement('div');
  box.style.cssText = `
    background:rgba(30,32,40,0.95); border:1px solid rgba(255,255,255,0.12);
    border-radius:16px; padding:32px 36px; max-width:460px; width:90%;
    box-shadow:0 24px 64px rgba(0,0,0,0.6); color:#e8e8f0;
  `;
  box.innerHTML = `
    <h2 style="margin:0 0 8px;font-size:18px;font-weight:600;letter-spacing:-0.3px;">Permissions needed</h2>
    <p style="margin:0 0 24px;font-size:13px;color:#9090a8;line-height:1.5;" id="perm-note"></p>
    <div id="perm-items" style="display:flex;flex-direction:column;gap:16px;"></div>
    <div style="margin-top:28px;display:flex;gap:10px;justify-content:flex-end;">
      <button id="perm-recheck" style="padding:8px 18px;border-radius:8px;border:1px solid rgba(255,255,255,0.18);background:rgba(255,255,255,0.08);color:#e8e8f0;font-size:13px;cursor:pointer;">Check again</button>
    </div>
  `;
  el.appendChild(box);
  document.body.appendChild(el);
  window.__permOverlayActive = true;
  setCursor(true);
  return el;
}

function renderItem(container, key, granted, platform, desc) {
  const m = META[key];
  if (!m) return;
  const item = document.createElement('div');
  item.style.cssText = `
    display:flex;gap:14px;align-items:flex-start;padding:14px;border-radius:10px;
    background:${granted ? 'rgba(40,180,80,0.08)' : 'rgba(255,80,60,0.08)'};
    border:1px solid ${granted ? 'rgba(40,180,80,0.25)' : 'rgba(255,80,60,0.2)'};
  `;
  const steps = platform === 'macos' ? m.mac : m.win;
  item.innerHTML = `
    <div style="font-size:20px;margin-top:1px;">${granted ? '✅' : '❌'}</div>
    <div style="flex:1;">
      <div style="font-size:14px;font-weight:600;margin-bottom:3px;">${m.label}</div>
      <div style="font-size:12px;color:#9090a8;line-height:1.5;margin-bottom:${granted ? 0 : '10px'};">${desc || ''}</div>
      ${granted ? '' : `
        <div style="font-size:11px;color:#aaa;margin-bottom:10px;font-style:italic;">${steps}</div>
        <button data-perm="${key}" style="padding:6px 14px;border-radius:6px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.1);color:#e8e8f0;font-size:12px;cursor:pointer;">Open Settings</button>
      `}
    </div>
  `;
  container.appendChild(item);
}

// required: array of permission keys (e.g. ['screen_capture'])
// opts.note: sentence shown under the title
// opts.descriptions: { [key]: 'why this widget needs it' }
export function guardPermissions(required, opts = {}) {
  const descriptions = opts.descriptions || {};
  const note = opts.note || 'This widget needs a few permissions to work fully.';
  let timer = null;

  async function check() {
    let perms;
    try { perms = await window.__TAURI__.core.invoke('check_permissions'); }
    catch (_) { return; }

    const missing = required.filter(k => !perms[k]);
    let overlay = document.getElementById('perm-overlay');

    if (missing.length === 0) {                       // all granted → no popup
      if (overlay) { overlay.remove(); window.__permOverlayActive = false; setCursor(false); }
      if (timer) { clearInterval(timer); timer = null; }
      return;
    }

    if (!overlay) overlay = buildOverlay();
    window.__permOverlayActive = true;
    setCursor(true);
    overlay.querySelector('#perm-note').textContent = note;
    const container = overlay.querySelector('#perm-items');
    container.innerHTML = '';
    for (const key of required) renderItem(container, key, !!perms[key], perms.platform, descriptions[key]);

    const { invoke } = window.__TAURI__.core;
    container.querySelectorAll('button[data-perm]').forEach(btn =>
      btn.addEventListener('click', () => invoke('open_permission_settings', { permission: btn.dataset.perm }))
    );
    overlay.querySelector('#perm-recheck').addEventListener('click', check);

    if (!timer) timer = setInterval(check, 2500);     // auto-dismiss once granted
  }

  check();
  return check;
}
