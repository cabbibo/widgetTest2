// ── Emoji-tassels widget ──────────────────────────────────────────────────────
// Fullscreen transparent, always click-through. Around every other on-screen
// window hangs a fringe of little emoji pendants: a single emoji on a short thin
// line back to its anchor on the window edge. Each dangles under gravity (with a
// slightly random weight), swings when the window is dragged, and scatters from
// the cursor. Anchors hidden behind a window in front are discarded.
// GPU-rendered with Three.js instancing at 60fps.

import * as THREE from 'three';
import { defaults, applyJSON } from './settings.js';
import { guardPermissions } from './permissions.js';

(async () => {
  try {
    const { getCurrentWindow, currentMonitor } = window.__TAURI__.window;
    const { LogicalPosition, LogicalSize }      = window.__TAURI__.dpi;
    const { invoke } = window.__TAURI__.core;
    const appWindow = getCurrentWindow();

    // Live, persisted settings. Loaded from disk now; the tray popover pushes
    // updates via the 'apply-settings' event, and the physics reads S each frame.
    const S = defaults();
    try { applyJSON(S, await invoke('load_settings', { name: 'emoji' })); } catch (_) {}
    window.__TAURI__.event.listen('apply-settings', (e) => {
      if (e.payload) applyJSON(S, JSON.stringify(e.payload));
    });

    const monitor = await currentMonitor();
    if (monitor) {
      const sw = monitor.size.width  / monitor.scaleFactor;
      const sh = monitor.size.height / monitor.scaleFactor;
      await appWindow.setPosition(new LogicalPosition(0, 0));
      await appWindow.setSize(new LogicalSize(sw, sh));
    }
    await appWindow.setIgnoreCursorEvents(true);

    // Pop a permission window only if Screen Recording (needed to detect the
    // on-screen windows the emoji hang from) isn't granted; otherwise nothing shows.
    guardPermissions(['screen_capture'], {
      note: 'The emoji tassels need Screen Recording to find the windows they hang from.',
      descriptions: { screen_capture: 'Used to read the position and titles of other on-screen windows.' },
    });

    // ── Renderer + screen-pixel orthographic camera (y-up world) ─────────────
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.style.cssText = 'position:fixed;inset:0';
    document.body.appendChild(renderer.domElement);
    renderer.domElement.addEventListener('webglcontextlost', (e) => e.preventDefault());

    let scrW = window.innerWidth, scrH = window.innerHeight;
    const scene  = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(0, scrW, scrH, 0, -10, 10);
    camera.updateProjectionMatrix();
    window.addEventListener('resize', () => {
      scrW = window.innerWidth; scrH = window.innerHeight;
      renderer.setSize(scrW, scrH);
      camera.right = scrW; camera.top = scrH;
      camera.updateProjectionMatrix();
    });

    // ── Emoji sprites (one instanced mesh each) + average colors ─────────────
    // The active emoji set lives in settings and can change live, so the meshes
    // are (re)built from S.emojis whenever it changes.
    const MAX_PER = 4000; // instance cap per emoji
    let EMOJIS = [];
    let meshes = [];
    let avgColors = [];
    function rebuildEmojis(list) {
      for (const m of meshes) { scene.remove(m); m.geometry.dispose(); m.material.map?.dispose(); m.material.dispose(); }
      meshes = []; avgColors = [];
      EMOJIS = list.slice();
      for (const em of EMOJIS) {
        const c = document.createElement('canvas'); c.width = c.height = 64;
        const cx = c.getContext('2d');
        cx.font = '52px serif'; cx.textAlign = 'center'; cx.textBaseline = 'middle';
        cx.fillText(em, 32, 34);
        const id = cx.getImageData(0, 0, 64, 64).data;
        let r = 0, g = 0, b = 0, a = 0;
        for (let i = 0; i < id.length; i += 4) {
          const al = id[i + 3];
          if (al > 12) { r += id[i] * al; g += id[i + 1] * al; b += id[i + 2] * al; a += al; }
        }
        avgColors.push(a > 0 ? [r / a / 255, g / a / 255, b / a / 255] : [1, 1, 1]);
        const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
        const mat  = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
        const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, MAX_PER);
        mesh.count = 0; mesh.frustumCulled = false;
        scene.add(mesh);
        meshes.push(mesh);
      }
    }
    rebuildEmojis(S.emojis.length ? S.emojis : ['🌙']);
    let emojiSig = EMOJIS.join('');

    // ── Lines (anchor → emoji), vertex-coloured by emoji average colour ──────
    const MAX_STRANDS = 12000;
    const linePos = new Float32Array(MAX_STRANDS * 2 * 3);
    const lineCol = new Float32Array(MAX_STRANDS * 2 * 3);
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3).setUsage(THREE.DynamicDrawUsage));
    lineGeo.setAttribute('color',    new THREE.BufferAttribute(lineCol, 3).setUsage(THREE.DynamicDrawUsage));
    const lineMat  = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, depthTest: false });
    const lineSegs = new THREE.LineSegments(lineGeo, lineMat);
    lineSegs.frustumCulled = false;
    scene.add(lineSegs);

    // ── Anchor dots (top of each tassel, tinted like its line) ───────────────
    const dotPos = new Float32Array(MAX_STRANDS * 3);
    const dotCol = new Float32Array(MAX_STRANDS * 3);
    const dotCanvas = document.createElement('canvas'); dotCanvas.width = dotCanvas.height = 16;
    const dctx = dotCanvas.getContext('2d');
    const grd = dctx.createRadialGradient(8, 8, 0, 8, 8, 8);
    grd.addColorStop(0, '#fff'); grd.addColorStop(0.55, '#fff'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    dctx.fillStyle = grd; dctx.fillRect(0, 0, 16, 16);
    const dotTex = new THREE.CanvasTexture(dotCanvas);
    const dotGeo = new THREE.BufferGeometry();
    dotGeo.setAttribute('position', new THREE.BufferAttribute(dotPos, 3).setUsage(THREE.DynamicDrawUsage));
    dotGeo.setAttribute('color',    new THREE.BufferAttribute(dotCol, 3).setUsage(THREE.DynamicDrawUsage));
    const dotMat  = new THREE.PointsMaterial({ size: 5, map: dotTex, vertexColors: true, transparent: true, depthTest: false, sizeAttenuation: false });
    const dots = new THREE.Points(dotGeo, dotMat);
    dots.frustumCulled = false;
    scene.add(dots);

    // ── Wind-chime synth (procedural; small glassy chimes through a long reverb) ──
    let actx = null, revSend = null, dryGain = null, wetGain = null, reverbNode = null, lastRevLen = 0;
    // High, glassy pentatonic → "small" chimes
    const SCALE    = [1046.50, 1174.66, 1396.91, 1567.98, 1760.00, 2093.00, 2349.32, 2793.83];
    const PARTIALS = [1, 2.76, 5.40, 8.93];   // free-free bar mode ratios
    const PGAIN    = [1, 0.38, 0.16, 0.07];   // softer upper partials = sweeter

    function makeIR(ac, seconds, decay) {
      const len = (ac.sampleRate * seconds) | 0;
      const buf = ac.createBuffer(2, len, ac.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
      return buf;
    }
    function ensureAudio() {
      if (actx) { if (actx.state === 'suspended') actx.resume(); return actx; }
      const ac = actx = new (window.AudioContext || window.webkitAudioContext)();
      reverbNode = ac.createConvolver(); reverbNode.buffer = makeIR(ac, S.reverbLength, 2.2);
      lastRevLen = S.reverbLength;
      wetGain   = ac.createGain(); wetGain.gain.value = S.reverb;
      dryGain   = ac.createGain(); dryGain.gain.value = 0.4;
      revSend   = ac.createBiquadFilter(); revSend.type = 'lowpass'; revSend.frequency.value = 6500;
      revSend.connect(reverbNode); reverbNode.connect(wetGain); wetGain.connect(ac.destination);
      dryGain.connect(ac.destination);
      return ac;
    }
    function playChime(pan, strength) {
      try {
        if (!S.soundEnabled || S.chimeVolume <= 0) return;
        const ac = ensureAudio(), t0 = ac.currentTime;
        if (S.reverbLength !== lastRevLen) { reverbNode.buffer = makeIR(ac, S.reverbLength, 2.2); lastRevLen = S.reverbLength; }
        wetGain.gain.value = S.reverb;
        const semis = Math.pow(2, S.pitch / 12);
        const base = SCALE[(Math.random() * SCALE.length) | 0] * semis;
        const vol  = S.chimeVolume * Math.min(0.45, 0.04 + strength * 0.04);
        const voice = ac.createGain(); voice.gain.value = 1;
        if (ac.createStereoPanner) {
          const pn = ac.createStereoPanner(); pn.pan.value = Math.max(-1, Math.min(1, pan));
          voice.connect(pn); pn.connect(dryGain); pn.connect(revSend);
        } else { voice.connect(dryGain); voice.connect(revSend); }
        for (let p = 0; p < PARTIALS.length; p++) {
          const osc = ac.createOscillator(); osc.type = 'sine';
          osc.frequency.value = base * PARTIALS[p] * (0.999 + Math.random() * 0.002);
          const g = ac.createGain(); const dur = 2.8 - p * 0.45;
          g.gain.setValueAtTime(0, t0);
          g.gain.linearRampToValueAtTime(vol * PGAIN[p], t0 + 0.006);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
          osc.connect(g); g.connect(voice);
          osc.start(t0); osc.stop(t0 + dur);
        }
      } catch (_) {}
    }

    // Wind: the air is calm almost all the time, with the occasional small gust
    // that drifts across the screen, disturbing only the cluster it passes over.
    const gusts = [];
    let nextGust = 1500;   // ms until first gust
    function spawnGust(now) {
      const fromLeft = Math.random() < 0.5;
      gusts.push({
        x: fromLeft ? -140 : scrW + 140,
        y: Math.random() * scrH,
        vx: (fromLeft ? 1 : -1) * S.gustSpeed * (0.7 + Math.random() * 0.6),
        vy: (Math.random() - 0.5) * 1.0,
        r:  S.gustSize     * (0.7 + Math.random() * 0.6),  // small chunk of moving air
        strength: S.gustStrength * (0.7 + Math.random() * 0.6),
      });
      nextGust = now + S.gustGap * 1000 * (0.6 + Math.random() * 0.8); // calm gap
    }

    const strands = new Map(); // key → { ax, ay, emoji, weight, occ, x, y, px, py }

    // ── Sampled world state (polled off the render loop) ─────────────────────
    // winOff = this widget window's own screen position. list_windows + the cursor
    // are in global screen coords; subtracting winOff at render keeps the tassels
    // aligned even if the widget window isn't exactly at (0,0).
    let windows = [], mouseX = -1e4, mouseY = -1e4, winOffX = 0, winOffY = 0;
    async function poll() {
      try {
        const wins = await invoke('list_windows');
        windows = wins.filter(w => !(w.name || '').startsWith('widget-'));
        const [mx, my] = await invoke('mouse_position');
        mouseX = mx; mouseY = my;
        const op = await appWindow.outerPosition();
        const sf = window.devicePixelRatio;
        winOffX = op.x / sf; winOffY = op.y / sf;
      } catch (_) {}
      setTimeout(poll, 33);
    }
    poll();

    const _m = new THREE.Matrix4();
    const _q = new THREE.Quaternion();
    const _pos = new THREE.Vector3();
    const _scl = new THREE.Vector3(1, 1, 1);

    // deterministic per-strand random in [0,1)
    const hash = (n) => { n = (n ^ 61) ^ (n >>> 16); n = (n + (n << 3)) | 0; n ^= n >>> 4; n = Math.imul(n, 0x27d4eb2d); n ^= n >>> 15; return ((n >>> 0) % 100000) / 100000; };

    function animate() {
      requestAnimationFrame(animate);

      // 0. Rebuild emoji meshes if the active set changed (toolbar / preferences).
      //    Also reset strands so the new emoji is distributed across the tassels.
      if (S.emojis.length && S.emojis.join('') !== emojiSig) {
        rebuildEmojis(S.emojis);
        emojiSig = EMOJIS.join('');
        strands.clear();
      }
      if (!meshes.length) { renderer.render(scene, camera); return; }

      // 1. Refresh anchors; mark occlusion against windows in front (earlier in list)
      const seen = new Set();
      for (let wi = 0; wi < windows.length; wi++) {
        const win = windows[wi];
        const { x, y, w, h } = win;
        if (w < 20 || h < 20) continue;
        const fronts = windows.slice(0, wi);
        const perim = 2 * (w + h);
        const n = Math.min(220, Math.max(4, Math.round(perim / S.spacing)));
        const wkey = `${win.app}|${win.name}|${Math.round(w)}x${Math.round(h)}`;
        for (let j = 0; j < n; j++) {
          const t = (j / n) * perim;
          let ax, ay;
          if      (t < w)          { ax = x + t;               ay = y; }
          else if (t < w + h)      { ax = x + w;               ay = y + (t - w); }
          else if (t < 2 * w + h)  { ax = x + w - (t - w - h); ay = y + h; }
          else                     { ax = x;                   ay = y + h - (t - 2 * w - h); }
          const occ = fronts.some(f => ax >= f.x && ax <= f.x + f.w && ay >= f.y && ay <= f.y + f.h);
          const key = wkey + ':' + j;
          seen.add(key);
          let s = strands.get(key);
          if (!s) {
            const seed = (Math.round(ax) * 73856093) ^ (Math.round(ay) * 19349663) ^ j;
            s = {
              emoji: (wi * 3 + j) % EMOJIS.length,
              weight: 0.55 + hash(seed) * 0.95,   // slightly random per-strand weight
              x: ax, y: ay + S.length, px: ax, py: ay + S.length, lastChime: 0,
            };
            strands.set(key, s);
          }
          s.ax = ax; s.ay = ay; s.occ = occ;
        }
      }
      for (const key of strands.keys()) if (!seen.has(key)) strands.delete(key);

      // 2. Verlet (single node, screen space y-down) + distance constraint to anchor
      const now = performance.now();
      const tw = now * 0.001;
      // spawn + advance gusts
      if (now > nextGust) spawnGust(now);
      for (let i = gusts.length - 1; i >= 0; i--) {
        const g = gusts[i];
        g.x += g.vx; g.y += g.vy;
        if (g.x < -300 || g.x > scrW + 300) gusts.splice(i, 1);
      }
      for (const s of strands.values()) {
        const vx = (s.x - s.px) * S.damping, vy = (s.y - s.py) * S.damping;
        s.px = s.x; s.py = s.y;
        s.x += vx; s.y += vy + S.gravity * s.weight;
        // wind = tiny ambient flutter + any gust currently passing over this strand
        let wx = S.ambient * Math.sin(tw * 0.7 + s.ax * 0.01), wy = 0;
        for (const g of gusts) {
          const dx = s.x - g.x, dy = s.y - g.y, r2 = g.r * g.r;
          const d2 = dx * dx + dy * dy;
          if (d2 < r2 * 4) {
            const fall = Math.exp(-d2 / r2) * g.strength;
            const len = Math.hypot(g.vx, g.vy) || 1;
            wx += g.vx / len * fall;
            wy += g.vy / len * fall * 0.5;
          }
        }
        s.x += wx / s.weight; s.y += wy / s.weight;   // lighter strands catch more
        const dxm = s.x - mouseX, dym = s.y - mouseY;
        const d2 = dxm * dxm + dym * dym;
        if (d2 < S.mouseRadius * S.mouseRadius && d2 > 0.01) {
          const d = Math.sqrt(d2), f = (1 - d / S.mouseRadius) * S.mouseForce;
          s.x += dxm / d * f; s.y += dym / d * f;
        }
        // keep the emoji exactly its length from the anchor
        for (let it = 0; it < 2; it++) {
          const dx = s.x - s.ax, dy = s.y - s.ay;
          const d = Math.hypot(dx, dy) || 0.0001;
          const diff = (d - S.length) / d;
          s.x -= dx * diff; s.y -= dy * diff;
        }
      }

      // 2b. Collisions → wind-chime — spatial grid over visible emoji nodes (CPU)
      const CR = 12, CR2 = CR * CR, COOL = 240, MINV = S.sensitivity, CELL = CR;
      let budget = 3;                      // cap new chimes per frame
      const grid = new Map();
      for (const s of strands.values()) {
        if (s.occ) continue;
        const cxk = Math.floor(s.x / CELL), cyk = Math.floor(s.y / CELL);
        for (let gy = -1; gy <= 1; gy++) for (let gx = -1; gx <= 1; gx++) {
          const arr = grid.get((cxk + gx) + ',' + (cyk + gy));
          if (!arr) continue;
          for (const o of arr) {
            const dx = s.x - o.x, dy = s.y - o.y;
            if (dx * dx + dy * dy >= CR2) continue;
            if (budget <= 0 || now - s.lastChime < COOL || now - o.lastChime < COOL) continue;
            const rvx = (s.x - s.px) - (o.x - o.px), rvy = (s.y - s.py) - (o.y - o.py);
            const rs = Math.hypot(rvx, rvy);      // relative approach speed
            if (rs > MINV) {
              playChime((s.x / scrW) * 2 - 1, rs);
              s.lastChime = now; o.lastChime = now; budget--;
            }
          }
        }
        const key = cxk + ',' + cyk;
        let arr = grid.get(key); if (!arr) { arr = []; grid.set(key, arr); }
        arr.push(s);
      }

      // 3. Render — emojis (instanced) + lines + anchor dots, skipping occluded strands
      _scl.set(S.emojiSize, S.emojiSize, 1);   // live emoji size (unit-plane geometry)
      dotMat.size = S.dotSize;
      lineMat.opacity = S.lineOpacity;
      const counts = new Array(meshes.length).fill(0);
      let li = 0;
      for (const s of strands.values()) {
        if (s.occ) continue;
        const em = s.emoji % meshes.length;
        // global → widget-window-local, then flip to y-up world
        const wx = s.x - winOffX,  wy = scrH - (s.y - winOffY);
        const ax = s.ax - winOffX, ay = scrH - (s.ay - winOffY);
        const col = avgColors[em];
        // emoji sprite
        if (counts[em] < MAX_PER) {
          _pos.set(wx, wy, 0);
          _m.compose(_pos, _q, _scl);
          meshes[em].setMatrixAt(counts[em]++, _m);
        }
        if (li < MAX_STRANDS) {
          // line anchor → emoji
          const o = li * 6;
          linePos[o]   = ax; linePos[o+1] = ay; linePos[o+2] = 0;
          linePos[o+3] = wx; linePos[o+4] = wy; linePos[o+5] = 0;
          lineCol[o]   = col[0]; lineCol[o+1] = col[1]; lineCol[o+2] = col[2];
          lineCol[o+3] = col[0]; lineCol[o+4] = col[1]; lineCol[o+5] = col[2];
          // anchor dot
          const d3 = li * 3;
          dotPos[d3] = ax; dotPos[d3+1] = ay; dotPos[d3+2] = 0;
          dotCol[d3] = col[0]; dotCol[d3+1] = col[1]; dotCol[d3+2] = col[2];
          li++;
        }
      }
      for (let e = 0; e < meshes.length; e++) {
        meshes[e].count = counts[e];
        meshes[e].instanceMatrix.needsUpdate = true;
      }
      lineGeo.setDrawRange(0, li * 2);
      lineGeo.attributes.position.needsUpdate = true;
      lineGeo.attributes.color.needsUpdate = true;
      dotGeo.setDrawRange(0, li);
      dotGeo.attributes.position.needsUpdate = true;
      dotGeo.attributes.color.needsUpdate = true;

      renderer.render(scene, camera);
    }
    animate();

    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') appWindow.close(); });
  } catch (e) { console.warn('emoji-tassels widget:', e); }
})();
