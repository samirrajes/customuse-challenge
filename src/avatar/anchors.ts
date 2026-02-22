// src/avatar/anchors.ts
import * as THREE from "three";

export type FoundAnchor = {
  name: string;
  obj: THREE.Object3D;
};

export type AnchorScanResult = {
  anchors: FoundAnchor[];
  byName: Map<string, THREE.Object3D>;
};

export function scanAnchors(
  root: THREE.Object3D,
  opts?: { prefix?: string; caseInsensitive?: boolean }
): AnchorScanResult {
  const prefix = opts?.prefix ?? "ANCHOR_";
  const ci = opts?.caseInsensitive ?? false;

  const anchors: FoundAnchor[] = [];
  const byName = new Map<string, THREE.Object3D>();

  root.traverse((o) => {
    const n = o.name ?? "";
    if (!n) return;

    const match = ci
      ? n.toLowerCase().startsWith(prefix.toLowerCase())
      : n.startsWith(prefix);

    if (!match) return;

    anchors.push({ name: n, obj: o });
    byName.set(n, o);
  });

  anchors.sort((a, b) => a.name.localeCompare(b.name));
  return { anchors, byName };
}

type AnchorsDebugUserData = {
  holders: THREE.Group[];
  sphereGeo: THREE.SphereGeometry;
  sphereMat: THREE.MeshBasicMaterial;
};

const BOUNDS_EXCLUDE_FLAG = "__excludeFromBounds";

export function createAnchorsDebugGroup(
  anchors: FoundAnchor[],
  opts?: { sphereRadius?: number; axesSize?: number; opacity?: number }
): THREE.Group {
  const manager = new THREE.Group();
  manager.name = "AnchorDebugManager";

  const sphereRadius = opts?.sphereRadius ?? 0.02;
  const axesSize = opts?.axesSize ?? 0.08;
  const opacity = opts?.opacity ?? 0.9;

  const sphereGeo = new THREE.SphereGeometry(sphereRadius, 12, 10);
  const sphereMat = new THREE.MeshBasicMaterial({
    color: 0xff3366,
    transparent: true,
    opacity,
    depthWrite: false,
  });

  const holders: THREE.Group[] = [];
  const worldScale = new THREE.Vector3();

  for (const a of anchors) {
    const holder = new THREE.Group();
    holder.name = `Viz_${a.name}`;
    holder.userData[BOUNDS_EXCLUDE_FLAG] = true;

    // ✅ parent under anchor so it inherits transform
    a.obj.add(holder);

    // Keep debug marker size stable in world units even when avatar/root scale is large.
    a.obj.getWorldScale(worldScale);
    holder.scale.set(
      1 / Math.max(1e-6, Math.abs(worldScale.x)),
      1 / Math.max(1e-6, Math.abs(worldScale.y)),
      1 / Math.max(1e-6, Math.abs(worldScale.z))
    );

    const sphere = new THREE.Mesh(sphereGeo, sphereMat);
    sphere.name = `VizSphere_${a.name}`;
    sphere.userData[BOUNDS_EXCLUDE_FLAG] = true;
    holder.add(sphere);

    const axes = new THREE.AxesHelper(axesSize);
    axes.name = `VizAxes_${a.name}`;
    axes.userData[BOUNDS_EXCLUDE_FLAG] = true;
    holder.add(axes);

    holders.push(holder);
  }

  // Store refs for toggling + disposal (DO NOT parent holders under manager)
  manager.userData = {
    holders,
    sphereGeo,
    sphereMat,
  } satisfies AnchorsDebugUserData;

  return manager;
}

export function setAnchorsDebugVisible(manager: THREE.Group, visible: boolean) {
  const ud = manager.userData as AnchorsDebugUserData | undefined;
  if (!ud?.holders) return;
  for (const h of ud.holders) h.visible = visible;
}

export function disposeAnchorsDebugGroup(manager: THREE.Group) {
  const ud = manager.userData as AnchorsDebugUserData | undefined;

  // Remove holders from anchors
  if (ud?.holders) {
    for (const holder of ud.holders) {
      holder.parent?.remove(holder);
    }
    ud.holders.length = 0;
  }

  // Dispose shared resources once
  ud?.sphereGeo?.dispose();
  ud?.sphereMat?.dispose();

  manager.clear();
  manager.userData = {};
}
