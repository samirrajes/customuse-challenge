// src/vision/sendToClipServer.ts
import type { ClipPrompt, ClipResult } from "./clipPrompts";

export async function classifyWithServer(
  rgba: Uint8Array,
  width: number,
  height: number,
  prompts: ClipPrompt[]
): Promise<ClipResult[]> {
  // Convert RGBA → PNG base64
  const flipped = flipY(rgba, width, height);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d")!;
  ctx.putImageData(new ImageData(flipped, width, height), 0, 0);

  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
  const base64 = await blobToBase64(blob);

  const response = await fetch("http://localhost:3001/classify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      imageBase64: base64,
      prompts,
      labels: prompts.map((p) => p.text),
      ids: prompts.map((p) => p.id),
    }),
  });

  const json = await response.json();

  // A) { results: [{id, score}] }
  if (Array.isArray(json?.results)) {
    return (json.results as any[]).map((r) => ({ id: String(r.id), score: Number(r.score) }));
  }

  // B) [{label, score}] (old) — map by prompt order
  if (Array.isArray(json)) {
    const byText = new Map<string, number>();
    for (const r of json as any[]) byText.set(String(r.label), Number(r.score));
    return prompts.map((p) => ({ id: p.id, score: byText.get(p.text) ?? 0 }));
  }

  throw new Error("Unexpected CLIP server response shape");
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      resolve(dataUrl.split(",")[1]); // remove data:image/png;base64,
    };
    reader.readAsDataURL(blob);
  });
}

function flipY(rgba: Uint8Array, width: number, height: number) {
  const flipped = new Uint8ClampedArray(rgba.length);
  const row = width * 4;
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * row;
    const dst = y * row;
    flipped.set(rgba.subarray(src, src + row), dst);
  }
  return flipped;
}