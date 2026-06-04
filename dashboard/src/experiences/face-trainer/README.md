# Face Trainer

Placement-agnostic facial-EMG → ARKit blendshapes, in the browser.

## What it is

Wear 8 electrodes anywhere on the face (frontal / temporal / cheek / peri-orbital — order doesn't matter). For each expression you train, the avatar shows you the target motion, you record a handful of reps mimicking it, and a per-expression detector learns the spatial pattern your particular placement produces. The avatar is three.js's [facecap.glb](https://threejs.org/examples/?q=morph#webgl_morphtargets_face) with 52 ARKit blendshapes.

## Why this composition

| | Avatar Foundation | Face Trainer (this) |
|---|---|---|
| Signal | EEG spectral log-power | Time-domain facial-EMG features (post-CAR) |
| Granularity | One link per (channel × band) | Full 8-channel pattern |
| Training | Two-state contrastive (Cohen's d) | Supervised mimicry, multi-rep |
| Quality metric | Within-session Cohen's d | Leave-one-rep-out balanced accuracy |
| Model | Linear univariate map | Per-expression L2 + group-lasso logistic |
| Placement | Per-channel manual choice | Agnostic — model learns *and exposes* which channels matter |
| Best for | Slow emotional states | Discrete facial actions |

Foundation answers "*can this electrode and band drive this expression?*". Face Trainer answers "*regardless of where my 8 electrodes are, can the system reliably tell when I'm making this expression?*". They're complementary.

## Pipeline

1. **Common-Average Reference** ([features.ts](./features.ts)) — on every 200 ms window we subtract the per-sample mean across the 8 channels. Anything common to all electrodes (line hum, broadband motion, reference drift) cancels; what's left is what *differs* between electrodes, which is what spatial decoding needs.
2. **Feature extraction** — per channel, 5 features:
   - log RMS, log variance, log line-length, slope-sign-change rate (Hudgins SSC with a 1 ms deadband), log high-band RMS
   - → 5 features × 8 channels = **40-D feature vector**, sampled at 12 Hz during recording
   - Stored layout matters: indices 0–4 are channel 1, 5–9 channel 2, … — these channel-blocks are the "groups" the regulariser sees
3. **Per-expression detector** ([detector.ts](./detector.ts)) — one binary classifier per expression:

   $$ \mathcal{L}(w, b) = \tfrac{1}{N}\sum_n \text{CE}(y_n, \sigma(w^\top x_n + b)) + \tfrac{\lambda_2}{2N}\lVert w \rVert_2^2 + \lambda_g \sum_{c=1}^{8} \lVert w_c \rVert_2 $$

   - **Ridge** ($\lambda_2 = 1.0$) keeps individual weights small and well-conditioned
   - **Group-lasso** ($\lambda_g = 0.3$) sums the L2 norm of each *channel-block*; the L1-over-blocks drives whole channels to **exactly zero** when they don't earn their keep
   - Optimised by Adam on the smooth part + block soft-threshold prox on the group-lasso term, threshold $\tau = \lambda_g \cdot lr / \sqrt{N}$ (auto-scales with rep count)
   - Class-balanced; standardiser ($\mu, \sigma$) fit on the training fold only
4. **Honest readiness score** — after every recorded rep:
   - **Leave-one-rep-out cross-validation** (the rep is the split unit, not the sample, to avoid temporal leakage)
   - Score reported is **balanced accuracy** (mean of sensitivity & specificity), so neither class can game the number even though they're already near-balanced (~24 pos / ~26 neg per rep)
   - Colour bar: red < 0.70 (weak) ≤ yellow < 0.85 (improving) ≤ green (ready)
5. **Channel-importance bar** — each card shows 8 cells, one per electrode. Brightness = $\lVert w_c \rVert_2$ normalised across channels. Dark cells were zeroed by group-lasso — the model is literally telling you which electrodes carry the signal for *this* expression. The first real debugging tool for placement-agnostic decoding: if Wink Left's bar shows no left-lateral electrode, you know *why* the detector won't train.
6. **Live prediction** — every animation frame, each detector outputs a posterior probability; in Try mode it drives one expression, in Free Mode every detector with CV ≥ 0.70 runs in parallel and additively drives its blendshape group. EMA smoothing ($\alpha = 0.25$) on the rendered influences.

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

For sEMG-style features at the data scale of this UI (~300 samples per detector after 6 reps), regularised linear classifiers consistently match or beat deep nets while remaining fast (< 5 ms to fit), interpretable, and trivially cross-validatable. See Phinyomark et al. 2018 (Sensors 18(5)) for a survey. Adding TFJS would mean ~1 MB of bundle for no decoding gain — and would lose the per-channel importance signal that group-lasso gives us for free.

## Persistence

All detectors (including `channelImportance`) persist to `localStorage` under the key `face-trainer:v2` and restore on the next session.

## Files

- `FaceTrainer.tsx` — three.js scene, recording state machine, per-card UI (incl. channel bar)
- `features.ts` — CAR + per-channel feature extraction
- `detector.ts` — L2 + group-lasso logistic regression, prox optimiser, LORO CV
- `prompts.ts` — expression catalog + rep-timeline state machine

## Assets

`facecap.glb` is loaded directly from the official three.js CDN — `https://threejs.org/examples/models/gltf/facecap.glb` — using KTX2 + Meshopt. No local copy required.
