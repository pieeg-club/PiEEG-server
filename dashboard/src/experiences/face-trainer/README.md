# Face Trainer

Placement-agnostic facial-EMG → ARKit blendshapes, in the browser.

## What it is

Wear 8 electrodes anywhere on the face (frontal / temporal / cheek / peri-orbital — order doesn't matter). For each expression you train, the avatar shows you the target motion, you record a handful of reps mimicking it, and a per-expression detector learns the spatial pattern your particular placement produces. The avatar is three.js's [facecap.glb](https://threejs.org/examples/?q=morph#webgl_morphtargets_face) with 52 ARKit blendshapes.

## Why this composition

| | Avatar Foundation | Face Trainer (this) |
|---|---|---|
| Signal | EEG spectral log-power | Time-domain facial-EMG features |
| Granularity | One link per (channel × band) | Full 8-channel pattern |
| Training | Two-state contrastive (Cohen's d) | Supervised mimicry, multi-rep |
| Quality metric | Within-session Cohen's d | Leave-one-rep-out balanced accuracy |
| Model | Linear univariate map | Per-expression L2 logistic regression |
| Placement | Per-channel manual choice | Agnostic — model learns the pattern |
| Best for | Slow emotional states | Discrete facial actions |

Foundation answers "*can this electrode and band drive this expression?*". Face Trainer answers "*regardless of where my 8 electrodes are, can the system reliably tell when I'm making this expression?*". They're complementary.

## Pipeline

1. **Feature extraction** ([features.ts](./features.ts)) — 200 ms sliding window per channel:
   - log RMS, log variance, log line-length, zero-crossing rate, log high-band RMS
   - → 5 features × 8 channels = **40-D feature vector**, sampled at 12 Hz during recording
2. **Per-expression detector** ([detector.ts](./detector.ts)) — one model per expression:
   - L2-regularised logistic regression, class-balanced, fit with Adam (λ = 1.0)
   - Standardiser (μ, σ) fit on the training set at fit time
3. **Honest readiness score** — after every recorded rep:
   - **Leave-one-rep-out cross-validation** (the rep is the split unit, not the sample, to avoid temporal leakage)
   - Score reported is **balanced accuracy** (mean of sensitivity & specificity), so the ~24-pos / ~36-neg class imbalance can't inflate the number
   - Colour bar: red < 0.70 (weak) ≤ yellow < 0.85 (improving) ≤ green (ready)
4. **Live prediction** — every animation frame, each detector outputs a posterior probability; in Try mode it drives one expression, in Free Mode every detector with CV ≥ 0.70 runs in parallel and additively drives its blendshape group.

All detectors persist to `localStorage` per expression id and restore on next session.

## The training loop (per expression)

```
[ Show ] → avatar plays the expression (you watch)
[ Record Rep ] → 3 s countdown
              → 1.5 s rest    (negative samples)
              → 0.6 s ramp up (cue only)
              → 2.0 s HOLD    (positive samples — you mimic at peak)
              → 0.6 s ramp down
              → 1.5 s rest    (negative samples)
              → readiness bar updates
Repeat 6 times for a full rep set.
[ Try ] → live posterior drives the avatar
```

## Expression catalog

Intentionally short and biased toward expressions an arbitrary 8-electrode placement can decode (large-muscle, large-amplitude actions): jaw open, smile, raise brows, furrow brow, hard blink, wink L/R, pucker. Each card shows an anatomy note so you understand *why* it should (or might not) work for your placement.

## Why not TensorFlow.js?

For sEMG-style features at the data scale of this UI (~300 samples per detector after 6 reps), regularised linear classifiers consistently match or beat deep nets while remaining fast (< 5 ms to fit), interpretable, and trivially cross-validatable. See Phinyomark et al. 2018 (Sensors 18(5)) for a survey. Adding TFJS would mean ~1 MB of bundle for no decoding gain.

## Files

- `FaceTrainer.tsx` — three.js scene, recording state machine, per-card UI
- `features.ts` — feature extractor + Welford standardiser
- `detector.ts` — L2 logistic regression + leave-one-rep-out CV
- `prompts.ts` — expression catalog + rep-timeline state machine

## Assets

`facecap.glb` is loaded directly from the official three.js CDN — `https://threejs.org/examples/models/gltf/facecap.glb` — using KTX2 + Meshopt. No local copy required.
