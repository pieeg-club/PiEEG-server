# Orb Control

Orb Control is a continuous BCI/EOG control demo for the PiEEG dashboard
experiences gallery. The user moves an orb with EOG gaze, builds charge with
focus, steadies it with calm, and releases stored charge with a blink.

## Signal mapping

| Signal | Effect |
| --- | --- |
| Focus above 0.32 | Grabs the orb and builds stored charge |
| EOG gaze X/Y | Moves the orb around the stage |
| Calm above 0.6 | Stabilizes the orb aura and suppresses artifact instability |
| Blink | Releases a pulse if charge is at least 72% |
| Blink below 72% | Logs a failed release |
| High blink amplitude/artifact | Shakes the orb unless calm is high |

## PiEEG integration

- Uses `useFocus(eegData)` for orb grab and charge.
- Uses `useRelax(eegData)` for stability.
- Uses `useBlink(eegData)` for release.
- Reads raw EOG from `eegData.buffers.current[0]` and `[1]`:
  - horizontal = `Fp2 - Fp1`
  - vertical = `(Fp1 + Fp2) / 2`
- Includes EOG response and movement speed sliders for mock-mode and hardware
  tuning. Higher EOG response means stronger gaze movement.
- Includes WASD/arrow fallback for local testing without EOG-like mock samples.
- Includes mock signal keys for local testing because PiEEG mock mode does not
  provide per-experience sliders.

## Controls

- Gaze speed: tune movement responsiveness.
- EOG response: tune raw frontal-channel movement amplitude.
- WASD or arrows: fallback gaze direction.
- F / R: raise / lower mock focus.
- C / X: raise / lower mock calm.
- B: mock blink.
- N / M: raise / lower mock artifact.
- Escape: return to the gallery.

Artifact is derived from frontal-channel blink amplitude plus the N/M mock
control. It is not a separate PiEEG protocol field; it represents blink or
muscle contamination in Fp1/Fp2 that makes the orb unstable unless relaxation is
high enough to steady it.

## Metrics

The experience tracks orb grabs, successful releases, failed blink releases, and
unstable periods.
