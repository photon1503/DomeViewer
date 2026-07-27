const NS = "http://www.w3.org/2000/svg";
const MAX_SLIT_OPENING_DEG = 85;

const palette = ["#7ad7ff", "#ff9f6e", "#bba4ff", "#71f3a9", "#ffd56f", "#ff7bb5"];

const state = {
  domeRadiusMm: 1500,
  slitWidthMm: 1100,
  maxSlitOpeningDeg: 85,
  slitWallHeightMm: 1500,
  azToleranceDeg: 2,
  latitudeDeg: 48,
  domeAzimuthDeg: 0,
  domeFollowsTelescope: true,
  followScopeId: 1,
  simulateDomeSlew: false,
  domeSlewSpeedDegPerSec: 7,
  domeAccelDegPerSec2: 4,
  domeDecelDegPerSec2: 5,
  domeSettleTimeSec: 0.6,
  sideViewRotationDeg: 0,
  showLaserLine: true,
  mountViewMode: "PROCEDURAL",
  mountModelUrl: "",
  telescopes: [createScope(1)]
};

const runtime = {
  currentDomeAzimuthDeg: 0,
  domeAngularVelDegPerSec: 0,
  settleUntilMs: 0,
  rafId: null,
  lastTsMs: 0,
  trackingRafId: null,
  trackingScopeId: null,
  trackingStartTsMs: 0,
  trackingDurationMs: 9000,
  trackingStartHaDeg: 0,
  trackingEndHaDeg: 0,
  trackingPauseUntilMs: 0,
  trackingLastPierSide: null,
  trackingOriginalPierSideMode: null,
  trackingOriginalPierSide: null,
  mountThreeView: null,
  mountThreeInitPromise: null,
  mountViewYawDeg: -36,
  mountViewPitchDeg: 18,
  mountViewDragging: false,
  mountViewLastX: 0,
  mountViewLastY: 0
};

let nextScopeId = 2;

const globalControls = [
  { key: "domeRadiusMm", label: "Dome Radius (mm)", min: 500, max: 12000, step: 10 },
  { key: "slitWidthMm", label: "Slit Width (mm)", min: 100, max: 20000, step: 10 },
  { key: "maxSlitOpeningDeg", label: "Shutter Vertical Limit (deg)", min: 5, max: 85, step: 1 },
  { key: "slitWallHeightMm", label: "Slit Wall Height (mm)", min: 300, max: 12000, step: 10 },
  { key: "azToleranceDeg", label: "Azimuth Tolerance (deg)", min: 0, max: 30, step: 1 },
  { key: "latitudeDeg", label: "Latitude (deg)", min: -89, max: 89, step: 0.1 },
  { key: "sideViewRotationDeg", label: "Side View Rotation (deg)", min: 0, max: 359, step: 1 }
];

const domeSimControls = [
  { key: "domeAzimuthDeg", label: "Dome Azimuth (deg)", min: 0, max: 359, step: 1 },
  { key: "domeSlewSpeedDegPerSec", label: "Dome Slew Speed (deg/s)", min: 0.2, max: 40, step: 0.1 },
  { key: "domeAccelDegPerSec2", label: "Dome Accel (deg/s^2)", min: 0.2, max: 100, step: 0.1 },
  { key: "domeDecelDegPerSec2", label: "Dome Decel (deg/s^2)", min: 0.2, max: 100, step: 0.1 },
  { key: "domeSettleTimeSec", label: "Settle Time (s)", min: 0, max: 30, step: 0.1 }
];

function createScope(idx) {
  return {
    id: idx,
    name: idx === 1 ? "RC Truss OTA" : `Telescope ${idx}`,
    otaLayout: idx === 1 ? "PRIMARY" : "SIDE_BY_SIDE",
    otaSideOffsetMm: idx === 1 ? 0 : 320,
    otaPiggybackOffsetMm: idx === 1 ? 0 : 180,
    mountType: "EQ",
    posNS: 80,
    posEW: 0,
    posUD: 272,
    gemAxisLength: idx === 1 ? 310 : 435,
    lateralAxisLength: idx === 1 ? 0 : 230,
    counterweightShaftLengthMm: 820,
    counterweightDiameterMm: 170,
    telescopeDiameterMm: idx === 1 ? 320 : 120,
    tubeLengthMm: idx === 1 ? 1080 : 760,
    hourAngleDeg: -12,
    declinationDeg: 68,
    pierSideMode: "AUTO",
    pierSide: "WEST",
    azimuth: 30,
    elevation: 42
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function degToRad(deg) {
  return (deg * Math.PI) / 180;
}

function normalizeHeading(deg) {
  let angle = deg % 360;
  if (angle < 0) angle += 360;
  return angle;
}

function normalizeSignedDeg(deg) {
  let angle = normalizeHeading(deg);
  if (angle > 180) angle -= 360;
  return angle;
}

function signedDeltaDeg(a, b) {
  const raw = normalizeHeading(a) - normalizeHeading(b);
  if (raw > 180) return raw - 360;
  if (raw < -180) return raw + 360;
  return raw;
}

function inSlit(angleDeg, slitSizeDeg, tolerance) {
  const half = slitSizeDeg / 2 + tolerance;
  const dist = Math.abs(((angleDeg + 180) % 360) - 180);
  return dist <= half;
}

function computeSlitOpeningDeg() {
  const radius = Math.max(1, state.domeRadiusMm);
  const width = Math.max(0, state.slitWidthMm);
  const raw = (width / radius) * (180 / Math.PI);
  return clamp(raw, 0, 170);
}

function getEffectiveSlitWidthMm() {
  const openingDeg = computeSlitOpeningDeg();
  return state.domeRadiusMm * degToRad(openingDeg);
}

function getFollowScope() {
  return state.telescopes.find((scope) => scope.id === Number(state.followScopeId)) ?? null;
}

function getMountScope() {
  return state.telescopes[0] ?? null;
}

function getOtaOffset(scope, optical, sideDir) {
  const layout = scope.otaLayout ?? "PRIMARY";
  const sideOffset = layout === "PRIMARY" ? 0 : Number(scope.otaSideOffsetMm) || 0;
  const piggybackHeight = layout === "PIGGYBACK" ? Number(scope.otaPiggybackOffsetMm) || 0 : 0;
  let piggybackDir = v3Norm(v3Cross(optical, sideDir));
  if (Math.hypot(piggybackDir.x, piggybackDir.y, piggybackDir.z) < 1e-6) piggybackDir = v3(0, 0, 1);
  if (v3Dot(piggybackDir, v3(0, 0, 1)) < 0) piggybackDir = v3Scale(piggybackDir, -1);
  return v3Add(v3Scale(sideDir, sideOffset), v3Scale(piggybackDir, piggybackHeight));
}

function getMountAxisPoint(scope = getMountScope()) {
  const mountScope = scope ?? getMountScope();
  if (!mountScope) return v3(0, 0, state.domeRadiusMm);
  return v3(mountScope.posEW, mountScope.posNS, state.domeRadiusMm + mountScope.posUD);
}

function getEqPierSide(scope) {
  const mountScope = getMountScope() ?? scope;
  if (mountScope.mountType !== "EQ") return null;
  if ((mountScope.pierSideMode ?? "AUTO") === "MANUAL") {
    return mountScope.pierSide === "EAST" ? "EAST" : "WEST";
  }
  return normalizeSignedDeg(mountScope.hourAngleDeg ?? 0) < 0 ? "WEST" : "EAST";
}

function getScopePointing(scope) {
  const mountScope = getMountScope() ?? scope;

  if (mountScope.mountType !== "EQ") {
    const azimuthDeg = normalizeHeading(mountScope.azimuth);
    const elevationDeg = clamp(mountScope.elevation, 0, 89);
    const az = degToRad(azimuthDeg);
    const el = degToRad(elevationDeg);
    const horiz = v3(Math.sin(az), Math.cos(az), 0);
    const optical = v3Norm(v3Add(v3Scale(horiz, Math.cos(el)), v3(0, 0, Math.sin(el))));
    return { optical, azimuthDeg, elevationDeg };
  }

  const lat = degToRad(clamp(state.latitudeDeg, -89.5, 89.5));
  const hourAngle = degToRad(normalizeSignedDeg(mountScope.hourAngleDeg ?? 0));
  const declination = degToRad(clamp(mountScope.declinationDeg ?? 0, -90, 90));

  const sinAlt = Math.sin(lat) * Math.sin(declination) + Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle);
  const elevationDeg = (Math.asin(clamp(sinAlt, -1, 1)) * 180) / Math.PI;

  const east = -Math.cos(declination) * Math.sin(hourAngle);
  const north = Math.sin(declination) * Math.cos(lat) - Math.cos(declination) * Math.sin(lat) * Math.cos(hourAngle);
  const azimuthDeg = normalizeHeading((Math.atan2(east, north) * 180) / Math.PI);
  const optical = v3Norm(v3(east, north, sinAlt));

  return { optical, azimuthDeg, elevationDeg };
}

function getEqTrackingHourAngleLimitDeg(scope) {
  const lat = degToRad(clamp(state.latitudeDeg, -89.5, 89.5));
  const dec = degToRad(clamp(scope.declinationDeg ?? 0, -89.5, 89.5));
  const cosH0 = -Math.tan(lat) * Math.tan(dec);

  if (cosH0 >= 1) return 0;
  if (cosH0 <= -1) return 180;
  return (Math.acos(cosH0) * 180) / Math.PI;
}

function isTrackingScope(scopeId) {
  return runtime.trackingScopeId === scopeId && runtime.trackingRafId !== null;
}

function stopTrackingTelescope(resetId = null) {
  const trackedScope = runtime.trackingScopeId !== null
    ? state.telescopes.find((item) => item.id === runtime.trackingScopeId)
    : null;
  if (runtime.trackingRafId !== null) {
    cancelAnimationFrame(runtime.trackingRafId);
  }
  if (trackedScope) {
    if (runtime.trackingOriginalPierSideMode) trackedScope.pierSideMode = runtime.trackingOriginalPierSideMode;
    if (runtime.trackingOriginalPierSide) trackedScope.pierSide = runtime.trackingOriginalPierSide;
  }
  const shouldRenderCards = runtime.trackingScopeId !== null || resetId !== null;
  runtime.trackingRafId = null;
  runtime.trackingScopeId = null;
  runtime.trackingStartTsMs = 0;
  runtime.trackingStartHaDeg = 0;
  runtime.trackingEndHaDeg = 0;
  runtime.trackingPauseUntilMs = 0;
  runtime.trackingLastPierSide = null;
  runtime.trackingOriginalPierSideMode = null;
  runtime.trackingOriginalPierSide = null;
  if (shouldRenderCards) {
    renderScopeCards();
    renderAll();
  }
}

function trackTelescopeFrame(tsMs) {
  const scope = state.telescopes.find((item) => item.id === runtime.trackingScopeId);
  if (!scope || scope.mountType !== "EQ") {
    stopTrackingTelescope();
    return;
  }

  if (!runtime.trackingStartTsMs) runtime.trackingStartTsMs = tsMs;
  const elapsed = tsMs - runtime.trackingStartTsMs;
  const progress = clamp(elapsed / runtime.trackingDurationMs, 0, 1);
  const nextHourAngleDeg = normalizeSignedDeg(
    runtime.trackingStartHaDeg + (runtime.trackingEndHaDeg - runtime.trackingStartHaDeg) * progress
  );
  const nextPierSide = nextHourAngleDeg < 0 ? "WEST" : "EAST";

  if (runtime.trackingPauseUntilMs > tsMs) {
    scope.hourAngleDeg = 0;
  } else if (runtime.trackingPauseUntilMs > 0) {
    runtime.trackingPauseUntilMs = 0;
    runtime.trackingLastPierSide = nextPierSide;
    scope.pierSide = nextPierSide;
    scope.pierSideMode = "AUTO";
    scope.hourAngleDeg = nextHourAngleDeg;
  } else if (runtime.trackingLastPierSide !== null && nextPierSide !== runtime.trackingLastPierSide) {
    runtime.trackingPauseUntilMs = tsMs + 500;
    scope.hourAngleDeg = 0;
    scope.pierSideMode = "MANUAL";
    scope.pierSide = runtime.trackingLastPierSide;
  } else {
    scope.hourAngleDeg = nextHourAngleDeg;
  }

  renderScopeCards();
  renderAll();

  if (progress >= 1) {
    stopTrackingTelescope(scope.id);
    return;
  }

  runtime.trackingRafId = requestAnimationFrame(trackTelescopeFrame);
}

function startTrackingTelescope(scopeId) {
  const scope = state.telescopes.find((item) => item.id === scopeId);
  if (!scope || scope.mountType !== "EQ") return;

  if (isTrackingScope(scopeId)) {
    stopTrackingTelescope(scopeId);
    return;
  }

  stopTrackingTelescope();

  const hourLimitDeg = getEqTrackingHourAngleLimitDeg(scope);
  if (hourLimitDeg <= 0.001) {
    renderScopeCards();
    renderAll();
    return;
  }

  runtime.trackingScopeId = scopeId;
  runtime.trackingStartTsMs = 0;
  runtime.trackingStartHaDeg = -hourLimitDeg;
  runtime.trackingEndHaDeg = hourLimitDeg;
  runtime.trackingPauseUntilMs = 0;
  runtime.trackingOriginalPierSideMode = scope.pierSideMode;
  runtime.trackingOriginalPierSide = scope.pierSide;
  runtime.trackingLastPierSide = "WEST";
  scope.pierSideMode = "AUTO";
  scope.hourAngleDeg = normalizeSignedDeg(runtime.trackingStartHaDeg);
  runtime.trackingRafId = requestAnimationFrame(trackTelescopeFrame);
}

function getDomeTargetAzimuthDeg() {
  if (state.domeFollowsTelescope) {
    const target = getFollowScope();
    if (target) {
      const hit = getScopeDomeHit(target);
      if (hit) return getPointAzimuthDeg(hit);
      return getScopePointing(target).azimuthDeg;
    }
  }
  return normalizeHeading(state.domeAzimuthDeg);
}

function getDomeAzimuthDeg() {
  return normalizeHeading(runtime.currentDomeAzimuthDeg);
}

function solveQuadraticPositive(A, B, C) {
  if (Math.abs(A) < 1e-9) return [];
  const disc = B * B - 4 * A * C;
  if (disc < 0) return [];
  const root = Math.sqrt(disc);
  const t1 = (-B - root) / (2 * A);
  const t2 = (-B + root) / (2 * A);
  return [t1, t2].filter((t) => Number.isFinite(t) && t > 1e-6).sort((a, b) => a - b);
}

function getScopeOpticalRay(scope) {
  const mountScope = getMountScope() ?? scope;
  const mount = getMountAxisPoint(mountScope);
  const pointing = getScopePointing(scope);
  const optical = pointing.optical;

  if (mountScope.mountType === "EQ") {
    const geometry = getEqMountGeometry(scope);
    return { origin: geometry.tubeFront, dir: geometry.optical };
  }

  const azGeometry = getAzOtaGeometry(scope);
  const tubeFront = azGeometry ? azGeometry.tubeFront : v3Add(mount, v3Scale(optical, Math.max(120, Number(scope.tubeLengthMm) || 760) * 0.58));
  return { origin: tubeFront, dir: optical };
}

function intersectRayWithDome(origin, dir, radiusMm) {
  const hits = [];

  const Axy = dir.x * dir.x + dir.y * dir.y;
  const Bxy = 2 * (origin.x * dir.x + origin.y * dir.y);
  const Cxy = origin.x * origin.x + origin.y * origin.y - radiusMm * radiusMm;
  const wallTs = solveQuadraticPositive(Axy, Bxy, Cxy);
  for (const t of wallTs) {
    const z = origin.z + dir.z * t;
    if (z >= -1e-6 && z <= radiusMm + 1e-6) hits.push(t);
  }

  const oz = origin.z - radiusMm;
  const As = dir.x * dir.x + dir.y * dir.y + dir.z * dir.z;
  const Bs = 2 * (origin.x * dir.x + origin.y * dir.y + oz * dir.z);
  const Cs = origin.x * origin.x + origin.y * origin.y + oz * oz - radiusMm * radiusMm;
  const capTs = solveQuadraticPositive(As, Bs, Cs);
  for (const t of capTs) {
    const z = origin.z + dir.z * t;
    if (z >= radiusMm - 1e-6 && z <= 2 * radiusMm + 1e-6) hits.push(t);
  }

  if (hits.length === 0) return null;
  const t = hits.sort((a, b) => a - b)[0];
  return v3(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t);
}

function getPointAzimuthDeg(point) {
  return normalizeHeading((Math.atan2(point.x, point.y) * 180) / Math.PI);
}

function getScopeDomeHit(scope) {
  const ray = getScopeOpticalRay(scope);
  return intersectRayWithDome(ray.origin, ray.dir, state.domeRadiusMm);
}

function isPointInsideSlit(point, domeAzimuthDeg, slitWidthMm, radiusMm, toleranceDeg, shutterLimitDeg) {
  if (point.z < -1e-6 || point.z > 2 * radiusMm + 1e-6) return false;
  const zMax = radiusMm + radiusMm * Math.sin(degToRad(clamp(shutterLimitDeg, 0, 90)));
  if (point.z > zMax + 1e-6) return false;

  const r = point.z <= radiusMm ? radiusMm : domeRadiusAtHeight(point.z, radiusMm);
  if (r < 1) return false;

  const az = degToRad(domeAzimuthDeg);
  const dirX = Math.sin(az);
  const dirY = Math.cos(az);
  const tanX = Math.cos(az);
  const tanY = -Math.sin(az);

  const cx = dirX * r;
  const cy = dirY * r;
  const dx = point.x - cx;
  const dy = point.y - cy;
  const tangentialOffset = dx * tanX + dy * tanY;

  const halfWidth = Math.min(slitWidthMm * 0.5, r * 0.96);
  const tolMm = r * degToRad(Math.max(0, toleranceDeg));
  return Math.abs(tangentialOffset) <= halfWidth + tolMm;
}

function evaluateScopeSlitVisibility(scope) {
  const domeAz = getDomeAzimuthDeg();
  const pointing = getScopePointing(scope);
  const hit = getScopeDomeHit(scope);
  const hitAz = hit ? getPointAzimuthDeg(hit) : normalizeHeading(pointing.azimuthDeg);
  const rel = signedDeltaDeg(hitAz, domeAz);
  const azPass = inSlit(rel, computeSlitOpeningDeg(), state.azToleranceDeg);

  if (pointing.elevationDeg > state.maxSlitOpeningDeg + 1e-6) {
    return {
      clear: false,
      reason: `Blocked: elevation ${pointing.elevationDeg.toFixed(1)} deg exceeds shutter limit ${state.maxSlitOpeningDeg.toFixed(1)} deg`
    };
  }

  if (!hit) {
    return {
      clear: azPass,
      reason: azPass ? "Inside slit window" : "Blocked: outside slit azimuth window"
    };
  }

  const slitPass = isPointInsideSlit(
    hit,
    domeAz,
    getEffectiveSlitWidthMm(),
    state.domeRadiusMm,
    state.azToleranceDeg,
    state.maxSlitOpeningDeg
  );

  if (!azPass || !slitPass) {
    return {
      clear: false,
      reason: "Blocked: line of sight hits dome outside slit"
    };
  }

  return {
    clear: true,
    reason: "Inside slit window"
  };
}

function syncDomeNow() {
  runtime.currentDomeAzimuthDeg = getDomeTargetAzimuthDeg();
  runtime.domeAngularVelDegPerSec = 0;
  runtime.settleUntilMs = 0;
  runtime.lastTsMs = 0;
  renderAll();
}

function advanceDomeSlew(tsMs) {
  if (!state.simulateDomeSlew) {
    runtime.currentDomeAzimuthDeg = getDomeTargetAzimuthDeg();
    runtime.domeAngularVelDegPerSec = 0;
    runtime.settleUntilMs = 0;
    runtime.lastTsMs = tsMs;
    return false;
  }

  if (!runtime.lastTsMs) {
    runtime.lastTsMs = tsMs;
    return false;
  }

  const dtSec = Math.max(0, (tsMs - runtime.lastTsMs) / 1000);
  runtime.lastTsMs = tsMs;

  const target = getDomeTargetAzimuthDeg();
  const current = getDomeAzimuthDeg();
  const delta = signedDeltaDeg(target, current);

  const vel = runtime.domeAngularVelDegPerSec;
  const maxSpeed = Math.max(0.01, state.domeSlewSpeedDegPerSec);
  const accel = Math.max(0.01, state.domeAccelDegPerSec2);
  const decel = Math.max(0.01, state.domeDecelDegPerSec2);
  const settleMs = Math.max(0, state.domeSettleTimeSec * 1000);

  if (runtime.settleUntilMs > tsMs) {
    runtime.currentDomeAzimuthDeg = target;
    runtime.domeAngularVelDegPerSec = 0;
    return false;
  }

  if (Math.abs(delta) < 0.02 && Math.abs(vel) < 0.05) {
    runtime.currentDomeAzimuthDeg = target;
    runtime.domeAngularVelDegPerSec = 0;
    runtime.settleUntilMs = settleMs > 0 ? tsMs + settleMs : 0;
    return true;
  }

  const dir = Math.sign(delta) || 1;
  let velMag = Math.abs(vel);
  if (vel * dir < 0) {
    velMag = Math.max(0, velMag - decel * dtSec);
  } else {
    const stopDist = (velMag * velMag) / (2 * decel);
    if (stopDist >= Math.abs(delta)) {
      velMag = Math.max(0, velMag - decel * dtSec);
    } else {
      velMag = Math.min(maxSpeed, velMag + accel * dtSec);
    }
  }

  runtime.domeAngularVelDegPerSec = dir * velMag;
  const rawStep = runtime.domeAngularVelDegPerSec * dtSec;
  const step = Math.abs(rawStep) > Math.abs(delta) ? delta : rawStep;
  runtime.currentDomeAzimuthDeg = normalizeHeading(current + step);
  return Math.abs(step) > 0.0001;
}

function shouldAnimateDome() {
  if (!state.simulateDomeSlew) return false;
  if (runtime.settleUntilMs > 0) return Date.now() < runtime.settleUntilMs;
  return (
    Math.abs(signedDeltaDeg(getDomeTargetAzimuthDeg(), getDomeAzimuthDeg())) > 0.02 ||
    Math.abs(runtime.domeAngularVelDegPerSec) > 0.02
  );
}

function animationFrame(tsMs) {
  const moved = advanceDomeSlew(tsMs);
  if (moved) renderAll();

  if (shouldAnimateDome()) {
    runtime.rafId = requestAnimationFrame(animationFrame);
  } else {
    runtime.rafId = null;
    runtime.lastTsMs = 0;
    runtime.domeAngularVelDegPerSec = 0;
    runtime.settleUntilMs = 0;
    if (moved) renderAll();
  }
}

function ensureDomeAnimation() {
  if (runtime.rafId !== null) return;
  if (!shouldAnimateDome()) return;
  runtime.rafId = requestAnimationFrame(animationFrame);
}

function v3(x, y, z) {
  return { x, y, z };
}

function v3Add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function v3Scale(v, s) {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

function v3Dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function v3Cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}

function v3Norm(v) {
  const n = Math.hypot(v.x, v.y, v.z);
  if (n < 1e-9) return { x: 0, y: 0, z: 0 };
  return { x: v.x / n, y: v.y / n, z: v.z / n };
}

function v3RotateAroundAxis(v, axis, angleRad) {
  const k = v3Norm(axis);
  const cosA = Math.cos(angleRad);
  const sinA = Math.sin(angleRad);
  return v3Add(
    v3Add(v3Scale(v, cosA), v3Scale(v3Cross(k, v), sinA)),
    v3Scale(k, v3Dot(k, v) * (1 - cosA))
  );
}

function domeRadiusAtHeight(zMm, radiusMm) {
  if (zMm <= radiusMm) return radiusMm;
  const dz = zMm - radiusMm;
  return Math.sqrt(Math.max(0, radiusMm * radiusMm - dz * dz));
}

function buildDomeSlitRibbon3D(radiusMm, slitAzDeg, slitWidthMm, wallHeightMm, shutterLimitDeg, samples = 48) {
  const az = degToRad(slitAzDeg);
  const dirX = Math.sin(az);
  const dirY = Math.cos(az);
  const tanX = Math.cos(az);
  const tanY = -Math.sin(az);

  const leftWall = [];
  const rightWall = [];
  const leftCap = [];
  const rightCap = [];

  const wallTop = clamp(wallHeightMm, 0, radiusMm);
  for (let i = 0; i <= samples; i += 1) {
    const t = i / samples;
    const zWall = t * wallTop;
    const rWall = radiusMm;
    const halfWall = Math.min(slitWidthMm * 0.5, rWall * 0.96);
    const cwx = dirX * rWall;
    const cwy = dirY * rWall;
    leftWall.push(v3(cwx + tanX * halfWall, cwy + tanY * halfWall, zWall));
    rightWall.push(v3(cwx - tanX * halfWall, cwy - tanY * halfWall, zWall));
  }

  const capSamples = Math.max(8, samples);
  const zCapMax = radiusMm + radiusMm * Math.sin(degToRad(clamp(shutterLimitDeg, 0, 90)));
  for (let i = 0; i <= capSamples; i += 1) {
    const t = i / capSamples;
    const z = wallTop + t * (zCapMax - wallTop);
    const r = domeRadiusAtHeight(z, radiusMm);
    if (r < 1) continue;
    const half = Math.min(slitWidthMm * 0.5, r * 0.96);
    const cx = dirX * r;
    const cy = dirY * r;
    leftCap.push(v3(cx + tanX * half, cy + tanY * half, z));
    rightCap.push(v3(cx - tanX * half, cy - tanY * half, z));
  }

  return { leftWall, rightWall, leftCap, rightCap };
}

function buildTopSlitFootprint(radiusMm, slitAzDeg, slitWidthMm, wallHeightMm, shutterLimitDeg, samples = 36) {
  const az = degToRad(slitAzDeg);
  const dirX = Math.sin(az);
  const dirY = Math.cos(az);
  const tanX = Math.cos(az);
  const tanY = -Math.sin(az);
  const halfWidth = Math.min(slitWidthMm * 0.5, radiusMm * 0.96);
  const wallTop = clamp(wallHeightMm, 0, radiusMm);
  const zMax = radiusMm + radiusMm * Math.sin(degToRad(clamp(shutterLimitDeg, 0, 90)));
  const left = [];
  const right = [];

  for (let i = 0; i <= samples; i += 1) {
    const t = i / samples;
    const z = wallTop + t * (zMax - wallTop);
    const r = domeRadiusAtHeight(z, radiusMm);
    const cx = dirX * r;
    const cy = dirY * r;
    left.push(v3(cx + tanX * halfWidth, cy + tanY * halfWidth, z));
    right.push(v3(cx - tanX * halfWidth, cy - tanY * halfWidth, z));
  }

  return { left, right };
}

function getEqMountGeometry(scope) {
  const up = v3(0, 0, 1);
  const mountScope = getMountScope() ?? scope;
  const mount = getMountAxisPoint(mountScope);
  const latAbs = degToRad(clamp(Math.abs(state.latitudeDeg), 0, 89.5));
  const hemiSign = state.latitudeDeg >= 0 ? 1 : -1;
  const raUnit = v3Norm(v3(0, hemiSign * Math.cos(latAbs), Math.sin(latAbs)));
  const hourAngle = degToRad(normalizeSignedDeg(mountScope.hourAngleDeg ?? 0));
  const declination = degToRad(clamp(mountScope.declinationDeg ?? 0, -90, 90));
  const decUnit = v3Norm(v3RotateAroundAxis(v3(1, 0, 0), raUnit, -hourAngle));
  const equatorOptical = v3Norm(v3Cross(decUnit, raUnit));
  const optical = v3Norm(v3Add(v3Scale(raUnit, Math.sin(declination)), v3Scale(equatorOptical, Math.cos(declination))));

  const pierSideSign = getEqPierSide(scope) === "EAST" ? 1 : -1;
  const pierTop = v3Add(mount, v3(0, 0, -72));
  const raBack = v3Add(mount, v3Scale(raUnit, -258));
  const raFront = v3Add(mount, v3Scale(raUnit, 36));
  const wedgeBack = v3Add(mount, v3Scale(raUnit, -182));
  const wedgeFront = v3Add(mount, v3Scale(raUnit, -92));
  const raShoulder = v3Add(mount, v3Scale(raUnit, -146));
  const raHead = mount;
  const gemAxisLength = Math.max(70, Number(scope.gemAxisLength) || 435);
  const lateralAxisLength = Number(scope.lateralAxisLength) || 0;
  const sideDir = v3Scale(decUnit, pierSideSign);
  const decHousingHalfLen = Math.min(185, Math.max(120, gemAxisLength * 0.22));
  const decScopeEnd = v3Add(raHead, v3Scale(sideDir, decHousingHalfLen));
  const decCounterEnd = v3Add(raHead, v3Scale(sideDir, -decHousingHalfLen));
  const tubeLen = Math.max(120, Number(scope.tubeLengthMm) || 760);
  const tubeRadius = Math.max(24, (Number(scope.telescopeDiameterMm) || 120) * 0.5);
  let saddleNormal = v3Norm(v3Cross(optical, sideDir));
  if (Math.hypot(saddleNormal.x, saddleNormal.y, saddleNormal.z) < 1e-6) saddleNormal = v3Norm(v3Add(up, v3Scale(sideDir, -v3Dot(up, sideDir))));
  if (Math.hypot(saddleNormal.x, saddleNormal.y, saddleNormal.z) < 1e-6) saddleNormal = up;
  if (v3Dot(saddleNormal, up) < 0) saddleNormal = v3Scale(saddleNormal, -1);
  const saddleLift = Math.min(95, Math.max(28, gemAxisLength * 0.14));
  const lateralOffset = scope.otaLayout === "SIDE_BY_SIDE" ? lateralAxisLength : 0;
  const otaOffset = v3Add(getOtaOffset(scope, optical, sideDir), v3Scale(sideDir, lateralOffset));
  const saddle = v3Add(v3Add(decScopeEnd, v3Scale(saddleNormal, saddleLift)), otaOffset);
  const tubeCenterAtSaddle = v3Add(saddle, v3Scale(saddleNormal, tubeRadius + Math.max(14, tubeRadius * 0.22)));
  const tubeBack = v3Add(tubeCenterAtSaddle, v3Scale(optical, -tubeLen / 3));
  const tubeFront = v3Add(tubeCenterAtSaddle, v3Scale(optical, tubeLen * (2 / 3)));
  const saddleBack = saddle;
  const saddlePlateHalfLen = Math.min(220, Math.max(90, tubeLen * 0.18));
  const saddlePlateBack = v3Add(saddle, v3Scale(optical, -saddlePlateHalfLen));
  const saddlePlateFront = v3Add(saddle, v3Scale(optical, saddlePlateHalfLen));
  const cwBarLen = Math.max(120, Number(mountScope.counterweightShaftLengthMm) || 820);
  const cwDiameter = Math.max(30, Number(mountScope.counterweightDiameterMm) || 170);
  const cwThickness = Math.max(45, cwDiameter * 0.42);
  const cwEnd = v3Add(raHead, v3Scale(sideDir, -cwBarLen));
  const cwWeightOuter = v3Add(raHead, v3Scale(sideDir, -cwBarLen * 0.9));
  const cwWeightInner = v3Add(raHead, v3Scale(sideDir, -cwBarLen * 0.75));
  const cwWeightOuterBack = v3Add(cwWeightOuter, v3Scale(sideDir, cwThickness * 0.5));
  const cwWeightOuterFront = v3Add(cwWeightOuter, v3Scale(sideDir, -cwThickness * 0.5));
  const cwWeightInnerBack = v3Add(cwWeightInner, v3Scale(sideDir, cwThickness * 0.5));
  const cwWeightInnerFront = v3Add(cwWeightInner, v3Scale(sideDir, -cwThickness * 0.5));
  const decA = decCounterEnd;
  const decB = decScopeEnd;

  return {
    mount,
    optical,
    raUnit,
    decUnit,
    pierTop,
    wedgeBack,
    wedgeFront,
    raBack,
    raFront,
    raShoulder,
    raHead,
    decA,
    decB,
    decScopeEnd,
    decCounterEnd,
    saddle,
    saddleBack,
    saddlePlateBack,
    saddlePlateFront,
    tubeBack,
    tubeFront,
    cwEnd,
    cwWeightOuter,
    cwWeightOuterBack,
    cwWeightOuterFront,
    cwWeightInner,
    cwWeightInnerBack,
    cwWeightInnerFront,
    cwDiameter
  };
}

function getAzOtaGeometry(scope) {
  const up = v3(0, 0, 1);
  const mountScope = getMountScope() ?? scope;
  const mount = getMountAxisPoint(mountScope);
  const pointing = getScopePointing(scope);
  const optical = pointing.optical;
  const az = degToRad(pointing.azimuthDeg);
  const horiz = v3(Math.sin(az), Math.cos(az), 0);
  const azHead = v3(mount.x, mount.y, mount.z + Math.max(110, mountScope.gemAxisLength * 0.45));
  let sideDir = v3Norm(v3Cross(up, horiz));
  if (Math.hypot(sideDir.x, sideDir.y, sideDir.z) < 1e-6) sideDir = v3(1, 0, 0);
  const saddle = v3Add(azHead, getOtaOffset(scope, optical, sideDir));
  const tubeLen = Math.max(120, Number(scope.tubeLengthMm) || 760);
  return {
    mount,
    optical,
    azHead,
    sideDir,
    saddle,
    barA: v3Add(azHead, v3Scale(sideDir, 85)),
    barB: v3Add(azHead, v3Scale(sideDir, -85)),
    tubeBack: v3Add(saddle, v3Scale(optical, -tubeLen * 0.42)),
    tubeFront: v3Add(saddle, v3Scale(optical, tubeLen * 0.58))
  };
}

function buildMountScopeScene3D() {
  const up = v3(0, 0, 1);
  const scene = [];
  const mountScope = getMountScope();

  state.telescopes.forEach((scope, idx) => {
    const color = palette[idx % palette.length];
    const isMountOwner = scope === mountScope;
    const mountConfig = mountScope ?? scope;
    const mount = getMountAxisPoint(mountConfig);
    const pointing = getScopePointing(scope);
    const optical = pointing.optical;
    const az = degToRad(pointing.azimuthDeg);
    const scopeFill = hexToRgba(color, 0.35);

    const rods = [];
    const circles = [];
    const labels = [];

    if (isMountOwner) {
      rods.push({
        a: v3(mount.x, mount.y, 0),
        b: mount,
        diameterMm: 190,
        fill: "rgba(126,145,176,0.55)",
        stroke: "rgba(230,240,255,0.7)",
        swMm: 10,
        isPierColumn: true
      });
    }

    if (mountConfig.mountType === "EQ") {
      const geometry = getEqMountGeometry(scope);

      if (isMountOwner) {
        rods.push({ a: mount, b: geometry.pierTop, diameterMm: 210, fill: "rgba(138,148,164,0.74)", stroke: "rgba(232,238,246,0.82)", swMm: 10 });
        rods.push({ a: geometry.wedgeBack, b: geometry.pierTop, diameterMm: 82, fill: "rgba(54,57,64,0.92)", stroke: "rgba(166,171,180,0.86)", swMm: 7 });
        rods.push({ a: geometry.pierTop, b: geometry.wedgeFront, diameterMm: 92, fill: "rgba(54,57,64,0.92)", stroke: "rgba(166,171,180,0.86)", swMm: 7 });
        rods.push({ a: geometry.wedgeFront, b: geometry.raShoulder, diameterMm: 76, fill: "rgba(54,57,64,0.92)", stroke: "rgba(166,171,180,0.86)", swMm: 7 });
        rods.push({ a: geometry.raBack, b: geometry.raFront, diameterMm: 198, fill: "rgba(58,61,68,0.96)", stroke: "rgba(170,176,186,0.92)", swMm: 9, isRaHousing: true });
        rods.push({ a: geometry.decA, b: geometry.decB, diameterMm: 176, fill: "rgba(66,70,77,0.96)", stroke: "rgba(176,182,191,0.92)", swMm: 9, isDecHousing: true });
        rods.push({ a: geometry.decScopeEnd, b: geometry.saddleBack, diameterMm: 116, fill: "rgba(46,49,56,0.96)", stroke: "rgba(176,182,191,0.92)", swMm: 7, isSaddleSupport: true });
      }
      if (!isMountOwner) {
        rods.push({ a: geometry.decScopeEnd, b: geometry.saddleBack, diameterMm: 82, fill: "rgba(196,214,236,0.54)", stroke: "rgba(238,246,255,0.96)", swMm: 7 });
      }
      rods.push({
        a: geometry.tubeBack,
        b: geometry.tubeFront,
        diameterMm: Math.max(48, scope.telescopeDiameterMm),
        fill: scopeFill,
        stroke: color,
        swMm: 8,
        isTube: true
      });
      rods.push({
        a: geometry.saddlePlateBack,
        b: geometry.saddlePlateFront,
        diameterMm: Math.max(70, scope.telescopeDiameterMm * 0.7),
        fill: "rgba(36,39,46,0.98)",
        stroke: "rgba(186,192,201,0.95)",
        swMm: 7,
        isSaddlePlate: true
      });
      circles.push({ c: geometry.tubeFront, rMm: Math.max(20, scope.telescopeDiameterMm * 0.5), stroke: color, fill: "rgba(225,235,250,0.26)", swMm: 8, isAperture: true });

      if (isMountOwner) {
        rods.push({ a: geometry.raHead, b: geometry.cwEnd, diameterMm: 34, fill: "rgba(234,238,244,0.88)", stroke: "rgba(245,248,252,0.98)", swMm: 5, isCounterweightBar: true });
        circles.push({ c: mount, rMm: 76, stroke: "rgba(224,230,238,0.84)", fill: "rgba(70,73,80,0.58)", swMm: 14 });
        circles.push({ c: geometry.pierTop, rMm: 58, stroke: "rgba(224,230,238,0.88)", fill: "rgba(210,92,42,0.78)", swMm: 10 });
        circles.push({ c: geometry.raShoulder, rMm: 52, stroke: "rgba(224,230,238,0.9)", fill: "rgba(58,61,68,0.7)", swMm: 8 });
        circles.push({ c: geometry.raHead, rMm: 68, stroke: "rgba(224,230,238,0.92)", fill: "rgba(210,92,42,0.88)", swMm: 5 });
        circles.push({ c: geometry.raHead, rMm: 56, stroke: "rgba(236,240,246,0.94)", fill: "rgba(56,60,67,0.94)", swMm: 6 });
        circles.push({ c: geometry.raHead, rMm: 40, stroke: "rgba(236,240,246,0.92)", fill: "rgba(88,93,102,0.92)", swMm: 7 });
        circles.push({ c: geometry.cwWeightOuter, depthBack: geometry.cwWeightOuterBack, depthFront: geometry.cwWeightOuterFront, rMm: geometry.cwDiameter * 0.5, stroke: "rgba(240,248,255,0.98)", fill: "rgba(217,229,248,0.82)", swMm: 9, isCounterweight: true });
        circles.push({ c: geometry.cwWeightInner, depthBack: geometry.cwWeightInnerBack, depthFront: geometry.cwWeightInnerFront, rMm: geometry.cwDiameter * 0.5, stroke: "rgba(240,248,255,0.95)", fill: "rgba(217,229,248,0.76)", swMm: 8, isCounterweight: true });
        labels.push({ p: geometry.cwWeightInner, text: "CW", color: "#d6e8ff" });
      }

      if (state.telescopes.length > 1) labels.push({ p: geometry.saddle, text: scope.name, color });
    } else {
      const geometry = getAzOtaGeometry(scope);
      const azHead = geometry.azHead;
      const horiz = v3(Math.sin(az), Math.cos(az), 0);
      if (isMountOwner) {
        let altAxis = v3Norm(v3Cross(up, horiz));
        if (Math.hypot(altAxis.x, altAxis.y, altAxis.z) < 1e-6) altAxis = v3(1, 0, 0);
        rods.push({ a: mount, b: azHead, diameterMm: 135, fill: "rgba(147,168,201,0.5)", stroke: color, swMm: 9 });
        rods.push({ a: azHead, b: geometry.barA, diameterMm: 80, fill: "rgba(190,209,232,0.5)", stroke: "rgba(235,245,255,0.95)", swMm: 7 });
        rods.push({ a: azHead, b: geometry.barB, diameterMm: 80, fill: "rgba(190,209,232,0.5)", stroke: "rgba(235,245,255,0.95)", swMm: 7 });
        rods.push({ a: geometry.barA, b: geometry.barB, diameterMm: 70, fill: "rgba(206,219,239,0.48)", stroke: "rgba(234,245,255,0.9)", swMm: 6 });
      }
      rods.push({
        a: geometry.tubeBack,
        b: geometry.tubeFront,
        diameterMm: Math.max(48, scope.telescopeDiameterMm),
        fill: scopeFill,
        stroke: color,
        swMm: 8,
        isTube: true
      });

      if (isMountOwner) {
        circles.push({ c: mount, rMm: 70, stroke: "rgba(230,240,255,0.85)", fill: "rgba(114,137,175,0.32)", swMm: 14 });
      }
      circles.push({ c: geometry.tubeFront, rMm: Math.max(20, scope.telescopeDiameterMm * 0.5), stroke: color, fill: "rgba(225,235,250,0.28)", swMm: 8, isAperture: true });
      labels.push({ p: geometry.saddle, text: scope.name, color });
    }

    scene.push({ color, rods, circles, labels });
  });

  return scene;
}

function projectTopPt(pt, cx, cy, scale) {
  return { x: cx + pt.x * scale, y: cy - pt.y * scale };
}

function projectSidePt(pt, sideRotDeg, xToPx, zToPx) {
  const rot = degToRad(sideRotDeg);
  const xh = pt.x * Math.cos(rot) + pt.y * Math.sin(rot);
  return { x: xToPx(xh), y: zToPx(pt.z) };
}

function strokePxFromMm(mm, scale, minPx = 1) {
  return Math.max(minPx, mm * scale * 0.16);
}

function radiusPxFromMm(mm, scale, minPx = 2) {
  return Math.max(minPx, mm * scale * 0.16);
}

function tubePxFromMm(mm, scale, minPx = 4) {
  return Math.max(minPx, mm * scale * 0.75);
}

function counterweightPxFromMm(mm, scale, minPx = 7) {
  return Math.max(minPx, mm * scale * 1.15);
}

function hexToRgba(hex, alpha = 1) {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return `rgba(192,210,236,${alpha})`;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return `rgba(192,210,236,${alpha})`;
  return `rgba(${r},${g},${b},${alpha})`;
}

function drawProjectedRod(svg, a, b, diameterPx, fill, stroke, edgeWidthPx) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const radius = Math.max(1.8, diameterPx * 0.5);

  if (len < 0.001) {
    svg.append(
      svgEl("circle", {
        cx: a.x,
        cy: a.y,
        r: radius,
        fill,
        stroke,
        "stroke-width": Math.max(0.8, edgeWidthPx)
      })
    );
    return;
  }

  const nx = -dy / len;
  const ny = dx / len;
  const p1 = `${a.x + nx * radius},${a.y + ny * radius}`;
  const p2 = `${b.x + nx * radius},${b.y + ny * radius}`;
  const p3 = `${b.x - nx * radius},${b.y - ny * radius}`;
  const p4 = `${a.x - nx * radius},${a.y - ny * radius}`;

  svg.append(
    svgEl("polygon", {
      points: `${p1} ${p2} ${p3} ${p4}`,
      fill,
      stroke,
      "stroke-width": Math.max(0.8, edgeWidthPx),
      "stroke-linejoin": "round"
    })
  );

  svg.append(
    svgEl("line", {
      x1: a.x + nx * radius * 0.35,
      y1: a.y + ny * radius * 0.35,
      x2: b.x + nx * radius * 0.35,
      y2: b.y + ny * radius * 0.35,
      stroke: "rgba(245,250,255,0.35)",
      "stroke-width": Math.max(0.7, edgeWidthPx * 0.45),
      "stroke-linecap": "round"
    })
  );

  svg.append(
    svgEl("circle", {
      cx: a.x,
      cy: a.y,
      r: radius,
      fill,
      stroke,
      "stroke-width": Math.max(0.8, edgeWidthPx)
    }),
    svgEl("circle", {
      cx: b.x,
      cy: b.y,
      r: radius,
      fill,
      stroke,
      "stroke-width": Math.max(0.8, edgeWidthPx)
    })
  );
}

function drawProjectedBox(svg, a, b, widthPx, fill, stroke, edgeWidthPx) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 0.001) return;

  const half = Math.max(3, widthPx * 0.5);
  const nx = -dy / len;
  const ny = dx / len;
  const depthX = Math.max(5, half * 0.46);
  const depthY = -Math.max(5, half * 0.34);
  const front = [
    { x: a.x + nx * half, y: a.y + ny * half },
    { x: b.x + nx * half, y: b.y + ny * half },
    { x: b.x - nx * half, y: b.y - ny * half },
    { x: a.x - nx * half, y: a.y - ny * half }
  ];
  const back = front.map((pt) => ({ x: pt.x + depthX, y: pt.y + depthY }));
  const points = (items) => items.map((pt) => `${pt.x},${pt.y}`).join(" ");

  svg.append(
    svgEl("polygon", {
      points: points([front[1], back[1], back[2], front[2]]),
      fill: "rgba(20,42,64,0.72)",
      stroke,
      "stroke-width": Math.max(0.7, edgeWidthPx * 0.75),
      "stroke-linejoin": "round"
    }),
    svgEl("polygon", {
      points: points([front[0], back[0], back[1], front[1]]),
      fill: "rgba(146,211,239,0.34)",
      stroke,
      "stroke-width": Math.max(0.7, edgeWidthPx * 0.75),
      "stroke-linejoin": "round"
    }),
    svgEl("polygon", {
      points: points(front),
      fill,
      stroke,
      "stroke-width": Math.max(0.9, edgeWidthPx),
      "stroke-linejoin": "round"
    }),
    svgEl("line", {
      x1: front[0].x + (front[1].x - front[0].x) * 0.16,
      y1: front[0].y + (front[1].y - front[0].y) * 0.16,
      x2: front[1].x - (front[1].x - front[0].x) * 0.16,
      y2: front[1].y - (front[1].y - front[0].y) * 0.16,
      stroke: "rgba(238,248,255,0.42)",
      "stroke-width": Math.max(0.8, edgeWidthPx * 0.55),
      "stroke-linecap": "round"
    })
  );
}

function drawProjectedCylinder(svg, back, front, radiusPx, fill, stroke, edgeWidthPx) {
  const dx = front.x - back.x;
  const dy = front.y - back.y;
  const len = Math.hypot(dx, dy);
  if (len < 0.001) {
    svg.append(svgEl("circle", { cx: front.x, cy: front.y, r: radiusPx, fill, stroke, "stroke-width": Math.max(0.8, edgeWidthPx) }));
    return;
  }

  const nx = -dy / len;
  const ny = dx / len;
  const sideA = [
    { x: back.x + nx * radiusPx, y: back.y + ny * radiusPx },
    { x: front.x + nx * radiusPx, y: front.y + ny * radiusPx },
    { x: front.x - nx * radiusPx, y: front.y - ny * radiusPx },
    { x: back.x - nx * radiusPx, y: back.y - ny * radiusPx }
  ];
  const points = sideA.map((pt) => `${pt.x},${pt.y}`).join(" ");

  svg.append(
    svgEl("polygon", {
      points,
      fill: "rgba(204,219,238,0.62)",
      stroke,
      "stroke-width": Math.max(0.7, edgeWidthPx * 0.75),
      "stroke-linejoin": "round"
    }),
    svgEl("circle", {
      cx: back.x,
      cy: back.y,
      r: radiusPx,
      fill: "rgba(168,188,214,0.54)",
      stroke,
      "stroke-width": Math.max(0.7, edgeWidthPx * 0.75)
    }),
    svgEl("circle", {
      cx: front.x,
      cy: front.y,
      r: radiusPx,
      fill,
      stroke,
      "stroke-width": Math.max(0.9, edgeWidthPx)
    }),
    svgEl("circle", {
      cx: front.x - nx * radiusPx * 0.22,
      cy: front.y - ny * radiusPx * 0.22,
      r: radiusPx * 0.48,
      fill: "rgba(255,255,255,0.14)",
      stroke: "rgba(245,250,255,0.35)",
      "stroke-width": Math.max(0.6, edgeWidthPx * 0.45)
    })
  );
}

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, String(value));
  }
  return el;
}

function renderSceneTop(svg, scene, cx, cy, scale) {
  scene.forEach((obj) => {
    obj.rods.forEach((rod) => {
      const a = projectTopPt(rod.a, cx, cy, scale);
      const b = projectTopPt(rod.b, cx, cy, scale);
      drawProjectedRod(
        svg,
        a,
        b,
        rod.isTube
          ? tubePxFromMm(rod.diameterMm, scale, 4)
          : rod.isCounterweightBar
            ? counterweightPxFromMm(rod.diameterMm, scale, 4)
            : strokePxFromMm(rod.diameterMm, scale, 4),
        rod.fill,
        rod.stroke,
        strokePxFromMm(rod.swMm ?? 8, scale, 1)
      );
    });

    obj.circles.forEach((c) => {
      const p = projectTopPt(c.c, cx, cy, scale);
      svg.append(
        svgEl("circle", {
          cx: p.x,
          cy: p.y,
          r: c.isAperture
            ? tubePxFromMm(c.rMm * 2, scale, 3) * 0.5
            : c.isCounterweight
              ? counterweightPxFromMm(c.rMm * 2, scale, 4) * 0.5
              : radiusPxFromMm(c.rMm, scale, 2.4),
          fill: c.fill,
          stroke: c.stroke,
          "stroke-width": strokePxFromMm(c.swMm, scale, 1)
        })
      );
    });

    obj.labels.forEach((lb) => {
      const p = projectTopPt(lb.p, cx, cy, scale);
      svg.append(svgEl("text", { x: p.x + 8, y: p.y - 6, fill: lb.color, "font-size": 11 }));
      svg.lastChild.textContent = lb.text;
    });
  });
}

function renderSceneSide(svg, scene, sideRot, xToPx, zToPx, scale) {
  scene.forEach((obj) => {
    obj.rods.forEach((rod) => {
      const a = projectSidePt(rod.a, sideRot, xToPx, zToPx);
      const b = projectSidePt(rod.b, sideRot, xToPx, zToPx);
      drawProjectedRod(
        svg,
        a,
        b,
        rod.isTube
          ? tubePxFromMm(rod.diameterMm, scale, 4)
          : rod.isCounterweightBar
            ? counterweightPxFromMm(rod.diameterMm, scale, 4)
            : strokePxFromMm(rod.diameterMm, scale, 4),
        rod.fill,
        rod.stroke,
        strokePxFromMm(rod.swMm ?? 8, scale, 1)
      );
    });

    obj.circles.forEach((c) => {
      const p = projectSidePt(c.c, sideRot, xToPx, zToPx);
      svg.append(
        svgEl("circle", {
          cx: p.x,
          cy: p.y,
          r: c.isAperture
            ? tubePxFromMm(c.rMm * 2, scale, 3) * 0.5
            : c.isCounterweight
              ? counterweightPxFromMm(c.rMm * 2, scale, 4) * 0.5
              : radiusPxFromMm(c.rMm, scale, 2.2),
          fill: c.fill,
          stroke: c.stroke,
          "stroke-width": strokePxFromMm(c.swMm, scale, 1)
        })
      );
    });

    obj.labels.forEach((lb) => {
      const p = projectSidePt(lb.p, sideRot, xToPx, zToPx);
      svg.append(svgEl("text", { x: p.x + 7, y: p.y - 6, fill: lb.color, "font-size": 10 }));
      svg.lastChild.textContent = lb.text;
    });
  });
}

function getLaserSegments() {
  if (!state.showLaserLine) return [];
  return state.telescopes
    .map((scope, idx) => {
      const ray = getScopeOpticalRay(scope);
      const hit = getScopeDomeHit(scope);
      if (!hit) return null;
      return {
        color: palette[idx % palette.length],
        start: ray.origin,
        end: hit
      };
    })
    .filter(Boolean);
}

function renderLaserTop(svg, cx, cy, scale) {
  getLaserSegments().forEach((laser) => {
    const a = projectTopPt(laser.start, cx, cy, scale);
    const b = projectTopPt(laser.end, cx, cy, scale);
    svg.append(
      svgEl("line", {
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        stroke: "rgba(99,255,157,0.92)",
        "stroke-width": 2.2,
        "stroke-linecap": "round",
        "stroke-dasharray": "8 5"
      }),
      svgEl("circle", {
        cx: b.x,
        cy: b.y,
        r: 4.5,
        fill: "rgba(99,255,157,0.9)",
        stroke: "rgba(215,255,228,0.95)",
        "stroke-width": 1.2
      })
    );
  });
}

function renderLaserSide(svg, sideRot, xToPx, zToPx) {
  getLaserSegments().forEach((laser) => {
    const a = projectSidePt(laser.start, sideRot, xToPx, zToPx);
    const b = projectSidePt(laser.end, sideRot, xToPx, zToPx);
    svg.append(
      svgEl("line", {
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        stroke: "rgba(99,255,157,0.92)",
        "stroke-width": 2.2,
        "stroke-linecap": "round",
        "stroke-dasharray": "8 5"
      }),
      svgEl("circle", {
        cx: b.x,
        cy: b.y,
        r: 4.5,
        fill: "rgba(99,255,157,0.9)",
        stroke: "rgba(215,255,228,0.95)",
        "stroke-width": 1.2
      })
    );
  });
}

function createMountCamera(points, width, height) {
  const yaw = degToRad(runtime.mountViewYawDeg);
  const pitch = degToRad(runtime.mountViewPitchDeg);
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);
  const rotate = (pt) => {
    const x = pt.x * cosYaw - pt.y * sinYaw;
    const y = pt.x * sinYaw + pt.y * cosYaw;
    return { x, y: y * cosPitch - pt.z * sinPitch, z: y * sinPitch + pt.z * cosPitch };
  };

  const rotated = points.map(rotate);
  const bounds = rotated.reduce(
    (acc, pt) => ({
      minX: Math.min(acc.minX, pt.x),
      maxX: Math.max(acc.maxX, pt.x),
      minY: Math.min(acc.minY, pt.z),
      maxY: Math.max(acc.maxY, pt.z)
    }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
  );
  const pad = Math.min(width, height) * 0.09;
  const scale = Math.min((width - pad * 2) / Math.max(1, bounds.maxX - bounds.minX), (height - pad * 2) / Math.max(1, bounds.maxY - bounds.minY));
  const centerX = (bounds.minX + bounds.maxX) * 0.5;
  const centerY = (bounds.minY + bounds.maxY) * 0.5;

  return {
    scale,
    project(pt) {
      const r = rotate(pt);
      return {
        x: width * 0.5 + (r.x - centerX) * scale,
        y: height * 0.53 - (r.z - centerY) * scale,
        depth: r.y
      };
    }
  };
}

function mountStrokePx(mm, scale, minPx = 2) {
  return Math.max(minPx, mm * scale * 0.18);
}

function mountTubePx(mm, scale, minPx = 8) {
  return Math.max(minPx, mm * scale * 0.58);
}

function drawCanvasLine(ctx, a, b, widthPx, fill, stroke, edgePx) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = stroke;
  ctx.lineWidth = widthPx + edgePx * 2;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.strokeStyle = fill;
  ctx.lineWidth = widthPx;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.strokeStyle = "rgba(250,255,255,0.26)";
  ctx.lineWidth = Math.max(1, widthPx * 0.12);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y - widthPx * 0.22);
  ctx.lineTo(b.x, b.y - widthPx * 0.22);
  ctx.stroke();
  ctx.restore();
}

function drawCanvasDisc(ctx, p, radiusPx, fill, stroke, edgePx, squash = 1) {
  ctx.save();
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = edgePx;
  ctx.beginPath();
  ctx.ellipse(p.x, p.y, radiusPx, radiusPx * squash, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.16)";
  ctx.beginPath();
  ctx.ellipse(p.x - radiusPx * 0.22, p.y - radiusPx * 0.22, radiusPx * 0.36, radiusPx * 0.18, -0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawCanvasBox(ctx, camera, rod, widthMm) {
  const axis = v3Norm(v3Add(rod.b, v3Scale(rod.a, -1)));
  let across = v3Norm(v3Cross(axis, v3(0, 0, 1)));
  if (Math.hypot(across.x, across.y, across.z) < 1e-6) across = v3(1, 0, 0);
  const upFace = v3Norm(v3Cross(across, axis));
  const halfW = widthMm * 0.5;
  const halfD = widthMm * (rod.isSaddlePlate ? 0.16 : 0.32);
  const corners = [
    v3Add(v3Add(rod.a, v3Scale(across, halfW)), v3Scale(upFace, halfD)),
    v3Add(v3Add(rod.b, v3Scale(across, halfW)), v3Scale(upFace, halfD)),
    v3Add(v3Add(rod.b, v3Scale(across, -halfW)), v3Scale(upFace, halfD)),
    v3Add(v3Add(rod.a, v3Scale(across, -halfW)), v3Scale(upFace, halfD)),
    v3Add(v3Add(rod.a, v3Scale(across, halfW)), v3Scale(upFace, -halfD)),
    v3Add(v3Add(rod.b, v3Scale(across, halfW)), v3Scale(upFace, -halfD)),
    v3Add(v3Add(rod.b, v3Scale(across, -halfW)), v3Scale(upFace, -halfD)),
    v3Add(v3Add(rod.a, v3Scale(across, -halfW)), v3Scale(upFace, -halfD))
  ].map((pt) => camera.project(pt));
  const isMountBody = rod.isRaHousing || rod.isDecHousing || rod.isSaddleSupport || rod.isSaddlePlate;
  const faces = [
    { ids: [0, 1, 2, 3], fill: rod.fill },
    { ids: [4, 5, 6, 7], fill: isMountBody ? "rgba(26,28,34,0.98)" : "rgba(22,36,55,0.62)" },
    { ids: [0, 1, 5, 4], fill: isMountBody ? "rgba(88,92,100,0.96)" : "rgba(235,248,255,0.32)" },
    { ids: [1, 2, 6, 5], fill: isMountBody ? "rgba(42,45,52,0.98)" : "rgba(93,129,160,0.42)" },
    { ids: [2, 3, 7, 6], fill: isMountBody ? "rgba(20,22,28,0.98)" : "rgba(18,33,51,0.5)" },
    { ids: [3, 0, 4, 7], fill: isMountBody ? "rgba(70,74,82,0.97)" : "rgba(160,200,232,0.28)" }
  ].sort((a, b) => a.ids.reduce((sum, id) => sum + corners[id].depth, 0) - b.ids.reduce((sum, id) => sum + corners[id].depth, 0));

  ctx.save();
  ctx.lineJoin = "round";
  ctx.strokeStyle = isMountBody ? "rgba(208,214,224,0.68)" : rod.stroke;
  ctx.lineWidth = Math.max(1, mountStrokePx(rod.swMm ?? 8, camera.scale, isMountBody ? 0.7 : 1));
  faces.forEach((face) => {
    ctx.fillStyle = face.fill;
    ctx.beginPath();
    face.ids.forEach((id, idx) => {
      if (idx === 0) ctx.moveTo(corners[id].x, corners[id].y);
      else ctx.lineTo(corners[id].x, corners[id].y);
    });
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  });
  ctx.restore();
}

function drawMountBackground(ctx, width, height) {
  ctx.clearRect(0, 0, width, height);
  const gradient = ctx.createRadialGradient(width * 0.25, height * 0.18, 0, width * 0.5, height * 0.52, Math.max(width, height) * 0.7);
  gradient.addColorStop(0, "rgba(42,70,105,0.92)");
  gradient.addColorStop(1, "rgba(14,22,35,0.98)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "rgba(255,255,255,0.035)";
  ctx.lineWidth = 1;
  for (let x = 0; x < width; x += 32) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y < height; y += 32) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
}

async function ensureMountThreeView() {
  if (runtime.mountThreeView) return runtime.mountThreeView;
  if (runtime.mountThreeInitPromise) return runtime.mountThreeInitPromise;

  const canvas = document.getElementById("mount-view");
  const status = document.getElementById("mount-view-status");
  if (!canvas) return null;

  runtime.mountThreeInitPromise = import("./mount-three.js")
    .then((module) => {
      runtime.mountThreeView = module.createMountThreeView({ canvas, statusEl: status });
      return runtime.mountThreeView;
    })
    .catch((error) => {
      runtime.mountThreeInitPromise = null;
      if (status) status.textContent = `Three.js mount view failed: ${error.message}`;
      throw error;
    });

  return runtime.mountThreeInitPromise;
}

function getMountViewConfig() {
  const mount = getMountScope();
  if (!mount) return null;
  return {
    latitudeDeg: state.latitudeDeg,
    domeRadiusMm: state.domeRadiusMm,
    mountViewMode: state.mountViewMode,
    mount: {
      mountType: mount.mountType,
      posNS: Number(mount.posNS) || 0,
      posEW: Number(mount.posEW) || 0,
      posUD: Number(mount.posUD) || 0,
      hourAngleDeg: Number(mount.hourAngleDeg) || 0,
      declinationDeg: Number(mount.declinationDeg) || 0,
      azimuth: Number(mount.azimuth) || 0,
      elevation: Number(mount.elevation) || 0,
      counterweightShaftLengthMm: Number(mount.counterweightShaftLengthMm) || 820,
      counterweightDiameterMm: Number(mount.counterweightDiameterMm) || 170,
      pierSideMode: mount.pierSideMode,
      pierSide: mount.pierSide
    },
    scopes: state.telescopes.map((scope) => ({
      id: scope.id,
      name: scope.name,
      otaLayout: scope.otaLayout,
      otaSideOffsetMm: Number(scope.otaSideOffsetMm) || 0,
      otaPiggybackOffsetMm: Number(scope.otaPiggybackOffsetMm) || 0,
      gemAxisLength: Number(scope.gemAxisLength) || 435,
      lateralAxisLength: Number(scope.lateralAxisLength) || 0,
      telescopeDiameterMm: Number(scope.telescopeDiameterMm) || 120,
      tubeLengthMm: Number(scope.tubeLengthMm) || 760
    }))
  };
}

function drawMountView() {
  const config = getMountViewConfig();
  if (!config) return;
  ensureMountThreeView()
    .then((view) => {
      if (!view) return;
      view.update(config);
    })
    .catch(() => {});
}

function drawTopView() {
  const svg = document.getElementById("top-view");
  svg.innerHTML = "";

  const cx = 210;
  const cy = 210;
  const safePad = 36;
  const scale = (210 - safePad) / state.domeRadiusMm;
  const domePx = state.domeRadiusMm * scale;
  const slitOpeningDeg = computeSlitOpeningDeg();
  const domeAzimuthDeg = getDomeAzimuthDeg();

  svg.append(
    svgEl("line", { x1: cx, y1: 30, x2: cx, y2: 390, stroke: "rgba(220,235,255,0.4)", "stroke-width": 1 }),
    svgEl("line", { x1: 30, y1: cy, x2: 390, y2: cy, stroke: "rgba(220,235,255,0.4)", "stroke-width": 1 })
  );

  const n = svgEl("text", { x: cx, y: 22, fill: "#d9e7f7", "font-size": 13, "text-anchor": "middle" });
  const s = svgEl("text", { x: cx, y: 408, fill: "#d9e7f7", "font-size": 13, "text-anchor": "middle" });
  const w = svgEl("text", { x: 20, y: cy + 4, fill: "#d9e7f7", "font-size": 13 });
  const e = svgEl("text", { x: 398, y: cy + 4, fill: "#d9e7f7", "font-size": 13, "text-anchor": "end" });
  n.textContent = "N";
  s.textContent = "S";
  w.textContent = "W";
  e.textContent = "E";
  svg.append(n, s, w, e);

  svg.append(
    svgEl("circle", {
      cx,
      cy,
      r: domePx,
      fill: "rgba(219, 232, 248, 0.08)",
      stroke: "rgba(234,245,255,0.8)",
      "stroke-width": 2
    }),
    svgEl("circle", {
      cx,
      cy,
      r: domePx - 14,
      fill: "none",
      stroke: "rgba(234,245,255,0.35)",
      "stroke-width": 1
    })
  );

  const slitFootprint = buildTopSlitFootprint(
    state.domeRadiusMm,
    domeAzimuthDeg,
    getEffectiveSlitWidthMm(),
    state.slitWallHeightMm,
    state.maxSlitOpeningDeg,
    36
  );
  const topLeft = slitFootprint.left.map((pt) => projectTopPt(pt, cx, cy, scale));
  const topRight = slitFootprint.right.map((pt) => projectTopPt(pt, cx, cy, scale)).reverse();
  const slitPolyPts = [...topLeft, ...topRight].map((pt) => `${pt.x},${pt.y}`).join(" ");

  if (slitPolyPts.length > 0) {
    svg.append(svgEl("polygon", { points: slitPolyPts, fill: "rgba(3,6,12,0.95)", stroke: "none" }));
    if (topLeft.length > 1 && topRight.length > 1) {
      svg.append(
        svgEl("line", {
          x1: topLeft[0].x,
          y1: topLeft[0].y,
          x2: topLeft[topLeft.length - 1].x,
          y2: topLeft[topLeft.length - 1].y,
          stroke: "rgba(220,230,244,0.45)",
          "stroke-width": 1
        }),
        svgEl("line", {
          x1: topRight[topRight.length - 1].x,
          y1: topRight[topRight.length - 1].y,
          x2: topRight[0].x,
          y2: topRight[0].y,
          stroke: "rgba(220,230,244,0.45)",
          "stroke-width": 1
        })
      );
    }
  }

  const scene = buildMountScopeScene3D();
  renderSceneTop(svg, scene, cx, cy, scale);
  renderLaserTop(svg, cx, cy, scale);

  const domeTarget = getDomeTargetAzimuthDeg();
  const domeErr = Math.abs(signedDeltaDeg(domeTarget, domeAzimuthDeg));
  const info = svgEl("text", { x: cx, y: cy - domePx + 22, fill: "#c7d5e8", "font-size": 12, "text-anchor": "middle" });
  info.textContent = `Slit ${state.slitWidthMm.toFixed(0)} mm (${slitOpeningDeg.toFixed(1)} deg az width), shutter limit ${state.maxSlitOpeningDeg.toFixed(0)} deg @ ${domeAzimuthDeg.toFixed(0)} deg ${state.simulateDomeSlew ? `(target ${domeTarget.toFixed(0)} deg, err ${domeErr.toFixed(1)} deg)` : ""}`;
  svg.append(info);
}

function drawSideView() {
  const svg = document.getElementById("side-view");
  svg.innerHTML = "";

  const W = 640;
  const H = 420;
  const padX = 56;
  const padBottom = 36;
  const padTop = 22;

  const R = state.domeRadiusMm;
  const domeAzimuthDeg = getDomeAzimuthDeg();
  const sideRot = normalizeHeading(state.sideViewRotationDeg);
  const wallH = R;
  const totalH = 2 * R;
  const usableW = W - padX * 2;
  const usableH = H - padBottom - padTop;
  const scale = Math.min(usableW / (2 * R + 200), usableH / (totalH + 200));

  const xToPx = (x) => padX + (x + R) * scale;
  const zToPx = (z) => H - padBottom - z * scale;

  const left = xToPx(-R);
  const right = xToPx(R);
  const floorY = zToPx(0);
  const wallTop = zToPx(wallH);

  svg.append(
    svgEl("line", { x1: left - 25, y1: floorY, x2: right + 25, y2: floorY, stroke: "rgba(238,248,255,0.6)", "stroke-width": 1 }),
    svgEl("rect", {
      x: left,
      y: wallTop,
      width: right - left,
      height: floorY - wallTop,
      fill: "rgba(219, 232, 248, 0.12)",
      stroke: "rgba(237, 246, 255, 0.45)",
      "stroke-width": 2
    })
  );

  const capPath = [];
  for (let i = 0; i <= 80; i += 1) {
    const x = -R + (2 * R * i) / 80;
    const dz = Math.sqrt(Math.max(0, R * R - x * x));
    const z = wallH + dz;
    capPath.push(`${i === 0 ? "M" : "L"} ${xToPx(x)} ${zToPx(z)}`);
  }

  svg.append(
    svgEl("path", {
      d: capPath.join(" "),
      fill: "none",
      stroke: "rgba(237,246,255,0.75)",
      "stroke-width": 2
    })
  );

  const slitRibbon = buildDomeSlitRibbon3D(
    state.domeRadiusMm,
    domeAzimuthDeg,
    getEffectiveSlitWidthMm(),
    state.slitWallHeightMm,
    state.maxSlitOpeningDeg,
    36
  );

  const sideLeft = [...slitRibbon.leftWall, ...slitRibbon.leftCap].map((pt) => projectSidePt(pt, sideRot, xToPx, zToPx));
  const sideRight = [...slitRibbon.rightWall, ...slitRibbon.rightCap]
    .map((pt) => projectSidePt(pt, sideRot, xToPx, zToPx))
    .reverse();

  const slitPolyPts = [...sideLeft, ...sideRight].map((pt) => `${pt.x},${pt.y}`).join(" ");
  if (slitPolyPts.length > 0) {
    svg.append(
      svgEl("polygon", {
        points: slitPolyPts,
        fill: "rgba(3,6,12,0.95)",
        stroke: "rgba(226,236,250,0.5)",
        "stroke-width": 1
      })
    );
  }

  const scene = buildMountScopeScene3D();
  renderSceneSide(svg, scene, sideRot, xToPx, zToPx, scale);
  renderLaserSide(svg, sideRot, xToPx, zToPx);

  const yStepMm = Math.max(500, Math.round(totalH / 6 / 100) * 100);
  for (let mm = 0; mm <= Math.ceil(totalH); mm += yStepMm) {
    svg.append(svgEl("text", { x: 10, y: zToPx(mm) + 4, fill: "#cfe0f5", "font-size": 12 }));
    svg.lastChild.textContent = `${mm.toFixed(0)} mm`;
  }

  svg.append(
    svgEl("text", { x: left, y: H - 8, fill: "#cfe0f5", "font-size": 12 }),
    svgEl("text", { x: (left + right) / 2, y: H - 8, fill: "#cfe0f5", "text-anchor": "middle", "font-size": 12 }),
    svgEl("text", { x: right, y: H - 8, fill: "#cfe0f5", "text-anchor": "end", "font-size": 12 })
  );

  svg.children[svg.children.length - 3].textContent = `${Math.round(-R)} mm`;
  svg.children[svg.children.length - 2].textContent = "0 mm";
  svg.children[svg.children.length - 1].textContent = `${Math.round(R)} mm`;
}

function drawDiagnostics() {
  const host = document.getElementById("diagnostics");
  host.innerHTML = "";

  const title = document.createElement("h3");
  title.textContent = "Diagnostics";
  host.appendChild(title);

  state.telescopes.forEach((scope, idx) => {
    const row = document.createElement("div");
    row.className = "diag-line";

    const pointing = getScopePointing(scope);
    const heading = normalizeHeading(pointing.azimuthDeg);
    const visibility = evaluateScopeSlitVisibility(scope);

    const left = document.createElement("span");
    left.style.color = palette[idx % palette.length];
    left.textContent = scope.mountType === "EQ"
      ? `${scope.name}: HA ${normalizeSignedDeg(scope.hourAngleDeg).toFixed(0)} deg, Dec ${scope.declinationDeg.toFixed(0)} deg, Az ${heading.toFixed(0)} deg, El ${pointing.elevationDeg.toFixed(0)} deg`
      : `${scope.name}: Az ${heading.toFixed(0)} deg, El ${pointing.elevationDeg.toFixed(0)} deg, D ${scope.telescopeDiameterMm.toFixed(0)} mm, L ${scope.tubeLengthMm.toFixed(0)} mm`;

    const right = document.createElement("span");
    right.className = visibility.clear ? "diag-ok" : "diag-warn";
    right.textContent = visibility.reason;

    row.append(left, right);
    host.appendChild(row);
  });

  const summary = document.createElement("p");
  summary.style.marginBottom = "0";
  summary.style.color = "#a9bdd6";

  const domeCurrent = getDomeAzimuthDeg();
  const domeTarget = getDomeTargetAzimuthDeg();
  const domeErr = Math.abs(signedDeltaDeg(domeTarget, domeCurrent));
  const isSettling = runtime.settleUntilMs > Date.now();
  const domeState = !state.simulateDomeSlew
    ? "locked"
    : isSettling
      ? "settling"
      : domeErr > 0.05
        ? "slewing"
        : "on target";

  summary.textContent =
    `Slit cap ${state.maxSlitOpeningDeg.toFixed(0)} deg, latitude ${state.latitudeDeg.toFixed(1)} deg. Dome ${state.simulateDomeSlew ? `current ${domeCurrent.toFixed(1)} deg, target ${domeTarget.toFixed(1)} deg, error ${domeErr.toFixed(2)} deg, vel ${runtime.domeAngularVelDegPerSec.toFixed(2)} deg/s (${domeState}).` : `azimuth is ${domeCurrent.toFixed(1)} deg.`} Mode: ${state.domeFollowsTelescope ? "auto-follow" : "manual"}.`;
  host.appendChild(summary);
}

function renderAll() {
  if (!state.simulateDomeSlew) {
    runtime.currentDomeAzimuthDeg = getDomeTargetAzimuthDeg();
    runtime.domeAngularVelDegPerSec = 0;
    runtime.settleUntilMs = 0;
  }

  drawTopView();
  drawMountView();
  drawSideView();
  drawDiagnostics();
  ensureDomeAnimation();
}

function makeNumberField(scope, key, label, min, max, step) {
  return `
    <div class="field">
      <label for="${scope.id}-${key}">${label}</label>
      <input id="${scope.id}-${key}" data-scope-id="${scope.id}" data-scope-field="${key}" type="number"
        min="${min}" max="${max}" step="${step}" value="${scope[key]}">
    </div>
  `;
}

function makeTextField(scope, key, label, type) {
  return `
    <div class="field">
      <label for="${scope.id}-${key}">${label}</label>
      <input id="${scope.id}-${key}" data-scope-id="${scope.id}" data-scope-field="${key}" type="${type}" value="${scope[key]}">
    </div>
  `;
}

function makeSelectField(scope, key, label, opts) {
  const options = opts
    .map((opt) => `<option value="${opt}" ${opt === scope[key] ? "selected" : ""}>${opt}</option>`)
    .join("");

  return `
    <div class="field">
      <label for="${scope.id}-${key}">${label}</label>
      <select id="${scope.id}-${key}" data-scope-id="${scope.id}" data-scope-field="${key}">${options}</select>
    </div>
  `;
}

function makeMountNumberField(key, label, min, max, step) {
  const mountScope = getMountScope();
  return `
    <div class="field">
      <label for="mount-${key}">${label}</label>
      <input id="mount-${key}" data-mount-field="${key}" type="number"
        min="${min}" max="${max}" step="${step}" value="${mountScope?.[key] ?? 0}">
    </div>
  `;
}

function makeMountSliderField(key, label, min, max, step) {
  const mountScope = getMountScope();
  const value = mountScope?.[key] ?? 0;
  return `
    <div class="field mount-slider-field">
      <label for="mount-${key}">${label} (${Number(value).toFixed(0)} deg)</label>
      <input id="mount-${key}" data-mount-field="${key}" type="number"
        min="${min}" max="${max}" step="${step}" value="${value}">
      <input id="mount-${key}-slider" data-mount-field="${key}" type="range"
        min="${min}" max="${max}" step="${step}" value="${value}" aria-label="${label} slider">
    </div>
  `;
}

function makeMountSelectField(key, label, opts) {
  const mountScope = getMountScope();
  const value = mountScope?.[key];
  const options = opts
    .map((opt) => `<option value="${opt}" ${opt === value ? "selected" : ""}>${opt}</option>`)
    .join("");

  return `
    <div class="field">
      <label for="mount-${key}">${label}</label>
      <select id="mount-${key}" data-mount-field="${key}">${options}</select>
    </div>
  `;
}

function renderMountControls() {
  const host = document.getElementById("mount-controls");
  const mountScope = getMountScope();
  if (!host || !mountScope) return;

  const isEq = mountScope.mountType === "EQ";
  host.innerHTML = `
    ${makeMountSelectField("mountType", "Mount Type", ["EQ", "AZ"])}
    ${makeMountNumberField("posNS", "Position N/S (mm)", -5000, 5000, 10)}
    ${makeMountNumberField("posEW", "Position E/W (mm)", -5000, 5000, 10)}
    ${makeMountNumberField("posUD", "Position Up/Down (mm)", -5000, 5000, 10)}
    ${isEq ? makeMountNumberField("counterweightShaftLengthMm", "Counterweight Shaft Length (mm)", 120, 3000, 10) : ""}
    ${isEq ? makeMountNumberField("counterweightDiameterMm", "CW Diameter (mm)", 30, 800, 5) : ""}
    ${isEq ? makeMountSelectField("pierSideMode", "Meridian Flip", ["AUTO", "MANUAL"]) : ""}
    ${isEq ? makeMountSelectField("pierSide", "Pier Side", ["WEST", "EAST"]) : ""}
    ${isEq
      ? makeMountSliderField("hourAngleDeg", "RA Axis / Hour Angle", -180, 180, 1)
      : makeMountNumberField("azimuth", "Azimuth (deg)", 0, 359, 1)}
    ${isEq
      ? makeMountSliderField("declinationDeg", "DEC Axis / Declination", -90, 90, 1)
      : makeMountNumberField("elevation", "Elevation (deg)", 0, 89, 1)}
  `;

  const syncMountFieldInputs = (field) => {
    for (const control of host.querySelectorAll(`[data-mount-field="${field}"]`)) {
      if (control.tagName === "SELECT") continue;
      control.value = String(mountScope[field]);
      const label = control.closest(".field")?.querySelector("label");
      if (label && (field === "hourAngleDeg" || field === "declinationDeg")) {
        label.textContent = `${field === "hourAngleDeg" ? "RA Axis / Hour Angle" : "DEC Axis / Declination"} (${Number(mountScope[field]).toFixed(0)} deg)`;
      }
    }
  };

  for (const input of host.querySelectorAll("[data-mount-field]")) {
    input.addEventListener("input", (e) => {
      const field = e.target.getAttribute("data-mount-field");
      if (!field) return;

      if (field === "mountType" || field === "pierSideMode" || field === "pierSide") {
        mountScope[field] = e.target.value;
      } else {
        const parsed = Number(e.target.value);
        if (!Number.isFinite(parsed)) return;
        mountScope[field] = parsed;
      }

      if ((field === "mountType" || field === "pierSideMode") && runtime.trackingScopeId === mountScope.id) {
        stopTrackingTelescope();
      }
      if (field === "azimuth") mountScope.azimuth = normalizeHeading(mountScope.azimuth);
      if (field === "elevation") mountScope.elevation = clamp(mountScope.elevation, 0, 89);
      if (field === "hourAngleDeg") mountScope.hourAngleDeg = normalizeSignedDeg(mountScope.hourAngleDeg);
      if (field === "declinationDeg") mountScope.declinationDeg = clamp(mountScope.declinationDeg, -90, 90);

      if (field === "mountType" || field === "pierSideMode") {
        renderMountControls();
        renderScopeCards();
      } else {
        syncMountFieldInputs(field);
        if (["pierSide", "hourAngleDeg", "declinationDeg", "azimuth", "elevation"].includes(field)) {
          renderScopeCards();
        }
      }
      renderAll();
    });
  }
}

function renderScopeCards() {
  const wrap = document.getElementById("telescopes-container");
  wrap.innerHTML = "";
  const mountScope = getMountScope();

  for (let i = 0; i < state.telescopes.length; i += 1) {
    const scope = state.telescopes[i];
    const pointing = getScopePointing(scope);
    const isMountOwner = scope === mountScope;
    const mountConfig = mountScope ?? scope;

    const card = document.createElement("article");
    card.className = "scope-card";
    const isEq = mountConfig.mountType === "EQ";
    const removeButton = isMountOwner
      ? `<span class="chip">Primary OTA</span>`
      : `<button class="remove-scope" data-id="${scope.id}" type="button">Remove</button>`;
    const mountControls = isMountOwner
      ? `
        ${isEq ? makeNumberField(scope, "gemAxisLength", "GEM Axis Length (mm)", 0, 5000, 10) : ""}
        ${isEq ? makeNumberField(scope, "lateralAxisLength", "Lateral Axis Length (mm)", 0, 5000, 10) : ""}
      `
      : `
        ${makeSelectField(scope, "otaLayout", "OTA Layout", ["SIDE_BY_SIDE", "PIGGYBACK"])}
        ${isEq ? makeNumberField(scope, "gemAxisLength", "GEM Axis Length (mm)", 0, 5000, 10) : ""}
        ${isEq ? makeNumberField(scope, "lateralAxisLength", "Lateral Axis Length (mm)", 0, 5000, 10) : ""}
        ${makeNumberField(scope, "otaSideOffsetMm", "Side Offset (mm)", -2000, 2000, 10)}
        ${makeNumberField(scope, "otaPiggybackOffsetMm", "Piggyback Height (mm)", 0, 2000, 10)}
      `;
    card.innerHTML = `
      <div class="scope-card-header">
        <h4>${scope.name}</h4>
        ${removeButton}
      </div>

      <p class="scope-mode-note">
        ${isMountOwner
          ? isEq
            ? `Shared EQ mount: HA ${normalizeSignedDeg(mountConfig.hourAngleDeg).toFixed(0)} deg, Dec ${mountConfig.declinationDeg.toFixed(0)} deg, Pier ${getEqPierSide(scope)}, derived Az ${pointing.azimuthDeg.toFixed(0)} deg, El ${pointing.elevationDeg.toFixed(0)} deg`
            : `Shared AZ mount: Az ${pointing.azimuthDeg.toFixed(0)} deg, El ${pointing.elevationDeg.toFixed(0)} deg`
          : `Secondary OTA: ${scope.otaLayout === "PIGGYBACK" ? "piggyback" : "side-by-side"}, side ${Number(scope.otaSideOffsetMm || 0).toFixed(0)} mm, piggyback ${Number(scope.otaPiggybackOffsetMm || 0).toFixed(0)} mm`}
      </p>

      <div class="scope-grid">
        ${makeTextField(scope, "name", "Name", "text")}
        ${mountControls}
        ${makeNumberField(scope, "telescopeDiameterMm", "Telescope Diameter (mm)", 20, 1200, 5)}
        ${makeNumberField(scope, "tubeLengthMm", "Tube Length (mm)", 120, 4000, 10)}
      </div>

      ${isMountOwner && isEq ? `<div class="track-row"><button class="track-scope" data-id="${scope.id}" type="button">${isTrackingScope(mountConfig.id) ? "Stop Tracking" : "Track Mount"}</button></div>` : ""}
    `;

    wrap.appendChild(card);

    const removeBtn = card.querySelector(".remove-scope");
    if (removeBtn) {
      removeBtn.addEventListener("click", () => {
        if (state.telescopes.length === 1) return;
        if (runtime.trackingScopeId === scope.id) stopTrackingTelescope();
        state.telescopes = state.telescopes.filter((t) => t.id !== scope.id);
        if (!state.telescopes.find((t) => t.id === Number(state.followScopeId))) {
          state.followScopeId = state.telescopes[0]?.id ?? 1;
        }
        renderGlobalControls();
        renderDomeSimControls();
        renderScopeCards();
        renderAll();
      });
    }

    for (const input of card.querySelectorAll("[data-scope-field]")) {
      input.addEventListener("input", (e) => {
        const id = Number(e.target.getAttribute("data-scope-id"));
        const field = e.target.getAttribute("data-scope-field");
        const target = state.telescopes.find((t) => t.id === id);
        if (!target) return;

        if (field === "name" || field === "mountType" || field === "pierSideMode" || field === "pierSide" || field === "otaLayout") {
          target[field] = e.target.value;
        } else {
          const parsed = Number(e.target.value);
          if (!Number.isFinite(parsed)) return;
          target[field] = parsed;
        }

        if ((field === "mountType" || field === "pierSideMode") && runtime.trackingScopeId === target.id) {
          stopTrackingTelescope();
        }
        if (field === "mountType" || field === "pierSideMode") {
          renderScopeCards();
        }
        if (field === "name") renderDomeSimControls();
        if (field === "azimuth") target.azimuth = normalizeHeading(target.azimuth);
        if (field === "elevation") target.elevation = clamp(target.elevation, 0, 89);
        if (field === "hourAngleDeg") target.hourAngleDeg = normalizeSignedDeg(target.hourAngleDeg);
        if (field === "declinationDeg") target.declinationDeg = clamp(target.declinationDeg, -90, 90);
        if (field === "telescopeDiameterMm") target.telescopeDiameterMm = Math.max(20, target.telescopeDiameterMm);
        if (field === "tubeLengthMm") target.tubeLengthMm = Math.max(120, target.tubeLengthMm);
        if (field === "otaPiggybackOffsetMm") target.otaPiggybackOffsetMm = Math.max(0, target.otaPiggybackOffsetMm);

        renderAll();
      });
    }

    const trackBtn = card.querySelector(".track-scope");
    if (trackBtn) {
      trackBtn.addEventListener("click", () => {
        startTrackingTelescope(scope.id);
      });
    }

  }
}

function renderGlobalControls() {
  const host = document.getElementById("global-controls");
  host.innerHTML = "";

  for (const control of globalControls) {
    const field = document.createElement("div");
    field.className = "field";

    const label = document.createElement("label");
    label.setAttribute("for", control.key);
    label.textContent = control.label;

    const input = document.createElement("input");
    input.id = control.key;
    input.type = "number";
    input.min = String(control.min);
    input.max = String(control.max);
    input.step = String(control.step);
    input.value = String(state[control.key]);

    input.addEventListener("input", () => {
      const parsed = Number(input.value);
      if (!Number.isFinite(parsed)) return;
      state[control.key] = clamp(parsed, control.min, control.max);
      if (control.key === "domeAzimuthDeg" || control.key === "sideViewRotationDeg") {
        state[control.key] = normalizeHeading(state[control.key]);
      }
      renderAll();
    });

    if (control.key === "domeAzimuthDeg") input.disabled = state.domeFollowsTelescope;
    field.append(label, input);
    host.appendChild(field);
  }

  const sideRotSliderField = document.createElement("div");
  sideRotSliderField.className = "field";
  const sideRotSliderLabel = document.createElement("label");
  sideRotSliderLabel.setAttribute("for", "side-rotation-slider");
  sideRotSliderLabel.textContent = `Side View Rotation Slider (${state.sideViewRotationDeg.toFixed(0)} deg)`;
  const sideRotSlider = document.createElement("input");
  sideRotSlider.id = "side-rotation-slider";
  sideRotSlider.type = "range";
  sideRotSlider.min = "0";
  sideRotSlider.max = "359";
  sideRotSlider.step = "1";
  sideRotSlider.value = String(state.sideViewRotationDeg);
  sideRotSlider.addEventListener("input", () => {
    state.sideViewRotationDeg = normalizeHeading(Number(sideRotSlider.value));
    sideRotSliderLabel.textContent = `Side View Rotation Slider (${state.sideViewRotationDeg.toFixed(0)} deg)`;
    renderAll();
  });
  sideRotSliderField.append(sideRotSliderLabel, sideRotSlider);
  host.appendChild(sideRotSliderField);
}

function renderDomeSimControls() {
  const host = document.getElementById("dome-sim-controls");
  if (!host) return;
  host.innerHTML = "";

  for (const control of domeSimControls) {
    const field = document.createElement("div");
    field.className = "field";

    const label = document.createElement("label");
    label.setAttribute("for", control.key);
    label.textContent = control.label;

    const input = document.createElement("input");
    input.id = control.key;
    input.type = "number";
    input.min = String(control.min);
    input.max = String(control.max);
    input.step = String(control.step);
    input.value = String(state[control.key]);

    input.addEventListener("input", () => {
      const parsed = Number(input.value);
      if (!Number.isFinite(parsed)) return;
      state[control.key] = clamp(parsed, control.min, control.max);
      if (control.key === "domeAzimuthDeg") state[control.key] = normalizeHeading(state[control.key]);
      renderAll();
    });

    if (control.key === "domeAzimuthDeg") input.disabled = state.domeFollowsTelescope;
    field.append(label, input);
    host.appendChild(field);
  }

  const followToggleField = document.createElement("div");
  followToggleField.className = "field";
  const followLabel = document.createElement("label");
  followLabel.setAttribute("for", "dome-follows-toggle");
  followLabel.textContent = "Dome Follows Telescope";
  const followInput = document.createElement("input");
  followInput.id = "dome-follows-toggle";
  followInput.type = "checkbox";
  followInput.checked = state.domeFollowsTelescope;
  followInput.addEventListener("change", () => {
    state.domeFollowsTelescope = followInput.checked;
    renderDomeSimControls();
    renderAll();
  });
  followToggleField.append(followLabel, followInput);
  host.appendChild(followToggleField);

  const followScopeField = document.createElement("div");
  followScopeField.className = "field";
  const scopeLabel = document.createElement("label");
  scopeLabel.setAttribute("for", "follow-scope-id");
  scopeLabel.textContent = "Follow Telescope";
  const scopeSelect = document.createElement("select");
  scopeSelect.id = "follow-scope-id";

  state.telescopes.forEach((scope) => {
    const opt = document.createElement("option");
    opt.value = String(scope.id);
    opt.textContent = scope.name;
    if (scope.id === Number(state.followScopeId)) opt.selected = true;
    scopeSelect.appendChild(opt);
  });

  if (!state.telescopes.find((scope) => scope.id === Number(state.followScopeId))) {
    state.followScopeId = state.telescopes[0]?.id ?? 1;
  }

  scopeSelect.disabled = !state.domeFollowsTelescope;
  scopeSelect.addEventListener("change", () => {
    state.followScopeId = Number(scopeSelect.value);
    renderAll();
  });

  followScopeField.append(scopeLabel, scopeSelect);
  host.appendChild(followScopeField);

  const laserToggleField = document.createElement("div");
  laserToggleField.className = "field";
  const laserLabel = document.createElement("label");
  laserLabel.setAttribute("for", "show-laser-line");
  laserLabel.textContent = "Show Laser Line";
  const laserInput = document.createElement("input");
  laserInput.id = "show-laser-line";
  laserInput.type = "checkbox";
  laserInput.checked = state.showLaserLine;
  laserInput.addEventListener("change", () => {
    state.showLaserLine = laserInput.checked;
    renderAll();
  });
  laserToggleField.append(laserLabel, laserInput);
  host.appendChild(laserToggleField);

  const slewToggleField = document.createElement("div");
  slewToggleField.className = "field";
  const slewLabel = document.createElement("label");
  slewLabel.setAttribute("for", "simulate-dome-slew");
  slewLabel.textContent = "Simulate Dome Motion";
  const slewInput = document.createElement("input");
  slewInput.id = "simulate-dome-slew";
  slewInput.type = "checkbox";
  slewInput.checked = state.simulateDomeSlew;
  slewInput.addEventListener("change", () => {
    state.simulateDomeSlew = slewInput.checked;
    if (!state.simulateDomeSlew) runtime.currentDomeAzimuthDeg = getDomeTargetAzimuthDeg();
    renderAll();
  });
  slewToggleField.append(slewLabel, slewInput);
  host.appendChild(slewToggleField);

  const syncField = document.createElement("div");
  syncField.className = "field";
  const syncLabel = document.createElement("label");
  syncLabel.textContent = "Dome Sync";
  const syncBtn = document.createElement("button");
  syncBtn.type = "button";
  syncBtn.textContent = "Sync Dome To Target";
  syncBtn.addEventListener("click", () => syncDomeNow());
  syncField.append(syncLabel, syncBtn);
  host.appendChild(syncField);
}

function wireButtons() {
  const addBtn = document.getElementById("add-scope");
  addBtn.addEventListener("click", () => {
    const ota = createScope(nextScopeId);
    ota.otaLayout = "SIDE_BY_SIDE";
    ota.otaSideOffsetMm = 320 * (state.telescopes.length % 2 === 0 ? -1 : 1);
    ota.otaPiggybackOffsetMm = 180;
    state.telescopes.push(ota);
    state.followScopeId = state.followScopeId || nextScopeId;
    nextScopeId += 1;
    renderGlobalControls();
    renderDomeSimControls();
    renderScopeCards();
    renderAll();
  });

  const tabs = Array.from(document.querySelectorAll("[data-view-tab]"));
  const panels = Array.from(document.querySelectorAll("[data-view-panel]"));

  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      const targetView = tab.getAttribute("data-view-tab");

      for (const item of tabs) {
        const isActive = item === tab;
        item.classList.toggle("active", isActive);
        item.setAttribute("aria-selected", String(isActive));
      }

      for (const panel of panels) {
        const isActive = panel.getAttribute("data-view-panel") === targetView;
        panel.classList.toggle("active", isActive);
        panel.hidden = !isActive;
      }
      renderAll();
    });
  }

  const renderMode = document.getElementById("mount-render-mode");
  const modelUrl = document.getElementById("mount-model-url");
  const loadUrlBtn = document.getElementById("mount-load-url");
  const modelFile = document.getElementById("mount-model-file");
  const resetViewBtn = document.getElementById("mount-reset-view");

  if (renderMode) {
    renderMode.value = state.mountViewMode;
    renderMode.addEventListener("change", () => {
      state.mountViewMode = renderMode.value === "GLB" ? "GLB" : "PROCEDURAL";
      renderAll();
    });
  }

  if (modelUrl) {
    modelUrl.value = state.mountModelUrl;
    modelUrl.addEventListener("input", () => {
      state.mountModelUrl = modelUrl.value.trim();
    });
  }

  if (loadUrlBtn) {
    loadUrlBtn.addEventListener("click", () => {
      state.mountViewMode = "GLB";
      if (renderMode) renderMode.value = "GLB";
      ensureMountThreeView().then((view) => view?.loadGlbFromUrl(state.mountModelUrl)).catch(() => {});
    });
  }

  if (modelFile) {
    modelFile.addEventListener("change", () => {
      const file = modelFile.files?.[0] ?? null;
      if (!file) return;
      state.mountViewMode = "GLB";
      if (renderMode) renderMode.value = "GLB";
      ensureMountThreeView().then((view) => view?.loadGlbFromFile(file)).catch(() => {});
    });
  }

  if (resetViewBtn) {
    resetViewBtn.addEventListener("click", () => {
      ensureMountThreeView().then((view) => view?.resetView()).catch(() => {});
    });
  }
}

function init() {
  runtime.currentDomeAzimuthDeg = getDomeTargetAzimuthDeg();
  renderGlobalControls();
  renderDomeSimControls();
  renderMountControls();
  wireButtons();
  renderScopeCards();
  renderAll();
}

init();
