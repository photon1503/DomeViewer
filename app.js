const NS = "http://www.w3.org/2000/svg";
const MAX_SLIT_OPENING_DEG = 85;

const palette = ["#7ad7ff", "#ff9f6e", "#bba4ff", "#71f3a9", "#ffd56f", "#ff7bb5"];

const state = {
  domeRadiusMm: 1500,
  slitWidthMm: 1100,
  maxSlitOpeningDeg: 85,
  slitWallHeightMm: 1500,
  azToleranceDeg: 2,
  latitudeDeg: 52,
  domeAzimuthDeg: 0,
  domeFollowsTelescope: true,
  followScopeId: 1,
  simulateDomeSlew: true,
  domeSlewSpeedDegPerSec: 7,
  domeAccelDegPerSec2: 4,
  domeDecelDegPerSec2: 5,
  domeSettleTimeSec: 0.6,
  sideViewRotationDeg: 0,
  telescopes: [createScope(1)]
};

const runtime = {
  currentDomeAzimuthDeg: 0,
  domeAngularVelDegPerSec: 0,
  settleUntilMs: 0,
  rafId: null,
  lastTsMs: 0
};

let nextScopeId = 2;

const globalControls = [
  { key: "domeRadiusMm", label: "Dome Radius (mm)", min: 500, max: 12000, step: 10 },
  { key: "slitWidthMm", label: "Slit Width (mm)", min: 100, max: 20000, step: 10 },
  { key: "maxSlitOpeningDeg", label: "Max Slit Opening (deg)", min: 5, max: 85, step: 1 },
  { key: "slitWallHeightMm", label: "Slit Wall Height (mm)", min: 300, max: 12000, step: 10 },
  { key: "azToleranceDeg", label: "Azimuth Tolerance (deg)", min: 0, max: 30, step: 1 },
  { key: "latitudeDeg", label: "Latitude (deg)", min: -89, max: 89, step: 0.1 },
  { key: "domeAzimuthDeg", label: "Dome Azimuth (deg)", min: 0, max: 359, step: 1 },
  { key: "domeSlewSpeedDegPerSec", label: "Dome Slew Speed (deg/s)", min: 0.2, max: 40, step: 0.1 },
  { key: "domeAccelDegPerSec2", label: "Dome Accel (deg/s^2)", min: 0.2, max: 100, step: 0.1 },
  { key: "domeDecelDegPerSec2", label: "Dome Decel (deg/s^2)", min: 0.2, max: 100, step: 0.1 },
  { key: "domeSettleTimeSec", label: "Settle Time (s)", min: 0, max: 30, step: 0.1 },
  { key: "sideViewRotationDeg", label: "Side View Rotation (deg)", min: 0, max: 359, step: 1 }
];

function createScope(idx) {
  return {
    id: idx,
    name: `Telescope ${idx}`,
    mountType: "EQ",
    posNS: -80,
    posEW: 0,
    posUD: 272,
    gemAxisLength: 435,
    lateralAxisLength: 230,
    telescopeDiameterMm: 120,
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
  return clamp(raw, 0, state.maxSlitOpeningDeg);
}

function getEffectiveSlitWidthMm() {
  const openingDeg = computeSlitOpeningDeg();
  return state.domeRadiusMm * degToRad(openingDeg);
}

function getFollowScope() {
  return state.telescopes.find((scope) => scope.id === Number(state.followScopeId)) ?? null;
}

function getDomeTargetAzimuthDeg() {
  if (state.domeFollowsTelescope) {
    const target = getFollowScope();
    if (target) return normalizeHeading(target.azimuth);
  }
  return normalizeHeading(state.domeAzimuthDeg);
}

function getDomeAzimuthDeg() {
  return normalizeHeading(runtime.currentDomeAzimuthDeg);
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

function domeRadiusAtHeight(zMm, radiusMm) {
  if (zMm <= radiusMm) return radiusMm;
  const dz = zMm - radiusMm;
  return Math.sqrt(Math.max(0, radiusMm * radiusMm - dz * dz));
}

function buildDomeSlitRibbon3D(radiusMm, slitAzDeg, slitWidthMm, wallHeightMm, samples = 48) {
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
  for (let i = 0; i <= capSamples; i += 1) {
    const t = i / capSamples;
    const z = wallTop + t * (2 * radiusMm - wallTop);
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

function buildMountScopeScene3D() {
  const up = v3(0, 0, 1);
  const scene = [];

  state.telescopes.forEach((scope, idx) => {
    const color = palette[idx % palette.length];
    const mount = v3(scope.posEW, scope.posNS, scope.posUD);
    const az = degToRad(scope.azimuth);
    const el = degToRad(scope.elevation);
    const horiz = v3(Math.sin(az), Math.cos(az), 0);
    const optical = v3Norm(v3Add(v3Scale(horiz, Math.cos(el)), v3(0, 0, Math.sin(el))));

    const lines = [];
    const circles = [];
    const labels = [];

    lines.push({ a: v3(mount.x, mount.y, 0), b: mount, widthMm: 35, stroke: "rgba(220,230,255,0.55)" });

    if (scope.mountType === "EQ") {
      const latAbs = degToRad(clamp(Math.abs(state.latitudeDeg), 0, 89.5));
      const hemiSign = state.latitudeDeg >= 0 ? 1 : -1;
      const raUnit = v3Norm(v3(0, hemiSign * Math.cos(latAbs), Math.sin(latAbs)));
      let decUnit = v3Norm(v3Cross(raUnit, up));
      if (Math.hypot(decUnit.x, decUnit.y, decUnit.z) < 1e-6) decUnit = v3(1, 0, 0);

      const raLen = Math.max(120, scope.gemAxisLength);
      const raHead = v3Add(mount, v3Scale(raUnit, raLen));
      const decHalf = Math.max(80, scope.lateralAxisLength * 0.5);
      const decA = v3Add(raHead, v3Scale(decUnit, decHalf));
      const decB = v3Add(raHead, v3Scale(decUnit, -decHalf));

      const saddle = v3Dot(optical, decUnit) >= 0 ? decA : decB;
      const tubeLen = 700;
      const tubeEnd = v3Add(saddle, v3Scale(optical, tubeLen));

      const cwStart = v3Add(mount, v3Scale(raUnit, -Math.max(35, scope.gemAxisLength * 0.08)));
      const cwEnd = v3Add(cwStart, v3Scale(raUnit, -Math.max(220, scope.gemAxisLength * 1.05)));
      const cwMid = v3Add(cwStart, v3Scale(raUnit, -Math.max(220, scope.gemAxisLength * 1.05) * 0.7));

      lines.push({ a: mount, b: raHead, widthMm: 60, stroke: color });
      lines.push({ a: raHead, b: decA, widthMm: 40, stroke: "rgba(234,244,255,0.9)" });
      lines.push({ a: raHead, b: decB, widthMm: 40, stroke: "rgba(234,244,255,0.9)" });
      lines.push({ a: saddle, b: tubeEnd, widthMm: Math.max(35, scope.telescopeDiameterMm), stroke: color });
      lines.push({ a: mount, b: cwStart, widthMm: 30, stroke: "rgba(220,233,255,0.9)" });
      lines.push({ a: cwStart, b: cwEnd, widthMm: 30, stroke: "rgba(235,243,255,0.95)" });

      circles.push({ c: mount, rMm: 70, stroke: "rgba(230,240,255,0.85)", fill: "rgba(114,137,175,0.32)", swMm: 14 });
      circles.push({ c: raHead, rMm: 40, stroke: "rgba(227,240,255,0.9)", fill: "rgba(173,199,236,0.45)", swMm: 8 });
      circles.push({ c: tubeEnd, rMm: Math.max(20, scope.telescopeDiameterMm * 0.5), stroke: color, fill: "rgba(225,235,250,0.2)", swMm: 8 });
      circles.push({ c: cwEnd, rMm: 55, stroke: "rgba(240,248,255,0.95)", fill: "rgba(217,229,248,0.72)", swMm: 8 });
      circles.push({ c: cwMid, rMm: 42, stroke: "rgba(240,248,255,0.95)", fill: "rgba(217,229,248,0.72)", swMm: 8 });

      labels.push({ p: raHead, text: "RA", color: "#d6e8ff" });
      labels.push({ p: saddle, text: "DEC", color: "#d6e8ff" });
      labels.push({ p: cwStart, text: "CW", color: "#d6e8ff" });
    } else {
      const azHead = v3(mount.x, mount.y, mount.z + Math.max(110, scope.gemAxisLength * 0.45));
      let altAxis = v3Norm(v3Cross(up, horiz));
      if (Math.hypot(altAxis.x, altAxis.y, altAxis.z) < 1e-6) altAxis = v3(1, 0, 0);
      const barA = v3Add(azHead, v3Scale(altAxis, 85));
      const barB = v3Add(azHead, v3Scale(altAxis, -85));
      const tubeEnd = v3Add(azHead, v3Scale(optical, 740));

      lines.push({ a: mount, b: azHead, widthMm: 60, stroke: color });
      lines.push({ a: barA, b: barB, widthMm: 35, stroke: "rgba(230,240,255,0.9)" });
      lines.push({ a: azHead, b: tubeEnd, widthMm: Math.max(35, scope.telescopeDiameterMm), stroke: color });

      circles.push({ c: mount, rMm: 70, stroke: "rgba(230,240,255,0.85)", fill: "rgba(114,137,175,0.32)", swMm: 14 });
      circles.push({ c: tubeEnd, rMm: Math.max(20, scope.telescopeDiameterMm * 0.5), stroke: color, fill: "rgba(225,235,250,0.2)", swMm: 8 });
    }

    labels.push({ p: mount, text: scope.name, color });

    scene.push({ color, lines, circles, labels });
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

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, String(value));
  }
  return el;
}

function renderSceneTop(svg, scene, cx, cy, scale) {
  scene.forEach((obj) => {
    obj.lines.forEach((line) => {
      const a = projectTopPt(line.a, cx, cy, scale);
      const b = projectTopPt(line.b, cx, cy, scale);
      svg.append(
        svgEl("line", {
          x1: a.x,
          y1: a.y,
          x2: b.x,
          y2: b.y,
          stroke: line.stroke,
          "stroke-width": strokePxFromMm(line.widthMm, scale, 1.2),
          "stroke-linecap": "round"
        })
      );
    });

    obj.circles.forEach((c) => {
      const p = projectTopPt(c.c, cx, cy, scale);
      svg.append(
        svgEl("circle", {
          cx: p.x,
          cy: p.y,
          r: radiusPxFromMm(c.rMm, scale, 2.4),
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
    obj.lines.forEach((line) => {
      const a = projectSidePt(line.a, sideRot, xToPx, zToPx);
      const b = projectSidePt(line.b, sideRot, xToPx, zToPx);
      svg.append(
        svgEl("line", {
          x1: a.x,
          y1: a.y,
          x2: b.x,
          y2: b.y,
          stroke: line.stroke,
          "stroke-width": strokePxFromMm(line.widthMm, scale, 1.1),
          "stroke-linecap": "round"
        })
      );
    });

    obj.circles.forEach((c) => {
      const p = projectSidePt(c.c, sideRot, xToPx, zToPx);
      svg.append(
        svgEl("circle", {
          cx: p.x,
          cy: p.y,
          r: radiusPxFromMm(c.rMm, scale, 2.2),
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

  const slitRibbon = buildDomeSlitRibbon3D(
    state.domeRadiusMm,
    domeAzimuthDeg,
    getEffectiveSlitWidthMm(),
    state.slitWallHeightMm,
    36
  );
  const topLeft = slitRibbon.leftCap.map((pt) => projectTopPt(pt, cx, cy, scale));
  const topRight = slitRibbon.rightCap.map((pt) => projectTopPt(pt, cx, cy, scale)).reverse();
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

  const rawSlitDeg = (Math.max(0, state.slitWidthMm) / Math.max(1, state.domeRadiusMm)) * (180 / Math.PI);
  const isCapped = rawSlitDeg > state.maxSlitOpeningDeg + 0.0001;
  const domeTarget = getDomeTargetAzimuthDeg();
  const domeErr = Math.abs(signedDeltaDeg(domeTarget, domeAzimuthDeg));
  const info = svgEl("text", { x: cx, y: cy - domePx + 22, fill: "#c7d5e8", "font-size": 12, "text-anchor": "middle" });
  info.textContent = `Slit ${state.slitWidthMm.toFixed(0)} mm (${slitOpeningDeg.toFixed(1)} deg${isCapped ? " capped" : ""}) @ ${domeAzimuthDeg.toFixed(0)} deg ${state.simulateDomeSlew ? `(target ${domeTarget.toFixed(0)} deg, err ${domeErr.toFixed(1)} deg)` : ""}`;
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

    const heading = normalizeHeading(scope.azimuth);
    const domeAz = getDomeAzimuthDeg();
    const rel = signedDeltaDeg(heading, domeAz);
    const slitOk = inSlit(rel, computeSlitOpeningDeg(), state.azToleranceDeg);

    const left = document.createElement("span");
    left.style.color = palette[idx % palette.length];
    left.textContent = `${scope.name}: Az ${heading.toFixed(0)} deg, El ${scope.elevation.toFixed(0)} deg, D ${scope.telescopeDiameterMm.toFixed(0)} mm`;

    const right = document.createElement("span");
    right.className = slitOk ? "diag-ok" : "diag-warn";
    right.textContent = slitOk ? "Inside slit window" : "Outside slit window";

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

function renderScopeCards() {
  const wrap = document.getElementById("telescopes-container");
  wrap.innerHTML = "";

  for (let i = 0; i < state.telescopes.length; i += 1) {
    const scope = state.telescopes[i];

    const card = document.createElement("article");
    card.className = "scope-card";
    card.innerHTML = `
      <div class="scope-card-header">
        <h4>${scope.name}</h4>
        <button class="remove-scope" data-id="${scope.id}" type="button">Remove</button>
      </div>

      <div class="scope-grid">
        ${makeSelectField(scope, "mountType", "Mount Type", ["EQ", "AZ"])}
        ${makeTextField(scope, "name", "Name", "text")}
        ${makeNumberField(scope, "posNS", "Position N/S (mm)", -5000, 5000, 10)}
        ${makeNumberField(scope, "posEW", "Position E/W (mm)", -5000, 5000, 10)}
        ${makeNumberField(scope, "posUD", "Position Up/Down (mm)", -5000, 5000, 10)}
        ${makeNumberField(scope, "gemAxisLength", "GEM Axis Length (mm)", 0, 5000, 10)}
        ${makeNumberField(scope, "lateralAxisLength", "Lateral Axis Length (mm)", 0, 5000, 10)}
        ${makeNumberField(scope, "telescopeDiameterMm", "Telescope Diameter (mm)", 20, 1200, 5)}
        ${makeNumberField(scope, "azimuth", "Move Scope Azimuth (deg)", 0, 359, 1)}
        ${makeNumberField(scope, "elevation", "Move Scope Elevation (deg)", 0, 89, 1)}
      </div>

      <div class="move-panel">
        <div class="move-pad-wrap">
          <span class="move-caption">Move Scope</span>
          <div class="move-pad">
            <button class="move-btn" data-id="${scope.id}" data-field="posNS" data-step="10" type="button">N</button>
            <button class="move-btn" data-id="${scope.id}" data-field="posUD" data-step="10" type="button">U</button>
            <button class="move-btn" data-id="${scope.id}" data-field="posEW" data-step="-10" type="button">W</button>
            <button class="move-btn move-center" data-id="${scope.id}" data-center="true" type="button">0</button>
            <button class="move-btn" data-id="${scope.id}" data-field="posEW" data-step="10" type="button">E</button>
            <button class="move-btn" data-id="${scope.id}" data-field="posNS" data-step="-10" type="button">S</button>
            <button class="move-btn" data-id="${scope.id}" data-field="posUD" data-step="-10" type="button">D</button>
          </div>
        </div>

        <div class="move-sliders">
          <label for="${scope.id}-az-slider">Azimuth</label>
          <input id="${scope.id}-az-slider" data-scope-id="${scope.id}" data-scope-field="azimuth" type="range" min="0" max="359" step="1" value="${scope.azimuth}">
          <label for="${scope.id}-el-slider">Elevation</label>
          <input id="${scope.id}-el-slider" data-scope-id="${scope.id}" data-scope-field="elevation" type="range" min="0" max="89" step="1" value="${scope.elevation}">
        </div>
      </div>
    `;

    wrap.appendChild(card);

    card.querySelector(".remove-scope").addEventListener("click", () => {
      if (state.telescopes.length === 1) return;
      state.telescopes = state.telescopes.filter((t) => t.id !== scope.id);
      if (!state.telescopes.find((t) => t.id === Number(state.followScopeId))) {
        state.followScopeId = state.telescopes[0]?.id ?? 1;
      }
      renderGlobalControls();
      renderScopeCards();
      renderAll();
    });

    for (const input of card.querySelectorAll("[data-scope-field]")) {
      input.addEventListener("input", (e) => {
        const id = Number(e.target.getAttribute("data-scope-id"));
        const field = e.target.getAttribute("data-scope-field");
        const target = state.telescopes.find((t) => t.id === id);
        if (!target) return;

        if (field === "name" || field === "mountType") {
          target[field] = e.target.value;
        } else {
          const parsed = Number(e.target.value);
          if (!Number.isFinite(parsed)) return;
          target[field] = parsed;
        }

        if (field === "azimuth") target.azimuth = normalizeHeading(target.azimuth);
        if (field === "elevation") target.elevation = clamp(target.elevation, 0, 89);
        if (field === "telescopeDiameterMm") target.telescopeDiameterMm = Math.max(20, target.telescopeDiameterMm);

        renderAll();
      });
    }

    for (const btn of card.querySelectorAll(".move-btn")) {
      btn.addEventListener("click", () => {
        const id = Number(btn.getAttribute("data-id"));
        const target = state.telescopes.find((t) => t.id === id);
        if (!target) return;

        if (btn.getAttribute("data-center") === "true") {
          target.posNS = 0;
          target.posEW = 0;
          target.posUD = 0;
        } else {
          const field = btn.getAttribute("data-field");
          const step = Number(btn.getAttribute("data-step"));
          if (!field || !Number.isFinite(step)) return;
          target[field] = Number(target[field]) + step;
          if (field === "azimuth") target.azimuth = normalizeHeading(target.azimuth);
          if (field === "elevation") target.elevation = clamp(target.elevation, 0, 89);
        }

        renderScopeCards();
        renderAll();
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
    renderGlobalControls();
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
    state.telescopes.push(createScope(nextScopeId));
    state.followScopeId = state.followScopeId || nextScopeId;
    nextScopeId += 1;
    renderGlobalControls();
    renderScopeCards();
    renderAll();
  });
}

function init() {
  runtime.currentDomeAzimuthDeg = getDomeTargetAzimuthDeg();
  renderGlobalControls();
  wireButtons();
  renderScopeCards();
  renderAll();
}

init();
