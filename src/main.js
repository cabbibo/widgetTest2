import * as THREE from 'three';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
camera.position.z = 3;

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, premultipliedAlpha: false });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0);
document.body.appendChild(renderer.domElement);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function createNormalMap(size = 512) {
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(size, size);
  const d = imageData.data;
  const heights = new Float32Array(size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = x/size, v = y/size;
      heights[y*size+x] = Math.sin(u*Math.PI*12)*Math.sin(v*Math.PI*12)*0.5
        + Math.sin(u*Math.PI*4+0.7)*Math.sin(v*Math.PI*4+0.7)*0.3;
    }
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const l=heights[y*size+((x-1+size)%size)], r=heights[y*size+((x+1)%size)];
      const u=heights[((y-1+size)%size)*size+x], dn=heights[((y+1)%size)*size+x];
      let nx=(l-r)*4, ny=(u-dn)*4, nz=1;
      const len=Math.sqrt(nx*nx+ny*ny+nz*nz);
      nx/=len; ny/=len; nz/=len;
      const i=(y*size+x)*4;
      d[i]=Math.round((nx*0.5+0.5)*255);
      d[i+1]=Math.round((ny*0.5+0.5)*255);
      d[i+2]=Math.round((nz*0.5+0.5)*255);
      d[i+3]=255;
    }
  ctx.putImageData(imageData, 0, 0);
  return new THREE.CanvasTexture(canvas);
}

const normalMap = createNormalMap(512);
normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping;
normalMap.repeat.set(2, 2);

const cube = new THREE.Mesh(
  new THREE.BoxGeometry(1.5, 1.5, 1.5),
  new THREE.MeshStandardMaterial({
    color: 0x4488ff, normalMap,
    normalScale: new THREE.Vector2(2, 2),
    roughness: 0.3, metalness: 0.6,
  })
);
scene.add(cube);
scene.add(new THREE.AmbientLight(0xffffff, 0.4));
const l1 = new THREE.PointLight(0xffffff, 3, 10);
l1.position.set(3, 3, 3); scene.add(l1);
const l2 = new THREE.PointLight(0x8899ff, 1.5, 10);
l2.position.set(-3, -2, 2); scene.add(l2);

(function animate() {
  requestAnimationFrame(animate);
  cube.rotation.x += 0.005;
  cube.rotation.y += 0.009;
  renderer.render(scene, camera);
})();

(async () => {
  try {
    const { getCurrentWindow, currentMonitor } = window.__TAURI__.window;
    const { LogicalPosition } = window.__TAURI__.dpi;
    const appWindow = getCurrentWindow();
    const monitor = await currentMonitor();
    if (monitor) {
      const sw = monitor.size.width / monitor.scaleFactor;
      const sh = monitor.size.height / monitor.scaleFactor;
      await appWindow.setPosition(new LogicalPosition(sw/2 - 200, sh/2 - 200));
    }
    document.addEventListener('mousedown', () => appWindow.startDragging());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') appWindow.close(); });
  } catch(e) {
    console.warn('Tauri API:', e);
  }
})();
