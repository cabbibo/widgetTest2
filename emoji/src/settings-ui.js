// Preferences window: every setting in one place — sliders, toggles, and the emoji
// editor — auto-built from the shared SCHEMA. Changes apply live + persist.

import { SCHEMA, GROUPS, PALETTE, defaults, applyJSON } from './settings.js';

const { invoke } = window.__TAURI__.core;
const { emit, listen } = window.__TAURI__.event;

const NAME = 'emoji';
const settings = defaults();
try { applyJSON(settings, await invoke('load_settings', { name: NAME })); } catch (_) {}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => invoke('save_settings', { name: NAME, json: JSON.stringify(settings) }), 200);
}
function pushLive() { emit('apply-settings', { ...settings }); }

const app = document.getElementById('app');
const fmt = (v) => (Math.abs(v) >= 100 || Number.isInteger(v)) ? String(v) : v.toFixed(2);
const rangeEls = {}, valEls = {}, toggleEls = {};

// ── Header ───────────────────────────────────────────────────────────────────
const hdr = document.createElement('div');
hdr.className = 'hdr';
hdr.innerHTML = '<h1>EMOJI TASSELS</h1>';
const resetBtn = document.createElement('button'); resetBtn.textContent = 'Reset';
hdr.appendChild(resetBtn);
app.appendChild(hdr);

// ── Emoji editor ───────────────────────────────────────────────────────────────
const egh = document.createElement('div'); egh.className = 'group'; egh.textContent = 'Emojis';
app.appendChild(egh);
const activeRow = document.createElement('div'); activeRow.className = 'emoji-active'; app.appendChild(activeRow);
const palWrap = document.createElement('div'); palWrap.className = 'emoji-pal'; app.appendChild(palWrap);

function renderEmojis() {
  activeRow.innerHTML = '';
  settings.emojis.forEach((em, i) => {
    const b = document.createElement('button'); b.className = 'echip'; b.textContent = em; b.title = 'Remove';
    b.onclick = () => { settings.emojis.splice(i, 1); if (!settings.emojis.length) settings.emojis.push('🌙'); renderEmojis(); pushLive(); persist(); };
    activeRow.appendChild(b);
  });
  palWrap.innerHTML = '';
  for (const em of PALETTE) {
    const b = document.createElement('button'); b.className = 'epal'; b.textContent = em; b.title = 'Add';
    if (settings.emojis.includes(em)) b.classList.add('on');
    b.onclick = () => {
      const idx = settings.emojis.indexOf(em);
      if (idx >= 0) { settings.emojis.splice(idx, 1); if (!settings.emojis.length) settings.emojis.push('🌙'); }
      else if (settings.emojis.length < 24) settings.emojis.push(em);
      renderEmojis(); pushLive(); persist();
    };
    palWrap.appendChild(b);
  }
}
renderEmojis();

// ── Sliders + toggles, grouped ─────────────────────────────────────────────────
for (const group of GROUPS) {
  const gh = document.createElement('div'); gh.className = 'group'; gh.textContent = group;
  app.appendChild(gh);

  for (const s of SCHEMA.filter(x => x.group === group)) {
    if (s.type === 'toggle') {
      const row = document.createElement('label'); row.className = 'row toggle-row';
      const lab = document.createElement('span'); lab.className = 'lab'; lab.textContent = s.label;
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!settings[s.key];
      toggleEls[s.key] = cb;
      cb.addEventListener('change', () => { settings[s.key] = cb.checked; pushLive(); persist(); });
      row.appendChild(lab); row.appendChild(cb);
      app.appendChild(row);
    } else {
      const row = document.createElement('div'); row.className = 'row';
      const rl = document.createElement('div'); rl.className = 'rl';
      const lab = document.createElement('span'); lab.className = 'lab'; lab.textContent = s.label;
      const val = document.createElement('span'); val.className = 'val'; val.textContent = fmt(settings[s.key]);
      valEls[s.key] = val;
      rl.appendChild(lab); rl.appendChild(val);
      const input = document.createElement('input');
      input.type = 'range'; input.min = s.min; input.max = s.max; input.step = s.step; input.value = settings[s.key];
      rangeEls[s.key] = input;
      input.addEventListener('input', () => {
        const v = parseFloat(input.value); settings[s.key] = v; val.textContent = fmt(v); pushLive(); persist();
      });
      row.appendChild(rl); row.appendChild(input);
      app.appendChild(row);
    }
  }
}

function refreshControls() {
  for (const s of SCHEMA) {
    if (s.type === 'toggle') { if (toggleEls[s.key]) toggleEls[s.key].checked = !!settings[s.key]; }
    else if (rangeEls[s.key]) { rangeEls[s.key].value = settings[s.key]; valEls[s.key].textContent = fmt(settings[s.key]); }
  }
  renderEmojis();
}

resetBtn.addEventListener('click', () => {
  const d = defaults();
  for (const k in d) settings[k] = Array.isArray(d[k]) ? [...d[k]] : d[k];
  refreshControls(); pushLive(); persist();
});

// keep in sync with the toolbar (emoji/sound edits there)
listen('apply-settings', (e) => { if (e.payload) { applyJSON(settings, e.payload); refreshControls(); } });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.__TAURI__.window.getCurrentWindow().hide();
});
