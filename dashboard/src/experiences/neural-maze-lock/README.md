# Neural Maze Lock

Neural Maze Lock is a playable BCI/EOG maze for the PiEEG dashboard experiences
gallery. The player moves through a fixed serpentine maze using EOG gaze
direction from Fp1/Fp2, with WASD/arrow keys as a mock-mode fallback.

The maze is blocked by three neural lock types:

| Gate | Opens when |
| --- | --- |
| Focus | focus stays above 0.6 for two seconds |
| Calm | relaxation stays above 0.6 for two seconds |
| Blink | focus charges the lock to 100%, then a blink confirms |

The main research signal is false-trigger behavior. When focus rises while the
player is not adjacent to a gate, the experience logs a false trigger. This
tests whether neural signals can work as a reliable intent-confirmation layer in
spatial computing.

## PiEEG integration

- Uses `useFocus(eegData)` for cortical engagement.
- Uses `useRelax(eegData)` for alpha/theta relaxation.
- Uses `useBlink(eegData)` for deliberate blink confirmation.
- Reads raw EOG from `eegData.buffers.current[0]` and `[1]`:
  - horizontal = `Fp2 - Fp1`
  - vertical = `(Fp1 + Fp2) / 2`
- Includes an EOG response slider because mock mode and real devices may have
  different amplitudes. Higher response means stronger gaze movement.
- Includes keyboard fallback for local testing without EOG-like mock samples.
- Includes mock signal keys for local testing because PiEEG mock mode does not
  provide per-experience sliders.

## Controls

- WASD or arrows: fallback gaze direction.
- F / R: raise / lower mock focus.
- C / X: raise / lower mock calm.
- B: mock blink.
- Blink gates: first hold focus until the lock reaches 100%, then blink or press B.
- Escape: return to the gallery.
- Reset maze: restart the run and clear opened gates.

## Metrics

The experience tracks gates opened, gate attempts, false triggers, average gate
open time, and full maze completion time.
