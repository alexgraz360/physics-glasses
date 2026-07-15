// Reality Engine · Physics — Phase 0: prove the CV pipeline.
// Two trackers: (A) MediaPipe Hand Landmarker (ML, vendored wasm+model),
// (B) HSV color-blob (no ML). All kinematics in PIXELS — calibration is Phase 1.

import { FilesetResolver, HandLandmarker } from "../lib/tasks-vision/vision_bundle.mjs";

const video = document.getElementById("cam");
const canvas = document.getElementById("overlay");
const ctx = canvas.getContext("2d");

const pills = {
  cam: document.getElementById("pillCam"),
  model: document.getElementById("pillModel"),
  track: document.getElementById("pillTrack"),
};
const statPos = document.getElementById("statPos");
const statSpeed = document.getElementById("statSpeed");
const statFps = document.getElementById("statFps");
const hintEl = document.getElementById("hint");
const gate = document.getElementById("gate");
const gateErr = document.getElementById("gateErr");

function setPill(p, state) { // state: "", "wait", "ok", "err"
  p.className = "pill" + (state ? " " + state : "");
}
function setHint(text) {
  hintEl.textContent = text || "";
  hintEl.classList.toggle("hidden", !text);
}

// ---------------------------------------------------------------- state
let mode = "hand"; // "hand" | "ball"
let running = false;
let stream = null;
let landmarker = null;
let modelState = "loading"; // loading | ready | failed
let rafId = 0;

// Tracked point, all in VIDEO-FRAME pixel coordinates (the honest pixels).
const track = {
  active: false,
  x: 0, y: 0,          // smoothed position
  vx: 0, vy: 0,        // smoothed velocity px/s
  lastT: 0,            // ms timestamp of last accepted sample
  lastSeen: 0,         // ms timestamp target was last detected
  trail: [],           // [{x, y, t}]
};
const POS_ALPHA = 0.55;   // light position smoothing
const VEL_ALPHA = 0.30;   // heavier velocity smoothing (velocity is noisier)
const TRAIL_MS = 900;
const LOST_MS = 400;

// FPS of the processing loop (exponential moving average of frame interval).
let fpsEma = 0;
let lastLoopT = 0;

// ---------------------------------------------------------------- model (loads in background at page open)
async function loadModel() {
  try {
    setPill(pills.model, "wait");
    const files = await FilesetResolver.forVisionTasks("../lib/tasks-vision/wasm");
    landmarker = await HandLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: "../models/hand_landmarker.task", delegate: "GPU" },
      runningMode: "VIDEO",
      numHands: 1,
    });
    modelState = "ready";
    setPill(pills.model, "ok");
  } catch (err) {
    console.error("Hand model failed to load:", err);
    modelState = "failed";
    setPill(pills.model, "err");
    if (mode === "hand") setHint("Hand model failed to load — Ball · Color mode still works.");
  }
}
loadModel();

// ---------------------------------------------------------------- camera
async function startCamera() {
  setPill(pills.cam, "wait");
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    setPill(pills.cam, "ok");
    return true;
  } catch (err) {
    console.error("Camera failed:", err);
    setPill(pills.cam, "err");
    gateErr.style.display = "block";
    gateErr.textContent = err && err.name === "NotAllowedError"
      ? "Camera permission denied. Allow camera access for this site in Settings → Safari, then reload."
      : "Could not open the rear camera (" + (err && err.name || err) + "). Check that another app isn't using it.";
    return false;
  }
}

const startBtn = document.getElementById("startBtn");
startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  const ok = await startCamera();
  startBtn.disabled = false;
  if (!ok) return;
  gate.style.display = "none";
  running = true;
  updateHint();
  rafId = requestAnimationFrame(loop);
});

// Pause inference when hidden (keep the phone cool); resume on return.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    cancelAnimationFrame(rafId);
  } else if (running) {
    lastLoopT = 0;
    track.lastT = 0;
    rafId = requestAnimationFrame(loop);
  }
});

// ---------------------------------------------------------------- mode toggle
const btnHand = document.getElementById("modeHand");
const btnBall = document.getElementById("modeBall");
function setMode(m) {
  mode = m;
  btnHand.classList.toggle("active", m === "hand");
  btnBall.classList.toggle("active", m === "ball");
  track.active = false;
  track.trail.length = 0;
  setPill(pills.track, "");
  updateHint();
}
btnHand.addEventListener("click", () => setMode("hand"));
btnBall.addEventListener("click", () => setMode("ball"));

function updateHint() {
  if (!running) { setHint(""); return; }
  if (mode === "hand") {
    setHint(modelState === "failed"
      ? "Hand model failed to load — Ball · Color mode still works."
      : "Show a hand to the rear camera — tracking the index fingertip.");
  } else {
    setHint(blob.hasTarget
      ? "Tracking that color. Tap the ball again any time to re-sample."
      : "Point at a brightly colored ball and TAP it on screen to lock its color.");
  }
}

// ---------------------------------------------------------------- color-blob tracker (no ML)
const DETECT_W = 160; // inference happens on a downscaled frame
const detectCanvas = document.createElement("canvas");
const detectCtx = detectCanvas.getContext("2d", { willReadFrequently: true });

const blob = {
  hasTarget: false,
  hue: 0, sat: 0, val: 0, // sampled target color (HSV: h 0-360, s/v 0-1)
  hueTol: 22,
};

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max];
}
const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

// Tap to sample the ball's color (video coords <- screen coords).
canvas.addEventListener("pointerdown", (e) => {
  if (!running || mode !== "ball" || !video.videoWidth) return;
  const v = screenToVideo(e.clientX, e.clientY);
  if (!v) return;
  drawDetectFrame();
  const dx = Math.round(v.x * (detectCanvas.width / video.videoWidth));
  const dy = Math.round(v.y * (detectCanvas.height / video.videoHeight));
  // Average a small patch for a stable sample.
  const R = 2;
  const x0 = Math.max(0, dx - R), y0 = Math.max(0, dy - R);
  const w = Math.min(detectCanvas.width - x0, 2 * R + 1), h = Math.min(detectCanvas.height - y0, 2 * R + 1);
  const d = detectCtx.getImageData(x0, y0, w, h).data;
  let r = 0, g = 0, b = 0, n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  const [hh, ss, vv] = rgbToHsv(r / n, g / n, b / n);
  if (ss < 0.25 || vv < 0.2) {
    setHint("That spot isn't colorful enough to track — tap a bright, saturated ball.");
    return;
  }
  blob.hasTarget = true; blob.hue = hh; blob.sat = ss; blob.val = vv;
  track.active = false; track.trail.length = 0;
  updateHint();
});

function drawDetectFrame() {
  const vw = video.videoWidth, vh = video.videoHeight;
  detectCanvas.width = DETECT_W;
  detectCanvas.height = Math.max(1, Math.round(DETECT_W * vh / vw));
  detectCtx.drawImage(video, 0, 0, detectCanvas.width, detectCanvas.height);
}

// Returns {x, y} centroid of the largest matching blob in video coords, or null.
function detectBlob() {
  if (!blob.hasTarget) return null;
  drawDetectFrame();
  const w = detectCanvas.width, h = detectCanvas.height;
  const data = detectCtx.getImageData(0, 0, w, h).data;
  const minSat = Math.max(0.18, blob.sat * 0.5);
  const minVal = Math.max(0.15, blob.val * 0.45);
  const mask = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const [hh, ss, vv] = rgbToHsv(data[i], data[i + 1], data[i + 2]);
    if (ss >= minSat && vv >= minVal && hueDist(hh, blob.hue) <= blob.hueTol) mask[p] = 1;
  }
  // Largest connected component (4-neighbour BFS on the low-res mask).
  const labels = new Int32Array(w * h);
  const queue = new Int32Array(w * h);
  let best = null, bestSize = 0, label = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    label++;
    let head = 0, tail = 0, size = 0, sx = 0, sy = 0;
    queue[tail++] = start; labels[start] = label;
    while (head < tail) {
      const p = queue[head++];
      const px = p % w, py = (p / w) | 0;
      size++; sx += px; sy += py;
      if (px > 0     && mask[p - 1] && !labels[p - 1]) { labels[p - 1] = label; queue[tail++] = p - 1; }
      if (px < w - 1 && mask[p + 1] && !labels[p + 1]) { labels[p + 1] = label; queue[tail++] = p + 1; }
      if (py > 0     && mask[p - w] && !labels[p - w]) { labels[p - w] = label; queue[tail++] = p - w; }
      if (py < h - 1 && mask[p + w] && !labels[p + w]) { labels[p + w] = label; queue[tail++] = p + w; }
    }
    if (size > bestSize) { bestSize = size; best = { x: sx / size, y: sy / size }; }
  }
  const MIN_PIXELS = 10; // reject specks at detect resolution
  if (!best || bestSize < MIN_PIXELS) return null;
  return {
    x: best.x * (video.videoWidth / w),
    y: best.y * (video.videoHeight / h),
  };
}

// ---------------------------------------------------------------- hand tracker (ML)
// Tracks landmark 8 = index fingertip.
function detectHand(nowMs) {
  if (modelState !== "ready") return null;
  const res = landmarker.detectForVideo(video, nowMs);
  const lm = res.landmarks && res.landmarks[0];
  if (!lm) return null;
  const tip = lm[8];
  return { x: tip.x * video.videoWidth, y: tip.y * video.videoHeight };
}

// ---------------------------------------------------------------- kinematics (pixels only)
function updateKinematics(p, nowMs) {
  if (!p) {
    if (track.active && nowMs - track.lastSeen > LOST_MS) {
      track.active = false;
      track.trail.length = 0;
    }
    return;
  }
  if (!track.active || !track.lastT) {
    track.active = true;
    track.x = p.x; track.y = p.y;
    track.vx = 0; track.vy = 0;
  } else {
    const dt = (nowMs - track.lastT) / 1000;
    if (dt > 0 && dt < 0.5) {
      const nx = track.x + POS_ALPHA * (p.x - track.x);
      const ny = track.y + POS_ALPHA * (p.y - track.y);
      const ivx = (nx - track.x) / dt, ivy = (ny - track.y) / dt;
      track.vx += VEL_ALPHA * (ivx - track.vx);
      track.vy += VEL_ALPHA * (ivy - track.vy);
      track.x = nx; track.y = ny;
    } else {
      track.x = p.x; track.y = p.y; track.vx = 0; track.vy = 0;
    }
  }
  track.lastT = nowMs;
  track.lastSeen = nowMs;
  track.trail.push({ x: track.x, y: track.y, t: nowMs });
  while (track.trail.length && nowMs - track.trail[0].t > TRAIL_MS) track.trail.shift();
}

// ---------------------------------------------------------------- coordinate mapping
// The <video> uses object-fit: cover; map video-frame px <-> screen (CSS) px.
function coverTransform() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const dw = canvas.clientWidth, dh = canvas.clientHeight;
  const s = Math.max(dw / vw, dh / vh);
  return { s, ox: (dw - vw * s) / 2, oy: (dh - vh * s) / 2 };
}
function videoToScreen(x, y) {
  const t = coverTransform();
  return t ? { x: x * t.s + t.ox, y: y * t.s + t.oy } : null;
}
function screenToVideo(x, y) {
  const t = coverTransform();
  if (!t) return null;
  const vx = (x - t.ox) / t.s, vy = (y - t.oy) / t.s;
  if (vx < 0 || vy < 0 || vx > video.videoWidth || vy > video.videoHeight) return null;
  return { x: vx, y: vy };
}

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

// ---------------------------------------------------------------- overlay drawing
function drawOverlay(nowMs) {
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  if (!track.active) return;

  // Motion trail (fades with age).
  if (track.trail.length > 1) {
    for (let i = 1; i < track.trail.length; i++) {
      const a = track.trail[i - 1], b = track.trail[i];
      const pa = videoToScreen(a.x, a.y), pb = videoToScreen(b.x, b.y);
      if (!pa || !pb) continue;
      const age = (nowMs - b.t) / TRAIL_MS;
      ctx.strokeStyle = `rgba(77, 163, 255, ${(1 - age) * 0.85})`;
      ctx.lineWidth = 3.5 * (1 - age) + 1;
      ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    }
  }

  const p = videoToScreen(track.x, track.y);
  if (!p) return;
  const t = coverTransform();

  // Velocity vector: where the point would be 0.25 s from now at current velocity.
  const speed = Math.hypot(track.vx, track.vy);
  if (speed > 40) {
    const ex = p.x + track.vx * 0.25 * t.s;
    const ey = p.y + track.vy * 0.25 * t.s;
    const ang = Math.atan2(ey - p.y, ex - p.x);
    ctx.strokeStyle = "#3ddc84";
    ctx.fillStyle = "#3ddc84";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - 11 * Math.cos(ang - 0.45), ey - 11 * Math.sin(ang - 0.45));
    ctx.lineTo(ex - 11 * Math.cos(ang + 0.45), ey - 11 * Math.sin(ang + 0.45));
    ctx.closePath(); ctx.fill();
  }

  // Marker: crosshair ring on the tracked point.
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.arc(p.x, p.y, 14, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff"; ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineWidth = 1.5;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    ctx.beginPath();
    ctx.moveTo(p.x + dx * 18, p.y + dy * 18);
    ctx.lineTo(p.x + dx * 26, p.y + dy * 26);
    ctx.stroke();
  }
}

// ---------------------------------------------------------------- main loop
function loop(nowMs) {
  rafId = requestAnimationFrame(loop);
  if (!video.videoWidth) return;

  if (lastLoopT) {
    const inst = 1000 / (nowMs - lastLoopT);
    fpsEma = fpsEma ? fpsEma + 0.08 * (inst - fpsEma) : inst;
  }
  lastLoopT = nowMs;

  let point = null;
  try {
    point = mode === "hand" ? detectHand(nowMs) : detectBlob();
  } catch (err) {
    console.error("Tracker error:", err);
  }
  updateKinematics(point, nowMs);
  drawOverlay(nowMs);

  // Pills + readout.
  if (track.active) setPill(pills.track, "ok");
  else if (mode === "ball" && !blob.hasTarget) setPill(pills.track, "");
  else setPill(pills.track, "wait");

  if (track.active) {
    statPos.textContent = `${Math.round(track.x)}, ${Math.round(track.y)}`;
    statSpeed.textContent = `${Math.round(Math.hypot(track.vx, track.vy))}`;
    if (hintEl.textContent && mode === "hand") setHint("");
  } else {
    statPos.textContent = "—";
    statSpeed.textContent = "—";
    if (mode === "hand" && running) updateHint();
  }
  statFps.textContent = fpsEma ? `${Math.round(fpsEma)}` : "—";
}
