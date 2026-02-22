// src/vision/clipPrompts.ts
export type ClipPrompt = { id: string; text: string };
export type ClipResult = { id: string; score: number };

export const FAMILY_PROMPTS: ClipPrompt[] = [
  {
    id: "family/StrapHarness",
    text: "a wearable torso item with shoulder straps or harness bands, like a tactical vest, chest rig, or backpack harness",
  },
  { id: "family/Drape", text: "a cloth garment draped from the shoulders down the back like a cape or cloak" },
  { id: "family/PairedMount", text: "a pair of symmetric attachments mounted on the upper back like wings" },
  {
    id: "family/SurfaceMount",
    text: "a rigid object mounted close and flush to the back surface, like a shield or plate",
  },
  {
    id: "family/RigidStow",
    text: "a rigid stowed back item, often long or diagonal, like a sword, bow, guitar, or staff",
  },
  { id: "family/HingeTail", text: "an object hinged at the lower back that trails behind like a tail" },
];

export const ATTR_PROMPTS: ClipPrompt[] = [
  { id: "attr/HasStraps", text: "the object has visible shoulder straps, belts, loops, or harness bands" },
  { id: "attr/LooksCloth", text: "the object is flexible cloth fabric" },
  { id: "attr/TwoSymmetric", text: "the object has two symmetric protrusions" },
  { id: "attr/FlatPlate", text: "the object is wide and flat like a plate" },
  { id: "attr/LongRigid", text: "the object is long and rigid like a weapon or instrument" },
  { id: "attr/HangsDown", text: "the object hangs down behind the body" },
  { id: "attr/BulkyPack", text: "the object is bulky like a bag or pack worn close to the back" },
];

export const ALL_PROMPTS: ClipPrompt[] = [...FAMILY_PROMPTS, ...ATTR_PROMPTS];

export function isFamilyId(id: string) {
  return id.startsWith("family/");
}
export function isAttrId(id: string) {
  return id.startsWith("attr/");
}
export function shortId(id: string) {
  const i = id.indexOf("/");
  return i >= 0 ? id.slice(i + 1) : id;
}
