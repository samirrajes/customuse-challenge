// src/placement/accessoryGeom.ts
import * as THREE from "three";

export type PlacementIntent = {
  wantsFlush?: number; // plate-like cue (0..1)
  wantsDiagonal?: number; // long rigid cue (0..1)
};

export type AccessoryGeom = {
  aabb: THREE.Box3;
  aabbSize: THREE.Vector3;
  center: THREE.Vector3;
  yP02: number;
  yP50: number;
  yP85: number;
  yP95: number;
  topCenterDensity: number;

  pcaMajor: THREE.Vector3;
  pcaMid: THREE.Vector3;
  pcaMinor: THREE.Vector3;
  eigenvalues: THREE.Vector3; // λmajor >= λmid >= λminor

  elongation: number; // sqrt(λmajor/λmid)
  flatness: number; // sqrt(λmid/λminor)
  thickness: number; // extent along minor axis
};

export type MountData = {
  mountPointLocal: THREE.Vector3;
  mountNormalLocal: THREE.Vector3; // points outward from the mount face
  longAxisLocal: THREE.Vector3;
  debug: {
    usedNormal: "pcaMinor" | "aabbFace";
    projMin: number;
    projMax: number;
    threshold: number;
    selectedCount: number;
    totalCount: number;
  };
};

export function collectVerticesRootLocal(root: THREE.Object3D, maxPoints = 120_000): THREE.Vector3[] {
  root.updateWorldMatrix(true, true);
  const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert();

  const pts: THREE.Vector3[] = [];
  const tmp = new THREE.Vector3();
  const tmpWorld = new THREE.Vector3();
  const tmpMat = new THREE.Matrix4();

  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const isMesh = (mesh as any).isMesh || (mesh as any).isSkinnedMesh;
    if (!isMesh) return;

    const g = mesh.geometry as THREE.BufferGeometry | undefined;
    const pos = g?.attributes?.position as THREE.BufferAttribute | undefined;
    if (!g || !pos || pos.itemSize < 3) return;

    mesh.updateWorldMatrix(true, false);
    tmpMat.copy(mesh.matrixWorld);

    const count = pos.count;
    const stride = count > 60_000 ? Math.ceil(count / 60_000) : 1;

    for (let i = 0; i < count; i += stride) {
      tmp.fromBufferAttribute(pos, i);
      tmpWorld.copy(tmp).applyMatrix4(tmpMat);
      tmp.copy(tmpWorld).applyMatrix4(rootInv);
      pts.push(tmp.clone());
      if (pts.length >= maxPoints) return;
    }
  });

  return pts;
}

export function computeAccessoryGeom(root: THREE.Object3D, pts?: THREE.Vector3[]): AccessoryGeom {
  const points = pts ?? collectVerticesRootLocal(root);

  const aabb = new THREE.Box3();
  for (const p of points) aabb.expandByPoint(p);
  const aabbSize = aabb.getSize(new THREE.Vector3());
  const center = aabb.getCenter(new THREE.Vector3());
  const centerStrip = 0.22 * Math.max(1e-6, aabbSize.x);

  const ys = points.map((p) => p.y).sort((a, b) => a - b);
  const yP02 = percentileSorted(ys, 0.02);
  const yP50 = percentileSorted(ys, 0.5);
  const yP85 = percentileSorted(ys, 0.85);
  const yP95 = percentileSorted(ys, 0.95);

  let topCenterCount = 0;
  for (const p of points) {
    if (p.y < yP85) continue;
    if (Math.abs(p.x - center.x) > centerStrip) continue;
    topCenterCount++;
  }
  const topCenterDensity = topCenterCount / Math.max(1, points.length);

  const mean = new THREE.Vector3();
  for (const p of points) mean.add(p);
  mean.multiplyScalar(1 / Math.max(1, points.length));

  let c00 = 0,
    c01 = 0,
    c02 = 0,
    c11 = 0,
    c12 = 0,
    c22 = 0;

  for (const p of points) {
    const x = p.x - mean.x;
    const y = p.y - mean.y;
    const z = p.z - mean.z;
    c00 += x * x;
    c01 += x * y;
    c02 += x * z;
    c11 += y * y;
    c12 += y * z;
    c22 += z * z;
  }

  const n = Math.max(1, points.length);
  c00 /= n;
  c01 /= n;
  c02 /= n;
  c11 /= n;
  c12 /= n;
  c22 /= n;

  const { eigenvalues, eigenvectors } = jacobiEigenSym3(c00, c01, c02, c11, c12, c22, 18);

  const idx = [0, 1, 2].sort((a, b) => eigenvalues[b] - eigenvalues[a]);
  const vMajor = eigenvectors[idx[0]].clone().normalize();
  const vMid = eigenvectors[idx[1]].clone().normalize();
  const vMinor = eigenvectors[idx[2]].clone().normalize();

  const cross = new THREE.Vector3().crossVectors(vMajor, vMid);
  if (cross.dot(vMinor) < 0) vMinor.multiplyScalar(-1);

  const lamMajor = Math.max(1e-12, eigenvalues[idx[0]]);
  const lamMid = Math.max(1e-12, eigenvalues[idx[1]]);
  const lamMinor = Math.max(1e-12, eigenvalues[idx[2]]);

  const elongation = Math.sqrt(lamMajor / lamMid);
  const flatness = Math.sqrt(lamMid / lamMinor);
  const thickness = extentAlongAxisFromAabb(aabb, vMinor);

  return {
    aabb,
    aabbSize,
    center,
    yP02,
    yP50,
    yP85,
    yP95,
    topCenterDensity,
    pcaMajor: vMajor,
    pcaMid: vMid,
    pcaMinor: vMinor,
    eigenvalues: new THREE.Vector3(lamMajor, lamMid, lamMinor),
    elongation,
    flatness,
    thickness,
  };
}

/**
 * Robust mount-face selection in ROOT-LOCAL space.
 * - Uses PCA minor for planar/flush items (or when wantsFlush)
 * - Falls back to smallest AABB axis otherwise
 * - Disambiguates normal sign by ensuring mount face is on the "min" side vs the center
 * - Computes mount point as average of vertices in the lowest 5% band along that normal
 */
export function findMountFace(root: THREE.Object3D, geom: AccessoryGeom, intent?: PlacementIntent): MountData {
  const points = collectVerticesRootLocal(root);

  const wantsFlush = intent?.wantsFlush ?? 0;
  const wantsDiagonal = intent?.wantsDiagonal ?? 0;

  let n = geom.pcaMinor.clone();
  let usedNormal: MountData["debug"]["usedNormal"] = "pcaMinor";

  const planarCue = geom.flatness > 2.2 || geom.thickness < 0.12 * geom.aabbSize.length();

  // If not flush-ish, or if strongly diagonal-ish, use AABB smallest axis instead of PCA minor.
  if (!(wantsFlush > 0.25 || planarCue) || wantsDiagonal > 0.6) {
    const s = geom.aabbSize;
    const minAxis = s.x <= s.y && s.x <= s.z ? "x" : s.y <= s.z ? "y" : "z";
    n.set(minAxis === "x" ? 1 : 0, minAxis === "y" ? 1 : 0, minAxis === "z" ? 1 : 0);
    usedNormal = "aabbFace";
  }
  n.normalize();

  function computeMinFaceMount(nUnit: THREE.Vector3) {
    let projMin = Infinity;
    let projMax = -Infinity;

    const projs = new Float32Array(points.length);
    for (let i = 0; i < points.length; i++) {
      const d = points[i]!.dot(nUnit);
      projs[i] = d;
      if (d < projMin) projMin = d;
      if (d > projMax) projMax = d;
    }

    const span = Math.max(1e-9, projMax - projMin);
    const threshold = projMin + span * 0.05; // lowest 5% band

    const mountPoint = new THREE.Vector3();
    let count = 0;

    for (let i = 0; i < points.length; i++) {
      if (projs[i]! <= threshold) {
        mountPoint.add(points[i]!);
        count++;
      }
    }

    if (count > 0) mountPoint.multiplyScalar(1 / count);
    else mountPoint.copy(geom.center);

    return { mountPoint, projMin, projMax, threshold, count };
  }

  // 1) compute mount on min face along n
  let m = computeMinFaceMount(n);

  // 2) disambiguate which side is the "mount side" (PCA axes sign ambiguity)
  const centerProj = geom.center.dot(n);
  const mountProj = m.mountPoint.dot(n);

  // If mount point is on the "high" side of the object along n, flip and recompute
  if (mountProj > centerProj) {
    n.multiplyScalar(-1);
    m = computeMinFaceMount(n);
  }

  const mountNormal = n.clone(); // outward from mount face
  const longAxisLocal = geom.pcaMajor.clone();

  return {
    mountPointLocal: m.mountPoint,
    mountNormalLocal: mountNormal,
    longAxisLocal,
    debug: {
      usedNormal,
      projMin: m.projMin,
      projMax: m.projMax,
      threshold: m.threshold,
      selectedCount: m.count,
      totalCount: points.length,
    },
  };
}

/* ----------------------------- */
/* Helpers                       */
/* ----------------------------- */

function extentAlongAxisFromAabb(aabb: THREE.Box3, axisUnit: THREE.Vector3): number {
  const corners = [
    new THREE.Vector3(aabb.min.x, aabb.min.y, aabb.min.z),
    new THREE.Vector3(aabb.min.x, aabb.min.y, aabb.max.z),
    new THREE.Vector3(aabb.min.x, aabb.max.y, aabb.min.z),
    new THREE.Vector3(aabb.min.x, aabb.max.y, aabb.max.z),
    new THREE.Vector3(aabb.max.x, aabb.min.y, aabb.min.z),
    new THREE.Vector3(aabb.max.x, aabb.min.y, aabb.max.z),
    new THREE.Vector3(aabb.max.x, aabb.max.y, aabb.min.z),
    new THREE.Vector3(aabb.max.x, aabb.max.y, aabb.max.z),
  ];
  let mn = Infinity;
  let mx = -Infinity;
  for (const c of corners) {
    const d = c.dot(axisUnit);
    mn = Math.min(mn, d);
    mx = Math.max(mx, d);
  }
  return mx - mn;
}

function percentileSorted(sortedValues: number[], q: number): number {
  if (!sortedValues.length) return 0;
  const t = THREE.MathUtils.clamp(q, 0, 1) * (sortedValues.length - 1);
  const lo = Math.floor(t);
  const hi = Math.ceil(t);
  const a = sortedValues[lo]!;
  const b = sortedValues[hi]!;
  return a + (b - a) * (t - lo);
}

function jacobiEigenSym3(
  a00: number,
  a01: number,
  a02: number,
  a11: number,
  a12: number,
  a22: number,
  iters = 16
): { eigenvalues: number[]; eigenvectors: THREE.Vector3[] } {
  let A00 = a00,
    A01 = a01,
    A02 = a02,
    A11 = a11,
    A12 = a12,
    A22 = a22;

  let v00 = 1,
    v01 = 0,
    v02 = 0;
  let v10 = 0,
    v11 = 1,
    v12 = 0;
  let v20 = 0,
    v21 = 0,
    v22 = 1;

  function rotate(p: number, q: number) {
    let app = 0,
      aqq = 0,
      apq = 0;

    if (p === 0 && q === 1) {
      app = A00;
      aqq = A11;
      apq = A01;
    } else if (p === 0 && q === 2) {
      app = A00;
      aqq = A22;
      apq = A02;
    } else if (p === 1 && q === 2) {
      app = A11;
      aqq = A22;
      apq = A12;
    } else return;

    if (Math.abs(apq) < 1e-12) return;

    const tau = (aqq - app) / (2 * apq);
    const t = Math.sign(tau) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
    const c = 1 / Math.sqrt(1 + t * t);
    const s = t * c;

    const app2 = app - t * apq;
    const aqq2 = aqq + t * apq;

    if (p === 0 && q === 1) {
      A00 = app2;
      A11 = aqq2;
      A01 = 0;
      const A02_old = A02;
      const A12_old = A12;
      A02 = c * A02_old - s * A12_old;
      A12 = s * A02_old + c * A12_old;
    } else if (p === 0 && q === 2) {
      A00 = app2;
      A22 = aqq2;
      A02 = 0;
      const A01_old = A01;
      const A12_old = A12;
      A01 = c * A01_old - s * A12_old;
      A12 = s * A01_old + c * A12_old;
    } else {
      A11 = app2;
      A22 = aqq2;
      A12 = 0;
      const A01_old = A01;
      const A02_old = A02;
      A01 = c * A01_old - s * A02_old;
      A02 = s * A01_old + c * A02_old;
    }

    if (p === 0 && q === 1) {
      const nv00 = c * v00 - s * v01;
      const nv01 = s * v00 + c * v01;
      const nv10 = c * v10 - s * v11;
      const nv11 = s * v10 + c * v11;
      const nv20 = c * v20 - s * v21;
      const nv21 = s * v20 + c * v21;
      v00 = nv00;
      v01 = nv01;
      v10 = nv10;
      v11 = nv11;
      v20 = nv20;
      v21 = nv21;
    } else if (p === 0 && q === 2) {
      const nv00 = c * v00 - s * v02;
      const nv02 = s * v00 + c * v02;
      const nv10 = c * v10 - s * v12;
      const nv12 = s * v10 + c * v12;
      const nv20 = c * v20 - s * v22;
      const nv22 = s * v20 + c * v22;
      v00 = nv00;
      v02 = nv02;
      v10 = nv10;
      v12 = nv12;
      v20 = nv20;
      v22 = nv22;
    } else {
      const nv01 = c * v01 - s * v02;
      const nv02 = s * v01 + c * v02;
      const nv11 = c * v11 - s * v12;
      const nv12 = s * v11 + c * v12;
      const nv21 = c * v21 - s * v22;
      const nv22 = s * v21 + c * v22;
      v01 = nv01;
      v02 = nv02;
      v11 = nv11;
      v12 = nv12;
      v21 = nv21;
      v22 = nv22;
    }
  }

  for (let i = 0; i < iters; i++) {
    const a01Abs = Math.abs(A01);
    const a02Abs = Math.abs(A02);
    const a12Abs = Math.abs(A12);

    if (a01Abs >= a02Abs && a01Abs >= a12Abs) rotate(0, 1);
    else if (a02Abs >= a01Abs && a02Abs >= a12Abs) rotate(0, 2);
    else rotate(1, 2);
  }

  const evals = [A00, A11, A22];
  const evecs = [
    new THREE.Vector3(v00, v10, v20),
    new THREE.Vector3(v01, v11, v21),
    new THREE.Vector3(v02, v12, v22),
  ];

  return { eigenvalues: evals, eigenvectors: evecs };
}
