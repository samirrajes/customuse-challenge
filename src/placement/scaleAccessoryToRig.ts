// src/placement/scaleAccessoryToRig.ts
import * as THREE from "three";
import type { AvatarRig } from "../avatar/rig";
import type { AccessoryGeom } from "./accessoryGeom";

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

export type ScaleResult = {
  scale: THREE.Vector3; // ALWAYS uniform
  uniformScalar: number;
  reason: string;
};

/**
 * Uniform-only scaling aligned with your current pipeline:
 * - Avatar is normalized to height ~1 (normalizeToHeight(avatar, 1))
 * - Avatar is grounded to y=0 (avatar.position.y += -box.min.y)
 *
 * So:
 * - avatarHeight = 1
 * - groundY = 0
 */
export function computeScaleAccessoryToRig(
  rig: AvatarRig,
  geom: AccessoryGeom,
  family: Family,
  attrs?: AttrScores
): ScaleResult {
  // Pipeline assumptions
  const avatarH = 1.0;
  const groundY = 0.0;
  const drapeExtra = 0.05 * avatarH;

  // Accessory AABB sizes (local)
  const s = geom.aabbSize.clone();
  const accW = Math.max(1e-6, s.x);
  const accH = Math.max(1e-6, s.y);
  const accD = Math.max(1e-6, s.z);
  const accMax = Math.max(accW, accH, accD);

  // Rig measures / anchors
  const shoulderW = rig.measures.shoulderWidth || 0.6;

  // Prefer frame distance for torso height (more stable than "measures" when neck is missing etc.)
  const torsoH = Math.max(0.1, rig.frames.shoulderLine.origin.distanceTo(rig.frames.lowerBack.origin));

  // Drape target: ground -> shoulderLine + margin
  const shoulderLineY = rig.frames.shoulderLine.origin.y;
  const drapeTargetH = Math.max(0.1, shoulderLineY - groundY + drapeExtra);
  const isCloak =
    family === "Drape" &&
    classifyDrapeSubtype(attrs, geom) === "Cloak";

  // Choose ONE dimension to match per family
  let from = accMax;
  let to = avatarH;
  let reason = "Unknown: maxDim -> avatarHeight";

  switch (family) {
    case "RigidStow": {
      // agreed: 65% of avatar height
      from = accMax;
      to = 0.65 * avatarH;
      reason = "RigidStow: maxDim -> 0.65*avatarHeight";
      break;
    }

    case "Drape": {
      // cloak/cape both use shoulder->ground drape height
      from = accH;
      to = drapeTargetH;
      reason = isCloak
        ? "Drape/Cloak: height -> (ground→shoulderLine)+margin"
        : "Drape/Cape: height -> (ground→shoulderLine)+margin";
      break;
    }

    case "PairedMount": {
      // agreed: wingspan equals avatar height
      from = accW;
      to = 1.0 * avatarH;
      reason = "PairedMount: width -> avatarHeight";
      break;
    }

    case "StrapHarness": {
      // agreed: match torso height
      from = accH;
      to = torsoH;
      reason = "StrapHarness: height -> torsoHeight";
      break;
    }

    case "SurfaceMount": {
      // agreed: match torso width (shoulder width)
      from = accW;
      to = shoulderW;
      reason = "SurfaceMount: width -> shoulderWidth";
      break;
    }

    case "HingeTail": {
      // agreed: leave as-is for now
      return { scale: new THREE.Vector3(1, 1, 1), uniformScalar: 1, reason: "HingeTail: unchanged" };
    }

    default: {
      from = accMax;
      to = avatarH;
      reason = "Unknown: maxDim -> avatarHeight";
      break;
    }
  }

  // Uniform scalar
  let u = to / Math.max(1e-6, from);

  // Looser clamp to avoid “ukulele guitar”
  u = clamp(u, 0.25, 20.0);

  const scale = new THREE.Vector3(u, u, u);

  return {
    scale,
    uniformScalar: u,
    reason: `${reason} | from=${from.toFixed(3)} to=${to.toFixed(3)} u=${u.toFixed(3)} (accAABB=${accW.toFixed(
      3
    )},${accH.toFixed(3)},${accD.toFixed(3)})`,
  };
}

function clamp(x: number, a: number, b: number) {
  return Math.max(a, Math.min(b, x));
}

function classifyDrapeSubtype(attrs: AttrScores | undefined, geom: AccessoryGeom): "Cape" | "Cloak" {
  const looksCloth = attrs?.LooksCloth ?? 0;
  const hangsDown = attrs?.HangsDown ?? 0;
  const bulkyPack = attrs?.BulkyPack ?? 0;

  const depthRatio = geom.aabbSize.z / Math.max(1e-6, geom.aabbSize.y);
  const widthRatio = geom.aabbSize.x / Math.max(1e-6, geom.aabbSize.y);

  let cloak = looksCloth > 0.45 && hangsDown < 0.75;
  if (depthRatio > 0.52 && (widthRatio > 0.48 || bulkyPack > 0.04)) cloak = true;
  if (hangsDown > 0.7 && depthRatio < 0.42 && bulkyPack < 0.1) cloak = false;

  return cloak ? "Cloak" : "Cape";
}
