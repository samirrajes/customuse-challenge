import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export type Viewer = ReturnType<typeof createViewer>;

export function createViewer(container: HTMLElement) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1b2430);

  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.05, 200);
  camera.position.set(0, 1.4, 3.2);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x4a5a70, 1.55));
  scene.add(new THREE.AmbientLight(0xffffff, 1));
  const dir = new THREE.DirectionalLight(0xffffff, 1.25);
  dir.position.set(5, 10, 5);
  scene.add(dir);

  const grid = new THREE.GridHelper(10, 10, 0x5b6b81, 0x3d4a5d);
  grid.position.y = 0;
  scene.add(grid);

  function render() {
    controls.update();
    renderer.render(scene, camera);
  }

  function start() {
    const tick = () => {
      requestAnimationFrame(tick);
      render();
    };
    tick();
  }

  function resize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }

  window.addEventListener("resize", resize);

  return { scene, camera, renderer, controls, start, resize };
}
