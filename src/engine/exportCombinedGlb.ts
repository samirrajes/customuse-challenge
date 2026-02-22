import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";

function copyWorldTransform(src: THREE.Object3D, dst: THREE.Object3D) {
  src.updateWorldMatrix(true, true);
  const pos = src.getWorldPosition(new THREE.Vector3());
  const quat = src.getWorldQuaternion(new THREE.Quaternion());
  const scale = src.getWorldScale(new THREE.Vector3());
  dst.position.copy(pos);
  dst.quaternion.copy(quat);
  dst.scale.copy(scale);
  dst.updateWorldMatrix(true, true);
}

function buildExportRoot(avatar: THREE.Object3D, accessory: THREE.Object3D) {
  const avatarClone = avatar.clone(true);
  avatarClone.name = avatar.name || "Avatar";
  copyWorldTransform(avatar, avatarClone);

  const accessoryClone = accessory.clone(true);
  accessoryClone.name = accessory.name || "Accessory";
  copyWorldTransform(accessory, accessoryClone);

  const root = new THREE.Scene();
  root.name = "CombinedAvatarAccessory";
  root.add(avatarClone);

  // Keep accessory world transform while reparenting under avatar.
  avatarClone.attach(accessoryClone);
  return root;
}

export async function exportCombinedAvatarAccessoryGLB(
  avatar: THREE.Object3D,
  accessory: THREE.Object3D
): Promise<ArrayBuffer> {
  const exportRoot = buildExportRoot(avatar, accessory);
  const exporter = new GLTFExporter();

  return await new Promise<ArrayBuffer>((resolve, reject) => {
    exporter.parse(
      exportRoot,
      (result) => {
        if (result instanceof ArrayBuffer) {
          resolve(result);
          return;
        }
        reject(new Error("Expected binary GLB export result (ArrayBuffer)."));
      },
      (error) => {
        reject(error instanceof Error ? error : new Error(String(error)));
      },
      {
        binary: true,
        onlyVisible: true,
      }
    );
  });
}
