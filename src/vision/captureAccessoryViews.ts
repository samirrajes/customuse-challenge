// src/vision/captureAccessoryViews.ts
import * as THREE from "three";

export type ViewShot = { name: string; width: number; height: number; rgba: Uint8Array };

/**
 * Step 1 (Option A): Isolated offscreen renders using ORIGINAL materials/textures.
 * - Renders accessory in a hidden scene (no avatar, no bounds debug)
 * - Uses flat-ish lighting (ambient + hemisphere)
 * - Temporarily boosts tone mapping exposure for readability
 * - Centers accessory at origin for stable framing
 */
export function captureAccessoryViewsIsolated(
  renderer: THREE.WebGLRenderer,
  accessory: THREE.Object3D,
  opts?: { size?: number; views?: ("back" | "front" | "left" | "right" | "iso")[] }
): ViewShot[] {
  const size = opts?.size ?? 224;
  const views = opts?.views ?? ["back", "front", "left", "iso"];

  // ---------- Build isolated capture scene ----------
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  // Flat lighting (no shadows; textures should remain visible)
  scene.add(new THREE.AmbientLight(0xffffff, 10.0));
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.9));

  // Clone accessory so we don’t mutate the visible scene object
  const clone = accessory.clone(true);

  // Compute bounds on clone
  clone.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(clone);
  const center = box.getCenter(new THREE.Vector3());
  const extent = box.getSize(new THREE.Vector3());

  // Center clone at origin for stable camera framing
  clone.position.sub(center);
  clone.updateWorldMatrix(true, true);

  scene.add(clone);

  const radius = 0.5 * extent.length();

  // ---------- Offscreen target ----------
  const rt = new THREE.WebGLRenderTarget(size, size, { depthBuffer: true, stencilBuffer: false });
  const cam = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
  cam.up.set(0, 1, 0);

  const pixels = new Uint8Array(size * size * 4);
  const out: ViewShot[] = [];

  const origin = new THREE.Vector3(0, 0, 0);

  // Temporarily adjust renderer settings for the capture (restore afterwards)
  const prev = {
    toneMapping: renderer.toneMapping,
    toneMappingExposure: renderer.toneMappingExposure,
    outputColorSpace: renderer.outputColorSpace,
  };

  // These are safe defaults for making PBR-ish assets readable in small renders
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // Ensure we don't accidentally use shadows in the capture
  const prevShadow = renderer.shadowMap.enabled;
  renderer.shadowMap.enabled = false;

  try {
    for (const v of views) {
      positionCam(cam, v, origin, radius);
      cam.lookAt(origin);

      const prevRT = renderer.getRenderTarget();
      renderer.setRenderTarget(rt);
      renderer.clear(true, true, true);
      renderer.render(scene, cam);
      renderer.readRenderTargetPixels(rt, 0, 0, size, size, pixels);
      renderer.setRenderTarget(prevRT);

      out.push({ name: v, width: size, height: size, rgba: new Uint8Array(pixels) });
    }
  } finally {
    // Restore renderer settings
    renderer.shadowMap.enabled = prevShadow;
    renderer.toneMapping = prev.toneMapping;
    renderer.toneMappingExposure = prev.toneMappingExposure;
    renderer.outputColorSpace = prev.outputColorSpace;

    rt.dispose();
  }

  return out;
}

function positionCam(cam: THREE.PerspectiveCamera, view: string, c: THREE.Vector3, r: number) {
  const dist = (r / Math.tan(THREE.MathUtils.degToRad(cam.fov * 0.5))) * 1.25;

  if (view === "back") cam.position.set(c.x, c.y, c.z - dist);
  else if (view === "front") cam.position.set(c.x, c.y, c.z + dist);
  else if (view === "left") cam.position.set(c.x - dist, c.y, c.z);
  else if (view === "right") cam.position.set(c.x + dist, c.y, c.z);
  else cam.position.set(c.x + dist * 0.8, c.y + dist * 0.35, c.z + dist * 0.8); // iso
}