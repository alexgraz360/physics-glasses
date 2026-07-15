# physics-glasses

**Reality Engine · Physics mode** — phone-first web app that annotates the live camera view with
the physics of what you're looking at. Companion to
[astronomy-glasses](https://github.com/alexgraz360/astronomy-glasses).

**Live:** https://alexgraz360.github.io/physics-glasses/

## Phases

| Phase | What | Status |
|-------|------|--------|
| [Phase 0](https://alexgraz360.github.io/physics-glasses/phase0/) | Prove the CV pipeline: rear camera + real-time tracking (hand-pose ML and HSV color-blob) with position/velocity overlay, pixels only | ✅ built |
| [Phase 1](https://alexgraz360.github.io/physics-glasses/phase1/) | Experiments hub (sensor + camera families) with pendulum (DeviceMotion → period & g, real units) and object speed (COCO-SSD + Kalman + length calibration → m/s, mph) | ✅ built |
| Phase 2 | More experiments (free-fall, spring, sound, pose/sports) + higher-accuracy ball tracking | — |
| Phase 3 | Glasses / native (ARKit + LiDAR) if depth is needed | — |

## Layout

```
phase0/   Phase 0 spike (kept as-is)
phase1/   Experiments hub + experiment modules (phase1/experiments/*.js), plain ES modules, no build step
lib/      Vendored libraries (MediaPipe Tasks Vision bundle + wasm; TF.js + COCO-SSD)
models/   Vendored ML models (hand_landmarker.task; COCO-SSD lite_mobilenet_v2)
```

Static site, GitHub Pages from `main` (`/`). HTTPS (required for camera). No secrets, no backend —
all inference on-device.

## Vendored third-party assets

- **MediaPipe Tasks Vision** `0.10.35` (`lib/tasks-vision/`) — Google, Apache-2.0.
  ES bundle + wasm from the [`@mediapipe/tasks-vision`](https://www.npmjs.com/package/@mediapipe/tasks-vision) npm package.
- **Hand Landmarker model** (`models/hand_landmarker.task`, float16, 7.5 MB) — Google, Apache-2.0.
  From the [MediaPipe model zoo](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker).
- **TensorFlow.js** `4.22.0` (`lib/tfjs/tf.min.js`, 1.4 MB UMD) — Google, Apache-2.0.
- **COCO-SSD** `2.2.3` (`lib/tfjs/coco-ssd.min.js`, 9 KB) + **lite_mobilenet_v2 model**
  (`models/coco-ssd-lite/`, ~17.6 MB) — Google, Apache-2.0. From
  [`@tensorflow-models/coco-ssd`](https://www.npmjs.com/package/@tensorflow-models/coco-ssd) and the tfjs-models GCS bucket.

## Units honesty

A single 2D camera gives pixels, not meters. Camera experiments report **px/s until calibrated**
(mark a known length in frame → px/m), and calibrated speeds are only valid in the calibrated
plane. Sensor experiments (accelerometer/gyro) measure in real units directly. No fabricated
real-world numbers.
