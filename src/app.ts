// src/app.ts
import * as THREE from "three";

import { createViewer } from "./engine/viewer";
import { disposeObject, getRenderableBounds, isSupported, loadGLTFScene, loadGLTFSceneFromUrl, normalizeToHeight } from "./engine/assets";
import { createBoundsDebug } from "./engine/debug";
import { exportCombinedAvatarAccessoryGLB } from "./engine/exportCombinedGlb";

import { getDom } from "./ui/dom";
import { makeDropZone } from "./ui/dropzone";
import { setPreview } from "./ui/preview";

import {
  scanAnchors,
  createAnchorsDebugGroup,
  disposeAnchorsDebugGroup,
  setAnchorsDebugVisible,
  type FoundAnchor,
} from "./avatar/anchors";
import {
  IMPORTANT_ANCHOR_NAMES,
  buildCanonicalAnchorTemplate,
  synthesizeAnchorsFromTemplate,
  type CanonicalAnchorTemplate,
} from "./avatar/syntheticAnchors";

import { buildAvatarRig, type AvatarRig } from "./avatar/rig";

import { captureAccessoryViewsIsolated, type ViewShot } from "./vision/captureAccessoryViews";
import type { Family } from "./placement/placeByAnchorBandFit";
import { classifyAccessoryIntent } from "./pipeline/intentClassifier";
import { scaleAndPlaceAccessory } from "./pipeline/accessoryPlacement";

type AnchorSetupResult = {
  mode: "real" | "synthetic" | "none";
  count: number;
  error?: string;
};

export class App {
  private autoDownloadDebugShots = false;

  private els = getDom();
  private viewer = createViewer(this.els.wrap);

  private avatar: THREE.Group | null = null;
  private accessory: THREE.Group | null = null;

  private boundsDebug = createBoundsDebug(this.viewer.scene);

  private foundAnchors: FoundAnchor[] = [];
  private anchorsDebug: THREE.Group | null = null;

  private rig: AvatarRig | null = null;
  private canonicalAnchorTemplatePromise: Promise<CanonicalAnchorTemplate> | null = null;

  private anchorUI: {
    wrap: HTMLDivElement;
    header: HTMLDivElement;
    toggle: HTMLInputElement;
    viewsToggle: HTMLInputElement;
    boundsToggle: HTMLInputElement;
    list: HTMLPreElement;
    accessoryInfo: HTMLPreElement;
  } | null = null;

  async init() {
    this.viewer.start();
    this.setStatus("Load an avatar, then an accessory.");

    const tickDebug = () => {
      requestAnimationFrame(tickDebug);
      this.boundsDebug.update();
    };
    tickDebug();

    this.ensureAnchorUI();

    this.els.avatarBrowseBtn.addEventListener("click", () => this.els.avatarInput.click());
    this.els.accessoryBrowseBtn.addEventListener("click", () => this.els.accessoryInput.click());

    this.els.avatarInput.addEventListener("change", async () => {
      const file = this.els.avatarInput.files?.[0];
      if (file) await this.handleAvatarFile(file);
    });

    this.els.accessoryInput.addEventListener("change", async () => {
      const file = this.els.accessoryInput.files?.[0];
      if (file) await this.handleAccessoryFile(file);
    });

    this.els.downloadBtn.addEventListener("click", () => void this.handleDownloadCombined());

    makeDropZone(this.els.avatarDrop, (file) => void this.handleAvatarFile(file));
    makeDropZone(this.els.accessoryDrop, (file) => void this.handleAccessoryFile(file));
    this.updateDownloadButtonState();
  }

  private setStatus(msg: string) {
    this.els.statusEl.textContent = msg;
  }

  private updateDownloadButtonState() {
    this.els.downloadBtn.disabled = !(this.avatar && this.accessory);
  }

  private triggerGlbDownload(buffer: ArrayBuffer, filename: string) {
    const blob = new Blob([buffer], { type: "model/gltf-binary" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  private async handleDownloadCombined() {
    if (!this.avatar || !this.accessory) {
      this.setStatus("Load an avatar and accessory first.");
      return;
    }

    try {
      this.setStatus("Exporting combined GLB…");
      const buffer = await exportCombinedAvatarAccessoryGLB(this.avatar, this.accessory);
      this.triggerGlbDownload(buffer, "combined_avatar_accessory.glb");
      this.setStatus("Combined GLB downloaded.");
    } catch (e) {
      console.error(e);
      this.setStatus("Failed to export combined GLB.");
    }
  }

  private ensureAnchorUI() {
    if (this.anchorUI) return this.anchorUI;

    const wrap = document.createElement("div");
    wrap.style.position = "fixed";
    wrap.style.top = "12px";
    wrap.style.right = "12px";
    wrap.style.width = "560px";
    wrap.style.maxWidth = "calc(100vw - 24px)";
    wrap.style.maxHeight = "calc(100vh - 24px)";
    wrap.style.overflow = "hidden";
    wrap.style.zIndex = "999999";
    wrap.style.pointerEvents = "auto";
    wrap.style.background = "rgba(10,10,12,0.82)";
    wrap.style.border = "1px solid rgba(255,255,255,0.14)";
    wrap.style.borderRadius = "10px";
    wrap.style.backdropFilter = "blur(6px)";
    wrap.style.color = "rgba(255,255,255,0.9)";
    wrap.style.fontFamily =
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";
    wrap.style.fontSize = "12px";
    wrap.style.boxShadow = "0 10px 30px rgba(0,0,0,0.35)";

    const headerRow = document.createElement("div");
    headerRow.style.display = "flex";
    headerRow.style.alignItems = "center";
    headerRow.style.justifyContent = "space-between";
    headerRow.style.padding = "10px 10px 8px 10px";
    headerRow.style.borderBottom = "1px solid rgba(255,255,255,0.10)";

    const title = document.createElement("div");
    title.textContent = "Anchors";
    title.style.fontWeight = "700";

    const togglesWrap = document.createElement("div");
    togglesWrap.style.display = "flex";
    togglesWrap.style.alignItems = "center";
    togglesWrap.style.gap = "12px";

    const toggleRow = document.createElement("label");
    toggleRow.style.display = "flex";
    toggleRow.style.alignItems = "center";
    toggleRow.style.gap = "6px";
    toggleRow.style.userSelect = "none";

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = false;
    toggle.style.transform = "scale(1.05)";
    toggle.style.cursor = "pointer";

    const toggleText = document.createElement("span");
    toggleText.textContent = "anchors";
    toggleText.style.opacity = "0.9";

    toggleRow.appendChild(toggle);
    toggleRow.appendChild(toggleText);

    const viewsToggleRow = document.createElement("label");
    viewsToggleRow.style.display = "flex";
    viewsToggleRow.style.alignItems = "center";
    viewsToggleRow.style.gap = "6px";
    viewsToggleRow.style.userSelect = "none";

    const viewsToggle = document.createElement("input");
    viewsToggle.type = "checkbox";
    viewsToggle.checked = this.autoDownloadDebugShots;
    viewsToggle.style.transform = "scale(1.05)";
    viewsToggle.style.cursor = "pointer";

    const viewsToggleText = document.createElement("span");
    viewsToggleText.textContent = "save views";
    viewsToggleText.style.opacity = "0.9";

    viewsToggleRow.appendChild(viewsToggle);
    viewsToggleRow.appendChild(viewsToggleText);

    const boundsToggleRow = document.createElement("label");
    boundsToggleRow.style.display = "flex";
    boundsToggleRow.style.alignItems = "center";
    boundsToggleRow.style.gap = "6px";
    boundsToggleRow.style.userSelect = "none";

    const boundsToggle = document.createElement("input");
    boundsToggle.type = "checkbox";
    boundsToggle.checked = true;
    boundsToggle.style.transform = "scale(1.05)";
    boundsToggle.style.cursor = "pointer";

    const boundsToggleText = document.createElement("span");
    boundsToggleText.textContent = "bounds";
    boundsToggleText.style.opacity = "0.9";

    boundsToggleRow.appendChild(boundsToggle);
    boundsToggleRow.appendChild(boundsToggleText);

    togglesWrap.appendChild(toggleRow);
    togglesWrap.appendChild(viewsToggleRow);
    togglesWrap.appendChild(boundsToggleRow);

    headerRow.appendChild(title);
    headerRow.appendChild(togglesWrap);

    const list = document.createElement("pre");
    list.style.margin = "0";
    list.style.padding = "10px";
    list.style.maxHeight = "260px";
    list.style.overflow = "auto";
    list.style.whiteSpace = "pre-wrap";
    list.style.overflowWrap = "anywhere";
    list.style.background = "rgba(255,255,255,0.05)";
    list.style.borderTop = "1px solid rgba(255,255,255,0.06)";
    list.textContent = "No avatar loaded.";

    const accessoryInfo = document.createElement("pre");
    accessoryInfo.style.margin = "0";
    accessoryInfo.style.padding = "10px";
    accessoryInfo.style.maxHeight = "320px";
    accessoryInfo.style.overflow = "auto";
    accessoryInfo.style.whiteSpace = "pre-wrap";
    accessoryInfo.style.overflowWrap = "anywhere";
    accessoryInfo.style.background = "rgba(255,255,255,0.05)";
    accessoryInfo.style.borderTop = "1px solid rgba(255,255,255,0.06)";
    accessoryInfo.textContent = "No accessory loaded.";

    wrap.appendChild(headerRow);
    wrap.appendChild(list);
    wrap.appendChild(accessoryInfo);
    document.body.appendChild(wrap);

    toggle.addEventListener("change", () => {
      if (this.anchorsDebug) setAnchorsDebugVisible(this.anchorsDebug, toggle.checked);
    });

    viewsToggle.addEventListener("change", () => {
      this.autoDownloadDebugShots = viewsToggle.checked;
    });

    boundsToggle.addEventListener("change", () => {
      this.boundsDebug.setVisible(boundsToggle.checked);
    });
    this.boundsDebug.setVisible(boundsToggle.checked);

    this.anchorUI = { wrap, header: title, toggle, viewsToggle, boundsToggle, list, accessoryInfo };
    return this.anchorUI;
  }

  private clearRigAll() {
    this.rig = null;
  }

  private clearAnchorsAll() {
    if (this.anchorsDebug) {
      disposeAnchorsDebugGroup(this.anchorsDebug);
      this.viewer.scene.remove(this.anchorsDebug);
      this.anchorsDebug = null;
    }

    this.foundAnchors = [];
    this.clearRigAll();

    const ui = this.ensureAnchorUI();
    ui.toggle.checked = false;
    ui.header.textContent = "Anchors";
    ui.list.textContent = "No avatar loaded.";
    ui.accessoryInfo.textContent = "No accessory loaded.";
  }

  private async getCanonicalAnchorTemplate(): Promise<CanonicalAnchorTemplate> {
    if (this.canonicalAnchorTemplatePromise) return this.canonicalAnchorTemplatePromise;

    this.canonicalAnchorTemplatePromise = (async () => {
      const canonical = await loadGLTFSceneFromUrl("/assets/roblox_male_clean_with_anchors.glb");
      try {
        normalizeToHeight(canonical, 1);
        const { box } = getRenderableBounds(canonical);
        canonical.position.y += -box.min.y;
        canonical.updateWorldMatrix(true, true);
        return buildCanonicalAnchorTemplate(canonical);
      } finally {
        disposeObject(canonical);
      }
    })().catch((err) => {
      this.canonicalAnchorTemplatePromise = null;
      throw err;
    });

    return this.canonicalAnchorTemplatePromise;
  }

  private async scanAndSetupAnchors(): Promise<AnchorSetupResult> {
    if (!this.avatar) return { mode: "none", count: 0, error: "Avatar missing." };
    const ui = this.ensureAnchorUI();

    let mode: AnchorSetupResult["mode"] = "real";
    let error: string | undefined;

    const scanned = scanAnchors(this.avatar, { prefix: "ANCHOR_", caseInsensitive: false });
    let anchors = scanned.anchors;

    if (!anchors.length) {
      try {
        const template = await this.getCanonicalAnchorTemplate();
        anchors = synthesizeAnchorsFromTemplate(this.avatar, template);
        mode = "synthetic";
      } catch (e) {
        mode = "none";
        error = (e as Error)?.message ?? String(e);
        anchors = [];
      }
    }

    this.foundAnchors = anchors;

    if (this.anchorsDebug) {
      disposeAnchorsDebugGroup(this.anchorsDebug);
      this.viewer.scene.remove(this.anchorsDebug);
      this.anchorsDebug = null;
    }

    if (!anchors.length) {
      ui.header.textContent = "Anchors (0)";
      ui.toggle.checked = false;
      ui.list.textContent = error
        ? `No anchors found and canonical fallback failed.\n${error}`
        : "No anchors found (no nodes named ANCHOR_*).";
      return { mode, count: 0, error };
    }

    if (mode === "synthetic") {
      ui.header.textContent = `Anchors (synthetic: ${anchors.length}/${IMPORTANT_ANCHOR_NAMES.length})`;
      ui.list.textContent = `Synthesized ${anchors.length} anchors from canonical avatar:\n` + anchors.map((a) => a.name).join("\n");
    } else {
      ui.header.textContent = `Anchors (${anchors.length})`;
      ui.list.textContent = `Found ${anchors.length} anchors:\n` + anchors.map((a) => a.name).join("\n");
    }

    const dbg = createAnchorsDebugGroup(anchors, {
      sphereRadius: 0.02,
      axesSize: 0.08,
      opacity: 0.9,
    });

    this.viewer.scene.add(dbg);
    this.anchorsDebug = dbg;

    setAnchorsDebugVisible(dbg, ui.toggle.checked);
    return { mode, count: anchors.length, error };
  }

  private buildAndShowRig() {
    const ui = this.ensureAnchorUI();

    this.clearRigAll();
    this.rig = buildAvatarRig(this.foundAnchors);

    if (!this.rig.ok) {
      ui.accessoryInfo.textContent =
        "Rig build failed.\nMissing anchors:\n" + this.rig.missing.map((s) => `- ${s}`).join("\n");
      return;
    }
  }

  private clearAvatarAll() {
    if (this.avatar) {
      this.viewer.scene.remove(this.avatar);
      disposeObject(this.avatar);
      this.avatar = null;
    }
    this.clearAnchorsAll();
    this.boundsDebug.setAvatar(null);
    this.updateDownloadButtonState();
  }

  private clearAccessoryAll() {
    if (this.accessory) {
      this.viewer.scene.remove(this.accessory);
      disposeObject(this.accessory);
      this.accessory = null;
    }
    this.boundsDebug.setAccessory(null);

    const ui = this.ensureAnchorUI();
    ui.accessoryInfo.textContent = "No accessory loaded.";
    this.updateDownloadButtonState();
  }

  private async handleAvatarFile(file: File) {
    if (!isSupported(file)) {
      setPreview("avatar", this.els, file, "Unsupported format", "bad");
      this.setStatus("Avatar must be .glb or .gltf");
      return;
    }

    setPreview("avatar", this.els, file, "Loading…", "idle");
    this.setStatus("Loading avatar…");

    try {
      this.clearAvatarAll();

      this.avatar = await loadGLTFScene(file);

      // normalize to height 1m-ish (your existing convention)
      normalizeToHeight(this.avatar, 1);

      // put feet on ground
      const { box } = getRenderableBounds(this.avatar);
      this.avatar.position.y += -box.min.y;
      this.avatar.updateWorldMatrix(true, true);

      this.viewer.scene.add(this.avatar);
      this.boundsDebug.setAvatar(this.avatar);
      this.updateDownloadButtonState();

      const anchorSetup = await this.scanAndSetupAnchors();
      this.buildAndShowRig();

      setPreview("avatar", this.els, file, "Loaded", "good");
      if (anchorSetup.mode === "synthetic") {
        this.setStatus(`Avatar loaded. No embedded anchors found; synthesized ${anchorSetup.count} canonical anchors.`);
      } else if (anchorSetup.mode === "real") {
        this.setStatus(`Avatar loaded. ${anchorSetup.count} anchors detected.`);
      } else if (anchorSetup.error) {
        this.setStatus("Avatar loaded, but anchors unavailable (canonical fallback failed).");
      } else {
        this.setStatus("Avatar loaded. No anchors found.");
      }
    } catch (e) {
      console.error(e);
      this.clearAvatarAll();
      setPreview("avatar", this.els, file, "Failed to load", "bad");
      this.setStatus("Failed to load avatar.");
    }
  }

  private downloadShotPNG(name: string, shot: { width: number; height: number; rgba: Uint8Array }) {
    const { width, height, rgba } = shot;

    const flipped = new Uint8ClampedArray(rgba.length);
    const row = width * 4;
    for (let y = 0; y < height; y++) {
      const srcOff = (height - 1 - y) * row;
      const dstOff = y * row;
      flipped.set(rgba.subarray(srcOff, srcOff + row), dstOff);
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const imgData = new ImageData(flipped, width, height);
    ctx.putImageData(imgData, 0, 0);

    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `debug_${name}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  }

  private async handleAccessoryFile(file: File) {
    if (!isSupported(file)) {
      setPreview("accessory", this.els, file, "Unsupported format", "bad");
      this.setStatus("Accessory must be .glb or .gltf");
      return;
    }

    if (!this.avatar) {
      setPreview("accessory", this.els, file, "Load avatar first", "bad");
      this.setStatus("Load an avatar first.");
      return;
    }

    setPreview("accessory", this.els, file, "Loading…", "idle");
    this.setStatus("Loading accessory…");

    try {
      this.clearAccessoryAll();

      this.accessory = await loadGLTFScene(file);
      this.viewer.scene.add(this.accessory);
      this.boundsDebug.setAccessory(this.accessory);
      this.updateDownloadButtonState();

      setPreview("accessory", this.els, file, "Loaded", "good");

      const ui = this.ensureAnchorUI();
      const lines: string[] = [];
      let shots: ViewShot[] = [];
      let intent: Awaited<ReturnType<typeof classifyAccessoryIntent>> | null = null;
      let family: Family = "Unknown";

      try {
        shots = captureAccessoryViewsIsolated(this.viewer.renderer, this.accessory, {
          size: 224,
          views: ["back", "front", "left", "iso"],
        });

        if (this.autoDownloadDebugShots) {
          for (const s of shots) this.downloadShotPNG(s.name, s);
        }
      } catch (e) {
        console.error(e);
        lines.push("View capture ❌ failed");
        lines.push(`- ${(e as any)?.message ?? String(e)}`);
      }

      try {
        if (!shots.length) throw new Error("No captured views available");
        intent = await classifyAccessoryIntent(shots);
        family = intent.family;
        lines.push(...intent.lines);
      } catch (e) {
        console.error(e);
        lines.push("Step 3 ❌ CLIP intent scoring failed");
        lines.push(`- ${(e as any)?.message ?? String(e)}`);
      }

      if (intent) {
        lines.push("");
        try {
          if (!this.rig?.ok) throw new Error("Rig not ready");
          if (!this.accessory) throw new Error("Accessory missing");
          if (!this.avatar) throw new Error("Avatar missing");
          if (!this.foundAnchors.length) throw new Error("No anchors scanned from avatar");

          const placement = scaleAndPlaceAccessory(
            this.accessory,
            this.avatar,
            this.foundAnchors,
            this.rig,
            intent.family,
            intent.attrs
          );

          family = placement.family;
          lines.push(...placement.lines);
        } catch (e) {
          console.error(e);
          lines.push("Step 4 ❌ scale + anchor placement failed");
          lines.push(`- ${(e as any)?.message ?? String(e)}`);
        }
      }

      ui.accessoryInfo.textContent = lines.join("\n");
      this.setStatus(`Accessory loaded. family=${family}`);
    } catch (e) {
      console.error(e);
      this.boundsDebug.setAccessory(null);
      setPreview("accessory", this.els, file, "Failed to load", "bad");
      this.setStatus("Failed to load accessory.");

      const ui = this.ensureAnchorUI();
      ui.accessoryInfo.textContent = "Failed to load accessory.";
    }
  }
}
