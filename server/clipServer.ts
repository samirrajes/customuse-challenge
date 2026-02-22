// server/clipServer.ts
import express from "express";
import bodyParser from "body-parser";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import cors from "cors";
import { pipeline } from "@xenova/transformers";

type Prompt = { id: string; text: string };

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "20mb" }));

let classifier: any = null;

// -----------------------------
// Load CLIP model once at startup
// -----------------------------
async function loadModel() {
  console.log("Loading CLIP model (server-side)...");
  classifier = await pipeline("zero-shot-image-classification", "Xenova/clip-vit-base-patch32");
  console.log("CLIP ready.");
}

// -----------------------------
// Helpers
// -----------------------------
function makeTmpPngPath() {
  const name = `clip_${Date.now()}_${crypto.randomBytes(8).toString("hex")}.png`;
  return path.join(os.tmpdir(), name);
}

function coercePrompts(body: any): { prompts: Prompt[]; labels: string[] } {
  // Preferred: prompts: [{id,text}]
  if (Array.isArray(body?.prompts) && body.prompts.length) {
    const prompts: Prompt[] = body.prompts
      .map((p: any) => ({
        id: String(p?.id ?? ""),
        text: String(p?.text ?? ""),
      }))
      .filter((p: Prompt) => p.id && p.text);

    if (!prompts.length) throw new Error("`prompts` provided but empty/invalid");

    return { prompts, labels: prompts.map((p) => p.text) };
  }

  // Back-compat: labels: string[] (+ optional ids: string[])
  if (Array.isArray(body?.labels) && body.labels.length) {
    const labels: string[] = body.labels.map((s: any) => String(s));
    const ids: string[] | null = Array.isArray(body?.ids) && body.ids.length ? body.ids.map((s: any) => String(s)) : null;

    const prompts: Prompt[] = labels.map((text, i) => ({
      id: ids?.[i] ?? `label/${i}`,
      text,
    }));

    return { prompts, labels };
  }

  throw new Error("Missing `prompts` (preferred) or `labels` (back-compat).");
}

// -----------------------------
// Classification endpoint
// -----------------------------
app.post("/classify", async (req, res) => {
  const tmpPath = makeTmpPngPath();

  try {
    if (!classifier) {
      return res.status(503).json({ error: "CLIP model not loaded yet" });
    }

    const { imageBase64 } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ error: "Missing imageBase64" });
    }

    const { prompts, labels } = coercePrompts(req.body);

    // Decode base64 → Buffer → temp PNG (avoids any loader edge cases)
    const buffer = Buffer.from(imageBase64, "base64");
    fs.writeFileSync(tmpPath, buffer);

    // Ask CLIP to score ALL candidate labels
    // (top_k ensures you get all candidates back consistently)
    const result = await classifier(tmpPath, labels, { top_k: labels.length });

    // result shape (Xenova): [{ label: string, score: number }, ...]
    // We map back to prompt IDs by label text.
    const byText = new Map<string, Prompt>();
    for (const p of prompts) byText.set(p.text, p);

    const results = (Array.isArray(result) ? result : [])
      .map((r: any) => {
        const text = String(r?.label ?? "");
        const score = Number(r?.score ?? 0);
        const p = byText.get(text);
        return {
          id: p?.id ?? `label/unknown`,
          text,
          score: Number.isFinite(score) ? score : 0,
        };
      })
      .sort((a: any, b: any) => b.score - a.score);

    // Return a stable, structured response
    return res.json({
      results,
      meta: {
        model: "Xenova/clip-vit-base-patch32",
        numPrompts: prompts.length,
        // NOTE: scores from this pipeline are softmax-normalized over candidates
        // (so they sum ~1 over all candidates provided).
        normalized: true,
      },
    });
  } catch (err) {
    console.error("========== CLASSIFY ERROR ==========");
    console.error(err);
    console.error("====================================");
    return res.status(500).json({ error: String(err) });
  } finally {
    // Cleanup temp file (best-effort)
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
  }
});

// -----------------------------
// Start server
// -----------------------------
loadModel().then(() => {
  app.listen(3001, () => {
    console.log("CLIP server running on http://localhost:3001");
  });
});