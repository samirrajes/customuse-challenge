// src/avatar/rig.ts
import * as THREE from "three";
import type { FoundAnchor } from "./anchors";

export type RigFrame = {
  name: string;
  origin: THREE.Vector3;
  right: THREE.Vector3; // +X (avatar-right)
  up: THREE.Vector3; // +Y
  back: THREE.Vector3; // +Z (out of back)
  matrix: THREE.Matrix4; // local->world (basis + position)
};

export type AvatarRig = {
  ok: boolean;
  missing: string[];
  frames: {
    shoulderLine: RigFrame; // NEW: derived from shoulders (best for cape/wings)
    upperBack: RigFrame;
    midBack: RigFrame;
    lowerBack: RigFrame;
  };
  measures: {
    shoulderWidth: number;
    torsoDepth: number;
    torsoHeight: number;
  };
};

type AnchorMap = Map<string, FoundAnchor>;

function buildAnchorMap(anchors: FoundAnchor[], caseInsensitive = false): AnchorMap {
  const m = new Map<string, FoundAnchor>();
  for (const a of anchors) m.set(caseInsensitive ? a.name.toLowerCase() : a.name, a);
  return m;
}

function getAnchor(m: AnchorMap, name: string): FoundAnchor | null {
  return m.get(name) ?? m.get(name.toLowerCase()) ?? null;
}

function getWorldPos(a: FoundAnchor): THREE.Vector3 {
  const v = new THREE.Vector3();
  a.obj.getWorldPosition(v);
  return v;
}

function safeNormalize(v: THREE.Vector3, fallback: THREE.Vector3) {
  const len = v.length();
  if (len < 1e-8) return fallback.clone();
  return v.multiplyScalar(1 / len);
}

function makeFrame(
  name: string,
  origin: THREE.Vector3,
  right: THREE.Vector3,
  up: THREE.Vector3
): RigFrame {
  // Orthonormalize basis (robust even if inputs slightly off)
  const r0 = right.clone();
  const u0 = up.clone();

  const r = safeNormalize(r0, new THREE.Vector3(1, 0, 0));
  const uProj = u0.sub(r.clone().multiplyScalar(u0.dot(r)));
  const u = safeNormalize(uProj, new THREE.Vector3(0, 1, 0));
  let b = new THREE.Vector3().crossVectors(r, u);
  b = safeNormalize(b, new THREE.Vector3(0, 0, 1));

  // Recompute r to ensure perfect orthonormality
  const r2 = safeNormalize(new THREE.Vector3().crossVectors(u, b), r);

  const m = new THREE.Matrix4();
  m.makeBasis(r2, u, b);
  m.setPosition(origin);

  return { name, origin, right: r2, up: u, back: b, matrix: m };
}

/**
 * Build a minimal torso/back rig from Roblox *Sphere* attachment anchors.
 *
 * Key rules:
 * - Ignore "Rig" + "Group" anchors for placement.
 * - ShoulderAttachment spheres are good, but naming is viewer-relative:
 *   - LeftShoulderAttachment_Sphere is actually avatar RIGHT shoulder (when facing the avatar).
 *   - RightShoulderAttachment_Sphere is actually avatar LEFT shoulder.
 */
export function buildAvatarRig(foundAnchors: FoundAnchor[]): AvatarRig {
  const m = buildAnchorMap(foundAnchors, true);

  const A = {
    bodyBack: "ANCHOR_BodyBackAttachment_Sphere",
    bodyFront: "ANCHOR_BodyFrontAttachment_Sphere",

    // Shoulder attachment spheres (good), but swap meaning (viewer-relative names)
    leftShoulder_viewName: "ANCHOR_LeftShoulderAttachment_Sphere",
    rightShoulder_viewName: "ANCHOR_RightShoulderAttachment_Sphere",

    waistBack: "ANCHOR_WaistBackAttachment_Sphere",

    // Optional: only use for UP axis (height), not for origins
    neck: "ANCHOR_NeckAttachment_Sphere",
  };

  const aBodyBack = getAnchor(m, A.bodyBack);
  const aBodyFront = getAnchor(m, A.bodyFront);
  const aWaistBack = getAnchor(m, A.waistBack);

  const aShoulderL_view = getAnchor(m, A.leftShoulder_viewName);
  const aShoulderR_view = getAnchor(m, A.rightShoulder_viewName);

  const aNeck = getAnchor(m, A.neck); // optional

  const missing: string[] = [];
  if (!aBodyBack) missing.push(A.bodyBack);
  if (!aBodyFront) missing.push(A.bodyFront);
  if (!aWaistBack) missing.push(A.waistBack);
  if (!aShoulderL_view) missing.push(A.leftShoulder_viewName);
  if (!aShoulderR_view) missing.push(A.rightShoulder_viewName);

  if (missing.length) {
    const origin = new THREE.Vector3();
    const stub = makeFrame(
      "stub",
      origin,
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 1, 0)
    );
    return {
      ok: false,
      missing,
      frames: { shoulderLine: stub, upperBack: stub, midBack: stub, lowerBack: stub },
      measures: { shoulderWidth: 0, torsoDepth: 0, torsoHeight: 0 },
    };
  }

  // World positions
  const pBack = getWorldPos(aBodyBack!);
  const pFront = getWorldPos(aBodyFront!);
  const pWaistBack = getWorldPos(aWaistBack!);

  // Shoulder spheres — SWAP meanings to get avatar-left and avatar-right correctly.
  // Viewer-left shoulder sphere = avatar-right shoulder
  // Viewer-right shoulder sphere = avatar-left shoulder
  const pShoulderAvatarRight = getWorldPos(aShoulderL_view!);
  const pShoulderAvatarLeft = getWorldPos(aShoulderR_view!);

  const pNeck = aNeck ? getWorldPos(aNeck) : null;

  // Axes:
  // back = from front to back (out of back)
  const back = safeNormalize(pBack.clone().sub(pFront), new THREE.Vector3(0, 0, 1));

  // right = from avatar-left shoulder to avatar-right shoulder
  const right = safeNormalize(
    pShoulderAvatarRight.clone().sub(pShoulderAvatarLeft),
    new THREE.Vector3(1, 0, 0)
  );

  // up = prefer neck height direction; otherwise derive from cross to keep stable
  let up: THREE.Vector3;
  if (pNeck) {
    const neckDir = pNeck.clone().sub(pWaistBack);
    const neckNoBack = neckDir.sub(back.clone().multiplyScalar(neckDir.dot(back)));
    up = safeNormalize(neckNoBack, new THREE.Vector3(0, 1, 0));
  } else {
    up = safeNormalize(new THREE.Vector3().crossVectors(back, right), new THREE.Vector3(0, 1, 0));
  }

  // Re-orthonormalize
  const right2 = safeNormalize(new THREE.Vector3().crossVectors(up, back), right);
  const up2 = safeNormalize(new THREE.Vector3().crossVectors(back, right2), up);

  // Measures
  const shoulderWidth = pShoulderAvatarRight.distanceTo(pShoulderAvatarLeft);
  const torsoDepth = pBack.distanceTo(pFront);
  const torsoHeight = pNeck ? pNeck.distanceTo(pWaistBack) : 0;

  // Origins
  const shoulderMid = pShoulderAvatarLeft.clone().lerp(pShoulderAvatarRight, 0.5);

  // NEW shoulderLine: shoulder midpoint, nudged slightly backward so it's on the back surface
  const shoulderLineOrigin = shoulderMid
    .clone()
    .add(back.clone().multiplyScalar(Math.max(0.01, torsoDepth * 0.25)));

  // UpperBack: similar but a bit more "back-y" (useful when an asset is thick)
  const upperBackOrigin = shoulderMid
    .clone()
    .add(back.clone().multiplyScalar(Math.max(0.01, torsoDepth * 0.35)));

  const midBackOrigin = pBack.clone();
  const lowerBackOrigin = pWaistBack.clone();

  const shoulderLine = makeFrame("ShoulderLine", shoulderLineOrigin, right2, up2);
  const upperBack = makeFrame("UpperBack", upperBackOrigin, right2, up2);
  const midBack = makeFrame("MidBack", midBackOrigin, right2, up2);
  const lowerBack = makeFrame("LowerBack", lowerBackOrigin, right2, up2);

  return {
    ok: true,
    missing: [],
    frames: { shoulderLine, upperBack, midBack, lowerBack },
    measures: { shoulderWidth, torsoDepth, torsoHeight },
  };
}
