import * as THREE from "three";
import { getRenderableBounds } from "./assets";

export type BoundsDebug = {
  setAvatar(obj: THREE.Object3D | null): void;
  setAccessory(obj: THREE.Object3D | null): void;
  setVisible(visible: boolean): void;
  update(): void;
  dispose(): void;
};

export function createBoundsDebug(scene: THREE.Scene): BoundsDebug {
  let avatarTarget: THREE.Object3D | null = null;
  let accessoryTarget: THREE.Object3D | null = null;
  let avatarBox: THREE.Box3 | null = null;
  let accessoryBox: THREE.Box3 | null = null;
  let avatarHelper: THREE.Box3Helper | null = null;
  let accessoryHelper: THREE.Box3Helper | null = null;
  let visible = true;

  function clearHelper(h: THREE.Box3Helper | null) {
    if (!h) return null;
    scene.remove(h);
    (h.geometry as THREE.BufferGeometry).dispose?.();
    (h.material as THREE.Material).dispose?.();
    return null;
  }

  function setAvatar(obj: THREE.Object3D | null) {
    avatarTarget = obj;
    avatarBox = null;
    avatarHelper = clearHelper(avatarHelper);
    if (!obj) return;
    avatarBox = new THREE.Box3();
    avatarHelper = new THREE.Box3Helper(avatarBox, 0x00ff88);
    avatarHelper.visible = visible;
    scene.add(avatarHelper);
    update();
  }

  function setAccessory(obj: THREE.Object3D | null) {
    accessoryTarget = obj;
    accessoryBox = null;
    accessoryHelper = clearHelper(accessoryHelper);
    if (!obj) return;
    accessoryBox = new THREE.Box3();
    accessoryHelper = new THREE.Box3Helper(accessoryBox, 0xffcc66);
    accessoryHelper.visible = visible;
    scene.add(accessoryHelper);
    update();
  }

  function setVisible(next: boolean) {
    visible = next;
    if (avatarHelper) avatarHelper.visible = visible;
    if (accessoryHelper) accessoryHelper.visible = visible;
  }

  function update() {
    if (avatarTarget && avatarBox && avatarHelper) {
      avatarBox.copy(getRenderableBounds(avatarTarget).box);
      avatarHelper.updateMatrixWorld(true);
    }
    if (accessoryTarget && accessoryBox && accessoryHelper) {
      accessoryBox.copy(getRenderableBounds(accessoryTarget).box);
      accessoryHelper.updateMatrixWorld(true);
    }
  }

  function dispose() {
    avatarTarget = null;
    accessoryTarget = null;
    avatarBox = null;
    accessoryBox = null;
    avatarHelper = clearHelper(avatarHelper);
    accessoryHelper = clearHelper(accessoryHelper);
  }

  return { setAvatar, setAccessory, setVisible, update, dispose };
}
