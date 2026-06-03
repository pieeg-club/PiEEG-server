# Face Trainer

Placement-agnostic facial-EMG → 52 ARKit blendshapes, in the browser.

## What it is

Wear 8 electrodes anywhere on the face (frontal / temporal / cheek / mastoid — order doesn't matter). The avatar walks you through a mimicry carousel of 13 expressions; you mimic each one at peak intensity. A closed-form multi-output ridge regression learns the full spatial pattern across all 8 channels and maps it to the 52 ARKit blendshape weights of three.js's [facecap.glb](https://threejs.org/examples/?q=morph#webgl_morphtargets_face) model — all expressions decoded simultaneously, in a single linear model.

## Why this composition

| | Avatar Foundation | Face Trainer (this) |
|---|---|---|
| Features | EEG spectral log-power | Time-domain fEMG features |
| Granularity | One link per (channel × band) | Full 8-channel pattern |
| Output | One expression at a time | All 52 ARKit blendshapes at once |
| Calibration | Two-state contrastive (Cohen's d) | Supervised mimicry (R² per shape) |
| Speed | Slow emotional states | ~33 ms latency, transient |
| Placement | Per-channel manual choice | Agnostic — model learns the pattern |

Foundation answers "*can this electrode and band drive this expression?*". Face Trainer answers "*given any placement of 8 sensors, what is every shape my face is making right now?*". They're complementary.

## Pipeline

1. **Feature extraction** (200 ms sliding window per channel, 8 channels):
   - log RMS, log variance, log line-length, zero-crossing rate, log high-band RMS
   - → 5 features × 8 channels = **40-D feature vector**
2. **Standardisation**: Welford-online z-score (μ, σ frozen at fit time).
3. **Ridge regression**: `W = (XᵀX + λI)⁻¹ XᵀY`, λ = 5, Cholesky-solved.
4. **Free mode**: every animation frame → predict → clamp → EMA smooth → write to `head.morphTargetInfluences`.

Model + standardiser saved to `localStorage` and restored on next session.

## Files

- `FaceTrainer.tsx` — scene, mimicry loop, free-mode driver, UI
- `features.ts` — feature extractor + Welford standardiser
- `ridge.ts` — closed-form multi-output ridge with Cholesky solver
- `prompts.ts` — the 13-expression mimicry carousel

## Assets

The component loads `facecap.glb` from `/facecap.glb` first, then falls back to the official three.js CDN at `https://threejs.org/examples/models/gltf/facecap.glb`. The model uses KTX2 + Meshopt; the transcoder is loaded from the threejs.org CDN. To self-host, drop the GLB at `dashboard/public/facecap.glb`.
