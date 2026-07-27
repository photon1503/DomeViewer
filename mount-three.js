import * as THREE from "https://esm.sh/three@0.167.1";
import { OrbitControls } from "https://esm.sh/three@0.167.1/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "https://esm.sh/three@0.167.1/examples/jsm/loaders/GLTFLoader.js";

const MM = 0.001;
const LOCAL_RA_AXIS = new THREE.Vector3(0, 1, 0);
const NORTH = new THREE.Vector3(0, 1, 0);
const UP = new THREE.Vector3(0, 0, 1);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function degToRad(deg) {
  return (deg * Math.PI) / 180;
}

function normalizeSignedDeg(deg) {
  let angle = deg % 360;
  if (angle < 0) angle += 360;
  if (angle > 180) angle -= 360;
  return angle;
}

function v3(x, y, z) {
  return new THREE.Vector3(x, y, z);
}

function v3Norm(v) {
  const out = v.clone();
  const len = out.length();
  if (len < 1e-9) return out.set(0, 0, 0);
  return out.multiplyScalar(1 / len);
}

function getEqPierSide(mount) {
  if ((mount.pierSideMode ?? "AUTO") === "MANUAL") return mount.pierSide === "EAST" ? "EAST" : "WEST";
  return normalizeSignedDeg(mount.hourAngleDeg ?? 0) < 0 ? "WEST" : "EAST";
}

function getScopePointing(latitudeDeg, mount) {
  const lat = degToRad(clamp(latitudeDeg, -89.5, 89.5));
  const hourAngle = degToRad(normalizeSignedDeg(mount.hourAngleDeg ?? 0));
  const declination = degToRad(clamp(mount.declinationDeg ?? 0, -90, 90));
  const sinAlt = Math.sin(lat) * Math.sin(declination) + Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle);
  const east = -Math.cos(declination) * Math.sin(hourAngle);
  const north = Math.sin(declination) * Math.cos(lat) - Math.cos(declination) * Math.sin(lat) * Math.cos(hourAngle);
  return v3Norm(v3(east, north, sinAlt));
}

function getPiggybackDir(optical, sideDir) {
  const piggy = new THREE.Vector3().crossVectors(optical, sideDir);
  if (piggy.length() < 1e-6) return UP.clone();
  piggy.normalize();
  if (piggy.dot(UP) < 0) piggy.multiplyScalar(-1);
  return piggy;
}

function createPhysicalMaterial(color, roughness = 0.56, metalness = 0.44) {
  return new THREE.MeshPhysicalMaterial({
    color,
    roughness,
    metalness,
    clearcoat: 0.2,
    clearcoatRoughness: 0.24
  });
}

function makeCylinder(lengthMm, radiusMm, material) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radiusMm * MM, radiusMm * MM, lengthMm * MM, 28), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function makeBox(sizeX, sizeY, sizeZ, material) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(sizeX * MM, sizeY * MM, sizeZ * MM), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function makeRing(radiusMm, tubeRadiusMm, material, radialSegments = 26, tubularSegments = 60) {
  const mesh = new THREE.Mesh(new THREE.TorusGeometry(radiusMm * MM, tubeRadiusMm * MM, radialSegments, tubularSegments), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function addRodBetween(group, start, end, radiusMm, material) {
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length < 1e-6) return null;
  const rod = makeCylinder(length / MM, radiusMm, material);
  rod.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.clone().normalize());
  rod.position.copy(start).addScaledVector(delta, 0.5);
  group.add(rod);
  return rod;
}

function buildRcTrussOta(scopeGroup, tubeLenMm, tubeRadiusMm) {
  const carbonMat = createPhysicalMaterial("#24282e", 0.42, 0.48);
  const blackMat = createPhysicalMaterial("#14171c", 0.58, 0.36);
  const redMat = createPhysicalMaterial("#ad2d25", 0.32, 0.38);
  const spiderMat = createPhysicalMaterial("#d7dee9", 0.16, 0.14);

  const rearCellLen = Math.max(150, tubeLenMm * 0.22);
  const frontRingZ = tubeLenMm * 0.32 * MM;
  const rearRingZ = -tubeLenMm * 0.12 * MM;
  const trussRadius = tubeRadiusMm * 0.72;

  const rearCell = makeCylinder(rearCellLen, tubeRadiusMm * 0.68, blackMat);
  rearCell.rotation.x = Math.PI * 0.5;
  rearCell.position.z = -tubeLenMm * 0.08 * MM;
  scopeGroup.add(rearCell);

  const backPlate = new THREE.Mesh(new THREE.CylinderGeometry(tubeRadiusMm * 0.72 * MM, tubeRadiusMm * 0.72 * MM, 18 * MM, 32), blackMat);
  backPlate.rotation.x = Math.PI * 0.5;
  backPlate.position.z = rearCell.position.z - rearCellLen * 0.5 * MM;
  backPlate.castShadow = true;
  backPlate.receiveShadow = true;
  scopeGroup.add(backPlate);

  const frontRing = makeRing(trussRadius, 10, carbonMat);
  frontRing.position.z = frontRingZ;
  scopeGroup.add(frontRing);

  const rearRing = makeRing(trussRadius * 0.97, 11, carbonMat);
  rearRing.position.z = rearRingZ;
  scopeGroup.add(rearRing);

  const frontPlate = makeRing(trussRadius * 0.94, 11, blackMat);
  frontPlate.position.z = frontRingZ + 10 * MM;
  scopeGroup.add(frontPlate);

  const rodMat = createPhysicalMaterial("#1f2329", 0.28, 0.68);
  for (let i = 0; i < 8; i += 1) {
    const angleA = (i / 8) * Math.PI * 2;
    const angleB = angleA + Math.PI / 8;
    const rear = new THREE.Vector3(Math.cos(angleA) * trussRadius * MM, Math.sin(angleA) * trussRadius * MM, rearRingZ);
    const front = new THREE.Vector3(Math.cos(angleB) * trussRadius * MM, Math.sin(angleB) * trussRadius * MM, frontRingZ);
    addRodBetween(scopeGroup, rear, front, 5.2, rodMat);
  }

  const baffle = makeCylinder(Math.max(140, tubeLenMm * 0.18), tubeRadiusMm * 0.26, blackMat);
  baffle.rotation.x = Math.PI * 0.5;
  baffle.position.z = tubeLenMm * 0.08 * MM;
  scopeGroup.add(baffle);

  const focuser = makeCylinder(72, 18, blackMat);
  focuser.rotation.z = Math.PI * 0.5;
  focuser.position.set(0, tubeRadiusMm * 0.56 * MM, frontRingZ - 24 * MM);
  scopeGroup.add(focuser);

  const focuserPlate = makeBox(52, 14, 36, redMat);
  focuserPlate.position.set(0, tubeRadiusMm * 0.64 * MM, frontRingZ - 28 * MM);
  scopeGroup.add(focuserPlate);

  for (let i = 0; i < 4; i += 1) {
    const angle = (i / 4) * Math.PI * 2;
    const vane = addRodBetween(
      scopeGroup,
      new THREE.Vector3(Math.cos(angle) * trussRadius * 0.45 * MM, Math.sin(angle) * trussRadius * 0.45 * MM, frontRingZ + 6 * MM),
      new THREE.Vector3(0, 0, frontRingZ + 6 * MM),
      1.4,
      spiderMat
    );
    if (vane) vane.material = spiderMat;
  }
}

function buildEqScene(root, config, importedAsset) {
  const mount = config.mount;
  const latitudeDeg = config.latitudeDeg;
  const latAbs = degToRad(clamp(Math.abs(latitudeDeg), 0, 89.5));
  const hemiSign = latitudeDeg >= 0 ? 1 : -1;
  const raUnit = v3Norm(v3(0, hemiSign * Math.cos(latAbs), Math.sin(latAbs)));
  const raQuat = new THREE.Quaternion().setFromUnitVectors(LOCAL_RA_AXIS, raUnit.clone().normalize());
  const hourAngleRad = degToRad(normalizeSignedDeg(mount.hourAngleDeg ?? 0));
  const declinationRad = degToRad(clamp(mount.declinationDeg ?? 0, -90, 90));
  const pierSideSign = getEqPierSide(mount) === "EAST" ? 1 : -1;

  const headGroup = new THREE.Group();
  headGroup.quaternion.copy(raQuat);
  headGroup.position.z = 102 * MM;
  root.add(headGroup);

  const haGroup = new THREE.Group();
  haGroup.rotation.y = -hourAngleRad;
  headGroup.add(haGroup);

  const decRotGroup = new THREE.Group();
  decRotGroup.rotation.x = -declinationRad;
  haGroup.add(decRotGroup);

  const pierMat = createPhysicalMaterial("#d9e1ec", 0.2, 0.18);
  const darkMat = createPhysicalMaterial("#34373f", 0.58, 0.42);
  const darkerMat = createPhysicalMaterial("#1c1f25", 0.66, 0.44);
  const accentMat = createPhysicalMaterial("#b74a22", 0.36, 0.34);
  const shaftMat = createPhysicalMaterial("#eef2f8", 0.16, 0.14);
  const panelMat = createPhysicalMaterial("#2a2e35", 0.52, 0.4);

  const baseDisk = new THREE.Mesh(new THREE.CylinderGeometry(138 * MM, 152 * MM, 42 * MM, 42), darkerMat);
  baseDisk.rotation.x = Math.PI * 0.5;
  baseDisk.position.z = -150 * MM;
  baseDisk.castShadow = true;
  baseDisk.receiveShadow = true;
  root.add(baseDisk);

  const baseAccent = new THREE.Mesh(new THREE.CylinderGeometry(150 * MM, 160 * MM, 10 * MM, 40), accentMat);
  baseAccent.rotation.x = Math.PI * 0.5;
  baseAccent.position.z = -171 * MM;
  baseAccent.castShadow = true;
  baseAccent.receiveShadow = true;
  root.add(baseAccent);

  const pier = makeCylinder(1180, 22, pierMat);
  pier.rotation.x = Math.PI * 0.5;
  pier.position.z = -625 * MM;
  root.add(pier);

  const pierCap = new THREE.Mesh(new THREE.CylinderGeometry(84 * MM, 90 * MM, 40 * MM, 32), accentMat);
  pierCap.rotation.x = Math.PI * 0.5;
  pierCap.position.z = -38 * MM;
  pierCap.castShadow = true;
  pierCap.receiveShadow = true;
  root.add(pierCap);

  const yokeLeft = makeBox(46, 122, 190, panelMat);
  yokeLeft.position.set(-122 * MM, -26 * MM, -126 * MM);
  yokeLeft.rotation.x = -0.18;
  root.add(yokeLeft);

  const yokeRight = makeBox(46, 122, 190, panelMat);
  yokeRight.position.set(122 * MM, -26 * MM, -126 * MM);
  yokeRight.rotation.x = -0.18;
  root.add(yokeRight);

  const yokeBridge = makeBox(246, 56, 74, darkerMat);
  yokeBridge.position.set(0, -58 * MM, -184 * MM);
  root.add(yokeBridge);

  const encoderLeft = new THREE.Mesh(new THREE.CylinderGeometry(52 * MM, 52 * MM, 30 * MM, 28), darkerMat);
  encoderLeft.rotation.y = Math.PI * 0.5;
  encoderLeft.position.set(-132 * MM, 10 * MM, -10 * MM);
  encoderLeft.castShadow = true;
  encoderLeft.receiveShadow = true;
  root.add(encoderLeft);

  const encoderRight = new THREE.Mesh(new THREE.CylinderGeometry(52 * MM, 52 * MM, 30 * MM, 28), darkerMat);
  encoderRight.rotation.y = Math.PI * 0.5;
  encoderRight.position.set(132 * MM, 10 * MM, -10 * MM);
  encoderRight.castShadow = true;
  encoderRight.receiveShadow = true;
  root.add(encoderRight);

  const raBody = makeCylinder(274, 74, darkMat);
  raBody.position.y = -110 * MM;
  raBody.position.z = -14 * MM;
  headGroup.add(raBody);

  const raShroud = makeCylinder(214, 84, createPhysicalMaterial("#3c4047", 0.52, 0.38));
  raShroud.position.y = -144 * MM;
  raShroud.position.z = -34 * MM;
  headGroup.add(raShroud);

  const raCollar = new THREE.Mesh(new THREE.CylinderGeometry(76 * MM, 76 * MM, 62 * MM, 30), accentMat);
  headGroup.add(raCollar);
  raCollar.castShadow = true;
  raCollar.receiveShadow = true;
  raCollar.position.z = -8 * MM;

  const decHousingHalfLen = Math.min(176, Math.max(128, (Number(config.scopes[0]?.gemAxisLength) || 435) * 0.18));
  const decBody = makeCylinder(decHousingHalfLen * 2, 58, createPhysicalMaterial("#41464f", 0.44, 0.36));
  decBody.rotation.z = Math.PI * 0.5;
  decRotGroup.add(decBody);

  const decMotor = makeCylinder(136, 48, createPhysicalMaterial("#2b2f37", 0.54, 0.38));
  decMotor.position.x = -30 * MM;
  decMotor.rotation.z = Math.PI * 0.5;
  decRotGroup.add(decMotor);

  const decFrontCap = new THREE.Mesh(new THREE.CylinderGeometry(64 * MM, 64 * MM, 22 * MM, 28), createPhysicalMaterial("#575c65", 0.34, 0.28));
  decFrontCap.rotation.z = Math.PI * 0.5;
  decFrontCap.position.x = (decHousingHalfLen - 18) * MM;
  decRotGroup.add(decFrontCap);

  const decRearCap = new THREE.Mesh(new THREE.CylinderGeometry(60 * MM, 60 * MM, 18 * MM, 28), createPhysicalMaterial("#333840", 0.5, 0.34));
  decRearCap.rotation.z = Math.PI * 0.5;
  decRearCap.position.x = (-decHousingHalfLen + 16) * MM;
  decRotGroup.add(decRearCap);

  const scopeEndX = (decHousingHalfLen + 180) * pierSideSign;
  const counterEndDir = -pierSideSign;

  const cwLen = Math.max(120, Number(mount.counterweightShaftLengthMm) || 820);
  const cwDiameter = Math.max(30, Number(mount.counterweightDiameterMm) || 170);
  const cwShaft = makeCylinder(cwLen, 9, shaftMat);
  cwShaft.rotation.z = Math.PI * 0.5;
  cwShaft.position.x = counterEndDir * cwLen * 0.5 * MM;
  decRotGroup.add(cwShaft);

  const cwThickness = Math.max(45, cwDiameter * 0.42);
  const outerWeight = makeCylinder(cwThickness, cwDiameter * 0.5, createPhysicalMaterial("#d9e1ee", 0.18, 0.16));
  outerWeight.rotation.z = Math.PI * 0.5;
  outerWeight.position.x = counterEndDir * cwLen * 0.9 * MM;
  decRotGroup.add(outerWeight);

  const innerWeight = makeCylinder(cwThickness * 0.9, cwDiameter * 0.48, createPhysicalMaterial("#eef3fb", 0.12, 0.14));
  innerWeight.rotation.z = Math.PI * 0.5;
  innerWeight.position.x = counterEndDir * cwLen * 0.74 * MM;
  decRotGroup.add(innerWeight);

  const pointing = getScopePointing(latitudeDeg, mount);
  const sideDir = v3Norm(v3RotateAroundAxis(v3(1, 0, 0), raUnit, -hourAngleRad)).multiplyScalar(pierSideSign);
  const optical = pointing.clone();
  const piggyDir = getPiggybackDir(optical, sideDir);

  config.scopes.forEach((scope, index) => {
    const gemAxisLength = Math.max(70, Number(scope.gemAxisLength) || 435);
    const saddleLift = Math.min(88, Math.max(42, gemAxisLength * 0.12));
    const lateralAxisLength = Number(scope.lateralAxisLength) || 0;
    const sideOffsetMm = scope.otaLayout === "SIDE_BY_SIDE" ? lateralAxisLength + (Number(scope.otaSideOffsetMm) || 0) : 0;
    const piggyOffsetMm = scope.otaLayout === "PIGGYBACK" ? Number(scope.otaPiggybackOffsetMm) || 0 : 0;
    const tubeLen = Math.max(120, Number(scope.tubeLengthMm) || 760);
    const tubeRadius = Math.max(24, (Number(scope.telescopeDiameterMm) || 120) * 0.5);
    const scopeGroup = new THREE.Group();
    scopeGroup.position.set(
      (scopeEndX + sideOffsetMm * pierSideSign) * MM,
      0,
      (saddleLift + piggyOffsetMm) * MM
    );
    decRotGroup.add(scopeGroup);

    const support = makeBox(72, 42, Math.max(40, saddleLift), darkerMat);
    support.position.set(0, 0, -Math.max(40, saddleLift) * 0.5 * MM + 4 * MM);
    scopeGroup.add(support);

    const saddle = makeBox(186, 78, 34, createPhysicalMaterial("#20242b", 0.52, 0.38));
    saddle.position.z = 12 * MM;
    scopeGroup.add(saddle);

    const saddleTower = makeBox(62, 48, 54, createPhysicalMaterial("#272b32", 0.48, 0.34));
    saddleTower.position.z = 20 * MM;
    scopeGroup.add(saddleTower);

    const dovetail = makeBox(138, 46, 16, createPhysicalMaterial("#434953", 0.34, 0.26));
    dovetail.position.z = 38 * MM;
    scopeGroup.add(dovetail);

    const otaMount = new THREE.Group();
    otaMount.position.set(0, 0, 42 * MM);
    scopeGroup.add(otaMount);

    if (index === 0) {
      buildRcTrussOta(otaMount, Math.max(680, tubeLen), Math.max(70, tubeRadius * 1.55));
    } else {
      const tubeMat = createPhysicalMaterial(["#ff9f6e", "#bba4ff", "#71f3a9", "#ffd56f", "#ff7bb5"][index - 1] || "#7ad7ff", 0.28, 0.18);
      const tube = makeCylinder(tubeLen, tubeRadius, tubeMat);
      tube.rotation.x = Math.PI * 0.5;
      tube.position.z = tubeLen * MM / 6 + (tubeRadius + 18) * MM;
      otaMount.add(tube);

      const aperture = new THREE.Mesh(new THREE.CylinderGeometry(tubeRadius * 0.98 * MM, tubeRadius * 0.9 * MM, 12 * MM, 28), createPhysicalMaterial("#dde7f4", 0.14, 0.1));
      aperture.rotation.x = Math.PI * 0.5;
      aperture.position.z = tube.position.z + tubeLen * MM * 0.5;
      aperture.castShadow = true;
      aperture.receiveShadow = true;
      otaMount.add(aperture);
    }
  });

  if (importedAsset) {
    attachImportedAsset(root, headGroup, haGroup, decRotGroup, importedAsset);
  }
}

function v3RotateAroundAxis(v, axis, angleRad) {
  const k = v3Norm(axis);
  const cosA = Math.cos(angleRad);
  const sinA = Math.sin(angleRad);
  const cross = new THREE.Vector3().crossVectors(k, v);
  return v.clone().multiplyScalar(cosA).add(cross.multiplyScalar(sinA)).add(k.multiplyScalar(k.dot(v) * (1 - cosA)));
}

function attachImportedAsset(root, headGroup, haGroup, decRotGroup, importedAsset) {
  const instance = importedAsset.template.clone(true);
  normalizeImportedInstance(instance, importedAsset.targetHeight);
  const buckets = classifyImportedNodes(instance);
  const baseAnchor = new THREE.Group();
  const raAnchor = new THREE.Group();
  const decAnchor = new THREE.Group();
  const saddleAnchor = new THREE.Group();
  const cwAnchor = new THREE.Group();
  root.add(baseAnchor);
  headGroup.add(raAnchor);
  decRotGroup.add(decAnchor, saddleAnchor, cwAnchor);
  baseAnchor.add(instance);

  const reparent = (obj, parent) => {
    if (!obj) return;
    parent.attach(obj);
  };

  reparent(buckets.ra, raAnchor);
  reparent(buckets.dec, decAnchor);
  reparent(buckets.saddle, saddleAnchor);
  reparent(buckets.counterweight, cwAnchor);
  reparent(buckets.ota, saddleAnchor);
}

function normalizeImportedInstance(root, targetHeight) {
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  box.getSize(size);
  const height = Math.max(size.z, size.y, 1e-3);
  const scale = targetHeight / height;
  root.scale.setScalar(scale);
  root.updateMatrixWorld(true);
  const recentered = new THREE.Box3().setFromObject(root);
  const center = new THREE.Vector3();
  recentered.getCenter(center);
  root.position.sub(center);
  root.position.z -= recentered.min.z;
}

function classifyImportedNodes(root) {
  const roles = {
    ra: null,
    dec: null,
    saddle: null,
    counterweight: null,
    ota: null
  };
  root.traverse((obj) => {
    if (obj === root || rolesAllFound(roles) || !obj.name) return;
    const lower = obj.name.toLowerCase();
    if (!roles.counterweight && /(counter|cw)/.test(lower)) roles.counterweight = obj;
    else if (!roles.saddle && /(saddle|dovetail|plate)/.test(lower)) roles.saddle = obj;
    else if (!roles.dec && /dec/.test(lower)) roles.dec = obj;
    else if (!roles.ra && /(ra|polar)/.test(lower)) roles.ra = obj;
    else if (!roles.ota && /(ota|tube|scope)/.test(lower)) roles.ota = obj;
  });
  return roles;
}

function rolesAllFound(roles) {
  return roles.ra && roles.dec && roles.saddle && roles.counterweight && roles.ota;
}

function buildAzScene(root, config) {
  const mount = config.mount;
  const pierMat = createPhysicalMaterial("#cfd8e5", 0.32, 0.28);
  const bodyMat = createPhysicalMaterial("#2f343d", 0.54, 0.42);
  const pier = makeCylinder(1200, 24, pierMat);
  pier.position.z = -600 * MM;
  root.add(pier);
  const body = makeBox(180, 160, 240, bodyMat);
  body.position.z = 80 * MM;
  root.add(body);

  const azGroup = new THREE.Group();
  azGroup.rotation.z = -degToRad(mount.azimuth ?? 0);
  root.add(azGroup);
  const altGroup = new THREE.Group();
  altGroup.rotation.x = -degToRad(clamp(mount.elevation ?? 0, 0, 89));
  azGroup.add(altGroup);

  const fork = makeCylinder(260, 34, createPhysicalMaterial("#606875", 0.44, 0.32));
  fork.rotation.z = Math.PI * 0.5;
  altGroup.add(fork);
  const tube = makeCylinder(760, 60, createPhysicalMaterial("#75d6ff", 0.26, 0.16));
  tube.rotation.x = Math.PI * 0.5;
  tube.position.z = 380 * MM * 0.5;
  altGroup.add(tube);
}

function frameObject(camera, controls, object, direction, padding = 1.28) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  box.getCenter(center);
  box.getSize(size);
  const radius = Math.max(size.x, size.y, size.z) * 0.5;
  const fov = degToRad(camera.fov);
  const distance = (radius * padding) / Math.tan(fov * 0.5);
  const viewDir = direction.clone().normalize();
  camera.position.copy(center).addScaledVector(viewDir, distance);
  controls.target.copy(center);
  camera.near = Math.max(0.05, distance * 0.02);
  camera.far = Math.max(20, distance * 12);
  camera.updateProjectionMatrix();
  controls.update();
}

export function createMountThreeView({ canvas, statusEl }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  scene.up.set(0, 0, 1);

  const defaultViewDirection = new THREE.Vector3(2.55, -1.1, 0.26);

  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
  camera.up.set(0, 0, 1);
  camera.position.set(-2.95, 2.3, 0.72);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 0.65;
  controls.maxDistance = 8;
  controls.target.set(0.0, -0.06, -0.34);
  controls.update();

  const ambient = new THREE.HemisphereLight(0xe7f2ff, 0x172132, 1.4);
  scene.add(ambient);
  const key = new THREE.DirectionalLight(0xffffff, 1.7);
  key.position.set(2.2, -2.8, 3.4);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x9bb8de, 0.65);
  fill.position.set(-2.8, 2.4, 1.8);
  scene.add(fill);

  const root = new THREE.Group();
  scene.add(root);

  const loader = new GLTFLoader();
  let importedAsset = null;
  let objectUrl = null;
  let latestConfig = null;
  let animationFrameId = null;

  function setStatus(message) {
    if (statusEl) statusEl.textContent = message;
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    render();
  }

  function resetView() {
    if (root.children.length > 0) {
      frameObject(camera, controls, root, defaultViewDirection, 1.35);
    } else {
      camera.position.set(-2.95, 2.3, 0.72);
      controls.target.set(0.0, -0.06, -0.34);
    }
    controls.update();
    render();
  }

  function clearRoot() {
    while (root.children.length) root.remove(root.children[0]);
  }

  function render() {
    renderer.render(scene, camera);
  }

  function animate() {
    controls.update();
    render();
    animationFrameId = requestAnimationFrame(animate);
  }

  async function loadGlbFromUrl(url) {
    if (!url) {
      setStatus("Enter a GLB URL to import a mount model.");
      return;
    }
    setStatus("Loading GLB model...");
    const gltf = await loader.loadAsync(url);
    importedAsset = {
      template: gltf.scene,
      name: url.split("/").pop() || "GLB model",
      targetHeight: 0.95
    };
    if (latestConfig) update({ ...latestConfig, mountViewMode: "GLB" });
  }

  async function loadGlbFromFile(file) {
    if (!file) return;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    await loadGlbFromUrl(objectUrl);
    if (importedAsset) importedAsset.name = file.name;
  }

  function update(config) {
    latestConfig = config;
    clearRoot();
    const mountRoot = new THREE.Group();
    root.add(mountRoot);
    if (config.mount.mountType === "EQ") {
      buildEqScene(mountRoot, config, config.mountViewMode === "GLB" ? importedAsset : null);
    } else {
      buildAzScene(mountRoot, config);
    }

    frameObject(camera, controls, mountRoot, defaultViewDirection, config.mount.mountType === "EQ" ? 1.32 : 1.24);

    const modeLabel = config.mountViewMode === "GLB"
      ? importedAsset
        ? `GLB mode: ${importedAsset.name}. Orbit with drag, wheel to zoom.`
        : "GLB mode selected. Load a split-node GLB to bind RA/DEC joints."
      : `Procedural ASA DDM100-inspired mount with RC truss OTA. A ${Math.round(config.domeRadiusMm + config.mount.posUD)} mm, HA ${Math.round(config.mount.hourAngleDeg)} deg, Dec ${Math.round(config.mount.declinationDeg)} deg.`;
    setStatus(modeLabel);
    render();
  }

  function dispose() {
    if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
    controls.dispose();
    renderer.dispose();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }

  const observer = new ResizeObserver(() => resize());
  observer.observe(canvas);
  controls.addEventListener("change", render);
  resize();
  animate();

  return {
    update,
    loadGlbFromUrl,
    loadGlbFromFile,
    resetView,
    dispose
  };
}
