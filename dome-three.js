import * as THREE from "https://esm.sh/three@0.167.1";
import { buildMountIntoGroup } from "./mount-three.js";

const MM = 0.001;

function degToRad(deg) {
  return (deg * Math.PI) / 180;
}

function normalizeHeading(deg) {
  let angle = deg % 360;
  if (angle < 0) angle += 360;
  return angle;
}

function setOrthoFrustum(camera, aspect, halfHeight, near = 0.01, far = 100) {
  const halfWidth = halfHeight * aspect;
  camera.left = -halfWidth;
  camera.right = halfWidth;
  camera.top = halfHeight;
  camera.bottom = -halfHeight;
  camera.near = near;
  camera.far = far;
  camera.updateProjectionMatrix();
}

function clearGroup(group) {
  while (group.children.length) group.remove(group.children[0]);
}

function filterGeometryTriangles(geometry, keepTriangle) {
  const source = geometry.index ? geometry.index.array : null;
  const pos = geometry.attributes.position.array;
  const triCount = source ? source.length / 3 : pos.length / 9;
  const nextIndex = [];

  const readPoint = (idx) => {
    const base = idx * 3;
    return new THREE.Vector3(pos[base], pos[base + 1], pos[base + 2]);
  };

  for (let t = 0; t < triCount; t += 1) {
    const ia = source ? source[t * 3] : t * 3;
    const ib = source ? source[t * 3 + 1] : t * 3 + 1;
    const ic = source ? source[t * 3 + 2] : t * 3 + 2;
    const a = readPoint(ia);
    const b = readPoint(ib);
    const c = readPoint(ic);
    const centroid = new THREE.Vector3().add(a).add(b).add(c).multiplyScalar(1 / 3);
    if (keepTriangle(a, b, c, centroid)) {
      nextIndex.push(ia, ib, ic);
    }
  }

  const filtered = geometry.clone();
  filtered.setIndex(nextIndex);
  filtered.computeVertexNormals();
  return filtered;
}

function addDomeGeometry(group, config) {
  const radius = Math.max(200, Number(config.domeRadiusMm) || 1500) * MM;
  const wallHeight = Math.max(200, Number(config.slitWallHeightMm) || config.domeRadiusMm || 1500) * MM;
  const slitWidth = Math.max(20, Number(config.effectiveSlitWidthMm) || 900) * MM;
  const domeOpacity = Math.min(1, Math.max(0.05, Number(config.domeOpacity) || 1));
  const domeAz = degToRad(normalizeHeading(config.domeAzimuthDeg || 0));
  const maxSlitOpenRad = degToRad(Math.min(89.5, Math.max(0, Number(config.maxSlitOpeningDeg) || 85)));

  const shellMat = new THREE.MeshPhysicalMaterial({
    color: "#c9d8ea",
    roughness: 0.34,
    metalness: 0.05,
    transparent: domeOpacity < 0.999,
    opacity: domeOpacity,
    side: THREE.DoubleSide,
    clearcoat: 0.52,
    clearcoatRoughness: 0.28
  });
  const wallMat = new THREE.MeshPhysicalMaterial({
    color: "#b9cae2",
    roughness: 0.4,
    metalness: 0.06,
    transparent: domeOpacity < 0.999,
    opacity: domeOpacity,
    side: THREE.DoubleSide
  });

  const slitAssembly = new THREE.Group();
  // App azimuth uses 0 deg at +Y (north) and +90 deg at +X (east).
  // Slit base geometry points along +X, so convert heading to scene rotation.
  slitAssembly.rotation.z = Math.PI * 0.5 - domeAz;
  group.add(slitAssembly);

  const openBottomZ = radius * 0.02;
  const desiredTopZ = Math.sin(maxSlitOpenRad) * radius;
  const openTopZ = Math.min(radius * 0.97, Math.max(openBottomZ + radius * 0.08, desiredTopZ));

  // Build a hemisphere cap and remove triangles whose centroids fall inside
  // a rectangular slit band on the forward side. This avoids CSG robustness issues.
  const capBaseGeometry = new THREE.SphereGeometry(radius, 128, 96, 0, Math.PI * 2, 0, Math.PI * 0.5);
  capBaseGeometry.rotateX(Math.PI * 0.5);

  const halfW = slitWidth * 0.5;
  const xGate = radius * 0.08;
  const capGeometry = filterGeometryTriangles(capBaseGeometry, (_a, _b, _c, centroid) => {
    const inRectY = centroid.y >= -halfW && centroid.y <= halfW;
    const inRectZ = centroid.z >= openBottomZ && centroid.z <= openTopZ;
    const inForwardBand = centroid.x >= xGate;
    return !(inRectY && inRectZ && inForwardBand);
  });

  const capMesh = new THREE.Mesh(capGeometry, shellMat);
  capMesh.material = shellMat;
  slitAssembly.add(capMesh);

  const wall = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, wallHeight, 72, 1, true), wallMat);
  wall.rotation.x = Math.PI * 0.5;
  wall.position.z = -wallHeight * 0.5;
  group.add(wall);

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(radius * 1.03, 64),
    new THREE.MeshStandardMaterial({ color: "#1b2435", roughness: 0.82, metalness: 0.08 })
  );
  floor.position.z = -wallHeight;
  group.add(floor);

  return { radius, wallHeight };
}

function addLaser(group, config, radius, mountGroup) {
  if (!config.showLaserLine) return;
  const rayFromMount = mountGroup?.userData?.activeOpticalRay || null;
  const dir = rayFromMount
    ? rayFromMount.dir.clone()
    : config.followOptical
      ? new THREE.Vector3(
          Number(config.followOptical.x) || 0,
          Number(config.followOptical.y) || 0,
          Number(config.followOptical.z) || 0
        )
      : null;
  if (!dir) return;
  if (dir.lengthSq() < 1e-8) return;
  dir.normalize();

  const start = rayFromMount
    ? rayFromMount.origin.clone()
    : new THREE.Vector3(
        (Number(config.followOpticalOrigin?.x) || 0) * MM,
        (Number(config.followOpticalOrigin?.y) || 0) * MM,
        (Number(config.followOpticalOrigin?.z) || 0) * MM
      );
  const end = start.clone().add(dir.multiplyScalar(radius * 1.25));
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([start, end]),
    new THREE.LineBasicMaterial({ color: "#7affc8", transparent: true, opacity: 0.95 })
  );
  line.renderOrder = 999;
  line.material.depthTest = false;
  line.material.depthWrite = false;
  group.add(line);

  return rayFromMount;
}

export function createDomeThreeViews({ topCanvas, sideCanvas, statusEl }) {
  const topRenderer = new THREE.WebGLRenderer({ canvas: topCanvas, antialias: true, alpha: true });
  const sideRenderer = new THREE.WebGLRenderer({ canvas: sideCanvas, antialias: true, alpha: true });
  topRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  sideRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  topRenderer.outputColorSpace = THREE.SRGBColorSpace;
  sideRenderer.outputColorSpace = THREE.SRGBColorSpace;
  topRenderer.setClearColor(0x000000, 0);
  sideRenderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  scene.up.set(0, 0, 1);

  const ambient = new THREE.HemisphereLight(0xe7f2ff, 0x162335, 1.28);
  scene.add(ambient);
  const key = new THREE.DirectionalLight(0xffffff, 1.3);
  key.position.set(2.2, -2.5, 2.8);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x9ab8e0, 0.56);
  fill.position.set(-2.8, 2.1, 1.5);
  scene.add(fill);

  const root = new THREE.Group();
  const domeGroup = new THREE.Group();
  const mountGroup = new THREE.Group();
  const laserGroup = new THREE.Group();
  root.add(domeGroup);
  root.add(mountGroup);
  root.add(laserGroup);
  scene.add(root);

  const topCamera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.01, 100);
  topCamera.position.set(0, 0, 6.5);
  topCamera.up.set(0, 1, 0);
  topCamera.lookAt(0, 0, 0);

  const sideCamera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.01, 100);
  sideCamera.up.set(0, 0, 1);

  let latestConfig = null;

  function setStatus(message) {
    if (statusEl) statusEl.textContent = message;
  }

  function resizeOne(renderer, camera, canvas, span) {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    renderer.setSize(width, height, false);
    setOrthoFrustum(camera, width / height, span);
  }

  function render() {
    if (!latestConfig) return;
    topRenderer.render(scene, topCamera);
    sideRenderer.render(scene, sideCamera);
  }

  function resize() {
    const radius = Math.max(200, Number(latestConfig?.domeRadiusMm) || 1500) * MM;
    const wallHeight = Math.max(200, Number(latestConfig?.slitWallHeightMm) || latestConfig?.domeRadiusMm || 1500) * MM;

    // Tight fit so objects use as much canvas area as possible while avoiding clipping.
    const topSpan = radius * 1.04;
    const sideSpan = Math.max(radius * 1.06, radius + wallHeight * 0.62);

    resizeOne(topRenderer, topCamera, topCanvas, topSpan);
    resizeOne(sideRenderer, sideCamera, sideCanvas, sideSpan);
    render();
  }

  function update(config) {
    latestConfig = config;
    clearGroup(domeGroup);
    clearGroup(mountGroup);
    clearGroup(laserGroup);

    const { radius } = addDomeGeometry(domeGroup, config);
    buildMountIntoGroup(mountGroup, config, null);
    const activeRay = addLaser(laserGroup, config, radius, mountGroup);

    const sideRotRad = degToRad(normalizeHeading(config.sideViewRotationDeg || 0));
    const distance = radius * 4.8;
    sideCamera.position.set(Math.sin(sideRotRad) * distance, Math.cos(sideRotRad) * distance, radius * 0.1);
    sideCamera.lookAt(0, 0, -radius * 0.2);

    setStatus(`WebGL dome views synced. Dome az ${Math.round(config.domeAzimuthDeg || 0)} deg, side rot ${Math.round(config.sideViewRotationDeg || 0)} deg.`);
    resize();

    return activeRay
      ? {
          activeOpticalRayMm: {
            scopeId: Number(activeRay.scopeId) || null,
            origin: {
              x: activeRay.origin.x / MM,
              y: activeRay.origin.y / MM,
              z: activeRay.origin.z / MM
            },
            dir: {
              x: activeRay.dir.x,
              y: activeRay.dir.y,
              z: activeRay.dir.z
            }
          }
        }
      : null;
  }

  function dispose() {
    topRenderer.dispose();
    sideRenderer.dispose();
  }

  const topObserver = new ResizeObserver(() => resize());
  const sideObserver = new ResizeObserver(() => resize());
  topObserver.observe(topCanvas);
  sideObserver.observe(sideCanvas);

  return {
    update,
    dispose
  };
}
