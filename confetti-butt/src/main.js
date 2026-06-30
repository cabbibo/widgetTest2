import * as THREE from 'three';
import { guardPermissions } from './permissions.js';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
camera.position.z = 3;
camera.aspect = window.innerWidth / window.innerHeight;
camera.updateProjectionMatrix();

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, premultipliedAlpha: false });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.3;
document.body.appendChild(renderer.domElement);

// macOS occlusion (tab-out/in) can drop the WebGL context; without these handlers
// three.js never recovers and the transparent canvas comes back opaque-black.
renderer.domElement.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();           // required so the browser will fire 'restored'
  console.warn('WebGL context lost — will restore');
}, false);
renderer.domElement.addEventListener('webglcontextrestored', () => {
  console.warn('WebGL context restored');
  renderer.setClearColor(0x000000, 0);
  // three.js reinitialises its GL state automatically on the next render()
}, false);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ── Crystal shader (ported from FantasyCrystals/TrippyCrystal1.shader) ─────────
// Normal flip in vertex shader fixes back-facing objects with inverted normals.
const crystalVert = `
  uniform vec3  uLocalCameraPos;
  uniform float uIOR;
  varying vec3 vNor;
  varying vec3 vRo;
  varying vec3 vRd;
  varying vec3 vUnrefracted;
  varying vec4 vClipPos;
  void main() {
    vec3 n   = normalize(normal);
    vec3 eye = normalize(uLocalCameraPos - position);
    if (dot(eye, n) < 0.0) n = -n;
    vNor         = n;
    vRo          = position;
    vUnrefracted = eye;
    vec3 rd = refract(eye, -n, uIOR);
    vRd = (dot(rd, rd) < 0.0001) ? -n : rd;
    vec4 mvp = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vClipPos    = mvp;
    gl_Position = mvp;
  }
`;

const crystalFrag = `
  precision highp float;
  uniform float uTime;
  uniform float uDeltaStep;
  uniform float uColorMult;
  uniform float uOpaqueness;
  uniform vec3  uBaseColor;
  uniform vec3  uCenterOrbColor;
  uniform vec3  uNoiseColor;
  uniform vec3  uCenterOrbOffset;
  uniform float uCenterOrbFalloff;
  uniform float uCenterOrbFalloffSharpness;
  uniform float uCenterOrbImportance;
  uniform float uNoiseSize;
  uniform float uNoiseImportance;
  uniform float uNoiseSharpness;
  uniform float uNoiseSubtractor;
  uniform float uStepRefractionMult;
  uniform vec3  uReflectionColor;
  uniform float uReflectionSharpness;
  uniform float uReflectionMult;
  uniform float uRainbow;
  uniform sampler2D uBgTex;
  uniform float uBgStrength;
  uniform vec4  uBgTexRegion;  // NDC: minX, minY, maxX, maxY of captured region
  varying vec3 vNor;
  varying vec3 vRo;
  varying vec3 vRd;
  varying vec3 vUnrefracted;
  varying vec4 vClipPos;

  vec3 hsv2rgb_c(float h, float s, float v) {
    return v * mix(vec3(1.0), clamp(abs(fract(h + vec3(0.0,2.0/3.0,1.0/3.0))*6.0-3.0)-1.0,0.0,1.0), s);
  }

  float tri(float x)  { return abs(fract(x) - 0.5); }
  vec3  tri3(vec3 p)  { return vec3(tri(p.y+tri(p.z)), tri(p.z+tri(p.x)), tri(p.y+tri(p.x))); }
  float triAdd(vec3 p){ return tri(p.x + tri(p.y + tri(p.z))); }

  float triNoise(vec3 p) {
    p *= uNoiseSize * 2.0;
    p += tri3(p * 0.3) * 1.6;
    float f = triAdd(p.yxz * 0.3) * 0.35;
    p += tri3(p * 0.4 + 121.0);
    f += triAdd(p.yxz) * 0.25;
    p += tri3(p * 0.8 + 121.0);
    f += triAdd(p.yxz * 1.3) * 0.15;
    return f;
  }

  float t3D(vec3 pos) {
    return triNoise(pos * 0.05 + vec3(uTime * 0.012, uTime * 0.008, uTime * 0.015));
  }

  vec3 nT3D(vec3 pos) {
    vec3 e = vec3(0.001, 0.0, 0.0);
    float v = t3D(pos);
    return v * normalize(vec3(
      t3D(pos+e.xyy) - t3D(pos-e.xyy),
      t3D(pos+e.yxy) - t3D(pos-e.yxy),
      t3D(pos+e.yyx) - t3D(pos-e.yyx)
    ) + 0.0001);
  }

  void main() {
    vec3  col = vec3(0.0);
    float t = 0.0, c = 0.0, totalSmoke = 0.0;
    vec3  p  = vec3(0.0);
    vec3  rd = normalize(vRd);

    for (int i = 0; i < NUM_STEPS; i++) {
      t += uDeltaStep * exp(-2.0 * c);
      p  = vRo - rd * t * 2.0;

      vec3  smoke = nT3D(p);
      vec3  nor   = normalize(smoke + 0.0001);

      float nd   = clamp(length(smoke) - uNoiseSubtractor, 0.0, 1.0);
      nd = pow(nd, uNoiseSharpness) * uNoiseImportance;

      float dist = max(pow(length(p - uCenterOrbOffset), uCenterOrbFalloffSharpness), 0.001);
      float cd   = uCenterOrbImportance / (dist * uCenterOrbFalloff + 0.001);

      c = clamp(cd + nd, 0.0, 1.0);
      totalSmoke += c;
      rd = normalize(rd * (1.0 - c*uStepRefractionMult) + nor * c*uStepRefractionMult);

      vec3 base     = mix(uBaseColor, uCenterOrbColor*(nor*0.5+0.5), clamp(cd-nd, 0.0, 1.0));
      vec3 stepCol  = mix(base, uNoiseColor*(nor*0.5+0.5), clamp(nd, 0.0, 1.0));
      float hueShift = float(i) * 0.09 + nd * 0.4 + uTime * 0.06;
      vec3 rainbowCol = hsv2rgb_c(hueShift, 1.0, 2.5 * c);
      col = 0.99*col + mix(stepCol, rainbowCol, uRainbow) * clamp(c + 0.3*uRainbow, 0.0, 1.5);
    }

    col = col / float(NUM_STEPS) * uColorMult;
    float smokeA = clamp(totalSmoke * uOpaqueness, 0.0, 1.0);
    col *= smokeA;

    float m       = clamp(dot(normalize(vUnrefracted), normalize(vNor)), 0.0, 1.0);
    float fresnel = pow(1.0 - m, uReflectionSharpness) * uReflectionMult;
    col += fresnel * uReflectionColor;

    if (uBgStrength > 0.01) {
      vec2 ndc  = vClipPos.xy / vClipPos.w;
      vec2 bgUV = (ndc - uBgTexRegion.xy) / (uBgTexRegion.zw - uBgTexRegion.xy);
      bgUV     += vNor.xy * 0.12 * uBgStrength;
      bgUV.y    = 1.0 - bgUV.y;
      bgUV      = clamp(bgUV, 0.02, 0.98);
      col = mix(col, texture2D(uBgTex, bgUV).rgb, uBgStrength);
    }

    gl_FragColor = vec4(col, 1.0);
  }
`;

function crystalMat(opts = {}) {
  return new THREE.ShaderMaterial({
    vertexShader:   crystalVert,
    fragmentShader: crystalFrag,
    side:        THREE.DoubleSide,
    transparent: true,
    depthWrite:  false,
    defines: { NUM_STEPS: opts.numSteps ?? 12 },
    uniforms: {
      uLocalCameraPos:            { value: new THREE.Vector3() },
      uIOR:                       { value: opts.ior              ?? 0.8  },
      uTime:                      { value: 0.0 },
      uDeltaStep:                 { value: opts.deltaStep        ?? 0.015 },
      uColorMult:                 { value: opts.colorMult        ?? 1.5  },
      uOpaqueness:                { value: opts.opaqueness       ?? 0.5  },
      uNoiseSize:                 { value: opts.noiseSize        ?? 1.0  },
      uNoiseImportance:           { value: opts.noiseImportance  ?? 1.0  },
      uNoiseSharpness:            { value: opts.noiseSharpness   ?? 2.0  },
      uNoiseSubtractor:           { value: opts.noiseSubtractor  ?? 0.0  },
      uStepRefractionMult:        { value: opts.stepRefractionMult ?? 0.15 },
      uBaseColor:                 { value: new THREE.Color(opts.baseColor       ?? 0x000000) },
      uCenterOrbColor:            { value: new THREE.Color(opts.centerOrbColor  ?? 0xffffff) },
      uNoiseColor:                { value: new THREE.Color(opts.noiseColor      ?? 0xffffff) },
      uCenterOrbOffset:           { value: new THREE.Vector3() },
      uCenterOrbFalloff:          { value: opts.centerOrbFalloff          ?? 6.0 },
      uCenterOrbFalloffSharpness: { value: opts.centerOrbFalloffSharpness ?? 1.0 },
      uCenterOrbImportance:       { value: opts.centerOrbImportance       ?? 0.3 },
      uReflectionColor:           { value: new THREE.Color(opts.reflectionColor ?? 0xffffff) },
      uReflectionSharpness:       { value: opts.reflectionSharpness ?? 5.0 },
      uReflectionMult:            { value: opts.reflectionMult    ?? 0.4  },
      uRainbow:                   { value: opts.rainbow           ?? 0.0  },
      uBgTex:                     { value: null },
      uBgStrength:                { value: 0.0  },
      uBgTexRegion:               { value: new THREE.Vector4(-1, -1, 1, 1) },
    },
  });
}

const _tmpV3 = new THREE.Vector3();
function bindCrystal(mesh, mat) {
  mesh.onBeforeRender = (_r, _s, cam) => {
    _tmpV3.copy(cam.position);
    mesh.worldToLocal(_tmpV3);
    mat.uniforms.uLocalCameraPos.value.copy(_tmpV3);
  };
}

// ── Letter confetti shader ────────────────────────────────────────────────────
// Samples 3D noise from LOCAL UV coords → pattern is baked to the letter surface,
// doesn't scroll as the piece moves through the world.
const letterVert = `
  varying vec2 vUv;
  varying vec3 vLocalPos;
  void main() {
    vUv       = uv;
    vLocalPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const letterFrag = `
  precision highp float;
  uniform sampler2D uLetterTex;
  uniform float uTime;
  uniform float uHue;
  uniform float uLife;
  varying vec2 vUv;

  float tri(float x)  { return abs(fract(x) - 0.5); }
  vec3  tri3(vec3 p)  { return vec3(tri(p.y+tri(p.z)), tri(p.z+tri(p.x)), tri(p.y+tri(p.x))); }
  float triAdd(vec3 p){ return tri(p.x + tri(p.y + tri(p.z))); }

  float triNoise(vec3 p) {
    p += tri3(p * 0.3) * 1.6;
    float f = triAdd(p.yxz * 0.3) * 0.35;
    p += tri3(p * 0.4 + 121.0);
    f += triAdd(p.yxz) * 0.25;
    p += tri3(p * 0.8 + 121.0);
    f += triAdd(p.yxz * 1.3) * 0.15;
    return f;
  }

  vec3 hsv2rgb(float h, float s, float v) {
    vec3 c = clamp(abs(fract(h + vec3(0.0, 2.0/3.0, 1.0/3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
    return v * mix(vec3(1.0), c, s);
  }

  void main() {
    float alpha = texture2D(uLetterTex, vUv).a;
    if (alpha < 0.05) discard;

    // stable 3D noise anchored to local UV space — won't scroll as letter moves
    vec3 sp  = vec3(vUv * 5.0, uHue * 10.0);
    float n  = triNoise(sp);
    float n2 = triNoise(sp * 2.0 + 3.7 + uTime * 0.15);

    vec3 col = hsv2rgb(uHue + n * 0.5 + n2 * 0.15, 0.8, 0.9 + n * 0.9 + n2 * 0.3);
    col += n2 * 0.4 * vec3(1.0, 0.95, 0.7);   // inner sparkle

    gl_FragColor = vec4(col, alpha * uLife);
  }
`;

// ── Fleshy subsurface-scattering shader ───────────────────────────────────────
// Wrap-lit diffuse + back-scatter translucency for that soft, plump skin look.
// Lights live in view space, so shading stays put no matter where the butt sits.
const fleshVert = `
  uniform float uSpread;   // top-lean amount (deform, not translate)
  uniform float uSide;     // -1 left cheek, +1 right cheek
  uniform float uRadius;   // hemisphere radius (for normalizing the lean)
  varying vec3 vNormal;
  varying vec3 vViewPos;
  varying vec3 vLocalPos;
  void main() {
    // Anchor the flat base (y≈0), lean the top outward → the cheeks deform open
    // instead of sliding apart. Lean scales with height up the dome.
    float h    = clamp(position.y / uRadius, 0.0, 1.0);
    vec3  pos  = position;
    pos.x += uSide * uSpread * h * h;   // h² so the very top opens most

    vNormal     = normalize(normalMatrix * normal);
    vec4 mv     = modelViewMatrix * vec4(pos, 1.0);
    vViewPos    = mv.xyz;
    vLocalPos   = position;
    gl_Position = projectionMatrix * mv;
  }
`;

const fleshFrag = `
  precision highp float;
  uniform vec3  uColor;      // base skin tone
  uniform vec3  uSSSColor;   // shadow / rim tint
  uniform float uFlush;      // 0..1 audio-driven flush / glow boost
  uniform float uTime;
  uniform vec3  uLight;      // key-light direction in view space (driven by the cursor)
  varying vec3 vNormal;
  varying vec3 vViewPos;
  varying vec3 vLocalPos;

  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(-vViewPos);
    vec3 k = normalize(uLight);

    // ── Toon ramp: quantize the diffuse into flat cel bands ──────────────────
    float ndl  = dot(N, k) * 0.5 + 0.5;                 // 0..1
    float lo   = smoothstep(0.34, 0.38, ndl);           // shadow → mid
    float hi   = smoothstep(0.66, 0.70, ndl);           // mid → light
    float band = lo * 0.5 + hi * 0.5;                   // 3 flat levels

    vec3 shadowC = uColor * vec3(0.88, 0.82, 0.85);     // light, barely-cool shadow
    vec3 col     = mix(shadowC, uColor, band);

    // soft toony rim light along the silhouette
    float rim = smoothstep(0.55, 0.90, pow(1.0 - max(0.0, dot(N, V)), 2.0));
    col = mix(col, mix(uColor, uSSSColor, 0.6), rim * 0.35);

    // single crisp cartoon specular dot
    vec3  H    = normalize(k + V);
    float spec = smoothstep(0.984, 0.990, dot(N, H));
    col += spec * 0.45;

    col += uColor * uFlush * 0.30;   // whole-cheek flush on audio peaks
    gl_FragColor = vec4(col, 1.0);
  }
`;

// ── Scene materials ──────────────────────────────────────────────────────────
// One material per cheek so each can lean its own way (uSide). Light, pink,
// pig-butt skin.
const SKIN_COLOR = 0xf6c2d6;   // light bubblegum pink
const SSS_COLOR  = 0xe07f9a;   // soft rose rim
function makeFleshMat(side) {
  return new THREE.ShaderMaterial({
    vertexShader:   fleshVert,
    fragmentShader: fleshFrag,
    side: THREE.FrontSide,
    uniforms: {
      uColor:    { value: new THREE.Color(SKIN_COLOR) },
      uSSSColor: { value: new THREE.Color(SSS_COLOR)  },
      uLight:    { value: new THREE.Vector3(0.4, 0.65, 0.65).normalize() },
      uFlush:    { value: 0.0 },
      uTime:     { value: 0.0 },
      uSpread:   { value: 0.0 },
      uSide:     { value: side },
      uRadius:   { value: 0.34 },   // matches CHEEK_R below
    },
  });
}
const leftMat  = makeFleshMat(-1);
const rightMat = makeFleshMat(+1);
const allCrystalMats = [leftMat, rightMat];

// ── Background glass texture (64×64, updated ~10fps) ─────────────────────────
const BG_SIZE  = 64;
const bgPixels = new Uint8Array(BG_SIZE * BG_SIZE * 4);
const bgDataTex = new THREE.DataTexture(bgPixels, BG_SIZE, BG_SIZE, THREE.RGBAFormat);
bgDataTex.flipY       = false;
bgDataTex.minFilter   = THREE.LinearFilter;
bgDataTex.magFilter   = THREE.LinearFilter;
let mushLocalBBox = null;
let bgCapturing   = false;
let bgEnabled     = true;
let winLogX = 0, winLogY = 0;

// Shared lock: only ONE screen capture (butt bg OR magnifier) may run at a time.
// Two concurrent CGWindowListCreateImage calls flip our transparent window opaque-black.
window.__screenCaptureBusy = false;

// Cache window logical position (updated every 2 s)
(async () => {
  try {
    const { getCurrentWindow } = window.__TAURI__.window;
    const aw = getCurrentWindow();
    const refresh = async () => {
      const pos = await aw.outerPosition();
      const sf  = window.devicePixelRatio;
      winLogX = pos.x / sf;
      winLogY = pos.y / sf;
    };
    await refresh();
    setInterval(refresh, 2000);
  } catch(_) {}
})();

async function captureBg() {
  if (!bgEnabled || bgCapturing || !mushLocalBBox) return;
  if (window.__screenCaptureBusy) return; // don't overlap with the magnifier capture
  bgCapturing = true;
  window.__screenCaptureBusy = true;
  try {
    const corners = [];
    const v = new THREE.Vector3();
    garden.updateWorldMatrix(true, false);
    for (let ix = 0; ix < 2; ix++) for (let iy = 0; iy < 2; iy++) for (let iz = 0; iz < 2; iz++) {
      v.set(
        ix ? mushLocalBBox.max.x : mushLocalBBox.min.x,
        iy ? mushLocalBBox.max.y : mushLocalBBox.min.y,
        iz ? mushLocalBBox.max.z : mushLocalBBox.min.z,
      );
      v.applyMatrix4(garden.matrixWorld).project(camera);
      corners.push({ x: v.x, y: v.y });
    }
    const pad    = 0.15;
    const ndcMinX = Math.max(-1, Math.min(...corners.map(c => c.x)) - pad);
    const ndcMaxX = Math.min( 1, Math.max(...corners.map(c => c.x)) + pad);
    const ndcMinY = Math.max(-1, Math.min(...corners.map(c => c.y)) - pad);
    const ndcMaxY = Math.min( 1, Math.max(...corners.map(c => c.y)) + pad);

    // Convert NDC bounds → window-relative CSS px
    const cssX = (ndcMinX + 1) / 2 * window.innerWidth;
    const cssY = (1 - ndcMaxY) / 2 * window.innerHeight;
    const cssW = (ndcMaxX - ndcMinX) / 2 * window.innerWidth;
    const cssH = (ndcMaxY - ndcMinY) / 2 * window.innerHeight;

    const b64 = await window.__TAURI__.core.invoke('capture_bg_region', {
      title: 'widget-confetti-butt',
      winX: winLogX, winY: winLogY,
      relX: Math.max(0, cssX),  relY: Math.max(0, cssY),
      relW: Math.max(16, cssW), relH: Math.max(16, cssH),
    });

    if (b64) {
      const bin = atob(b64);
      for (let i = 0; i < bgPixels.length; i++) bgPixels[i] = bin.charCodeAt(i);
      bgDataTex.needsUpdate = true;
    }
  } catch(e) {
    console.warn('captureBg:', e);
    bgEnabled = false;
  }
  bgCapturing = false;
  window.__screenCaptureBusy = false;
}

// ── Butt: two fleshy cheeks that spread apart as you type ─────────────────────
// Crack faces straight up so the confetti words fart vertically out of the seam.
const garden = new THREE.Group();
// Locked to the base of the screen. BASE_Y sits the cheeks' equator just below the
// bottom edge so the rounded underside is cropped off-screen — only the mounds show.
const _halfH = Math.tan((camera.fov * Math.PI / 180) / 2) * camera.position.z;
const BASE_Y = -_halfH + 0.07;
// Start in the lower-RIGHT corner: anchor to the right edge (half-width = halfH·aspect)
// minus a margin for the butt's own width, so it lands in the corner on any aspect.
const START_X = _halfH * camera.aspect - 0.7;
garden.position.set(START_X, BASE_Y, 0);
// The butt faces straight up; confetti fires straight up.
const BARREL = new THREE.Vector3(0, 1, 0);
scene.add(garden);

// Emission point in butt-local space — up above the tail, where the fart erupts.
const FOUNTAIN_POS = new THREE.Vector3(0, 0.30, 0.06);

// Cheek domes — a bit MORE than a top hemisphere (thetaLength > π/2) so the
// underside curves back inward for a soft rounded base instead of a hard flat cut.
const CHEEK_R  = 0.34;
const BASE_GAP = 0.15;                 // resting half-distance between the cheeks
const cheekGeo = new THREE.SphereGeometry(CHEEK_R, 48, 32, 0, Math.PI * 2, 0, Math.PI * 0.62);

const leftCheek  = new THREE.Mesh(cheekGeo, leftMat);
const rightCheek = new THREE.Mesh(cheekGeo, rightMat);
const CHEEK_SY   = 1.15;               // base vertical stretch of each cheek
for (const ch of [leftCheek, rightCheek]) {
  ch.scale.set(0.92, CHEEK_SY, 0.82);
  garden.add(ch);
}
// Bases stay put at the resting gap; only the tops lean (see uSpread in the shader).
leftCheek.position.set(-BASE_GAP, 0, 0);
rightCheek.position.set(BASE_GAP, 0, 0);

// Spread state — bumped on every keypress, eases back to rest each frame.
let buttSpread = 0, buttSpreadTarget = 0;

// ── Curly pig tail (verlet physics) ───────────────────────────────────────────
// Rest shape: a corkscrew spiral in the X-Y plane, anchored at the upper-back of
// the butt. A spring chain pulls the tail back to this curl, while verlet inertia
// + segment constraints let it whip and jiggle when the butt moves or farts.
const tailMat = makeFleshMat(0);          // uSide 0 → no cheek shear, just toon skin
tailMat.side = THREE.DoubleSide;          // tapered tube — show both sides
allCrystalMats.push(tailMat);

const TAIL_N     = 26;
const TAIL_TURNS = 3.8;     // tighter corkscrew
const TAIL_R0    = 0.13;
const TAIL_ADV   = 0.30;    // length along the corkscrew's advance axis
const TAIL_TUBE  = 0.042;   // base tube radius (stays full, then points near the end)
const TAIL_TILT  = -0.95;   // tilt the corkscrew up (more upward than straight at the camera)
const TAIL_ANCHOR = new THREE.Vector3(0.15, 0.20, 0.04);  // off to the side, clear of the butthole
const tailRest = [];
{
  const raw = [];
  const axisX = new THREE.Vector3(1, 0, 0);
  for (let i = 0; i < TAIL_N; i++) {
    const t   = i / (TAIL_N - 1);
    const ang = t * TAIL_TURNS * Math.PI * 2;
    const r   = TAIL_R0 * (1 - 0.5 * t);               // coil tightens toward the tip
    // corkscrew coiling around its advance axis, then tilted up so it points more
    // upward (and to the side) rather than straight at the camera
    const p = new THREE.Vector3(Math.cos(ang) * r, -Math.sin(ang) * r, t * TAIL_ADV);
    p.applyAxisAngle(axisX, TAIL_TILT);
    raw.push(p);
  }
  const shift = TAIL_ANCHOR.clone().sub(raw[0]);        // move base curl to anchor
  for (const p of raw) tailRest.push(p.add(shift));
}
const tailNodes = tailRest.map(p => ({ pos: p.clone(), prev: p.clone() }));
const tailSeg   = tailRest.map((p, i) => i === 0 ? 0 : p.distanceTo(tailRest[i - 1]));
const TAIL_GRAV = -0.0007;
let tailMesh = null;

function tailKick(strength) {
  for (let i = 1; i < TAIL_N; i++) {
    const w = i / TAIL_N;                                // tip flicks most
    tailNodes[i].pos.x += (Math.random() - 0.5) * strength * w;
    tailNodes[i].pos.y += (Math.random() * 0.6 + 0.2) * strength * w;
    tailNodes[i].pos.z += (Math.random() - 0.5) * strength * w;
  }
}

function updateTail() {
  // verlet integrate (damped) + gravity
  for (let i = 1; i < TAIL_N; i++) {
    const n  = tailNodes[i];
    const vx = (n.pos.x - n.prev.x) * 0.90;
    const vy = (n.pos.y - n.prev.y) * 0.90;
    const vz = (n.pos.z - n.prev.z) * 0.90;
    n.prev.copy(n.pos);
    n.pos.x += vx; n.pos.y += vy + TAIL_GRAV; n.pos.z += vz;
  }
  // springy pull back toward the rest curl (so it always re-coils)
  for (let i = 1; i < TAIL_N; i++) tailNodes[i].pos.lerp(tailRest[i], 0.10);
  // keep segment lengths, anchored at the base (FABRIK-style forward pass)
  for (let it = 0; it < 4; it++) {
    tailNodes[0].pos.copy(tailRest[0]);
    for (let i = 1; i < TAIL_N; i++) {
      const a = tailNodes[i - 1].pos, b = tailNodes[i].pos;
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const len = Math.hypot(dx, dy, dz) || 1e-5;
      const s = tailSeg[i] / len;
      b.set(a.x + dx * s, a.y + dy * s, a.z + dz * s);
    }
  }
}

function buildTailMesh() {
  const curve  = new THREE.CatmullRomCurve3(tailNodes.map(n => n.pos));
  const SEG = 64, RING = 12;
  const pts    = curve.getSpacedPoints(SEG);
  const frames = curve.computeFrenetFrames(SEG, false);
  const pos = new Float32Array((SEG + 1) * (RING + 1) * 3);
  const nor = new Float32Array((SEG + 1) * (RING + 1) * 3);
  let p = 0;
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG;
    // stay full thickness, then narrow to a sharp point only near the very end
    const radius = TAIL_TUBE * (1 - THREE.MathUtils.smoothstep(t, 0.8, 1.0));
    const P = pts[i], N = frames.normals[i], B = frames.binormals[i];
    for (let j = 0; j <= RING; j++) {
      const a = j / RING * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      const nx = c * N.x + s * B.x, ny = c * N.y + s * B.y, nz = c * N.z + s * B.z;
      pos[p] = P.x + radius * nx; nor[p++] = nx;
      pos[p] = P.y + radius * ny; nor[p++] = ny;
      pos[p] = P.z + radius * nz; nor[p++] = nz;
    }
  }
  const idx = [];
  for (let i = 0; i < SEG; i++) for (let j = 0; j < RING; j++) {
    const a = i * (RING + 1) + j, b = a + RING + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal',   new THREE.BufferAttribute(nor, 3));
  geo.setIndex(idx);
  if (tailMesh) { garden.remove(tailMesh); tailMesh.geometry.dispose(); }
  tailMesh = new THREE.Mesh(geo, tailMat);
  garden.add(tailMesh);
}
buildTailMesh();

// ── Pink peach-fuzz hairs (tiny verlet strands all over the cheeks) ───────────
// Each hair is a 4-node chain rooted on a cheek surface, standing along the
// surface normal, with gravity sag + damping so they jiggle. Drawn as thin lines.
const HAIR_COUNT = 620;
const HSEG  = 3;                 // segments per hair → 4 nodes
const HNODE = HSEG + 1;
const HAIR_LEN = 0.038;
const hseg = HAIR_LEN / HSEG;
const HAIR_GRAV = -0.0011, HAIR_DAMP = 0.86, HAIR_BEND = 0.16;
const CS = [0.92 * CHEEK_R, 1.15 * CHEEK_R, 0.82 * CHEEK_R];   // cheek ellipsoid radii
const hairs = [];

function genHairs(offsetX, count) {
  for (let i = 0; i < count; i++) {
    const phi  = Math.random() * Math.PI * 2;
    const cosT = Math.random();                       // top hemisphere
    const sinT = Math.sqrt(1 - cosT * cosT);
    const dir  = new THREE.Vector3(sinT * Math.cos(phi), cosT, sinT * Math.sin(phi));
    const base = new THREE.Vector3(dir.x * CS[0] + offsetX, dir.y * CS[1], dir.z * CS[2]);
    const nrm  = new THREE.Vector3(dir.x / 0.92, dir.y / 1.15, dir.z / 0.82).normalize();
    const nodes = [];
    for (let n = 0; n < HNODE; n++) {
      const p = base.clone().addScaledVector(nrm, hseg * n);
      nodes.push({ pos: p.clone(), prev: p.clone() });
    }
    // base = undeformed root; root = its live position once the cheek shear is applied.
    // side/dy let us replay the exact vertex-shader shear (pos.x += side*spread*h²) on the CPU.
    hairs.push({ base, root: base.clone(), nrm, side: offsetX < 0 ? -1 : 1, dy: dir.y, nodes });
  }
}
genHairs(-BASE_GAP, HAIR_COUNT >> 1);
genHairs( BASE_GAP, HAIR_COUNT >> 1);

const hairVerts = HAIR_COUNT * HSEG * 2;
const hairPos   = new Float32Array(hairVerts * 3);
const hairCol   = new Float32Array(hairVerts * 3);
const hairGeo   = new THREE.BufferGeometry();
hairGeo.setAttribute('position', new THREE.BufferAttribute(hairPos, 3).setUsage(THREE.DynamicDrawUsage));
hairGeo.setAttribute('color',    new THREE.BufferAttribute(hairCol, 3));
// static root→tip pink gradient
{
  const rootC = [1.0, 0.58, 0.80], tipC = [1.0, 0.90, 0.96];
  let o = 0;
  for (let h = 0; h < HAIR_COUNT; h++) {
    for (let s = 0; s < HSEG; s++) {
      const f0 = s / HSEG, f1 = (s + 1) / HSEG;
      for (const f of [f0, f1]) {
        hairCol[o++] = rootC[0] + (tipC[0] - rootC[0]) * f;
        hairCol[o++] = rootC[1] + (tipC[1] - rootC[1]) * f;
        hairCol[o++] = rootC[2] + (tipC[2] - rootC[2]) * f;
      }
    }
  }
}
const hairMat   = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.92, depthWrite: false });
const hairLines = new THREE.LineSegments(hairGeo, hairMat);
hairLines.frustumCulled = false;
garden.add(hairLines);

function hairKick(strength) {
  for (const h of hairs) for (let i = 1; i < HNODE; i++) {
    const w = i / HSEG;
    h.nodes[i].pos.x += (Math.random() - 0.5) * strength * w;
    h.nodes[i].pos.y += (Math.random() - 0.5) * strength * w;
    h.nodes[i].pos.z += (Math.random() - 0.5) * strength * w;
  }
}

function updateHairs(t) {
  const wind = Math.sin(t * 1.3) * 0.00035;        // gentle breeze
  for (const h of hairs) {
    // Move the root with the live cheek surface: replay the vertex shader's shear
    // (geom.x += side*spread*h², then ×0.92 cheek scale). h = dir.y. So the fuzz
    // slides outward at the top exactly as the cheeks spread — it's glued to the mesh.
    h.root.set(h.base.x + 0.92 * h.side * buttSpread * h.dy * h.dy, h.base.y, h.base.z);
    h.nodes[0].pos.copy(h.root);
    h.nodes[0].prev.copy(h.root);
    // verlet + gravity
    for (let i = 1; i < HNODE; i++) {
      const nd = h.nodes[i];
      const vx = (nd.pos.x - nd.prev.x) * HAIR_DAMP;
      const vy = (nd.pos.y - nd.prev.y) * HAIR_DAMP;
      const vz = (nd.pos.z - nd.prev.z) * HAIR_DAMP;
      nd.prev.copy(nd.pos);
      nd.pos.x += vx + wind; nd.pos.y += vy + HAIR_GRAV; nd.pos.z += vz;
    }
    // bending stiffness — each node tries to CONTINUE the previous segment's
    // direction (the root normal for the first segment). Because the target is
    // relative to the chain (not an absolute pose pinned to the root), the tip
    // lags and follows the root through the chain instead of moving rigidly with it.
    for (let i = 1; i < HNODE; i++) {
      let dx, dy, dz;
      if (i === 1) { dx = h.nrm.x; dy = h.nrm.y; dz = h.nrm.z; }
      else {
        const p2 = h.nodes[i - 2].pos, p1 = h.nodes[i - 1].pos;
        dx = p1.x - p2.x; dy = p1.y - p2.y; dz = p1.z - p2.z;
        const l = Math.hypot(dx, dy, dz) || 1e-5; dx /= l; dy /= l; dz /= l;
      }
      const prev = h.nodes[i - 1].pos, nd = h.nodes[i].pos;
      const tx = prev.x + dx * hseg, ty = prev.y + dy * hseg, tz = prev.z + dz * hseg;
      nd.x += (tx - nd.x) * HAIR_BEND;
      nd.y += (ty - nd.y) * HAIR_BEND;
      nd.z += (tz - nd.z) * HAIR_BEND;
    }
    // keep segment lengths from the root outward
    for (let it = 0; it < 2; it++) {
      h.nodes[0].pos.copy(h.root);
      for (let i = 1; i < HNODE; i++) {
        const a = h.nodes[i - 1].pos, b = h.nodes[i].pos;
        const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        const len = Math.hypot(dx, dy, dz) || 1e-5, s = hseg / len;
        b.set(a.x + dx * s, a.y + dy * s, a.z + dz * s);
      }
    }
  }
  // write line buffer
  let o = 0;
  for (const h of hairs) {
    for (let s = 0; s < HSEG; s++) {
      const a = h.nodes[s].pos, b = h.nodes[s + 1].pos;
      hairPos[o++] = a.x; hairPos[o++] = a.y; hairPos[o++] = a.z;
      hairPos[o++] = b.x; hairPos[o++] = b.y; hairPos[o++] = b.z;
    }
  }
  hairGeo.attributes.position.needsUpdate = true;
}

// ── Butthole: an asterisk pucker that tightens & expands ──────────────────────
// A flat decal sitting in the crack, facing the viewer (depthTest off so it always
// reads on top). Its scale is driven by buttSpread, so it puckers tight at rest and
// opens up as the cheeks spread when you type.
function makeAsteriskTex() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d');
  x.translate(64, 64);
  x.strokeStyle = '#7e3344'; x.lineCap = 'round';
  const ARMS = 6;
  for (let i = 0; i < ARMS; i++) {
    x.save(); x.rotate(i / ARMS * Math.PI * 2);
    x.lineWidth = 13;
    x.beginPath(); x.moveTo(0, 6); x.lineTo(0, 52); x.stroke();
    x.restore();
  }
  x.fillStyle = '#561f2c'; x.beginPath(); x.arc(0, 0, 13, 0, Math.PI * 2); x.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const SHOW_BUTTHOLE = false;   // flip to true to bring the asterisk butthole back
const buttholeMat = new THREE.MeshBasicMaterial({ map: makeAsteriskTex(), transparent: true, opacity: 0, depthTest: false, depthWrite: false });
const butthole    = new THREE.Mesh(new THREE.PlaneGeometry(0.17, 0.17), buttholeMat);
butthole.position.copy(FOUNTAIN_POS);   // exactly where the letters fart out
butthole.rotation.x = -0.95;            // tilt to face up-and-toward the viewer
butthole.renderOrder = 12;
butthole.visible = false;               // only appears once the butt spreads wide
garden.add(butthole);

// ── Lighting ──────────────────────────────────────────────────────────────────
scene.add(new THREE.AmbientLight(0xffffff, 0.3));
const key = new THREE.DirectionalLight(0xffffff, 5.0);
key.position.set(3, 5, 4); scene.add(key);
const fill = new THREE.DirectionalLight(0x88aaff, 2.5);
fill.position.set(-4, 2, 2); scene.add(fill);
const rim = new THREE.DirectionalLight(0xffffff, 2.0);
rim.position.set(0, -2, -3); scene.add(rim);
const topLight = new THREE.PointLight(0xff5500, 3.0, 8);
topLight.position.set(0.8, 2, 0); scene.add(topLight);

// ── Audio: the cheeks flush with system audio ─────────────────────────────────
(async () => {
  try {
    await window.__TAURI__.event.listen('audio-freq', (e) => {
      const bins = e.payload;
      let sum = 0;
      for (let i = 5; i < 80; i++) sum += (bins[i] || 0);
      const level = Math.min(sum / 75, 1.0);
      allCrystalMats.forEach(m => { m.uniforms.uFlush.value = level; });
    });
  } catch(e) { console.warn('audio-freq:', e); }
})();

// ── Square puff confetti shader (no texture mask — full square) ───────────────
const squareFrag = `
  precision highp float;
  uniform float uTime;
  uniform float uHue;
  uniform float uLife;
  varying vec2 vUv;

  float tri(float x)  { return abs(fract(x) - 0.5); }
  vec3  tri3(vec3 p)  { return vec3(tri(p.y+tri(p.z)), tri(p.z+tri(p.x)), tri(p.y+tri(p.x))); }
  float triAdd(vec3 p){ return tri(p.x + tri(p.y + tri(p.z))); }
  float triNoise(vec3 p) {
    p += tri3(p * 0.3) * 1.6;
    float f = triAdd(p.yxz * 0.3) * 0.35;
    p += tri3(p * 0.4 + 121.0);
    f += triAdd(p.yxz) * 0.25;
    p += tri3(p * 0.8 + 121.0);
    f += triAdd(p.yxz * 1.3) * 0.15;
    return f;
  }
  vec3 hsv2rgb(float h, float s, float v) {
    vec3 c = clamp(abs(fract(h + vec3(0.0, 2.0/3.0, 1.0/3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
    return v * mix(vec3(1.0), c, s);
  }
  void main() {
    vec3 sp  = vec3(vUv * 5.0, uHue * 10.0);
    float n  = triNoise(sp);
    float n2 = triNoise(sp * 2.0 + 3.7 + uTime * 0.2);
    vec3 col = hsv2rgb(uHue + n * 0.5 + n2 * 0.15, 0.85, 0.9 + n * 0.9 + n2 * 0.3);
    col += n2 * 0.4 * vec3(1.0, 0.95, 0.7);
    gl_FragColor = vec4(col, uLife);
  }
`;

// ── Crystal confetti letters ──────────────────────────────────────────────────
const fallingLetters = [];
const GRAVITY = 0.002;

// Puff cloud rides along with the letter's fart plume (base velocity bvx/bvy/bvz).
function spawnPuff(worldPos, bvx, bvy, bvz) {
  for (let i = 0; i < 10; i++) {
    const mat = new THREE.ShaderMaterial({
      vertexShader: letterVert, fragmentShader: squareFrag,
      side: THREE.DoubleSide, transparent: true, depthWrite: false,
      uniforms: {
        uTime: { value: 0.0 },
        uHue:  { value: Math.random() },
        uLife: { value: 1.0 },
      },
    });
    const s    = 0.015 + Math.random() * 0.025;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(s, s), mat);
    mesh.position.copy(worldPos);
    scene.add(mesh);
    fallingLetters.push({
      mesh, mat,
      vx: bvx + (Math.random() - 0.5) * 0.03,
      vy: bvy * (0.4 + Math.random() * 0.6),
      vz: bvz + (Math.random() - 0.5) * 0.03,
      roll: Math.random() * Math.PI * 2,        // random start angle, always camera-facing
      rollSpeed: (Math.random() - 0.5) * 0.22,
      life: 1.0, decay: 0.038,
    });
  }
}

function spawnLetter(char) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const ctx = c.getContext('2d');
  ctx.font = 'bold 88px "Comic Sans MS", cursive';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(char, 64, 68);

  const tex = new THREE.CanvasTexture(c);
  const hue = Math.random();

  const mat = new THREE.ShaderMaterial({
    vertexShader:   letterVert,
    fragmentShader: letterFrag,
    side:        THREE.DoubleSide,
    transparent: true,
    depthWrite:  false,
    uniforms: {
      uLetterTex: { value: tex  },
      uTime:      { value: 0.0  },
      uHue:       { value: hue  },
      uLife:      { value: 1.0  },
    },
  });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 0.14), mat);

  // Spread the cheeks — each keystroke gives the butt a clench-and-part.
  buttSpreadTarget = Math.min(0.34, buttSpreadTarget + 0.11);
  tailKick(0.05);   // and flick the tail
  hairKick(0.012);  // and shiver the fuzz

  // Emit from the crack, in world space
  const worldFountain = FOUNTAIN_POS.clone().applyMatrix4(garden.matrixWorld);
  mesh.position.copy(worldFountain);

  // Cannon plume: fires along the barrel (the tilted crack direction); gravity arcs it.
  const up = 0.06 + Math.random() * 0.035;          // muzzle velocity
  const vx = BARREL.x * up + (Math.random() - 0.5) * 0.02;
  const vy = BARREL.y * up + (Math.random() - 0.5) * 0.02;
  const vz = BARREL.z * up + (Math.random() - 0.5) * 0.02;

  scene.add(mesh);
  fallingLetters.push({
    mesh, mat,
    vx, vy, vz,
    // mostly upright so words stay readable: just a ±20° tilt, no spinning
    roll: (Math.random() - 0.5) * (40 * Math.PI / 180),
    rollSpeed: 0,
    life: 1.0, decay: 0.014,
  });

  spawnPuff(worldFountain, vx, vy, vz);
}

(async () => {
  try { await window.__TAURI__.event.listen('keypress', (e) => spawnLetter(e.payload)); }
  catch(_) {}
})();

document.addEventListener('keydown', (e) => {
  if (e.key.length === 1 && /[a-zA-Z0-9]/.test(e.key)) spawnLetter(e.key.toUpperCase());
});

// ── Render loop ───────────────────────────────────────────────────────────────
let bgFrame = 0;
let _fpsCount = 0, _fpsLast = 0, _fpsCurrent = 0;
(function animate() {
  requestAnimationFrame(animate);

  const elapsed = performance.now() * 0.001;

  // FPS counter — update display once per second
  _fpsCount++;
  const _fpsNow = performance.now();
  if (_fpsNow - _fpsLast >= 1000) {
    _fpsCurrent = _fpsCount;
    _fpsCount = 0;
    _fpsLast = _fpsNow;
    const fpsEl = document.getElementById('sp-fps');
    if (fpsEl) fpsEl.textContent = _fpsCurrent + ' fps';
  }

  // no rotation — the butt faces straight up so the confetti farts vertically

  // ease the cheek spread: target relaxes each frame, current chases it.
  // The tops of the cheeks lean apart (shader deform); the bases stay anchored.
  buttSpreadTarget *= 0.90;
  buttSpread += (buttSpreadTarget - buttSpread) * 0.35;
  leftMat.uniforms.uSpread.value  = buttSpread;
  rightMat.uniforms.uSpread.value = buttSpread;

  garden.position.y = BASE_Y;   // stay locked to the base of the screen

  // butthole puckers open as the cheeks spread (shows readily now)
  const vis = SHOW_BUTTHOLE ? THREE.MathUtils.clamp((buttSpread - 0.05) / 0.10, 0, 1) : 0;
  butthole.visible = vis > 0.01;
  buttholeMat.opacity = vis;
  const puck = THREE.MathUtils.clamp(0.6 + buttSpread * 3.0 + Math.sin(elapsed * 2.0) * 0.04, 0.4, 1.5);
  butthole.scale.setScalar(puck);

  // curly tail physics + rebuild its tube
  updateTail();
  buildTailMesh();

  // peach-fuzz hair physics
  updateHairs(elapsed);

  allCrystalMats.forEach(m => { m.uniforms.uTime.value = elapsed; });

  for (let i = fallingLetters.length - 1; i >= 0; i--) {
    const l = fallingLetters[i];
    l.vy -= GRAVITY;
    l.mesh.position.x += l.vx;
    l.mesh.position.y += l.vy;
    l.mesh.position.z += l.vz;

    // billboard: always face the camera, but spin freely in-plane (around view axis)
    l.roll += l.rollSpeed;
    l.mesh.quaternion.copy(camera.quaternion);
    l.mesh.rotateZ(l.roll);

    l.life -= l.decay;
    l.mat.uniforms.uTime.value = elapsed;
    l.mat.uniforms.uLife.value = Math.max(0, l.life);

    if (l.life <= 0) {
      scene.remove(l.mesh);
      l.mesh.geometry.dispose();
      l.mat.uniforms.uLetterTex?.value.dispose();
      l.mat.dispose();
      fallingLetters.splice(i, 1);
    }
  }

  renderer.render(scene, camera);
})();


// ── Window setup + click-through ─────────────────────────────────────────────
(async () => {
  try {
    const { getCurrentWindow, currentMonitor } = window.__TAURI__.window;
    const { LogicalPosition, LogicalSize } = window.__TAURI__.dpi;
    const appWindow = getCurrentWindow();

    const monitor = await currentMonitor();
    if (monitor) {
      const sw = monitor.size.width  / monitor.scaleFactor;
      const sh = monitor.size.height / monitor.scaleFactor;
      await appWindow.setPosition(new LogicalPosition(0, 0));
      await appWindow.setSize(new LogicalSize(sw, sh));
    }

    // Start click-through; pollMouse will enable cursor events only over the butt
    await appWindow.setIgnoreCursorEvents(true);

    const { invoke } = window.__TAURI__.core;

    // ── Click-through tracking ───────────────────────────────────────────────
    let overGarden = false;

    async function pollMouse() {
      try {
        const [gx, gy] = await invoke('mouse_position');
        // Butt: projected bounding circle
        const gp = garden.position.clone().project(camera);
        const cx = (gp.x + 1) / 2 * window.innerWidth;
        const cy = (1 - gp.y) / 2 * window.innerHeight;
        const overButt = (gx - cx) ** 2 + (gy - cy) ** 2 < 180 * 180;
        // while the permission popup is up, keep the whole window clickable
        const hit = window.__permOverlayActive || overButt;
        if (!dragging && hit !== overGarden) {
          overGarden = hit;
          await appWindow.setIgnoreCursorEvents(!hit);
        }
      } catch(_) {}
      setTimeout(pollMouse, 40);
    }
    pollMouse();

    // Drag the butt along the base of the screen (horizontal only — y is locked)
    let dragging = false, dragLast = null;
    const fovRad = camera.fov * Math.PI / 180;
    const dragScale = () => 2 * Math.tan(fovRad / 2) * camera.position.z / window.innerHeight;

    renderer.domElement.addEventListener('pointerdown', (e) => {
      if (!overGarden) return;
      dragging  = true;
      dragLast  = { x: e.clientX, y: e.clientY };
      renderer.domElement.setPointerCapture(e.pointerId);
    });
    renderer.domElement.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const s  = dragScale();
      garden.position.x += (e.clientX - dragLast.x) * s;   // slide sideways only
      dragLast = { x: e.clientX, y: e.clientY };
    });
    renderer.domElement.addEventListener('pointerup', () => { dragging = false; dragLast = null; });

    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') appWindow.close(); });

    // Only Input Monitoring is required (to catch keystrokes). Screen Recording was
    // only for the audio-reactive flush — optional, so we don't gate on it.
    guardPermissions(['input_monitoring'], {
      note: 'This widget needs Input Monitoring so it can fart confetti words as you type.',
      descriptions: {
        input_monitoring: 'Used to catch your keystrokes and fart out the confetti words.',
      },
    });
  } catch(e) { console.warn('Tauri API:', e); }
})();
