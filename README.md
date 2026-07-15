# physics-glasses

**Reality Engine · Physics mode** — phone-first web app that annotates the live camera view with
the physics of what you're looking at. Companion to
[astronomy-glasses](https://github.com/alexgraz360/astronomy-glasses).

**Live:** https://alexgraz360.github.io/physics-glasses/

## Phases

| Phase | What | Status |
|-------|------|--------|
| [Phase 0](https://alexgraz360.github.io/physics-glasses/phase0/) | Prove the CV pipeline: rear camera + real-time tracking (hand-pose ML and HSV color-blob) with position/velocity overlay, pixels only | ✅ built |
| Phase 1 | One polished mini-experiment (projectile analyzer) with calibration to real units | — |
| Phase 2 | More experiments (pendulum, free-fall, pose/sports) + robustness | — |
| Phase 3 | Glasses / native (ARKit + LiDAR) if depth is needed | — |

## Layout

```
phase0/   Phase 0 app (index.html + main.js, plain ES modules, no build step)
lib/      Vendored libraries (MediaPipe Tasks Vision bundle + wasm)
models/   Vendored ML models (hand_landmarker.task)
```

Static site, GitHub Pages from `main` (`/`). HTTPS (required for camera). No secrets, no backend —
all inference on-device.

## Vendored third-party assets

- **MediaPipe Tasks Vision** `0.10.35` (`lib/tasks-vision/`) — Google, Apache-2.0.
  ES bundle + wasm from the [`@mediapipe/tasks-vision`](https://www.npmjs.com/package/@mediapipe/tasks-vision) npm package.
- **Hand Landmarker model** (`models/hand_landmarker.task`, float16, 7.5 MB) — Google, Apache-2.0.
  From the [MediaPipe model zoo](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker).

## Units honesty

Phase 0 reports **pixels only** (px, px/s). A single 2D camera gives pixels, not meters —
real-world units require the calibration step planned for Phase 1. No fabricated real-world numbers.
