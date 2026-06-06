# MAVLink Drone

Fly a real drone with your face — same fEMG decoders as **Face Trainer**, but instead of moving an ARKit blendshape they fire MAVLink packets to an autopilot.

## What it is

1. Wear the 8 PiEEG electrodes on your face the same way as Face Trainer (frontal / temporal / cheek / peri-orbital; order doesn't matter).
2. Pick an expression card. Hit **Record Rep** and mimic the expression on the 3-2-1 → rest → HOLD → rest timeline. Repeat ~6 times.
3. The leave-one-rep-out readiness bar turns green when the detector is solid.
4. Each card has a dropdown that binds the expression to a drone command: `TAKEOFF`, `LAND`, `RTL (home)`, or a continuous axis (forward, back, roll L/R, throttle up/down, yaw L/R).
5. Hit **Free Flight (BCI)** and your face is the joystick.

The default backend is an in-browser 3D quadcopter simulator. When you're ready, click **Connect Real Drone…** to open a USB serial port to a SiK / Holybro telemetry radio (or any MAVLink-over-serial bridge) and fly the actual aircraft over the *exact same* command pipeline.

## Why this composition

The signal-processing stack is **identical to [Face Trainer](../face-trainer/README.md)**:

- 8 channels → Common-Average Reference → 5 time-domain features per channel @ 12 Hz → 40-D feature vector
- Per-expression L2 + group-lasso logistic regression (Adam + block-soft-threshold prox)
- Leave-one-rep-out balanced-accuracy CV → honest readiness colour
- Group-lasso channel bar → shows which electrodes the model actually uses

Face Trainer was already the right primitive for this — the only thing this mini-game adds is a thin **output layer** that turns posteriors into MAVLink. We import its `features.ts` and `detector.ts` directly; there is no signal-processing fork.

## Pipeline (output side)

```
expression detector ──► posterior p ∈ [0,1]
                       │
                       ├─ continuous binding (e.g. Smile → Forward)
                       │     strength = max(0, (p − 0.55) / 0.45)
                       │     → accumulated into a ManualSetpoint
                       │     → MANUAL_CONTROL (#69) @ 20 Hz, int16 × ±1000
                       │
                       └─ one-shot binding (e.g. Jaw Open → TAKEOFF)
                             rising edge at p ≥ 0.75, resets when p ≤ 0.45
                             → COMMAND_LONG (#76) with the right MAV_CMD
                                 - ARM/DISARM   (400)
                                 - NAV_TAKEOFF  (22)
                                 - NAV_LAND     (21)
                                 - RTL          (20)
```

A 1 Hz `HEARTBEAT` (#0) keeps the autopilot's RC-failsafe timer happy.

### Safety in the controller layer

All flight commands go through `DroneController`, which is the same class in sim and real:

- **Dead-man stick recentre** — if no detector has fired for 0.8 s, the manual setpoint goes back to neutral (0,0,0,0). One-shots that need a deliberate, sustained high posterior to fire (rising-edge gate at p ≥ 0.75, falling edge at p ≤ 0.45) avoid being triggered by stray transients.
- **Auto-disarm on touchdown** — in sim, when altitude reaches 0 the controller disarms. (On a real bird, ArduPilot/PX4 do this themselves.)
- **ARM and LAND always reachable** — both buttons are in the left panel, independent of the BCI state machine.
- **REAL DRONE badge** — a red badge appears in the header whenever the backend is `MavlinkController`, not `SimulatorController`. There is no silent fallback path.
- **Confirmation prompt** before opening Web Serial, with a reminder to start in open space and keep the radio kill switch in reach.

## The MAVLink subset

We hand-roll just enough MAVLink v2 to do the job — encoder is ~300 lines, no runtime dependency:

| Message | ID | Used for | CRC_EXTRA |
|---|---|---|---|
| `HEARTBEAT` | 0 | keep-alive @ 1 Hz | 50 |
| `MANUAL_CONTROL` | 69 | joystick @ 20 Hz, axes ±1000 | 243 |
| `COMMAND_LONG` | 76 | ARM/DISARM, TAKEOFF, LAND, RTL | 152 |

Wire format is the standard MAVLink v2 frame (STX `0xFD`, header, payload, X.25 CRC), with trailing zero-byte truncation. We're a GCS (`MAV_TYPE_GCS = 6`, `MAV_AUTOPILOT_INVALID = 8`), sysid 255, talking to a vehicle with sysid 1.

Every byte sent (or "would-be-sent" in sim) is decoded and pushed onto the on-screen frame log so you can see exactly what's going to the autopilot.

## Connecting to a real drone

The browser side uses the [Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API) — available in Chrome / Edge / Opera, not Firefox or Safari. Plug in any of:

- SiK telemetry radio ground unit (Holybro, RFD900, mRobotics) on USB at 57600 bps
- USB↔TELEM serial cable directly to a Pixhawk's TELEM port
- ESP32 / Pi acting as a serial bridge (e.g. a MAVLink-WiFi adapter exposed as USB-CDC)

Click **Connect Real Drone…**, pick the port from the browser prompt, and the controller starts streaming the heartbeat. ARM when the autopilot is happy (pre-arm checks pass — that's *its* job, not ours), TAKEOFF if you're in a `GUIDED`-style mode, and then either drive manually or let Free Flight do it.

Anything you trained in the sim works without re-training, because the controller API is the same.

## Persistence

Detectors + bindings persist to `localStorage` under `mavlink-drone:v1` and restore on the next session. Face Trainer's models live under `face-trainer:v2` and are kept separate — different bindings, different lives.

## Files

- `MavlinkDrone.tsx` — Three.js scene, recording state machine, per-card UI, frame log
- `commands.ts` — re-exports Face Trainer's expressions + adds the drone command catalog and default bindings
- `controller.ts` — `DroneController` interface, `SimulatorController` (in-browser physics), `MavlinkController` (Web Serial)
- `mavlink.ts` — MAVLink v2 frame builder + the 3 message encoders we use

## Things to be honest about

- **The sim is a flight-feel toy, not an SITL.** Velocity setpoints lerp into position; there is no gravity model, no wind, no autopilot loop. It exists so you can verify your expression → command mappings make sense before you fly the real thing. For physical testing against a virtual autopilot, point this at a [PX4 SITL](https://docs.px4.io/main/en/simulation/) or [ArduPilot SITL](https://ardupilot.org/dev/docs/sitl-simulator-software-in-the-loop.html) UDP/serial bridge — the wire bytes we emit are the same a real vehicle expects.
- **CV ≥ 0.70 is *necessary*, not sufficient.** Leave-one-rep-out balanced accuracy on a within-session dataset means the model can tell HOLD from rest in this session. It does **not** mean it will generalise to a noisy outdoor environment with the headset shifting on your sweaty forehead.
- **You are the pilot.** A kill switch, a spotter, and the local UAV regulations are all your responsibility. The mini-game won't catch a misfire that flies your drone into a tree.

## Credits

- MAVLink protocol: [mavlink.io](https://mavlink.io/), © MAVLink project.
- fEMG pipeline reused from Face Trainer (this repo).
