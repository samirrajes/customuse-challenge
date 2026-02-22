import * as THREE from "three";
import { scanAnchors, type FoundAnchor } from "./anchors";
import { getRenderableBounds } from "../engine/assets";

export const REQUIRED_ANCHOR_NAMES = [
  "ANCHOR_BodyBackAttachment_Sphere",
  "ANCHOR_BodyFrontAttachment_Sphere",
  "ANCHOR_LeftShoulderAttachment_Sphere",
  "ANCHOR_RightShoulderAttachment_Sphere",
  "ANCHOR_WaistBackAttachment_Sphere",
] as const;

export const OPTIONAL_ANCHOR_NAMES = ["ANCHOR_NeckAttachment_Sphere"] as const;

export const IMPORTANT_ANCHOR_NAMES = [...REQUIRED_ANCHOR_NAMES, ...OPTIONAL_ANCHOR_NAMES] as const;

type ImportantAnchorName = (typeof IMPORTANT_ANCHOR_NAMES)[number];

type CanonicalAnchorPoint = {
  name: ImportantAnchorName;
  worldPos: THREE.Vector3;
  uvw: THREE.Vector3;
};

export type CanonicalAnchorTemplate = {
  canonicalBounds: {
    min: THREE.Vector3;
    size: THREE.Vector3;
    center: THREE.Vector3;
  };
  anchors: CanonicalAnchorPoint[];
};

function clamp01(v: number) {
  return THREE.MathUtils.clamp(v, 0, 1);
}

function worldToUvw(pos: THREE.Vector3, min: THREE.Vector3, size: THREE.Vector3) {
  return new THREE.Vector3(
    clamp01((pos.x - min.x) / Math.max(1e-6, size.x)),
    clamp01((pos.y - min.y) / Math.max(1e-6, size.y)),
    clamp01((pos.z - min.z) / Math.max(1e-6, size.z))
  );
}

function uvwToWorld(uvw: THREE.Vector3, min: THREE.Vector3, size: THREE.Vector3) {
  return new THREE.Vector3(
    min.x + uvw.x * size.x,
    min.y + uvw.y * size.y,
    min.z + uvw.z * size.z
  );
}

function safeNormalize(v: THREE.Vector3, fallback: THREE.Vector3) {
  if (v.lengthSq() < 1e-10) return fallback.clone();
  return v.normalize();
}

function isValidRaycastHit(hit: THREE.Intersection) {
  const obj = hit.object as THREE.Object3D | undefined;
  if (!obj || !obj.visible) return false;
  const mesh = obj as THREE.Mesh;
  if (!mesh.isMesh) return false;
  const name = (obj.name ?? "").toLowerCase();
  if (name.startsWith("anchor_")) return false;
  return true;
}

function pickClosestToRef(points: THREE.Vector3[], ref: THREE.Vector3) {
  let best: THREE.Vector3 | null = null;
  let bestD2 = Infinity;
  for (const p of points) {
    const d2 = p.distanceToSquared(ref);
    if (d2 < bestD2) {
      bestD2 = d2;
      best = p;
    }
  }
  return best;
}

function raycastSurfaceNearPoint(
  targetAvatar: THREE.Object3D,
  raycaster: THREE.Raycaster,
  mapped: THREE.Vector3,
  normalHint: THREE.Vector3,
  radial: THREE.Vector3,
  travel: number
) {
  const candidates: THREE.Vector3[] = [];

  const cast = (origin: THREE.Vector3, dir: THREE.Vector3, far: number) => {
    raycaster.near = 0;
    raycaster.far = far;
    raycaster.set(origin, dir);
    const hits = raycaster.intersectObject(targetAvatar, true).filter(isValidRaycastHit);
    for (const h of hits) candidates.push(h.point.clone());
  };

  const n = safeNormalize(normalHint.clone(), radial);
  const r = safeNormalize(radial.clone(), n);

  // Name-aware normal axis from both sides.
  cast(mapped.clone().addScaledVector(n, travel), n.clone().negate(), travel * 2.4);
  cast(mapped.clone().addScaledVector(n, -travel), n.clone(), travel * 2.4);

  // Radial fallback from both sides.
  cast(mapped.clone().addScaledVector(r, travel), r.clone().negate(), travel * 2.4);
  cast(mapped.clone().addScaledVector(r, -travel), r.clone(), travel * 2.4);

  return pickClosestToRef(candidates, mapped);
}

export function buildCanonicalAnchorTemplate(canonicalRoot: THREE.Object3D): CanonicalAnchorTemplate {
  canonicalRoot.updateWorldMatrix(true, true);

  const { anchors } = scanAnchors(canonicalRoot, {
    prefix: "ANCHOR_",
    caseInsensitive: false,
  });

  const byName = new Map<string, FoundAnchor>();
  for (const a of anchors) byName.set(a.name, a);

  const missingRequired = REQUIRED_ANCHOR_NAMES.filter((name) => !byName.has(name));
  if (missingRequired.length) {
    throw new Error(`Canonical avatar missing anchors: ${missingRequired.join(", ")}`);
  }

  const { box, size, center } = getRenderableBounds(canonicalRoot);
  const min = box.min.clone();

  const points: CanonicalAnchorPoint[] = [];
  for (const name of IMPORTANT_ANCHOR_NAMES) {
    const found = byName.get(name);
    if (!found) continue;
    const worldPos = found.obj.getWorldPosition(new THREE.Vector3());
    points.push({
      name,
      worldPos: worldPos.clone(),
      uvw: worldToUvw(worldPos, min, size),
    });
  }

  return {
    canonicalBounds: { min, size, center },
    anchors: points,
  };
}

export function synthesizeAnchorsFromTemplate(
  targetAvatar: THREE.Object3D,
  template: CanonicalAnchorTemplate
): FoundAnchor[] {
  targetAvatar.updateWorldMatrix(true, true);

  const { box: targetBox, size: targetSize, center: targetCenter } = getRenderableBounds(targetAvatar);
  const targetMin = targetBox.min.clone();
  const maxDim = Math.max(targetSize.x, targetSize.y, targetSize.z);

  const raycaster = new THREE.Raycaster();
  const synthesized: FoundAnchor[] = [];
  const mappedByName = new Map<ImportantAnchorName, THREE.Vector3>();

  for (const p of template.anchors) {
    mappedByName.set(p.name, uvwToWorld(p.uvw, targetMin, targetSize));
  }

  const mappedBack = mappedByName.get("ANCHOR_BodyBackAttachment_Sphere");
  const mappedFront = mappedByName.get("ANCHOR_BodyFrontAttachment_Sphere");
  const mappedLeftShoulder = mappedByName.get("ANCHOR_LeftShoulderAttachment_Sphere");
  const mappedRightShoulder = mappedByName.get("ANCHOR_RightShoulderAttachment_Sphere");

  const backDir = safeNormalize(
    (mappedBack && mappedFront ? mappedBack.clone().sub(mappedFront) : new THREE.Vector3()).clone(),
    new THREE.Vector3(0, 0, 1)
  );
  const rightDir = safeNormalize(
    (
      mappedLeftShoulder && mappedRightShoulder
        ? mappedLeftShoulder.clone().sub(mappedRightShoulder)
        : new THREE.Vector3()
    ).clone(),
    new THREE.Vector3(1, 0, 0)
  );
  const shoulderMid = mappedLeftShoulder
    ? mappedLeftShoulder.clone().lerp(mappedRightShoulder ?? mappedLeftShoulder, 0.5)
    : targetCenter.clone();

  const shoulderLeftOut = safeNormalize(
    (mappedLeftShoulder ? mappedLeftShoulder.clone().sub(shoulderMid) : new THREE.Vector3()).clone(),
    rightDir
  );
  const shoulderRightOut = safeNormalize(
    (mappedRightShoulder ? mappedRightShoulder.clone().sub(shoulderMid) : new THREE.Vector3()).clone(),
    rightDir.clone().negate()
  );

  const surfaceNormalByName: Partial<Record<ImportantAnchorName, THREE.Vector3>> = {
    ANCHOR_BodyBackAttachment_Sphere: backDir.clone(),
    ANCHOR_BodyFrontAttachment_Sphere: backDir.clone().negate(),
    ANCHOR_WaistBackAttachment_Sphere: backDir.clone(),
    ANCHOR_LeftShoulderAttachment_Sphere: shoulderLeftOut.clone(),
    ANCHOR_RightShoulderAttachment_Sphere: shoulderRightOut.clone(),
  };

  const surfaceAnchors = new Set<ImportantAnchorName>([
    "ANCHOR_BodyBackAttachment_Sphere",
    "ANCHOR_BodyFrontAttachment_Sphere",
    "ANCHOR_LeftShoulderAttachment_Sphere",
    "ANCHOR_RightShoulderAttachment_Sphere",
    "ANCHOR_WaistBackAttachment_Sphere",
  ]);

  for (const p of template.anchors) {
    const mapped = mappedByName.get(p.name) ?? uvwToWorld(p.uvw, targetMin, targetSize);
    const radial = safeNormalize(mapped.clone().sub(targetCenter), backDir.clone());
    let worldPos = mapped.clone();

    if (surfaceAnchors.has(p.name)) {
      const normalHint = surfaceNormalByName[p.name]?.clone() ?? radial.clone();
      const travel = Math.max(0.06, maxDim * 0.22);
      const surface = raycastSurfaceNearPoint(targetAvatar, raycaster, mapped, normalHint, radial, travel);
      if (surface) {
        worldPos = surface.clone().addScaledVector(normalHint, 0.0015);
      }
    }

    const localPos = targetAvatar.worldToLocal(worldPos.clone());
    const obj = new THREE.Object3D();
    obj.name = p.name;
    obj.position.copy(localPos);
    targetAvatar.add(obj);
    synthesized.push({ name: p.name, obj });
  }

  synthesized.sort((a, b) => a.name.localeCompare(b.name));
  targetAvatar.updateWorldMatrix(true, true);
  return synthesized;
}
