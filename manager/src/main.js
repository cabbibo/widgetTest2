// Widget manager pillbox. A transparent, always-on-top strip parked under the
// menu bar. It lists every widget that has registered with the dock and lets you
// open (launch) or close (quit) each one. The strip is click-through everywhere
// except over the pill, so it never blocks the desktop behind it.

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { getCurrentWindow, currentMonitor } = window.__TAURI__.window;
const { LogicalSize, LogicalPosition } = window.__TAURI__.dpi;
const appWindow = getCurrentWindow();

const pill = document.getElementById('pill');
let visible = true;
let parked = false;   // we centre the pillbox once, then leave it wherever it's dragged
let widgets = [];   // [{id, name, glyph, exec, running}]

// ── Window sizing + parking ───────────────────────────────────────────────────
// Keep the transparent window snug around the pill as chips appear/disappear.
// The window's top-left is preserved, so toggling a widget never moves the box;
// we only centre it under the menu bar on the very first render.
async function fit() {
  await new Promise((r) => requestAnimationFrame(r));
  const r = pill.getBoundingClientRect();
  const w = Math.max(120, Math.ceil(r.width) + 24);   // + #wrap padding
  const h = Math.max(56, Math.ceil(r.height) + 16);
  await appWindow.setSize(new LogicalSize(w, h));
  if (!parked) {
    parked = true;
    const m = await currentMonitor();
    if (m) {
      const sw = m.size.width / m.scaleFactor;
      await appWindow.setPosition(new LogicalPosition(Math.round(sw / 2 - w / 2), 34));
    }
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function render() {
  pill.innerHTML = '';

  // leading: quit the manager itself
  const x = document.createElement('button');
  x.className = 'ctl close'; x.textContent = '✕'; x.title = 'Quit widget manager';
  x.onclick = () => invoke('quit_app');
  pill.appendChild(x);

  const sep = document.createElement('div'); sep.className = 'sep'; pill.appendChild(sep);

  if (!widgets.length) {
    const e = document.createElement('div'); e.className = 'empty';
    e.textContent = 'No widgets yet. Launch each widget once and it registers itself here.';
    pill.appendChild(e);
    fit();
    return;
  }

  for (const w of widgets) {
    const chip = document.createElement('button');
    chip.className = 'chip ' + (w.running ? 'on' : 'off');
    chip.title = w.running ? `Close ${w.name}` : `Open ${w.name}`;

    const dot = document.createElement('span'); dot.className = 'dot';
    const glyph = document.createElement('span'); glyph.className = 'glyph'; glyph.textContent = w.glyph;
    const name = document.createElement('span'); name.className = 'name'; name.textContent = w.name;
    chip.append(dot, glyph, name);

    chip.onclick = async () => {
      // Optimistic flip so the dot responds instantly, then reconcile.
      w.running = await invoke('toggle_widget', { id: w.id });
      render();
      setTimeout(refresh, 600);   // re-check once the process has settled
    };
    pill.appendChild(chip);
  }
  fit();
}

// ── State polling ─────────────────────────────────────────────────────────────
// Widgets can also be quit from their own tray, so keep the dots honest.
async function refresh() {
  try {
    const next = await invoke('list_widgets');
    // Re-render only if the set or any running state changed (avoids flicker).
    const changed = next.length !== widgets.length ||
      next.some((n, i) => !widgets[i] || widgets[i].id !== n.id || widgets[i].running !== n.running);
    widgets = next;
    if (changed) render();
  } catch (_) {}
}

// ── Click-through hit-testing ─────────────────────────────────────────────────
await appWindow.setIgnoreCursorEvents(true);
async function pollCursor() {
  try {
    const [gx, gy] = await invoke('mouse_position');
    const pos = await appWindow.outerPosition();
    const sf = window.devicePixelRatio;
    const lx = gx - pos.x / sf, ly = gy - pos.y / sf;
    const r = pill.getBoundingClientRect();
    const over = visible && lx >= r.left && lx <= r.right && ly >= r.top && ly <= r.bottom;
    await appWindow.setIgnoreCursorEvents(!over);
  } catch (_) {}
  setTimeout(pollCursor, 60);
}

// drag the pillbox by its background (not the buttons)
pill.addEventListener('pointerdown', (e) => { if (e.target === pill) appWindow.startDragging(); });

// tray → Show / Hide pillbox
listen('toggle-bar', () => {
  visible = !visible;
  if (visible) { appWindow.show(); appWindow.setFocus(); } else { appWindow.hide(); }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
await refresh();
render();
pollCursor();
setInterval(refresh, 2000);
