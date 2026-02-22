import type { AttrScores, Family } from "../placement/placeByAnchorBandFit";
import type { ViewShot } from "../vision/captureAccessoryViews";
import { ALL_PROMPTS, isAttrId, isFamilyId, shortId, type ClipResult } from "../vision/clipPrompts";
import { classifyWithServer } from "../vision/sendToClipServer";

export type IntentClassificationResult = {
  family: Family;
  aggFamily: ClipResult[];
  aggAttr: ClipResult[];
  attrs: AttrScores;
  notes: string[];
  lines: string[];
};

export async function classifyAccessoryIntent(shots: ViewShot[]): Promise<IntentClassificationResult> {
  if (!shots.length) throw new Error("No captured views");

  const perView: { view: string; results: ClipResult[] }[] = [];
  for (const s of shots) {
    const res = await classifyWithServer(s.rgba, s.width, s.height, ALL_PROMPTS);
    perView.push({ view: s.name, results: res });
  }

  const perViewFamily = perView.map((pv) => ({
    view: pv.view,
    results: pv.results.filter((r) => isFamilyId(r.id)),
  }));

  const perViewAttr = perView.map((pv) => ({
    view: pv.view,
    results: pv.results.filter((r) => isAttrId(r.id)),
  }));

  const weightsByView: Record<string, number> = {};
  for (const pv of perViewFamily) {
    const sorted = [...pv.results].sort((a, b) => b.score - a.score);
    weightsByView[pv.view] = viewWeightFromMargin(sorted.map((x) => x.score));
  }

  const aggFamily = aggregateWeighted(perViewFamily, weightsByView);
  const aggAttr = aggregateWeighted(perViewAttr, weightsByView);

  const pick = pickFamilyWithEvidence(aggFamily, aggAttr);
  const family = pick.family;
  const attrs = buildAttrs(aggAttr);

  const lines: string[] = [];
  lines.push("Step 3 ✅ CLIP intent scoring (family + attributes)");
  lines.push("");
  lines.push("Aggregated family (weighted) top-6:");
  for (const r of aggFamily.slice(0, 6)) lines.push(`- ${shortId(r.id)}  ${(r.score * 100).toFixed(1)}%`);
  lines.push("");
  lines.push("Aggregated attributes (weighted) top-7:");
  for (const r of aggAttr.slice(0, 7)) lines.push(`- ${shortId(r.id)}  ${(r.score * 100).toFixed(1)}%`);
  lines.push("");
  lines.push(`Final family: ${family}`);
  lines.push("Notes:");
  for (const n of pick.notes) lines.push(`- ${n}`);

  return {
    family,
    aggFamily,
    aggAttr,
    attrs,
    notes: pick.notes,
    lines,
  };
}

function buildAttrs(aggAttr: ClipResult[]): AttrScores {
  const attr = (id: string) => aggAttr.find((x) => x.id === `attr/${id}`)?.score ?? 0;
  return {
    HasStraps: attr("HasStraps"),
    LooksCloth: attr("LooksCloth"),
    TwoSymmetric: attr("TwoSymmetric"),
    FlatPlate: attr("FlatPlate"),
    LongRigid: attr("LongRigid"),
    HangsDown: attr("HangsDown"),
    BulkyPack: attr("BulkyPack"),
  };
}

function viewWeightFromMargin(sortedScoresDesc: number[]) {
  const s1 = sortedScoresDesc[0] ?? 0;
  const s2 = sortedScoresDesc[1] ?? 0;
  const margin = Math.max(0, s1 - s2);
  return 0.35 + 0.65 * Math.min(1, margin / 0.4);
}

function aggregateWeighted(
  perView: { view: string; results: ClipResult[] }[],
  weightsByView: Record<string, number>
): ClipResult[] {
  const agg: Record<string, number> = {};
  let wsum = 0;

  for (const pv of perView) {
    const w = weightsByView[pv.view] ?? 1;
    wsum += w;
    for (const r of pv.results) agg[r.id] = (agg[r.id] ?? 0) + w * r.score;
  }

  const out: ClipResult[] = Object.entries(agg).map(([id, score]) => ({
    id,
    score: score / Math.max(1e-6, wsum),
  }));

  out.sort((a, b) => b.score - a.score);
  return out;
}

function pickFamilyWithEvidence(
  aggFamily: ClipResult[],
  aggAttr: ClipResult[]
): { family: Family; notes: string[] } {
  const notes: string[] = [];

  const fam = (id: Family) => aggFamily.find((x) => x.id === `family/${id}`)?.score ?? 0;
  const attr = (id: string) => aggAttr.find((x) => x.id === `attr/${id}`)?.score ?? 0;

  const hasStraps = attr("HasStraps");
  const bulkyPack = attr("BulkyPack");
  const longRigid = attr("LongRigid");
  const looksCloth = attr("LooksCloth");
  const twoSym = attr("TwoSymmetric");
  const flatPlate = attr("FlatPlate");
  const hangsDown = attr("HangsDown");

  const votes: Record<Family, number> = {
    StrapHarness: fam("StrapHarness"),
    Drape: fam("Drape"),
    PairedMount: fam("PairedMount"),
    SurfaceMount: fam("SurfaceMount"),
    RigidStow: fam("RigidStow"),
    HingeTail: fam("HingeTail"),
    Unknown: 0,
  };

  votes.StrapHarness += 0.65 * hasStraps + 0.55 * bulkyPack - 0.25 * flatPlate;
  votes.Drape += 0.85 * looksCloth + 0.35 * hangsDown - 0.35 * longRigid;
  votes.PairedMount += 0.75 * twoSym - 0.2 * bulkyPack;
  votes.SurfaceMount += 0.7 * flatPlate + 0.55 * flatPlate + 0.3 * twoSym - 0.2 * hangsDown - 0.25 * longRigid;
  votes.RigidStow +=
    0.9 * longRigid +
    0.95 * longRigid -
    0.45 * flatPlate -
    0.25 * twoSym -
    0.2 * hasStraps -
    0.2 * looksCloth -
    0.15 * bulkyPack;
  votes.HingeTail += 0.9 * hangsDown - 0.15 * flatPlate;

  if (longRigid < 0.12 && flatPlate >= 0.03) {
    votes.RigidStow *= 0.72;
    notes.push("rigid damp: low LongRigid + plate cues -> suppress RigidStow");
  }

  const vestLike =
    hasStraps >= 0.11 &&
    flatPlate >= 0.06 &&
    longRigid <= 0.16 &&
    hangsDown <= 0.14 &&
    twoSym <= 0.35;
  if (vestLike) {
    votes.StrapHarness += 0.28 + 0.45 * hasStraps + 0.2 * flatPlate;
    votes.SurfaceMount -= 0.18 + 0.25 * hasStraps;
    notes.push("vest prior: strap+plate wearable cues -> boost StrapHarness over SurfaceMount");
  }

  if (bulkyPack >= 0.12 && hasStraps >= 0.1 && twoSym <= 0.2) {
    votes.PairedMount -= 0.2;
    votes.StrapHarness += 0.25;
    notes.push("paired suppression: strong backpack cues -> boost StrapHarness");
  }

  const rawTop = aggFamily[0] ?? { id: "family/Unknown", score: 0 };
  const rawBest = (shortId(rawTop.id) as Family) || "Unknown";

  const sortedVotes = (Object.keys(votes) as Family[])
    .filter((k) => k !== "Unknown")
    .map((k) => ({ k, v: votes[k] }))
    .sort((a, b) => b.v - a.v);

  const best = sortedVotes[0];
  const second = sortedVotes[1];
  const delta = (best?.v ?? 0) - (second?.v ?? 0);

  const overrideMin = vestLike ? 0.04 : 0.08;
  let finalFamily: Family = rawBest;

  const vestTieBreak =
    rawBest === "SurfaceMount" &&
    hasStraps >= 0.12 &&
    flatPlate >= 0.06 &&
    longRigid <= 0.16 &&
    votes.StrapHarness >= votes.SurfaceMount - 0.05;

  if (vestTieBreak) {
    finalFamily = "StrapHarness";
    notes.push("vest tie-break: SurfaceMount near-tie with strong strap cues -> StrapHarness");
  } else if (best && best.k !== rawBest && delta > overrideMin) {
    finalFamily = best.k;
    notes.push(`rescored override: ${rawBest} → ${finalFamily} (Δ=${delta.toFixed(3)})`);
  } else {
    finalFamily = rawBest;
    notes.push(`rescored keep: ${finalFamily} (Δ=${delta.toFixed(3)})`);
  }

  notes.push(
    `attrs: LongRigid=${longRigid.toFixed(3)} HasStraps=${hasStraps.toFixed(3)} BulkyPack=${bulkyPack.toFixed(
      3
    )} LooksCloth=${looksCloth.toFixed(3)} TwoSym=${twoSym.toFixed(3)} FlatPlate=${flatPlate.toFixed(
      3
    )} HangsDown=${hangsDown.toFixed(3)}`
  );

  return { family: finalFamily, notes };
}
