// Always-visible quick-control toolbar: ✕ | emojis (click to change/remove) | ＋ | sound.
// Edits the active emoji set + sound toggle live (broadcasts 'apply-settings') and persists.

import { defaults, applyJSON, SCHEMA, GROUPS } from './settings.js';

const { invoke } = window.__TAURI__.core;
const { emit, listen } = window.__TAURI__.event;
const { getCurrentWindow, currentMonitor } = window.__TAURI__.window;
const { LogicalSize, LogicalPosition } = window.__TAURI__.dpi;
const appWindow = getCurrentWindow();

const NAME = 'emoji';
const S = defaults();
try { applyJSON(S, await invoke('load_settings', { name: NAME })); } catch (_) {}

// Full emoji set with searchable keywords (name + aliases + tags).
let EMOJI_DATA = [];
try { EMOJI_DATA = await (await fetch('/emojis.json')).json(); } catch (_) {}
function searchEmojis(q) {
  q = q.trim().toLowerCase();
  if (!q) return EMOJI_DATA;
  const scored = [];
  for (const e of EMOJI_DATA) {
    const k = e.k;
    let score = 0;
    if (k === q || k.split(' ').includes(q)) score = 3;
    else if (k.split(' ').some(w => w.startsWith(q))) score = 2;
    else if (k.includes(q)) score = 1;
    if (score) scored.push([score, e]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.map(s => s[1]);
}
const isEmoji = (s) => /\p{Extended_Pictographic}/u.test(s);

const pill     = document.getElementById('pill');
const picker   = document.getElementById('picker');
const settingsPanel = document.getElementById('settings');
const W = 520;

// Park it top-centre on first load (just below the menu bar).
(async () => {
  const m = await currentMonitor();
  if (m) {
    const sw = m.size.width / m.scaleFactor;
    await appWindow.setPosition(new LogicalPosition(Math.round(sw / 2 - W / 2), 34));
  }
})();
if (!S.showToolbar) appWindow.hide();

// The toolbar window is a transparent strip — keep it click-through everywhere
// except over the pill (and the open picker), so it never blocks the desktop.
await appWindow.setIgnoreCursorEvents(true);
async function pollCursor() {
  try {
    const [gx, gy] = await invoke('mouse_position');
    const pos = await appWindow.outerPosition();
    const sf = window.devicePixelRatio;
    const lx = gx - pos.x / sf, ly = gy - pos.y / sf;   // window-local CSS px
    const inRect = (el) => {
      const r = el.getBoundingClientRect();
      return lx >= r.left && lx <= r.right && ly >= r.top && ly <= r.bottom;
    };
    const over = inRect(pill)
      || (picker.classList.contains('open') && inRect(picker))
      || (settingsPanel.classList.contains('open') && inRect(settingsPanel));
    await appWindow.setIgnoreCursorEvents(!over);
  } catch (_) {}
  setTimeout(pollCursor, 60);
}
pollCursor();

const persist  = () => invoke('save_settings', { name: NAME, json: JSON.stringify(S) });
let saveT = null;
const persistSoon = () => { clearTimeout(saveT); saveT = setTimeout(persist, 200); }; // debounce slider drags
const pushLive = () => emit('apply-settings', { ...S });
const fmt = (v) => (Math.abs(v) >= 100 || Number.isInteger(v)) ? String(v) : v.toFixed(2);
let editingIndex = -1;   // which pill emoji's picker is open (replace mode)
const setH = (h) => appWindow.setSize(new LogicalSize(W, h));
const collapse = () => {
  picker.classList.remove('open'); settingsPanel.classList.remove('open');
  editingIndex = -1; renderPill(); setH(82);
};
const expand = () => setH(380);

const mkBtn  = (txt, cls) => { const b = document.createElement('button'); b.className = 'btn' + (cls ? ' ' + cls : ''); b.textContent = txt; return b; };
const mkPick = (txt, cls) => { const b = document.createElement('button'); b.className = cls; b.textContent = txt; return b; };
const sep    = () => { const s = document.createElement('div'); s.className = 'sep'; return s; };

function renderPill() {
  pill.innerHTML = '';
  const x = mkBtn('✕', 'close'); x.title = 'Close widget'; x.onclick = () => invoke('quit_app'); pill.appendChild(x);
  pill.appendChild(sep());
  S.emojis.forEach((em, i) => {
    const b = mkBtn(em, i === editingIndex ? 'editing' : ''); b.title = 'Change or remove';
    b.onclick = () => openPicker({ type: 'replace', index: i }); pill.appendChild(b);
  });
  const add = mkBtn('＋', 'ico'); add.title = 'Add emoji'; add.onclick = () => openPicker({ type: 'add' }); pill.appendChild(add);
  pill.appendChild(sep());
  const snd = mkBtn(S.soundEnabled ? '🔊' : '🔇', 'ico'); snd.title = 'Toggle sound';
  snd.onclick = () => { S.soundEnabled = !S.soundEnabled; persist(); pushLive(); renderPill(); };
  pill.appendChild(snd);
  const gear = mkBtn('⚙', 'ico'); gear.title = 'Settings';
  gear.onclick = () => { settingsPanel.classList.contains('open') ? collapse() : openSettings(); };
  pill.appendChild(gear);
}

// Settings dropdown — all sliders/toggles, built from the shared SCHEMA.
function buildSettings() {
  settingsPanel.innerHTML = '';
  for (const group of GROUPS) {
    const gh = document.createElement('div'); gh.className = 's-group'; gh.textContent = group;
    settingsPanel.appendChild(gh);
    for (const s of SCHEMA.filter(x => x.group === group)) {
      if (s.type === 'toggle') {
        const row = document.createElement('label'); row.className = 's-row s-toggle';
        const lab = document.createElement('span'); lab.textContent = s.label;
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!S[s.key];
        cb.addEventListener('change', () => { S[s.key] = cb.checked; pushLive(); persistSoon(); });
        row.appendChild(lab); row.appendChild(cb); settingsPanel.appendChild(row);
      } else {
        const row = document.createElement('div'); row.className = 's-row';
        const top = document.createElement('div'); top.className = 's-top';
        const lab = document.createElement('span'); lab.textContent = s.label;
        const val = document.createElement('span'); val.className = 's-val'; val.textContent = fmt(S[s.key]);
        top.appendChild(lab); top.appendChild(val);
        const inp = document.createElement('input');
        inp.type = 'range'; inp.min = s.min; inp.max = s.max; inp.step = s.step; inp.value = S[s.key];
        inp.addEventListener('input', () => { const v = parseFloat(inp.value); S[s.key] = v; val.textContent = fmt(v); pushLive(); persistSoon(); });
        row.appendChild(top); row.appendChild(inp); settingsPanel.appendChild(row);
      }
    }
  }
}

function openSettings() {
  picker.classList.remove('open');
  editingIndex = -1; renderPill();
  buildSettings();                 // rebuild → reflects any external changes
  settingsPanel.classList.add('open');
  setH(486);
}

function pick(em, mode) {
  if (mode.type === 'replace') {
    S.emojis[mode.index] = em;
    persist(); pushLive(); renderPill(); collapse();   // one swap, then close
  } else {
    if (S.emojis.length < 24) S.emojis.push(em);
    persist(); pushLive(); renderPill();               // stay open → click more
  }
}

function openPicker(mode) {
  settingsPanel.classList.remove('open');
  editingIndex = mode.type === 'replace' ? mode.index : -1;
  renderPill();           // highlight the emoji being edited
  picker.innerHTML = '';

  // search box (type a word to filter, or paste an emoji to use directly)
  const inputRow = document.createElement('div'); inputRow.className = 'pick-input';
  const tin = document.createElement('input'); tin.type = 'text'; tin.placeholder = 'search emoji (e.g. cat) or paste one…';
  inputRow.appendChild(tin);
  picker.appendChild(inputRow);

  if (mode.type === 'replace') {
    const rm = document.createElement('button'); rm.className = 'pick-remove'; rm.textContent = '✕  remove';
    rm.onclick = () => { S.emojis.splice(mode.index, 1); if (!S.emojis.length) S.emojis.push('🌙'); commit(); };
    picker.appendChild(rm);
  }

  // scrollable grid of all (or filtered) emojis
  const grid = document.createElement('div'); grid.className = 'pick-grid';
  picker.appendChild(grid);

  function renderGrid() {
    const q = tin.value;
    const list = searchEmojis(q);
    grid.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (let i = 0; i < Math.min(list.length, 600); i++) {
      const e = list[i];
      const b = mkPick(e.e, 'pick'); b.title = e.n;
      b.onclick = () => pick(e.e, mode);
      frag.appendChild(b);
    }
    grid.appendChild(frag);
  }
  tin.addEventListener('input', renderGrid);
  tin.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const v = tin.value.trim();
    if (isEmoji(v)) { pick(v, mode); return; }        // pasted an emoji → use it
    const list = searchEmojis(v);
    if (list.length) pick(list[0].e, mode);            // else use top match
  });

  renderGrid();
  picker.classList.add('open');
  expand();
  setTimeout(() => tin.focus(), 30);
}

function commit() { persist(); pushLive(); renderPill(); collapse(); }

const anyOpen = () => picker.classList.contains('open') || settingsPanel.classList.contains('open');
// Esc closes whichever dropdown is open
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && anyOpen()) { e.preventDefault(); collapse(); }
});
// click outside the open dropdown (empty area) closes it; clicking other apps blurs us
document.addEventListener('pointerdown', (e) => {
  if (!anyOpen()) return;
  if (picker.contains(e.target) || settingsPanel.contains(e.target) || pill.contains(e.target)) return;
  collapse();
});
window.addEventListener('blur', () => { if (anyOpen()) collapse(); });

// drag the toolbar by the pill background (not the buttons)
pill.addEventListener('pointerdown', (e) => { if (e.target === pill) appWindow.startDragging(); });

// stay in sync if Preferences changes things
listen('apply-settings', (e) => {
  if (!e.payload) return;
  applyJSON(S, e.payload);
  if (S.showToolbar) appWindow.show(); else appWindow.hide();
  renderPill();
});

renderPill();
collapse();
