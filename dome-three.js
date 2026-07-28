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

function applyExactSphereNormals(geometry, radius) {
  const positionAttr = geometry.attributes.position;
  const normals = new Float32Array(positionAttr.count * 3);
  for (let i = 0; i < positionAttr.count; i += 1) {
    normals[i * 3] = positionAttr.getX(i) / radius;
    normals[i * 3 + 1] = positionAttr.getY(i) / radius;
    normals[i * 3 + 2] = positionAttr.getZ(i) / radius;
  }
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
}

function createSphericalBandPatch(radius, yStart, yEnd, phiRangeForRing, ySegments, phiSegments) {
  const positions = [];
  const indices = [];

  for (let i = 0; i <= ySegments; i += 1) {
    const y = yStart + ((yEnd - yStart) * i) / ySegments;
    const yClamped = Math.max(-radius * 0.99999, Math.min(radius * 0.99999, y));
    const ringRadius = Math.sqrt(Math.max(1e-10, radius * radius - yClamped * yClamped));
    const [phiStart, phiEnd] = phiRangeForRing(ringRadius);
    for (let j = 0; j <= phiSegments; j += 1) {
      const phi = phiStart + ((phiEnd - phiStart) * j) / phiSegments;
      positions.push(ringRadius * Math.cos(phi), yClamped, ringRadius * Math.sin(phi));
    }
  }

  for (let i = 0; i < ySegments; i += 1) {
    for (let j = 0; j < phiSegments; j += 1) {
      const a = i * (phiSegments + 1) + j;
      const b = a + phiSegments + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  applyExactSphereNormals(geometry, radius);
  return geometry;
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
  const halfW = Math.min(slitWidth * 0.5, radius * 0.92);
  const bandMinRing = Math.sqrt(Math.max(0, radius * radius - halfW * halfW));
  // The slit cutout runs from a straight front edge up over the zenith and
  // down to a straight back edge, so the zenith itself is inside the slit.
  // The vertical limit only constrains how far the shutter is allowed to open.
  const backTopZ = Math.min(radius * 0.97, bandMinRing * 0.985);

  // Build the dome shell from clean spherical patches so the slit cutout has
  // straight vertical sides and straight front/back edges.
  const phiFull = () => [0, Math.PI];
  const phiBelowSlit = (ringRadius) => [0, Math.asin(Math.min(1, openBottomZ / ringRadius))];
  const phiBehindSlit = (ringRadius) => [Math.PI - Math.asin(Math.min(1, backTopZ / ringRadius)), Math.PI];

  const shellPatches = [
    createSphericalBandPatch(radius, -radius, -halfW, phiFull, 48, 96),
    createSphericalBandPatch(radius, halfW, radius, phiFull, 48, 96),
    createSphericalBandPatch(radius, -halfW, halfW, phiBelowSlit, 12, 8),
    createSphericalBandPatch(radius, -halfW, halfW, phiBehindSlit, 24, 32)
  ];
  for (const patchGeometry of shellPatches) {
    slitAssembly.add(new THREE.Mesh(patchGeometry, shellMat));
  }

  // Real modelled shutter: a curved panel spanning the slit from the straight
  // front edge over the crest to the straight back edge. It slides backward
  // over the dome to open.
  const shutterOpenPctRaw = Number(config.shutterOpenPct);
  const shutterOpenFraction = Math.min(1, Math.max(0, (Number.isFinite(shutterOpenPctRaw) ? shutterOpenPctRaw : 100) / 100));
  const shutterRadius = radius * 1.018;
  const shutterHalfW = Math.min(halfW + radius * 0.035, radius * 0.96);
  const shutterZBot = Math.max(radius * 0.012, openBottomZ - radius * 0.015);
  const shutterBackZ = Math.max(radius * 0.012, backTopZ - radius * 0.03);

  const shutterMat = new THREE.MeshPhysicalMaterial({
    color: "#93a9c4",
    roughness: 0.3,
    metalness: 0.55,
    transparent: domeOpacity < 0.999,
    opacity: Math.min(1, domeOpacity + 0.15),
    side: THREE.DoubleSide,
    clearcoat: 0.4,
    clearcoatRoughness: 0.3
  });

  const shutterPhiRange = (ringRadius) => [
    Math.asin(Math.min(1, shutterZBot / ringRadius)),
    Math.PI - Math.asin(Math.min(1, shutterBackZ / ringRadius))
  ];
  const shutterMesh = new THREE.Mesh(
    createSphericalBandPatch(shutterRadius, -shutterHalfW, shutterHalfW, shutterPhiRange, 20, 72),
    shutterMat
  );
  // The shutter vertical limit caps the opening travel: at 100% open the
  // shutter front edge reaches the configured elevation limit.
  const shutterBottomEdgeRad = Math.asin(Math.min(1, shutterZBot / shutterRadius));
  const shutterTravelRad = Math.max(0.02, maxSlitOpenRad - shutterBottomEdgeRad);
  shutterMesh.rotation.y = -shutterOpenFraction * shutterTravelRad;
  slitAssembly.add(shutterMesh);

  // Static guide rails on both sides of the slit, running over the crest to
  // the back of the dome so the shutter stays on its track when open.
  const railMat = new THREE.MeshPhysicalMaterial({
    color: "#5a6c85",
    roughness: 0.42,
    metalness: 0.6,
    transparent: domeOpacity < 0.999,
    opacity: Math.min(1, domeOpacity + 0.2),
    side: THREE.DoubleSide
  });
  const railRadius = radius * 1.028;
  const railWidth = radius * 0.028;
  const railPhiRange = (ringRadius) => [
    Math.asin(Math.min(1, shutterZBot / ringRadius)),
    Math.PI * 0.97
  ];
  for (const sideSign of [-1, 1]) {
    const railInnerY = sideSign * shutterHalfW;
    const railOuterY = sideSign * (shutterHalfW + railWidth);
    const railGeometry = createSphericalBandPatch(
      railRadius,
      Math.min(railInnerY, railOuterY),
      Math.max(railInnerY, railOuterY),
      railPhiRange,
      4,
      72
    );
    slitAssembly.add(new THREE.Mesh(railGeometry, railMat));
  }

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
