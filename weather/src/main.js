// ── Weather widget ─────────────────────────────────────────────────────────
// A tiny floating card on a transparent window. On launch it figures out where
// you are from your IP, asks Open-Meteo for the current conditions, and shows a
// big weather glyph + temperature + your city. No API keys, all over https.
// Drag anywhere to move it; click the × to quit. Refreshes every 10 minutes.

const { getCurrentWindow } = window.__TAURI__.window;
const appWindow = getCurrentWindow();

const REFRESH_MS = 10 * 60 * 1000;

// WMO weather codes → a glyph + label. `night` swaps a couple of day glyphs.
// https://open-meteo.com/en/docs (see "Weather variable documentation").
function describe(code, isDay) {
  const sun = isDay ? '☀️' : '🌙';
  const partly = isDay ? '⛅' : '☁️';
  const table = {
    0:  [sun, 'Clear'],
    1:  [isDay ? '🌤️' : '🌙', 'Mostly clear'],
    2:  [partly, 'Partly cloudy'],
    3:  ['☁️', 'Overcast'],
    45: ['🌫️', 'Fog'],
    48: ['🌫️', 'Rime fog'],
    51: ['🌦️', 'Light drizzle'],
    53: ['🌦️', 'Drizzle'],
    55: ['🌧️', 'Heavy drizzle'],
    56: ['🌧️', 'Freezing drizzle'],
    57: ['🌧️', 'Freezing drizzle'],
    61: ['🌦️', 'Light rain'],
    63: ['🌧️', 'Rain'],
    65: ['🌧️', 'Heavy rain'],
    66: ['🌧️', 'Freezing rain'],
    67: ['🌧️', 'Freezing rain'],
    71: ['🌨️', 'Light snow'],
    73: ['🌨️', 'Snow'],
    75: ['❄️', 'Heavy snow'],
    77: ['🌨️', 'Snow grains'],
    80: ['🌦️', 'Light showers'],
    81: ['🌧️', 'Showers'],
    82: ['⛈️', 'Violent showers'],
    85: ['🌨️', 'Snow showers'],
    86: ['❄️', 'Snow showers'],
    95: ['⛈️', 'Thunderstorm'],
    96: ['⛈️', 'Thunderstorm + hail'],
    99: ['⛈️', 'Thunderstorm + hail'],
  };
  return table[code] || ['🌡️', '—'];
}

// IP geolocation. ipwho.is first; ipapi.co as a fallback. Both free + https.
async function locate() {
  try {
    const r = await fetch('https://ipwho.is/');
    const j = await r.json();
    if (j && j.success !== false && j.latitude != null) {
      return { lat: j.latitude, lon: j.longitude, city: j.city, country: j.country_code };
    }
  } catch {}
  const r = await fetch('https://ipapi.co/json/');
  const j = await r.json();
  return { lat: j.latitude, lon: j.longitude, city: j.city, country: j.country_code };
}

async function getWeather(lat, lon, fahrenheit) {
  const unit = fahrenheit ? 'fahrenheit' : 'celsius';
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,weather_code,is_day&temperature_unit=${unit}&timezone=auto`;
  const r = await fetch(url);
  const j = await r.json();
  return j.current;
}

// ── DOM ──────────────────────────────────────────────────────────────────────
const card = document.createElement('div');
card.style.cssText =
  'position:fixed;inset:8px;border-radius:18px;-webkit-user-select:none;user-select:none;cursor:grab;' +
  'display:flex;align-items:center;gap:14px;padding:14px 18px;overflow:hidden;' +
  'font:14px/1.3 -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;color:#f4f7ff;' +
  'background:linear-gradient(150deg,rgba(40,54,82,0.82),rgba(22,30,48,0.82));' +
  'box-shadow:0 10px 34px rgba(0,0,0,0.45),inset 0 0 0 1px rgba(255,255,255,0.08);' +
  'backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);';
document.body.appendChild(card);

const glyph = document.createElement('div');
glyph.style.cssText = 'font-size:46px;line-height:1;filter:drop-shadow(0 2px 6px rgba(0,0,0,0.4));';

const info = document.createElement('div');
info.style.cssText = 'display:flex;flex-direction:column;gap:2px;min-width:0;';

const tempEl = document.createElement('div');
tempEl.style.cssText = 'font-size:26px;font-weight:600;letter-spacing:-0.5px;';

const descEl = document.createElement('div');
descEl.style.cssText = 'font-size:13px;opacity:0.9;white-space:nowrap;';

const cityEl = document.createElement('div');
cityEl.style.cssText = 'font-size:11px;opacity:0.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';

info.append(tempEl, descEl, cityEl);
card.append(glyph, info);

// Click-to-close dot (the window is non-focusable, so there's no Escape).
const closeDot = document.createElement('div');
closeDot.textContent = '×';
closeDot.title = 'close';
closeDot.style.cssText =
  'position:fixed;top:10px;right:12px;width:16px;height:16px;border-radius:50%;cursor:pointer;' +
  'display:flex;align-items:center;justify-content:center;font-size:13px;line-height:1;color:#ffd9d9;' +
  'background:rgba(0,0,0,0.35);opacity:0;transition:opacity .15s;z-index:5;';
closeDot.addEventListener('click', () => appWindow.close());
document.body.appendChild(closeDot);
document.body.addEventListener('mouseenter', () => { closeDot.style.opacity = '0.85'; });
document.body.addEventListener('mouseleave', () => { closeDot.style.opacity = '0'; });

// Drag the whole card to move the window.
card.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target === closeDot) return;
  appWindow.startDragging();
});

// ── Render ─────────────────────────────────────────────────────────────────
function showError(msg) {
  glyph.textContent = '⚠️';
  tempEl.textContent = '—';
  descEl.textContent = msg;
  cityEl.textContent = 'will retry…';
}

async function refresh() {
  try {
    const loc = await locate();
    if (loc.lat == null) return showError('No location');
    const fahrenheit = (loc.country || '').toUpperCase() === 'US';
    const cur = await getWeather(loc.lat, loc.lon, fahrenheit);
    const [g, label] = describe(cur.weather_code, cur.is_day === 1);
    glyph.textContent = g;
    tempEl.textContent = `${Math.round(cur.temperature_2m)}°${fahrenheit ? 'F' : 'C'}`;
    descEl.textContent = label;
    cityEl.textContent = loc.city || '';
  } catch (e) {
    showError('Offline?');
  }
}

glyph.textContent = '⏳';
tempEl.textContent = '—';
descEl.textContent = 'Loading…';
refresh();
setInterval(refresh, REFRESH_MS);
