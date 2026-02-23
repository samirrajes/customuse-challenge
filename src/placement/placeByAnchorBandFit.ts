import * as THREE from "three";
import type { FoundAnchor } from "../avatar/anchors";
import { collectVerticesRootLocal, findMountFace, type AccessoryGeom } from "./accessoryGeom";
import { getRenderableBounds } from "../engine/assets";

export type Family =
  | "StrapHarness"
  | "Drape"
  | "PairedMount"
  | "SurfaceMount"
  | "RigidStow"
  | "HingeTail"
  | "Unknown";

export type AttrScores = Partial<
  Record<"HasStraps" | "LooksCloth" | "TwoSymmetric" | "FlatPlate" | "LongRigid" | "HangsDown" | "BulkyPack", number>
>;

export type DrapeSubtype = "Cape" | "Cloak";

type FrameLike = {
  name?: string;
  origin: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
  back: THREE.Vector3;
};

type AnchorKey = "bodyBack" | "bodyFront" | "leftShoulder" | "rightShoulder" | "waistBack" | "neck";

type AnchorWorld = Partial<Record<AnchorKey, THREE.Vector3>>;

type AnchorFrames = {
  ok: boolean;
  missing: string[];
  measures: {
    shoulderWidth: number;
    torsoDepth: number;
    torsoHeight: number;
  };
  points: {
    bodyFront: THREE.Vector3;
    bodyBack: THREE.Vector3;
    shoulderMid: THREE.Vector3;
    neck: THREE.Vector3 | null;
  };
  frames: {
    shoulderLine: FrameLike;
    midBack: FrameLike;
    lowerBack: FrameLike;
  };
};

type ROI = {
  xRadius: number;
  yMin: number;
  yMax: number;
};

type AttachPointResult = {
  pointLocal: THREE.Vector3;
  isCapeTopLock: boolean;
};

type CandidateEval = {
  yawDeg: number;
  qWorld: THREE.Quaternion;
  posWorld: THREE.Vector3;
  backOffset: number;
  score: number;
  minDepth: number;
  centerDepth: number;
  depthQuantile: number;
  fracFront: number;
  fracBehind: number;
  mountAlign: number;
  capeTopDeltaY: number;
};

export type PlaceByAnchorBandFitOpts = {
  midYAlpha?: number;
  pairedMidYAlpha?: number;
  rigidMidYAlpha?: number;
  maxAccessoryPoints?: number;
  evalPoints?: number;
  quantile?: number;
  attrThresh?: number;
  capeTopLockEps?: number;
  backpackOverride?: boolean;
};

export type PlaceByAnchorBandFitResult = {
  family: Family;
  drapeSubtype: DrapeSubtype;
  frame: FrameLike;
  yawDeg: number;
  backOffset: number;
  targetOrigin: THREE.Vector3;
  attachPointLocal: THREE.Vector3;
  debug: {
    score: number;
    yawStageScore: number;
    minDepth: number;
    centerDepth: number;
    depthQuantile: number;
    fracFront: number;
    fracBehind: number;
    targetDepth: number;
    effectiveFamily: Family;
    mountAlign: number;
    wingLike: boolean;
    backpackLike: boolean;
    capeTopDeltaY: number;
    finalPlacementShift: { dx: number; dy: number; dz: number };
    cloakScaleMode: "hangBlend" | "legacy";
    cloakClaspBand: string;
    cloakTopCenterDensity: number;
    cloakZShift: number;
    neckHoleFitUsed: boolean;
    neckHoleSamples: number;
    strapHarnessMode: "TorsoWear" | "BackCarry";
  };
};

function safeNormalize(v: THREE.Vector3, fallback: THREE.Vector3) {
  const len = v.length();
  if (len < 1e-8) return fallback.clone();
  return v.multiplyScalar(1 / len);
}

function clamp01(v: number) {
  return THREE.MathUtils.clamp(v, 0, 1);
}

function buildAnchorMap(anchors: FoundAnchor[]) {
  const m = new Map<string, FoundAnchor>();
  for (const a of anchors) m.set(a.name.toLowerCase(), a);
  return m;
}

function getAnchorWorld(anchors: FoundAnchor[]): AnchorWorld {
  const m = buildAnchorMap(anchors);
  const names: Record<AnchorKey, string> = {
    bodyBack: "anchor_bodybackattachment_sphere",
    bodyFront: "anchor_bodyfrontattachment_sphere",
    leftShoulder: "anchor_leftshoulderattachment_sphere",
    rightShoulder: "anchor_rightshoulderattachment_sphere",
    waistBack: "anchor_waistbackattachment_sphere",
    neck: "anchor_neckattachment_sphere",
  };

  const out: AnchorWorld = {};
  for (const k of Object.keys(names) as AnchorKey[]) {
    const found = m.get(names[k]);
    if (!found) continue;
    const v = new THREE.Vector3();
    found.obj.getWorldPosition(v);
    out[k] = v;
  }
  return out;
}

function makeFrame(name: string, origin: THREE.Vector3, rightIn: THREE.Vector3, upIn: THREE.Vector3, backIn: THREE.Vector3): FrameLike {
  const back = safeNormalize(backIn.clone(), new THREE.Vector3(0, 0, 1));
  let up = upIn.clone().sub(back.clone().multiplyScalar(upIn.dot(back)));
  up = safeNormalize(up, new THREE.Vector3(0, 1, 0));
  let right = new THREE.Vector3().crossVectors(up, back);
  right = safeNormalize(right, rightIn);
  up = safeNormalize(new THREE.Vector3().crossVectors(back, right), up);
  return { name, origin, right, up, back };
}

function buildFramesFromAnchors(anchors: FoundAnchor[]): AnchorFrames {
  const A = getAnchorWorld(anchors);

  const missing: string[] = [];
  if (!A.bodyBack) missing.push("ANCHOR_BodyBackAttachment_Sphere");
  if (!A.bodyFront) missing.push("ANCHOR_BodyFrontAttachment_Sphere");
  if (!A.leftShoulder) missing.push("ANCHOR_LeftShoulderAttachment_Sphere");
  if (!A.rightShoulder) missing.push("ANCHOR_RightShoulderAttachment_Sphere");
  if (!A.waistBack) missing.push("ANCHOR_WaistBackAttachment_Sphere");

  const stub: FrameLike = {
    name: "stub",
    origin: new THREE.Vector3(),
    right: new THREE.Vector3(1, 0, 0),
    up: new THREE.Vector3(0, 1, 0),
    back: new THREE.Vector3(0, 0, 1),
  };

  if (missing.length) {
    return {
      ok: false,
      missing,
      measures: { shoulderWidth: 0, torsoDepth: 0, torsoHeight: 0 },
      points: {
        bodyFront: new THREE.Vector3(),
        bodyBack: new THREE.Vector3(),
        shoulderMid: new THREE.Vector3(),
        neck: null,
      },
      frames: { shoulderLine: stub, midBack: stub, lowerBack: stub },
    };
  }

  const pBack = A.bodyBack!;
  const pFront = A.bodyFront!;
  const pShoulderL = A.leftShoulder!;
  const pShoulderR = A.rightShoulder!;
  const pWaistBack = A.waistBack!;
  const pNeck = A.neck ?? null;

  const back = safeNormalize(pBack.clone().sub(pFront), new THREE.Vector3(0, 0, 1));

  const shoulderVec = pShoulderR.clone().sub(pShoulderL);
  let rightRaw = shoulderVec.clone().sub(back.clone().multiplyScalar(shoulderVec.dot(back)));
  rightRaw = safeNormalize(rightRaw, new THREE.Vector3(1, 0, 0));

  let upRaw: THREE.Vector3;
  if (pNeck) {
    const neckVec = pNeck.clone().sub(pWaistBack);
    upRaw = neckVec.sub(back.clone().multiplyScalar(neckVec.dot(back)));
    upRaw = safeNormalize(upRaw, new THREE.Vector3(0, 1, 0));
  } else {
    const worldUp = new THREE.Vector3(0, 1, 0);
    upRaw = worldUp.sub(back.clone().multiplyScalar(worldUp.dot(back)));
    upRaw = safeNormalize(upRaw, new THREE.Vector3(0, 1, 0));
  }

  const shoulderMid = pShoulderL.clone().lerp(pShoulderR, 0.5);
  const torsoDepth = pBack.distanceTo(pFront);
  const shoulderWidth = pShoulderL.distanceTo(pShoulderR);
  const torsoHeight = Math.max(0.1, shoulderMid.distanceTo(pWaistBack));

  const shoulderLineOrigin = shoulderMid.clone().add(back.clone().multiplyScalar(Math.max(0.008, torsoDepth * 0.2)));

  return {
    ok: true,
    missing: [],
    measures: { shoulderWidth, torsoDepth, torsoHeight },
    points: {
      bodyFront: pFront.clone(),
      bodyBack: pBack.clone(),
      shoulderMid: shoulderMid.clone(),
      neck: pNeck ? pNeck.clone() : null,
    },
    frames: {
      shoulderLine: makeFrame("ShoulderLine", shoulderLineOrigin, rightRaw, upRaw, back),
      midBack: makeFrame("MidBack", pBack.clone(), rightRaw, upRaw, back),
      lowerBack: makeFrame("LowerBack", pWaistBack.clone(), rightRaw, upRaw, back),
    },
  };
}

function resolveUnknown(attrs: AttrScores, t: number): Family {
  const a = (k: keyof AttrScores) => attrs[k] ?? 0;
  if (a("TwoSymmetric") >= t) return "PairedMount";
  if (a("HasStraps") >= t || a("BulkyPack") >= t) return "StrapHarness";
  if (a("LooksCloth") >= t || a("HangsDown") >= t) return "Drape";
  if (a("FlatPlate") >= t) return "SurfaceMount";
  if (a("LongRigid") >= t) return "RigidStow";
  return "SurfaceMount";
}

function isWingLike(geom: AccessoryGeom) {
  return geom.aabbSize.x >= 1.35 * geom.aabbSize.y && geom.aabbSize.z <= 0.22 * geom.aabbSize.x;
}

function isBackpackLike(attrs: AttrScores) {
  return (attrs.BulkyPack ?? 0) >= 0.1 || (attrs.HasStraps ?? 0) >= 0.1;
}

function isTorsoWearStrapHarness(attrs: AttrScores, geom: AccessoryGeom) {
  const hasStraps = attrs.HasStraps ?? 0;
  const flatPlate = attrs.FlatPlate ?? 0;
  const bulkyPack = attrs.BulkyPack ?? 0;
  const longRigid = attrs.LongRigid ?? 0;
  const hangsDown = attrs.HangsDown ?? 0;
  const depthRatio = geom.aabbSize.z / Math.max(1e-6, geom.aabbSize.x);
  const vestLikeAttrs = hasStraps >= 0.1 && flatPlate >= 0.06 && longRigid <= 0.2 && hangsDown <= 0.22;
  const thinPlateGeom = depthRatio <= 0.34;

  const backpackGeom = depthRatio >= 0.36 && flatPlate < 0.1;
  const strongBackpack =
    bulkyPack >= 0.24 || (bulkyPack >= 0.16 && backpackGeom && hasStraps >= 0.1 && flatPlate < 0.12);
  if (strongBackpack) return false;

  if (vestLikeAttrs && thinPlateGeom) return true;
  if (flatPlate >= 0.09 && depthRatio <= 0.36) return true;
  if (hasStraps >= 0.12 && depthRatio <= 0.3 && bulkyPack < 0.22) return true;
  return depthRatio <= 0.24;
}

function targetFrameFromFamily(
  frames: AnchorFrames["frames"],
  family: Family,
  midYAlpha: number,
  pairedMidYAlpha: number,
  rigidMidYAlpha: number
): FrameLike {
  if (family === "Drape") return frames.shoulderLine;
  if (family === "HingeTail") return frames.lowerBack;
  if (family === "PairedMount") {
    const p = frames.midBack.origin.clone();
    p.y = THREE.MathUtils.lerp(frames.midBack.origin.y, frames.shoulderLine.origin.y, pairedMidYAlpha);
    return { ...frames.midBack, name: "PairedMountTarget", origin: p };
  }
  if (family === "StrapHarness") {
    const p = frames.midBack.origin.clone();
    p.y = THREE.MathUtils.lerp(frames.midBack.origin.y, frames.shoulderLine.origin.y, midYAlpha);
    return { ...frames.midBack, name: "StrapHarnessTarget", origin: p };
  }
  if (family === "RigidStow") {
    const p = frames.midBack.origin.clone();
    p.y = THREE.MathUtils.lerp(frames.midBack.origin.y, frames.shoulderLine.origin.y, rigidMidYAlpha);
    return { ...frames.midBack, name: "RigidStowTarget", origin: p };
  }
  return { ...frames.midBack, name: `${family}Target` };
}

function classifyDrapeSubtype(attrs: AttrScores, geom: AccessoryGeom): DrapeSubtype {
  const looksCloth = attrs.LooksCloth ?? 0;
  const hangsDown = attrs.HangsDown ?? 0;
  const bulkyPack = attrs.BulkyPack ?? 0;

  const depthRatio = geom.aabbSize.z / Math.max(1e-6, geom.aabbSize.y);
  const widthRatio = geom.aabbSize.x / Math.max(1e-6, geom.aabbSize.y);

  let cloak = looksCloth > 0.45 && hangsDown < 0.75;

  if (depthRatio > 0.52 && (widthRatio > 0.48 || bulkyPack > 0.04)) cloak = true;
  if (hangsDown > 0.7 && depthRatio < 0.42 && bulkyPack < 0.1) cloak = false;

  return cloak ? "Cloak" : "Cape";
}

function downsamplePoints(pts: THREE.Vector3[], want: number) {
  if (pts.length <= want) return pts;
  const stride = Math.ceil(pts.length / want);
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < pts.length; i += stride) out.push(pts[i]!);
  return out;
}

function computeBandCentroid(points: THREE.Vector3[], geom: AccessoryGeom, yLoFrac: number, yHiFrac: number, xStripFrac?: number) {
  const h = Math.max(1e-6, geom.aabb.max.y - geom.aabb.min.y);
  const yLo = geom.aabb.min.y + h * yLoFrac;
  const yHi = geom.aabb.min.y + h * yHiFrac;

  const centerX = geom.center.x;
  const strip = xStripFrac ? Math.max(1e-6, geom.aabbSize.x * xStripFrac) : Infinity;

  const c = new THREE.Vector3();
  let n = 0;

  for (const p of points) {
    if (p.y < yLo || p.y > yHi) continue;
    if (Math.abs(p.x - centerX) > strip) continue;
    c.add(p);
    n++;
  }

  if (!n) return { centroid: geom.center.clone(), count: 0 };
  return { centroid: c.multiplyScalar(1 / n), count: n };
}

function computeAttachPointLocal(
  points: THREE.Vector3[],
  geom: AccessoryGeom,
  family: Family,
  drapeSubtype: DrapeSubtype,
  mountFacePoint?: THREE.Vector3
): AttachPointResult {
  if ((family === "RigidStow" || family === "SurfaceMount") && mountFacePoint) {
    return { pointLocal: mountFacePoint.clone(), isCapeTopLock: false };
  }

  if (family === "Drape" && drapeSubtype === "Cape") {
    const top = computeBandCentroid(points, geom, 0.94, 1.0, 0.25);
    const p = top.centroid.clone();
    p.y = geom.aabb.max.y;
    return { pointLocal: p, isCapeTopLock: true };
  }

  if (family === "Drape" && drapeSubtype === "Cloak") {
    const c = computeBandCentroid(points, geom, 0.56, 0.78);
    return { pointLocal: c.centroid, isCapeTopLock: false };
  }

  if (family === "PairedMount") {
    const c = computeBandCentroid(points, geom, 0.45, 0.72, 0.2);
    return { pointLocal: c.centroid, isCapeTopLock: false };
  }

  if (family === "RigidStow" || family === "StrapHarness") {
    const c = computeBandCentroid(points, geom, 0.65, 0.88);
    return { pointLocal: c.centroid, isCapeTopLock: false };
  }

  if (family === "SurfaceMount") {
    const c = computeBandCentroid(points, geom, 0.38, 0.68);
    return { pointLocal: c.centroid, isCapeTopLock: false };
  }

  if (family === "HingeTail") {
    const c = computeBandCentroid(points, geom, 0.08, 0.35);
    return { pointLocal: c.centroid, isCapeTopLock: false };
  }

  const c = computeBandCentroid(points, geom, 0.5, 0.8);
  return { pointLocal: c.centroid, isCapeTopLock: false };
}

function worldFromPosePoint(
  pLocal: THREE.Vector3,
  posWorld: THREE.Vector3,
  qWorld: THREE.Quaternion,
  scale: THREE.Vector3,
  out: THREE.Vector3
) {
  out.copy(pLocal).multiply(scale).applyQuaternion(qWorld).add(posWorld);
  return out;
}

function rigCoords(world: THREE.Vector3, frame: FrameLike, out = new THREE.Vector3()) {
  out.copy(world).sub(frame.origin);
  const x = out.dot(frame.right);
  const y = out.dot(frame.up);
  const z = out.dot(frame.back);
  return { x, y, z };
}

function worldFromRig(frame: FrameLike, x: number, y: number, z: number) {
  return frame.origin
    .clone()
    .addScaledVector(frame.right, x)
    .addScaledVector(frame.up, y)
    .addScaledVector(frame.back, z);
}

function computeStrapHarnessTorsoTarget(points: AnchorFrames["points"], frame: FrameLike) {
  const front = rigCoords(points.bodyFront, frame);
  const back = rigCoords(points.bodyBack, frame);
  const shoulder = rigCoords(points.shoulderMid, frame);

  const torsoMidY = 0.5 * (front.y + back.y);
  const desiredX = shoulder.x;
  const desiredY = THREE.MathUtils.lerp(torsoMidY, shoulder.y, 0.34);
  const desiredZ = THREE.MathUtils.lerp(front.z, back.z, 0.22);
  return worldFromRig(frame, desiredX, desiredY, desiredZ);
}

function percentile(values: number[], q: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const t = THREE.MathUtils.clamp(q, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(t);
  const hi = Math.ceil(t);
  const a = sorted[lo]!;
  const b = sorted[hi]!;
  return a + (b - a) * (t - lo);
}

function computeWorldStats(pointsLocal: THREE.Vector3[], posWorld: THREE.Vector3, qWorld: THREE.Quaternion, scale: THREE.Vector3) {
  const tmpW = new THREE.Vector3();
  let yMin = Infinity;
  let yMax = -Infinity;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (const p of pointsLocal) {
    worldFromPosePoint(p, posWorld, qWorld, scale, tmpW);
    if (tmpW.y < yMin) yMin = tmpW.y;
    if (tmpW.y > yMax) yMax = tmpW.y;
    if (tmpW.x < minX) minX = tmpW.x;
    if (tmpW.x > maxX) maxX = tmpW.x;
    if (tmpW.z < minZ) minZ = tmpW.z;
    if (tmpW.z > maxZ) maxZ = tmpW.z;
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minZ) || !Number.isFinite(yMax)) {
    return { yMin: 0, centerX: posWorld.x, centerY: posWorld.y, centerZ: posWorld.z };
  }
  return { yMin, centerX: 0.5 * (minX + maxX), centerY: 0.5 * (yMin + yMax), centerZ: 0.5 * (minZ + maxZ) };
}

function computeTopBandCentroidWorld(
  pointsLocal: THREE.Vector3[],
  geom: AccessoryGeom,
  posWorld: THREE.Vector3,
  qWorld: THREE.Quaternion,
  scale: THREE.Vector3,
  yLoFrac = 0.78,
  yHiFrac = 1.0,
  xStripFrac = 0.28
) {
  const band = computeBandCentroid(pointsLocal, geom, yLoFrac, yHiFrac, xStripFrac);
  const centroidWorld = worldFromPosePoint(band.centroid, posWorld, qWorld, scale, new THREE.Vector3());
  return { centroidWorld, count: band.count };
}

function computeDepthQuantileForPose(
  pointsLocal: THREE.Vector3[],
  posWorld: THREE.Vector3,
  qWorld: THREE.Quaternion,
  scale: THREE.Vector3,
  frame: FrameLike,
  measures: AnchorFrames["measures"],
  family: Family,
  roi: ROI,
  quantile: number
) {
  const dzVals: number[] = [];
  const tmpW = new THREE.Vector3();

  for (const p of pointsLocal) {
    worldFromPosePoint(p, posWorld, qWorld, scale, tmpW);
    const { x, y, z } = rigCoords(tmpW, frame);

    if (Math.abs(x) > roi.xRadius) continue;
    if (y < roi.yMin || y > roi.yMax) continue;

    const zSurface = torsoBackSurfaceDepth(x, y, measures, family);
    dzVals.push(z - zSurface);
  }

  if (!dzVals.length) return 0;
  return percentile(dzVals, quantile);
}

function familyROI(measures: AnchorFrames["measures"], family: Family): ROI {
  const shoulderW = Math.max(0.08, measures.shoulderWidth);
  const torsoH = Math.max(0.2, measures.torsoHeight);

  if (family === "Drape") return { xRadius: shoulderW * 0.5, yMin: -torsoH * 0.95, yMax: torsoH * 0.25 };
  if (family === "HingeTail") return { xRadius: shoulderW * 0.24, yMin: -torsoH * 0.35, yMax: torsoH * 0.2 };
  if (family === "PairedMount") return { xRadius: shoulderW * 0.5, yMin: -torsoH * 0.55, yMax: torsoH * 0.45 };
  if (family === "RigidStow") return { xRadius: shoulderW * 0.34, yMin: -torsoH * 0.95, yMax: torsoH * 0.35 };
  return { xRadius: shoulderW * 0.32, yMin: -torsoH * 0.65, yMax: torsoH * 0.35 };
}

function torsoBackSurfaceDepth(x: number, y: number, measures: AnchorFrames["measures"], family: Family): number {
  const halfShoulder = Math.max(0.08, measures.shoulderWidth * 0.5);
  const torsoH = Math.max(0.2, measures.torsoHeight);
  const depth = Math.max(0.05, measures.torsoDepth);

  const widthScale = family === "PairedMount" ? 1.2 : family === "Drape" ? 1.3 : 1.0;
  const heightScale = family === "Drape" ? 1.35 : 1.05;

  const nx = x / (halfShoulder * widthScale);
  const ny = y / (torsoH * 0.5 * heightScale);

  const drop = depth * (0.24 * nx * nx + 0.11 * ny * ny);
  return -THREE.MathUtils.clamp(drop, 0, depth * 0.92);
}

function solveBackOffset(
  pointsLocal: THREE.Vector3[],
  posNoBack: THREE.Vector3,
  qWorld: THREE.Quaternion,
  scale: THREE.Vector3,
  frame: FrameLike,
  measures: AnchorFrames["measures"],
  family: Family,
  roi: ROI,
  targetDepth: number,
  quantile: number,
  backMin: number,
  backMax: number
) {
  const dzVals: number[] = [];
  const tmpW = new THREE.Vector3();

  for (const p of pointsLocal) {
    worldFromPosePoint(p, posNoBack, qWorld, scale, tmpW);
    const { x, y, z } = rigCoords(tmpW, frame);

    if (Math.abs(x) > roi.xRadius) continue;
    if (y < roi.yMin || y > roi.yMax) continue;

    const zSurface = torsoBackSurfaceDepth(x, y, measures, family);
    dzVals.push(z - zSurface);
  }

  if (!dzVals.length) return { backOffset: 0, depthQuantile: 0, supportCount: 0 };

  const depthQuantile = percentile(dzVals, quantile);
  const raw = targetDepth - depthQuantile;
  const backOffset = THREE.MathUtils.clamp(raw, backMin, backMax);
  return { backOffset, depthQuantile, supportCount: dzVals.length };
}

function evaluateCandidate(
  pointsLocal: THREE.Vector3[],
  posWorld: THREE.Vector3,
  qWorld: THREE.Quaternion,
  scale: THREE.Vector3,
  frame: FrameLike,
  measures: AnchorFrames["measures"],
  family: Family,
  drapeSubtype: DrapeSubtype,
  roi: ROI,
  targetDepth: number,
  penetrationEps: number,
  contactBand: number,
  backOffset: number,
  mountNormalLocal: THREE.Vector3 | null
): Omit<CandidateEval, "yawDeg" | "qWorld" | "posWorld" | "backOffset" | "depthQuantile" | "capeTopDeltaY"> {
  const dzVals: number[] = [];
  const tmpW = new THREE.Vector3();

  let minDz = Infinity;
  let pen = 0;
  let gap = 0;
  let total = 0;
  let inRoi = 0;
  let behind = 0;
  let front = 0;
  let sumZ = 0;
  let sumX = 0;

  const allowedInset = family === "Drape" && drapeSubtype === "Cloak" ? Math.max(0.015, measures.torsoDepth * 0.3) : 0;

  for (const p of pointsLocal) {
    worldFromPosePoint(p, posWorld, qWorld, scale, tmpW);
    const { x, y, z } = rigCoords(tmpW, frame);

    total++;
    sumZ += z;
    sumX += x;
    if (z >= 0) behind++;
    else front++;

    if (Math.abs(x) > roi.xRadius) continue;
    if (y < roi.yMin || y > roi.yMax) continue;

    inRoi++;
    const zSurface = torsoBackSurfaceDepth(x, y, measures, family);
    const dz = z - zSurface;
    dzVals.push(dz);
    if (dz < minDz) minDz = dz;

    const penLimit = -(allowedInset + penetrationEps);
    if (dz < penLimit) {
      const inside = penLimit - dz;
      pen += inside * inside;
    }
  }

  if (!inRoi || !Number.isFinite(minDz)) {
    return {
      score: 1e12,
      minDepth: -1,
      centerDepth: 0,
      fracFront: 0,
      fracBehind: 0,
      mountAlign: 0,
    };
  }

  const contactThreshold = minDz + contactBand;
  let contactCount = 0;
  for (const dz of dzVals) {
    if (dz > contactThreshold) continue;
    contactCount++;
    const over = dz - targetDepth;
    if (over > 0) gap += over * over;
  }

  const penAvg = pen / inRoi;
  const gapAvg = gap / Math.max(1, contactCount);
  const fracBehind = behind / Math.max(1, total);
  const fracFront = front / Math.max(1, total);
  const centerDepth = sumZ / Math.max(1, total);
  const centerX = sumX / Math.max(1, total);

  const centerPenalty = centerX * centerX;

  let sidePenalty = 0;
  if (family === "Drape" && drapeSubtype === "Cloak") {
    const under = Math.max(0, 0.12 - fracFront);
    const over = Math.max(0, fracFront - 0.62);
    sidePenalty = under * under + over * over;
  } else {
    if (family === "StrapHarness") {
      const wantBehind = 0.5;
      sidePenalty = (fracBehind - wantBehind) * (fracBehind - wantBehind);
    } else {
      const wantBehind = family === "HingeTail" ? 0.7 : 0.82;
      const under = Math.max(0, wantBehind - fracBehind);
      sidePenalty = under * under;
    }
  }

  let mountAlign = 0.5;
  let mountPenalty = 0;
  if (mountNormalLocal) {
    const mountNormalWorld = mountNormalLocal.clone().applyQuaternion(qWorld).normalize();
    mountAlign = clamp01((mountNormalWorld.dot(frame.back.clone().multiplyScalar(-1)) + 1) * 0.5);
    const wMount = family === "SurfaceMount" ? 45 : family === "RigidStow" ? 35 : 0;
    mountPenalty = wMount * (1 - mountAlign) * (1 - mountAlign);
  }

  const score = 3200 * penAvg + 280 * gapAvg + 60 * centerPenalty + 110 * sidePenalty + 0.25 * Math.abs(backOffset) + mountPenalty;

  return { score, minDepth: minDz, centerDepth, fracFront, fracBehind, mountAlign };
}

function worldPosToParentLocal(posWorld: THREE.Vector3, parent: THREE.Object3D | null): THREE.Vector3 {
  if (!parent) return posWorld.clone();
  return parent.worldToLocal(posWorld.clone());
}

function worldQuatToParentLocal(qWorld: THREE.Quaternion, parent: THREE.Object3D | null): THREE.Quaternion {
  if (!parent) return qWorld.clone();

  parent.updateWorldMatrix(true, false);
  const parentRot = new THREE.Matrix4().extractRotation(parent.matrixWorld);
  const qParent = new THREE.Quaternion().setFromRotationMatrix(parentRot);
  return qParent.clone().invert().multiply(qWorld.clone());
}

function applyWorldPose(obj: THREE.Object3D, posWorld: THREE.Vector3, qWorld: THREE.Quaternion) {
  const parent = obj.parent ?? null;
  if (parent) parent.updateWorldMatrix(true, false);

  obj.position.copy(worldPosToParentLocal(posWorld, parent));
  obj.quaternion.copy(worldQuatToParentLocal(qWorld, parent));
  obj.updateWorldMatrix(true, true);
}

export function placeAccessoryByAnchorBandFit(
  accessory: THREE.Object3D,
  avatarRoot: THREE.Object3D,
  anchors: FoundAnchor[],
  familyIn: Family,
  geom: AccessoryGeom,
  attrs: AttrScores,
  opts?: PlaceByAnchorBandFitOpts
): PlaceByAnchorBandFitResult {
  avatarRoot.updateWorldMatrix(true, false);
  const anchorFrames = buildFramesFromAnchors(anchors);
  if (!anchorFrames.ok) throw new Error(`Missing anchors: ${anchorFrames.missing.join(", ")}`);

  const wingLike = isWingLike(geom);
  const backpackLike = isBackpackLike(attrs);

  let family = familyIn === "Unknown" ? resolveUnknown(attrs, opts?.attrThresh ?? 0.35) : familyIn;
  const allowBackpackOverride = opts?.backpackOverride ?? true;
  if (allowBackpackOverride && family === "PairedMount" && backpackLike && !wingLike) family = "StrapHarness";
  const strapHarnessTorsoWear = family === "StrapHarness" && isTorsoWearStrapHarness(attrs, geom);

  const drapeSubtype = family === "Drape" ? classifyDrapeSubtype(attrs, geom) : "Cape";

  const frame = targetFrameFromFamily(
    anchorFrames.frames,
    family,
    opts?.midYAlpha ?? 0.5,
    opts?.pairedMidYAlpha ?? 0.5,
    opts?.rigidMidYAlpha ?? 0.22
  );
  const targetOrigin = frame.origin.clone();

  const maxAccessoryPoints = opts?.maxAccessoryPoints ?? 28_000;
  const evalPoints = opts?.evalPoints ?? 1_200;
  const quantile = opts?.quantile ?? 0.08;

  const localAll = collectVerticesRootLocal(accessory, maxAccessoryPoints);
  if (!localAll.length) throw new Error("Accessory has no mesh vertices");
  const pointsLocal = downsamplePoints(localAll, evalPoints);

  const mountFace =
    family === "RigidStow" || family === "SurfaceMount" ? findMountFace(accessory, geom, { wantsFlush: 1, wantsDiagonal: 0 }) : null;
  const mountNormalLocal = mountFace?.mountNormalLocal ?? null;
  const attach = computeAttachPointLocal(pointsLocal, geom, family, drapeSubtype, mountFace?.mountPointLocal);
  const attachPointLocal = attach.pointLocal;

  const baseQuatWorld = accessory.getWorldQuaternion(new THREE.Quaternion()).normalize();
  const scaleLocal = accessory.scale.clone();
  const avatarCenter = getRenderableBounds(avatarRoot).center;

  const roi = familyROI(anchorFrames.measures, family);

  const torsoDepth = Math.max(0.05, anchorFrames.measures.torsoDepth);
  const targetDepth =
    family === "Drape"
      ? drapeSubtype === "Cloak"
        ? -Math.max(0.03, torsoDepth * 0.35)
        : 0.004
      : family === "RigidStow"
        ? 0.008
        : 0.002;

  let backMin = -0.005;
  let backMax = 0.1;
  if (family === "Drape" && drapeSubtype === "Cape") {
    backMin = -0.005;
    backMax = 0.08;
  } else if (family === "Drape" && drapeSubtype === "Cloak") {
    backMin = -0.04;
    backMax = 0.05;
  } else if (family === "RigidStow") {
    backMin = -0.005;
    backMax = 0.16;
  }

  const penetrationEps = family === "Drape" && drapeSubtype === "Cloak" ? 0.003 : 0.0015;
  const contactBand = family === "Drape" ? 0.03 : 0.02;

  const yAxisWorld = new THREE.Vector3(0, 1, 0);

  let bestYaw: CandidateEval | null = null;

  // Pass A: pick yaw and back offset from raw pose only.
  for (const yawDeg of [0, 90, 180, 270] as const) {
    const qYaw = new THREE.Quaternion().setFromAxisAngle(yAxisWorld, THREE.MathUtils.degToRad(yawDeg));
    const qWorld = qYaw.clone().multiply(baseQuatWorld).normalize();

    const attachOffsetW = attachPointLocal.clone().multiply(scaleLocal).applyQuaternion(qWorld);
    const posNoBack = targetOrigin.clone().sub(attachOffsetW);

    const solved = solveBackOffset(
      pointsLocal,
      posNoBack,
      qWorld,
      scaleLocal,
      frame,
      anchorFrames.measures,
      family,
      roi,
      targetDepth,
      quantile,
      backMin,
      backMax
    );

    const posWorld = posNoBack.clone().addScaledVector(frame.back, solved.backOffset);

    const scored = evaluateCandidate(
      pointsLocal,
      posWorld,
      qWorld,
      scaleLocal,
      frame,
      anchorFrames.measures,
      family,
      drapeSubtype,
      roi,
      targetDepth,
      penetrationEps,
      contactBand,
      solved.backOffset,
      mountNormalLocal
    );

    const cur: CandidateEval = {
      yawDeg,
      qWorld,
      posWorld,
      backOffset: solved.backOffset,
      score: scored.score,
      minDepth: scored.minDepth,
      centerDepth: scored.centerDepth,
      depthQuantile: solved.depthQuantile,
      fracFront: scored.fracFront,
      fracBehind: scored.fracBehind,
      mountAlign: scored.mountAlign,
      capeTopDeltaY: 0,
    };

    if (!bestYaw) {
      bestYaw = cur;
      continue;
    }

    const tieBand = bestYaw.score * 0.02;
    const isTie = Math.abs(cur.score - bestYaw.score) <= tieBand;

    if (cur.score < bestYaw.score && !isTie) {
      bestYaw = cur;
      continue;
    }

    if (isTie) {
      if (cur.mountAlign > bestYaw.mountAlign + 1e-4) {
        bestYaw = cur;
        continue;
      }
      if (Math.abs(cur.mountAlign - bestYaw.mountAlign) <= 1e-4 && cur.score < bestYaw.score) {
        bestYaw = cur;
      }
    }
  }

  if (!bestYaw) throw new Error("No placement candidate");

  // Pass B: apply placement shifts on top of selected yaw without re-running yaw search.
  const finalPosWorld = bestYaw.posWorld.clone();
  let capeTopDeltaY = 0;
  let cloakScaleMode: "hangBlend" | "legacy" = "legacy";
  let cloakClaspBand = "n/a";
  let cloakZShift = 0;
  let neckHoleFitUsed = false;
  let neckHoleSamples = 0;
  const strapHarnessMode: "TorsoWear" | "BackCarry" = strapHarnessTorsoWear ? "TorsoWear" : "BackCarry";
  if (family === "Drape") {
    const stats0 = computeWorldStats(pointsLocal, finalPosWorld, bestYaw.qWorld, scaleLocal);
    const groundDeltaY = -stats0.yMin;
    if (Math.abs(groundDeltaY) > 1e-6) {
      finalPosWorld.y += groundDeltaY;
      capeTopDeltaY = groundDeltaY;
    }

    if (drapeSubtype === "Cloak") {
      // Align top band of cloak near neck/back-of-head region.
      const topBand = computeTopBandCentroidWorld(pointsLocal, geom, finalPosWorld, bestYaw.qWorld, scaleLocal, 0.78, 1.0, 0.28);
      const neckBase = anchorFrames.points.neck?.clone() ?? anchorFrames.points.shoulderMid.clone();
      const neckLift = Math.max(0.01, anchorFrames.measures.torsoHeight * 0.04);
      const neckBack = Math.max(0.004, anchorFrames.measures.torsoDepth * 0.08);
      const targetTop = neckBase.clone().addScaledVector(frame.up, neckLift).addScaledVector(frame.back, neckBack);

      if (topBand.count > 0) {
        const delta = targetTop.sub(topBand.centroidWorld);
        const dx = THREE.MathUtils.clamp(delta.dot(frame.right), -0.2, 0.2);
        const dy = THREE.MathUtils.clamp(delta.dot(frame.up), -0.12, 0.12);
        const dz = THREE.MathUtils.clamp(delta.dot(frame.back), -0.16, 0.16);
        finalPosWorld
          .addScaledVector(frame.right, dx)
          .addScaledVector(frame.up, dy)
          .addScaledVector(frame.back, dz);

        cloakClaspBand = "top22->neck(+up,+back)";
        neckHoleFitUsed = !!anchorFrames.points.neck;
        neckHoleSamples = topBand.count;
        cloakScaleMode = "hangBlend";
      } else {
        // Fallback: center cloak around avatar X/Z if top-band sample fails.
        const stats1 = computeWorldStats(pointsLocal, finalPosWorld, bestYaw.qWorld, scaleLocal);
        finalPosWorld.x += avatarCenter.x - stats1.centerX;
        finalPosWorld.z += avatarCenter.z - stats1.centerZ;
        cloakClaspBand = "centerXZ-fallback";
      }

      cloakZShift = finalPosWorld.clone().sub(bestYaw.posWorld).dot(frame.back);
    }
  }

  if (family === "RigidStow") {
    const statsR = computeWorldStats(pointsLocal, finalPosWorld, bestYaw.qWorld, scaleLocal);
    const centerWorld = new THREE.Vector3(statsR.centerX, statsR.centerY, statsR.centerZ);
    const centered = rigCoords(centerWorld, frame);
    finalPosWorld.addScaledVector(frame.right, -centered.x);
    finalPosWorld.addScaledVector(frame.up, -centered.y);
  }

  if (family === "StrapHarness" && strapHarnessTorsoWear) {
    const statsS = computeWorldStats(pointsLocal, finalPosWorld, bestYaw.qWorld, scaleLocal);
    const currentCenter = new THREE.Vector3(statsS.centerX, statsS.centerY, statsS.centerZ);
    const desiredCenter = computeStrapHarnessTorsoTarget(anchorFrames.points, frame);
    finalPosWorld.add(desiredCenter.sub(currentCenter));
  }

  const finalShiftWorld = finalPosWorld.clone().sub(bestYaw.posWorld);
  const finalPlacementShift = {
    dx: finalShiftWorld.dot(frame.right),
    dy: finalShiftWorld.dot(frame.up),
    dz: finalShiftWorld.dot(frame.back),
  };

  const finalScored = evaluateCandidate(
    pointsLocal,
    finalPosWorld,
    bestYaw.qWorld,
    scaleLocal,
    frame,
    anchorFrames.measures,
    family,
    drapeSubtype,
    roi,
    targetDepth,
    penetrationEps,
    contactBand,
    bestYaw.backOffset,
    mountNormalLocal
  );
  const finalDepthQuantile = computeDepthQuantileForPose(
    pointsLocal,
    finalPosWorld,
    bestYaw.qWorld,
    scaleLocal,
    frame,
    anchorFrames.measures,
    family,
    roi,
    quantile
  );

  applyWorldPose(accessory, finalPosWorld, bestYaw.qWorld);

  return {
    family,
    drapeSubtype,
    frame,
    yawDeg: bestYaw.yawDeg,
    backOffset: bestYaw.backOffset,
    targetOrigin,
    attachPointLocal,
    debug: {
      score: finalScored.score,
      yawStageScore: bestYaw.score,
      minDepth: finalScored.minDepth,
      centerDepth: finalScored.centerDepth,
      depthQuantile: finalDepthQuantile,
      fracFront: finalScored.fracFront,
      fracBehind: finalScored.fracBehind,
      targetDepth,
      effectiveFamily: family,
      mountAlign: finalScored.mountAlign,
      wingLike,
      backpackLike,
      capeTopDeltaY,
      finalPlacementShift,
      cloakScaleMode,
      cloakClaspBand,
      cloakTopCenterDensity: geom.topCenterDensity,
      cloakZShift,
      neckHoleFitUsed,
      neckHoleSamples,
      strapHarnessMode,
    },
  };
}
