import { guardPermissions } from './permissions.js';

// ── Lens widget ───────────────────────────────────────────────────────────────
// A floating 3D magnifying glass (transparent window — only the glass + its
// annotations draw). It magnifies the screen behind the glass and OCR-reads the
// area around it. The word nearest the glass center gets a curved, bloomy
// highlight *inside the glass* (so you know which one you're on); if nothing is
// close to the center, nothing shows. Around the glass float: the definition
// (left), synonyms as plain bubbles (upper right, above the handle) and the
// word's history as a chain of nodes back to its oldest form (down the middle).
// All local: Vision OCR + the macOS Oxford dictionary/thesaurus.

const TITLE   = 'widget-magnifier';
const LENS_PX = 150;   // on-screen diameter of the glass
const OUT     = 320;   // internal canvas resolution
const CAP     = 120;   // logical px of screen magnified inside the glass
const OCR_REG = 200;   // logical px OCR'd around the glass
const OCR_OUT = 420;   // resolution that region is OCR'd at
const CA_PX   = 7;     // chromatic-aberration shift at the rim, in canvas px
const FOCUS_PX = 46;   // a word must be within this many screen px of center to lock
const WIDTH = 580, HEIGHT = 620;
const LCX = 250, LCY = 190;   // glass center, in window coords
const RIM = LENS_PX / 2;

(async () => {
  try {
    const { getCurrentWindow } = window.__TAURI__.window;
    const { invoke } = window.__TAURI__.core;
    const appWindow = getCurrentWindow();

    const root = document.body;
    root.style.cssText =
      'margin:0;width:100vw;height:100vh;position:relative;overflow:hidden;background:transparent;' +
      'font:11px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;color:#eef;user-select:none;';

    const place = (a, r) => ({ x: LCX + r * Math.cos(a), y: LCY - r * Math.sin(a) });
    const el = (css, z) => { const d = document.createElement('div'); d.style.cssText = css + ';position:absolute;z-index:' + z + ';'; root.appendChild(d); return d; };
    const esc = (s) => (s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

    // SVG layer for connector lines
    const SVGNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%');
    svg.style.cssText = 'position:absolute;inset:0;z-index:1;pointer-events:none;overflow:visible;';
    root.appendChild(svg);
    const line = (x1, y1, x2, y2, stroke, w, cls) => {
      const l = document.createElementNS(SVGNS, 'line');
      l.setAttribute('x1', x1); l.setAttribute('y1', y1); l.setAttribute('x2', x2); l.setAttribute('y2', y2);
      l.setAttribute('stroke', stroke); l.setAttribute('stroke-width', w); l.setAttribute('stroke-linecap', 'round');
      if (cls) l.classList.add(cls);
      svg.appendChild(l); return l;
    };

    // ── The glass (stage holds handle, bezel, canvas, glare) ────────────────────
    const stage = el('left:' + LCX + 'px;top:' + LCY + 'px;transform:translate(-50%,-50%);width:0;height:0;', 5);

    const HANDLE_LEN = 130;
    const handle = document.createElement('div');
    handle.style.cssText =
      'position:absolute;left:' + (RIM * 0.72) + 'px;top:' + (RIM * 0.72) + 'px;width:22px;height:' + HANDLE_LEN + 'px;' +
      'transform-origin:50% 0;transform:rotate(-45deg);border-radius:11px;z-index:-1;' +
      'background:linear-gradient(90deg,#4b3c1d 0%,#8a7038 22%,#e7d49a 47%,#fffaf0 52%,#cdb074 62%,#7a5f2c 82%,#3f3014 100%);' +
      'box-shadow:0 6px 14px rgba(0,0,0,0.5),inset 0 0 4px rgba(0,0,0,0.4);';
    const knob = document.createElement('div');
    knob.style.cssText =
      'position:absolute;left:50%;bottom:-7px;transform:translateX(-50%);width:30px;height:30px;border-radius:50%;' +
      'background:radial-gradient(circle at 36% 32%,#fffaf0,#caa863 55%,#6e521f);box-shadow:0 4px 10px rgba(0,0,0,0.55);';
    handle.appendChild(knob);
    stage.appendChild(handle);

    const bezel = document.createElement('div');
    const BZ = LENS_PX + 16;
    bezel.style.cssText =
      'position:absolute;left:50%;top:50%;width:' + BZ + 'px;height:' + BZ + 'px;transform:translate(-50%,-50%);border-radius:50%;' +
      'background:conic-gradient(from 210deg,#3a2e12,#cdb074,#fff7e6,#a98a45,#5a4720,#e6d29a,#42330f,#cdb074,#3a2e12);' +
      'box-shadow:0 10px 30px rgba(0,0,0,0.55),inset 0 0 10px rgba(0,0,0,0.6);';
    stage.appendChild(bezel);

    const lens = document.createElement('canvas');
    lens.width = OUT; lens.height = OUT;
    lens.style.cssText =
      'position:absolute;left:50%;top:50%;width:' + LENS_PX + 'px;height:' + LENS_PX + 'px;transform:translate(-50%,-50%);' +
      'border-radius:50%;cursor:grab;box-shadow:inset 0 0 22px rgba(0,0,0,0.5),inset 0 0 2px rgba(255,255,255,0.4);';
    stage.appendChild(lens);
    const lensCtx = lens.getContext('2d', { willReadFrequently: true });

    const glare = document.createElement('div');
    glare.style.cssText =
      'position:absolute;left:50%;top:50%;width:' + LENS_PX + 'px;height:' + LENS_PX + 'px;transform:translate(-50%,-50%);' +
      'border-radius:50%;pointer-events:none;mix-blend-mode:screen;' +
      'background:radial-gradient(120% 120% at 32% 26%,rgba(255,255,255,0.32),rgba(255,255,255,0.05) 34%,rgba(255,255,255,0) 48%),' +
      'radial-gradient(150% 150% at 72% 84%,rgba(150,180,255,0.10),rgba(0,0,0,0) 42%);';
    stage.appendChild(glare);

    let dragging = false;
    const grab = (e) => {
      if (e.button !== 0) return;
      dragging = true;
      setTimeout(() => { dragging = false; }, 1200);
      appWindow.startDragging();
    };
    lens.addEventListener('pointerdown', grab);
    handle.addEventListener('pointerdown', grab);

    // Tiny click-to-close dot (the window is non-focusable, so there's no Escape)
    const closeDot = document.createElement('div');
    closeDot.title = 'close';
    closeDot.textContent = '×';
    closeDot.style.cssText =
      'position:absolute;left:50%;top:-' + (RIM + 14) + 'px;transform:translateX(-50%);width:15px;height:15px;border-radius:50%;' +
      'display:flex;align-items:center;justify-content:center;font-size:12px;line-height:1;color:#ffd9d9;cursor:pointer;' +
      'background:rgba(40,20,20,0.7);box-shadow:0 1px 5px rgba(0,0,0,0.5);opacity:0.55;';
    closeDot.addEventListener('mouseenter', () => { closeDot.style.opacity = '1'; });
    closeDot.addEventListener('mouseleave', () => { closeDot.style.opacity = '0.55'; });
    closeDot.addEventListener('click', () => appWindow.close());
    stage.appendChild(closeDot);

    // ── Chromatic-aberration render of the captured square into the round glass ──
    const out = lensCtx.createImageData(OUT, OUT);
    const C = OUT / 2, RR = OUT / 2;
    // Precompute the lens mapping once — geometry is constant, only the captured
    // pixels change each frame. Per frame we then do 3 lookups + 3 mults per pixel
    // (no sqrt/pow), which is what makes the magnify smooth.
    const N = OUT * OUT;
    const rIdx = new Int32Array(N), gIdx = new Int32Array(N), bIdx = new Int32Array(N);
    const vig = new Float32Array(N);
    const inside = new Uint8Array(N);
    (function buildLensTables() {
      const clamp = (v) => v < 0 ? 0 : v > OUT - 1 ? OUT - 1 : v | 0;
      for (let y = 0; y < OUT; y++) {
        for (let x = 0; x < OUT; x++) {
          const di = y * OUT + x;
          const nx = (x - C) / RR, ny = (y - C) / RR;
          const r = Math.sqrt(nx * nx + ny * ny);
          if (r > 1) { inside[di] = 0; continue; }
          inside[di] = 1;
          const pull = 1 - 0.12 * (1 - r * r);
          const bx = C + (x - C) * pull, by = C + (y - C) * pull;
          const shift = CA_PX * r * r;
          rIdx[di] = (clamp(by + ny * shift) * OUT + clamp(bx + nx * shift)) * 4;
          gIdx[di] = (clamp(by) * OUT + clamp(bx)) * 4 + 1;
          bIdx[di] = (clamp(by - ny * shift) * OUT + clamp(bx - nx * shift)) * 4 + 2;
          vig[di] = 1 - 0.5 * Math.pow(r, 3.5);
        }
      }
    })();
    function renderGlass(src) {
      const o = out.data;
      for (let di = 0, p = 0; di < N; di++, p += 4) {
        if (!inside[di]) { o[p + 3] = 0; continue; }
        const v = vig[di];
        o[p]     = src[rIdx[di]] * v;
        o[p + 1] = src[gIdx[di]] * v;
        o[p + 2] = src[bIdx[di]] * v;
        o[p + 3] = 255;
      }
      lensCtx.putImageData(out, 0, 0);
    }

    // Curved, bloomy highlight on the focused word (box in glass-canvas px)
    function drawHighlight(b) {
      if (!b) return;
      const rx = Math.min(b.w * 0.6 + 11, RR), ry = Math.min(b.h * 0.95 + 9, RR);
      lensCtx.save();
      lensCtx.beginPath(); lensCtx.arc(C, C, RR - 1, 0, Math.PI * 2); lensCtx.clip();
      lensCtx.globalCompositeOperation = 'lighter';
      const g = lensCtx.createRadialGradient(b.cx, b.cy, 0, b.cx, b.cy, Math.max(rx, ry));
      g.addColorStop(0,    'rgba(255,249,228,0.72)');
      g.addColorStop(0.45, 'rgba(255,226,172,0.30)');
      g.addColorStop(1,    'rgba(255,210,150,0)');
      lensCtx.fillStyle = g;
      lensCtx.beginPath(); lensCtx.ellipse(b.cx, b.cy, rx, ry, 0, 0, Math.PI * 2); lensCtx.fill();
      lensCtx.strokeStyle = 'rgba(255,150,110,0.85)';
      lensCtx.lineWidth = 2.2;
      lensCtx.shadowColor = 'rgba(255,110,80,0.9)';
      lensCtx.shadowBlur = 12;
      lensCtx.beginPath(); lensCtx.ellipse(b.cx, b.cy, rx + 1, ry + 1, 0, 0, Math.PI * 2); lensCtx.stroke();
      lensCtx.restore();
    }

    // ── Floating annotations (plain backgrounds — no backdrop blur) ─────────────
    const card = el(
      'left:6px;top:' + LCY + 'px;transform:translateY(-50%);width:' + (LCX - RIM - 14) + 'px;max-height:' + (HEIGHT - 20) + 'px;' +
      'overflow:auto;text-align:right;padding:9px 11px;border-radius:12px;background:rgba(12,14,30,0.82);' +
      'box-shadow:0 6px 18px rgba(0,0,0,0.45);display:none;', 6);
    const cardTitle = document.createElement('div');
    cardTitle.style.cssText = 'font-size:8px;letter-spacing:1.5px;text-transform:uppercase;opacity:0.4;margin-bottom:4px;';
    cardTitle.textContent = 'definition';
    const cardWord = document.createElement('div');
    cardWord.style.cssText = 'font-size:14px;font-weight:700;color:#fff;margin-bottom:3px;';
    const cardBody = document.createElement('div');
    cardBody.style.cssText = 'font-size:10.5px;color:#d4d8f0;line-height:1.4;';
    card.append(cardTitle, cardWord, cardBody);

    const synBubbles = [];
    const histNodes = [];
    const clearPool = (pool) => { pool.forEach(n => n.remove()); pool.length = 0; };
    const clearLines = (cls) => [...svg.querySelectorAll('.' + cls)].forEach(l => l.remove());

    function renderSynonyms(syns) {
      clearPool(synBubbles); clearLines('syn-line');
      const list = (syns || []).slice(0, 8);
      const A0 = 6 * Math.PI / 180, A1 = 132 * Math.PI / 180;
      list.forEach((s, i) => {
        const t = list.length === 1 ? 0.5 : i / (list.length - 1);
        const ang = A0 + (A1 - A0) * t;
        const rad = 116 + (i % 2) * 34;
        const p = place(ang, rad), rimP = place(ang, RIM + 2);
        line(rimP.x, rimP.y, p.x, p.y, 'rgba(150,170,255,0.45)', 1.2, 'syn-line');
        const b = el(
          'left:' + p.x + 'px;top:' + p.y + 'px;transform:translate(-50%,-50%);padding:3px 9px;border-radius:11px;' +
          'background:rgba(30,33,58,0.92);white-space:nowrap;color:#cdd6ff;font-size:10px;box-shadow:0 2px 7px rgba(0,0,0,0.4);', 6);
        b.textContent = s;
        synBubbles.push(b);
      });
    }

    function renderHistory(nodes) {
      clearPool(histNodes); clearLines('hist-line');
      const list = (nodes || []).slice(0, 8);
      if (!list.length) return;
      const x = LCX, y0 = LCY + RIM + 26;
      const avail = (HEIGHT - 20) - y0;
      const step = Math.min(46, Math.max(32, avail / list.length));
      line(x, LCY + RIM + 2, x, y0 + (list.length - 1) * step, 'rgba(150,170,255,0.4)', 1.4, 'hist-line');
      list.forEach((nd, i) => {
        const y = y0 + i * step;
        const dot = el('left:' + x + 'px;top:' + y + 'px;transform:translate(-50%,-50%);width:9px;height:9px;border-radius:50%;' +
           'background:radial-gradient(circle at 35% 35%,#cdd6ff,#5566cc);box-shadow:0 0 7px rgba(120,150,255,0.6);', 6);
        histNodes.push(dot);
        const lbl = el(
          'left:' + (x + 12) + 'px;top:' + y + 'px;transform:translateY(-50%);max-width:300px;white-space:nowrap;overflow:hidden;' +
          'text-overflow:ellipsis;text-shadow:0 1px 3px rgba(0,0,0,0.85);', 6);
        lbl.innerHTML =
          '<span style="font-size:8px;letter-spacing:.5px;text-transform:uppercase;color:#8fa0e0">' + esc(nd.label) + '</span>' +
          (nd.detail ? ' <span style="font-size:10.5px;color:#e6e9ff">' + esc(nd.detail) + '</span>' : '');
        histNodes.push(lbl);
      });
    }

    // ── Etymology → granular node chain (recent → oldest) ───────────────────────
    const LANGS = [
      'Proto-Indo-European', 'Proto-Germanic', 'Proto-Slavic', 'Late Latin', 'Medieval Latin', 'modern Latin',
      'ecclesiastical Latin', 'Anglo-Norman French', 'late Middle English', 'Middle English', 'Old English',
      'Old French', 'Old Norse', 'Middle Dutch', 'Middle Low German', 'Old High German', 'Old Saxon',
      'ancient Greek', 'Latin', 'Greek', 'Sanskrit', 'Arabic', 'Hebrew', 'Persian', 'Italian', 'Spanish',
      'Portuguese', 'German', 'Dutch', 'French', 'Germanic', 'Celtic', 'Frankish', 'Norwegian', 'Swedish'
    ];
    function parseEtymology(etym) {
      if (!etym) return [];
      const markers = [];
      const reEra = /\b(?:early |late |mid[ -])?\d{1,2}(?:st|nd|rd|th) century\b/gi;
      let m;
      while ((m = reEra.exec(etym))) markers.push({ i: m.index, len: m[0].length, label: m[0] });
      for (const lang of LANGS) {
        const re = new RegExp('\\b' + lang.replace(/[-]/g, '[- ]') + '\\b', 'gi');
        while ((m = re.exec(etym))) markers.push({ i: m.index, len: m[0].length, label: m[0] });
      }
      markers.sort((a, b) => a.i - b.i);
      const kept = [];
      for (const mk of markers) {
        if (kept.length && mk.i < kept[kept.length - 1].i + kept[kept.length - 1].len) continue;
        kept.push(mk);
      }
      if (!kept.length) return [{ label: 'origin', detail: etym.replace(/\s+/g, ' ').trim() }];
      const nodes = [];
      for (let k = 0; k < kept.length; k++) {
        const start = kept[k].i + kept[k].len;
        const end = k + 1 < kept.length ? kept[k + 1].i : etym.length;
        let detail = etym.slice(start, end)
          .replace(/^[\s,:;.()]+/, '')
          .replace(/^(?:from|via|based on|related to|reinforced by|influenced by|of|and|a|an|the)\s+/i, '')
          .replace(/[\s,;:]+$/, '').replace(/\s+/g, ' ').trim();
        if (detail.length > 64) detail = detail.slice(0, 61) + '…';
        nodes.push({ label: kept[k].label, detail });
      }
      return nodes;
    }

    // Strip example usages: in the Oxford format each gloss is followed by
    // ": <example> | <example>" running up to the next sub-sense (•) / sense digit.
    function cleanDefinition(s) {
      if (!s) return '';
      return s
        .replace(/:\s[^•]*?(?=\s•|\s[1-9]\s|$)/g, '')
        .replace(/\s+([.;,])/g, '$1')
        .replace(/\s{2,}/g, ' ')
        .replace(/\s*•\s*/g, '  •  ')
        .trim();
    }

    function showLookup(d) {
      card.style.display = 'block';
      cardWord.textContent = d.word || '';
      const def = cleanDefinition(d.definition);
      cardBody.textContent = def || 'no definition';
      cardBody.style.color = def ? '#d4d8f0' : '#8890b0';
      renderSynonyms(d.synonyms);
      renderHistory(parseEtymology(d.etymology));
    }
    function clearLookup() {
      card.style.display = 'none';
      clearPool(synBubbles); clearPool(histNodes);
      clearLines('syn-line'); clearLines('hist-line');
    }

    // ── Two decoupled loops: a fast magnify loop, a separate OCR/lookup loop ─────
    // Magnification must never wait on OCR (the slow part), so they run apart.
    let mBusy = false, oBusy = false, lastKey = '', moveSeq = 0, lastOcrSeq = -1;
    let lastOcr = 0, lastLookup = '', focusBox = null, curCx = LCX, curCy = LCY;

    async function magnifyLoop() {
      if (mBusy) { setTimeout(magnifyLoop, 8); return; }
      mBusy = true;
      try {
        const pos = await appWindow.outerPosition();
        const sf = window.devicePixelRatio;
        curCx = pos.x / sf + LCX; curCy = pos.y / sf + LCY;
        const key = (curCx | 0) + ',' + (curCy | 0);
        if (key !== lastKey) { lastKey = key; moveSeq++; }
        const buf = await invoke('capture_region_raw', { cx: curCx, cy: curCy, region: CAP, outSize: OUT });
        const src = new Uint8ClampedArray(buf);
        if (src.length === N * 4) { renderGlass(src); drawHighlight(focusBox); }
      } catch (e) { /* transient */ }
      mBusy = false;
      setTimeout(magnifyLoop, 12);
    }

    async function ocrLoop() {
      if (oBusy) { setTimeout(ocrLoop, 40); return; }
      oBusy = true;
      try {
        if (moveSeq !== lastOcrSeq || performance.now() - lastOcr > 700) {
          lastOcrSeq = moveSeq; lastOcr = performance.now();
          const json = await invoke('ocr_words', { title: TITLE, cx: curCx, cy: curCy, region: OCR_REG, outPx: OCR_OUT });
          let words = []; try { words = JSON.parse(json); } catch {}
          let best = null, bestPx = Infinity;
          for (const wd of words) {
            const dpx = Math.hypot(wd.x + wd.w / 2 - 0.5, wd.y + wd.h / 2 - 0.5) * OCR_REG;
            if (dpx < bestPx) { bestPx = dpx; best = wd; }
          }
          if (best && bestPx <= FOCUS_PX) {
            // OCR region → glass-canvas px (concentric, different field of view)
            const k = OCR_REG / CAP * OUT;
            const cxg = (0.5 + (best.x + best.w / 2 - 0.5) * OCR_REG / CAP) * OUT;
            const cyg = (0.5 + (best.y + best.h / 2 - 0.5) * OCR_REG / CAP) * OUT;
            focusBox = { cx: cxg, cy: cyg, w: best.w * k, h: best.h * k };
            const w = best.t.replace(/[^A-Za-z'-]/g, '').toLowerCase();
            if (w.length > 1 && w !== lastLookup) {
              lastLookup = w;
              const dj = await invoke('define_word', { word: w });
              let dd = {}; try { dd = JSON.parse(dj); } catch {}
              if (dd && dd.word) showLookup(dd); else clearLookup();
            }
          } else if (focusBox || lastLookup) {
            focusBox = null; lastLookup = ''; clearLookup();
          }
        }
      } catch (e) { /* transient */ }
      oBusy = false;
      setTimeout(ocrLoop, 50);
    }
    magnifyLoop();
    ocrLoop();

    // ── Click-through everywhere except the magnifying glass ────────────────────
    // The window is set to ignore cursor events by default (clicks pass to the
    // desktop). We poll the global cursor and only "solidify" the window while the
    // cursor is over the glass, the handle, or the close dot.
    const distToSeg = (px, py, ax, ay, bx, by) => {
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1;
      let t = ((px - ax) * dx + (py - ay) * dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    };
    let ignored = null;
    const U = Math.SQRT1_2;  // handle direction (down-right, 45°)
    async function cursorLoop() {
      try {
        const m = await invoke('mouse_position');
        const mx = m[0], my = m[1];
        let over =
          Math.hypot(mx - curCx, my - curCy) <= RIM + 4 ||                                  // glass
          Math.hypot(mx - curCx, my - (curCy - RIM - 6)) <= 11;                             // close dot
        if (!over) {
          const sx = curCx + U * (RIM * 0.72), sy = curCy + U * (RIM * 0.72);
          over = distToSeg(mx, my, sx, sy, sx + U * HANDLE_LEN, sy + U * HANDLE_LEN) <= 15; // handle
        }
        // while the permission popup is up, keep the window clickable
        const want = window.__permOverlayActive ? false : !(over || dragging);
        if (want !== ignored) { ignored = want; await appWindow.setIgnoreCursorEvents(want); }
      } catch (e) { /* transient */ }
      setTimeout(cursorLoop, 60);
    }
    await appWindow.setIgnoreCursorEvents(true);
    ignored = true;
    cursorLoop();

    // Pop a permission window only if Screen Recording (needed to magnify/read the
    // screen) isn't granted; otherwise nothing shows.
    guardPermissions(['screen_capture'], {
      note: 'The lens needs Screen Recording to magnify and read the screen behind the glass.',
      descriptions: { screen_capture: 'Used to capture and magnify the screen under the lens, and to OCR the words around it.' },
    });
  } catch (e) { console.warn('lens widget:', e); }
})();
