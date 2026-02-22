# Customuse Back-Accessory Placement Engineering Challenge

## How To Run

### Dependencies
- Node.js `24+`
- npm `11+`

```bash
npm install
```

Terminal 1:

```bash
node server/clipServer.ts
```

Terminal 2:

```bash
npm run dev
```

Then open the local Vite URL (usually `http://localhost:5173`), load an avatar, then load an accessory.

---

## System Algorithms

## 1) Anchor Algorithm

When an avatar already has anchors, we use them directly.
When an avatar has no anchors, we transfer anchors from a canonical Roblox male template.

### Anchor source selection

| Condition | Action |
| --- | --- |
| Avatar contains `ANCHOR_*` nodes | Use scanned anchors directly |
| Avatar has no `ANCHOR_*` nodes | Synthesize anchors from canonical template |

### Canonical anchor transfer algorithm (for unseen avatars)

Canonical template used: `public/assets/roblox_male_clean_with_anchors.glb`

1. Normalize canonical template and target avatar to the same scale convention.
2. Read canonical anchor world positions.
3. Convert each canonical anchor to normalized box coordinates (`uvw`) in canonical bounds.
4. Map each `uvw` point into target avatar bounds to get an initial anchor estimate.
5. For surface anchors (back/front/shoulders/waist), raycast around the estimate and snap to nearest valid surface hit.
6. Add synthesized `ANCHOR_*` objects to the target avatar.
7. Build torso frames (`shoulderLine`, `midBack`, `lowerBack`) from the final anchor set.

### Assumptions for canonical anchor transfer

- Target avatar is Roblox-like.
- Target avatar is in the same neutral pose as canonical male.
- Avatar is upright with `+Y` up.
- Avatar uses the same standard orientation as canonical male (facing the camera in viewer setup).
- Body proportions are within the range where box-relative transfer is meaningful.

add images here

---

## 2) Accessory Classification (CLIP Pipeline)

We classify each accessory using lightweight CLIP on offscreen renders, then combine view-level evidence.

### Offscreen render strategy

| Item | Value |
| --- | --- |
| Render type | Isolated accessory-only scene |
| Resolution | `224 x 224` |
| Views | `back`, `front`, `left`, `iso` |
| Model | `Xenova/clip-vit-base-patch32` |
| Endpoint | `POST /classify` on local server |

add images here.

### Category structure

We use two parallel prompt sets:
- family prompts (coarse intent class)
- attribute prompts (shape/material cues)

### Family prompts

| Family ID | Meaning |
| --- | --- |
| `StrapHarness` | torso-worn item with straps/harness behavior |
| `Drape` | cloth-like drape from shoulders/back |
| `PairedMount` | symmetric pair mounted on upper back (e.g. wings) |
| `SurfaceMount` | rigid flush mount against back surface |
| `RigidStow` | rigid stowed object (often long/diagonal) |
| `HingeTail` | lower-back hinged trailing object |

### Attribute prompts

| Attribute ID | Cue |
| --- | --- |
| `HasStraps` | visible straps/loops/harness |
| `LooksCloth` | cloth/fabric appearance |
| `TwoSymmetric` | two symmetric protrusions |
| `FlatPlate` | broad flat plate-like geometry |
| `LongRigid` | long rigid object |
| `HangsDown` | hangs downward from mount |
| `BulkyPack` | bulky pack-like volume |

### Scoring + decision flow

1. Run CLIP for each view against all family + attribute prompts.
2. Compute per-view confidence weight from top-1 vs top-2 margin.
3. Aggregate weighted family and attribute scores across views.
4. Apply rescoring/tie-break heuristics (e.g. vest-like or backpack-like priors).
5. Output final family used by scaling and placement.

---

## 3) Applying Classification To Placement

After classification, placement runs in two steps.

## Step A: Scaling (simple policy)

Uniform-only scaling, one target dimension per family.

| Family | Matched accessory dimension | Target avatar measurement |
| --- | --- | --- |
| `RigidStow` | max dimension | `0.65 * avatarHeight` |
| `Drape` | height | shoulder-to-ground span (+ margin) |
| `PairedMount` | width | `avatarHeight` |
| `StrapHarness` | height | torso height |
| `SurfaceMount` | width | shoulder width |
| `HingeTail` | unchanged | identity scale |

## Step B: Geometry analysis + orientation + placement

### Geometry analysis

From accessory vertices we compute:
- AABB size/center/percentiles
- PCA axes (`major`, `mid`, `minor`) + eigenvalues
- flatness / elongation / thickness
- mount-face estimate for rigid/flush classes

### Orientation and position solve

1. Pick target rig frame based on family.
2. Pick family-specific attach band on accessory.
3. Evaluate discrete yaw candidates.
4. For each yaw, solve back offset using torso depth proxy and quantile fitting.
5. Score candidate by penetration/contact/alignment terms.
6. Choose best candidate, then apply small family-specific post adjustments.

### Current hard constraints

- `+Y` is upright.
- Rotation search is quarter turns only (`0/90/180/270`, with a reduced set for some families).

---

## Future Work

1. Add a shift refinement pass to actively minimize clipping and floating after initial placement.
2. Add a placement confidence score from combined signals (classification certainty + geometric fit quality).
3. If confidence is low, trigger guided user tuning instead of auto-accepting placement.
4. Expand orientation search beyond quarter turns to continuous optimization.
5. Add data-driven calibration of family tie-break weights from labeled placement outcomes.
6. Add benchmark/test scenes with quantitative metrics for regression tracking.

---

## Other Methods Tried

I also tried direct geometric avatar segmentation (without relying on robust anchors):
- detect back surface directly from mesh normals/curvature
- split avatar into head / upper torso / lower torso / waist bands
- derive placement frames from those estimated regions

### What happened

| Method | Human-like bodies | Roblox bodies | Why |
| --- | --- | --- | --- |
| Back extraction from smooth torso geometry | Worked reasonably | Unstable | blockier topology and stylized proportions reduce geometric signal quality |
| Region segmentation by anatomical proportions | Worked reasonably | Often failed | canonical human ratios do not map cleanly to Roblox body layouts |
| Frame derivation from mesh-only cues | Sometimes usable | Noisy | missing stable landmarks caused frame drift and orientation errors |

In short: these geometry-only methods were promising on realistic human meshes, but brittle on Roblox-style avatars.
That is why this version prioritizes anchor-driven rig frames plus CLIP-assisted accessory intent classification.

add images here.
