// Single source of truth for the emoji-tassels widget settings.
// SCHEMA drives the Preferences UI (sliders + toggles); `emojis` is the active set
// edited from the toolbar; PALETTE is the choices shown in the emoji picker.

export const DEFAULT_EMOJIS = ['🌙','⭐','✨','💫','🔮','🌈','🦋','🌸','🍄','🌀'];

export const PALETTE = [
  '🌙','⭐','✨','💫','🔮','🌈','🦋','🌸','🍄','🌀',
  '🌷','🌼','🍀','🌿','🪻','🐚','🪸','🫧','❄️','🔥',
  '💧','⚡','🌊','🍃','🌺','🌻','💐','🪷','🐝','🐌',
  '🦄','🐙','🐡','🌟','💎','🎐','🪩','🕯️','🧿','☁️',
];

export const SCHEMA = [
  // Wind
  { key: 'ambient',      label: 'Ambient flutter', min: 0,    max: 0.2,  step: 0.005, def: 0.035, group: 'Wind' },
  { key: 'gustGap',      label: 'Calm between gusts (s)', min: 1, max: 20, step: 0.5, def: 7,     group: 'Wind' },
  { key: 'gustSize',     label: 'Gust size',       min: 40,   max: 300,  step: 5,     def: 120,   group: 'Wind' },
  { key: 'gustStrength', label: 'Gust strength',   min: 0,    max: 6,    step: 0.1,   def: 2.5,   group: 'Wind' },
  { key: 'gustSpeed',    label: 'Gust speed',      min: 1,    max: 9,    step: 0.2,   def: 3.5,   group: 'Wind' },

  // Motion
  { key: 'gravity',      label: 'Gravity',         min: 0.1,  max: 1.5,  step: 0.05,  def: 0.55,  group: 'Motion' },
  { key: 'damping',      label: 'Floppiness',      min: 0.8,  max: 0.99, step: 0.005, def: 0.9,   group: 'Motion' },
  { key: 'length',       label: 'Strand length',   min: 8,    max: 40,   step: 1,     def: 15,    group: 'Motion' },
  { key: 'spacing',      label: 'Spacing',         min: 8,    max: 40,   step: 1,     def: 16,    group: 'Motion' },
  { key: 'mouseRadius',  label: 'Cursor radius',   min: 20,   max: 160,  step: 5,     def: 75,    group: 'Motion' },
  { key: 'mouseForce',   label: 'Cursor push',     min: 0,    max: 20,   step: 0.5,   def: 9,     group: 'Motion' },

  // Sound
  { key: 'soundEnabled', label: 'Sound',           type: 'toggle', def: true,         group: 'Sound' },
  { key: 'chimeVolume',  label: 'Chime volume',    min: 0,    max: 1,    step: 0.02,  def: 0.5,   group: 'Sound' },
  { key: 'reverb',       label: 'Reverb',          min: 0,    max: 2,    step: 0.05,  def: 1.15,  group: 'Sound' },
  { key: 'reverbLength', label: 'Reverb length (s)', min: 1,  max: 8,    step: 0.2,   def: 4.2,   group: 'Sound' },
  { key: 'pitch',        label: 'Pitch (semitones)', min: -12, max: 12,  step: 1,     def: 0,     group: 'Sound' },
  { key: 'sensitivity',  label: 'Collision sensitivity', min: 0.4, max: 4, step: 0.1, def: 1.3,   group: 'Sound' },

  // Look
  { key: 'emojiSize',    label: 'Emoji size',      min: 8,    max: 30,   step: 1,     def: 15,    group: 'Look' },
  { key: 'lineOpacity',  label: 'Line opacity',    min: 0,    max: 1,    step: 0.05,  def: 0.6,   group: 'Look' },
  { key: 'dotSize',      label: 'Dot size',        min: 0,    max: 12,   step: 0.5,   def: 5,     group: 'Look' },
  { key: 'showToolbar',  label: 'Show toolbar',    type: 'toggle', def: true,         group: 'Look' },
];

export const GROUPS = [...new Set(SCHEMA.map(s => s.group))];

export function defaults() {
  const o = { emojis: [...DEFAULT_EMOJIS] };
  for (const s of SCHEMA) o[s.key] = s.def;
  return o;
}

// Merge a persisted JSON string (or object) into target, validating types/ranges.
export function applyJSON(target, json) {
  if (!json) return target;
  let saved = json;
  if (typeof json === 'string') { try { saved = JSON.parse(json); } catch { return target; } }
  for (const s of SCHEMA) {
    const v = saved[s.key];
    if (s.type === 'toggle') { if (typeof v === 'boolean') target[s.key] = v; }
    else if (typeof v === 'number' && isFinite(v)) target[s.key] = Math.min(s.max, Math.max(s.min, v));
  }
  if (Array.isArray(saved.emojis)) {
    const e = saved.emojis.filter(x => typeof x === 'string' && x.length).slice(0, 24);
    if (e.length) target.emojis = e;
  }
  return target;
}
