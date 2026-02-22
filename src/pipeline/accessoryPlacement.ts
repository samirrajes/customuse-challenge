import * as THREE from "three";

import type { FoundAnchor } from "../avatar/anchors";
import type { AvatarRig } from "../avatar/rig";
import { computeAccessoryGeom } from "../placement/accessoryGeom";
import { placeAccessoryByAnchorBandFit, type AttrScores, type Family } from "../placement/placeByAnchorBandFit";
import { computeScaleAccessoryToRig } from "../placement/scaleAccessoryToRig";

export type PlacementResult = {
  family: Family;
  lines: string[];
};

export function scaleAndPlaceAccessory(
  accessory: THREE.Object3D,
  avatar: THREE.Object3D,
  foundAnchors: FoundAnchor[],
  rig: AvatarRig,
  family: Family,
  attrs: AttrScores
): PlacementResult {
  const geom0 = computeAccessoryGeom(accessory);
  const effective = resolveEffectiveFamilyForScaleAndPlacement(family, attrs, geom0);

  const scaleRes = computeScaleAccessoryToRig(rig, geom0, effective.family, attrs);
  accessory.scale.copy(scaleRes.scale);
  accessory.updateWorldMatrix(true, true);

  const geom1 = computeAccessoryGeom(accessory);
  const placed = placeAccessoryByAnchorBandFit(accessory, avatar, foundAnchors, effective.family, geom1, attrs, {
    midYAlpha: 0.5,
    pairedMidYAlpha: 0.5,
    rigidMidYAlpha: 0.22,
    backpackOverride: true,
  });

  const lines: string[] = [];
  lines.push("Step 4 ✅ scale + anchor placement");
  lines.push(`- resolvedFamily: ${family}`);
  lines.push(`- effectiveFamily: ${effective.family}`);
  if (effective.remapped) lines.push(`- familyRemap: ${effective.reason}`);
  lines.push(
    `- scale: ${scaleRes.scale
      .toArray()
      .map((v) => v.toFixed(4))
      .join(", ")}  (${scaleRes.reason})`
  );
  lines.push(`- yawDeg: ${placed.yawDeg.toFixed(1)}`);
  lines.push(`- backOffset: ${placed.backOffset.toFixed(4)}`);
  lines.push(`- mountAlign: ${placed.debug.mountAlign.toFixed(4)}`);
  lines.push(
    `- placement: depthQ=${placed.debug.depthQuantile.toFixed(4)} minDepth=${placed.debug.minDepth.toFixed(
      4
    )} score=${placed.debug.score.toFixed(4)}`
  );
  lines.push(
    `- finalPlacementShift(frame): dx=${placed.debug.finalPlacementShift.dx.toFixed(4)} dy=${placed.debug.finalPlacementShift.dy.toFixed(4)} dz=${placed.debug.finalPlacementShift.dz.toFixed(4)}`
  );
  lines.push(
    `- accessoryPosWorld: ${accessory
      .getWorldPosition(new THREE.Vector3())
      .toArray()
      .map((v) => v.toFixed(3))
      .join(", ")}`
  );

  return { family: effective.family, lines };
}

function resolveEffectiveFamilyForScaleAndPlacement(
  family: Family,
  attrs: {
    HasStraps?: number;
    BulkyPack?: number;
  },
  geom: { aabbSize: THREE.Vector3 }
): {
  family: Family;
  remapped: boolean;
  wingLike: boolean;
  backpackLike: boolean;
  reason: string;
} {
  const wingLike = geom.aabbSize.x >= 1.35 * geom.aabbSize.y && geom.aabbSize.z <= 0.22 * geom.aabbSize.x;
  const backpackLike = (attrs.BulkyPack ?? 0) >= 0.1 || (attrs.HasStraps ?? 0) >= 0.1;

  return {
    family,
    remapped: false,
    wingLike,
    backpackLike,
    reason: "No remap (trust CLIP family)",
  };
}
