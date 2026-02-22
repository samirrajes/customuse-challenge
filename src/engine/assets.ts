import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const gltfLoader = new GLTFLoader();

export async function loadGLTFScene(file: File): Promise<THREE.Group> {
  const objectUrl = URL.createObjectURL(file);
  try {
    return await loadGLTFSceneFromUrl(objectUrl);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function loadGLTFSceneFromUrl(url: string): Promise<THREE.Group> {
  return new Promise((resolve, reject) => {
    gltfLoader.load(
      url,
      (gltf) => {
        resolve(gltf.scene);
      },
      undefined,
      (err) => {
        reject(err);
      }
    );
  });
}

export function disposeObject(obj: THREE.Object3D) {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry?.dispose?.();
      const mat = mesh.material as any;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose?.());
      else mat?.dispose?.();
    }
  });
}

function isRenderableBoundsMesh(obj: THREE.Object3D): obj is THREE.Mesh {
  const mesh = obj as THREE.Mesh;
  if (!mesh.isMesh) return false;
  if (!obj.visible) return false;
  if (obj.userData?.__excludeFromBounds) return false;
  const name = (obj.name ?? "").toLowerCase();
  if (name.startsWith("anchor_")) return false;
  if (name.startsWith("viz")) return false;
  if (name.includes("helper")) return false;
  return true;
}

function hasBoundsExcludedAncestor(obj: THREE.Object3D) {
  let p: THREE.Object3D | null = obj.parent;
  while (p) {
    if (!p.visible) return true;
    if (p.userData?.__excludeFromBounds) return true;
    const n = (p.name ?? "").toLowerCase();
    if (n.startsWith("viz")) return true;
    p = p.parent;
  }
  return false;
}

export function getRenderableBounds(obj: THREE.Object3D) {
  obj.updateWorldMatrix(true, true);

  const box = new THREE.Box3();
  box.makeEmpty();
  const tmp = new THREE.Box3();
  let hasAny = false;

  obj.traverse((child) => {
    if (!isRenderableBoundsMesh(child)) return;
    if (hasBoundsExcludedAncestor(child)) return;
    tmp.makeEmpty();
    // Use Three's object bounds path (precise) to avoid skewed/skinned local bbox artifacts.
    tmp.setFromObject(child, true);
    if (tmp.isEmpty()) return;
    if (!hasAny) box.copy(tmp);
    else box.union(tmp);
    hasAny = true;
  });

  // Fallback for unusual assets with no visible meshes.
  if (!hasAny) box.setFromObject(obj, true);

  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  return { box, size, center };
}

export function normalizeToHeight(obj: THREE.Object3D, targetHeight = 1.7) {
  const { size, center } = getRenderableBounds(obj);

  obj.position.sub(center);

  const height = Math.max(size.y, 1e-6);
  const s = targetHeight / height;
  obj.scale.setScalar(s);

  const { center: center2 } = getRenderableBounds(obj);
  obj.position.sub(center2);
}

export function getBounds(obj: THREE.Object3D) {
  return getRenderableBounds(obj);
}

export function isSupported(file: File) {
  const name = file.name.toLowerCase();
  return name.endsWith(".glb") || name.endsWith(".gltf");
}
