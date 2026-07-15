// Projectile / object speed — CAMERA experiment.
// TF.js COCO-SSD (lite_mobilenet_v2, Apache-2.0, vendored) detects objects; a constant-velocity
// Kalman filter smooths the track and predicts through motion blur / missed detections; a
// two-tap length calibration sets px-per-metre so speed reads in real m/s and mph.
// Uncalibrated readings stay honestly in px/s.

const DETECT_W = 480;        // detector input width (downscaled from the video frame)
const SCORE_MIN = 0.30;
const AUTO_CLASS = "sports ball"; // auto-lock this class when it appears
const AUTO_SCORE = 0.40;
const LOST_S = 0.9;          // coast on prediction this long, then drop the lock
const REACQ_S = 3.0;         // keep looking for the same class this long after losing it
const TRAIL_S = 1.2;
const SPEED_MIN_PX = 30;     // below this we don't draw the velocity vector
const CAL_KEY = "pg.p1.calibration";
const MPH_PER_MS = 2.23694;

let root, els = {};
let running = false;
let stream = null;
let model = null;
let modelState = "idle"; // idle | loading | ready | failed
let video, overlay, ctx;
let detectCanvas, dctx;
let rafId = 0;
let detectLoopActive = false;

let latest = [];   // last detection set, video coords: {x,y,w,h,cx,cy,class,score,t}
let target = null; // {class, kfx, kfy, lastMeas, lostAt}
let trail = [];
let fpsEma = 0, detHzEma = 0, lastFrameT = 0;
let calib = { ppm: 0, mode: false, pts: [] }; // ppm = pixels per metre (video coords)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function setPill(el, cls) { el.className = "pill" + (cls ? " " + cls : ""); }
function setHint(text) {
  els.hint.textContent = text || "";
  els.hint.classList.toggle("hidden", !text);
}

// ---------------------------------------------------------------- 1-D constant-velocity Kalman
// Axes are independent, so the 4-state CV filter splits into two 2-state filters.
class KF1D {
  constructor(p, rPos, sigmaA) {
    this.p = p; this.v = 0;
    this.r2 = rPos * rPos; this.sa2 = sigmaA * sigmaA;
    this.Ppp = rPos * rPos * 4; this.Ppv = 0; this.Pvv = 1e6;
  }
  predict(dt) {
    this.p += this.v * dt;
    const { Ppp, Ppv, Pvv, sa2 } = this;
    this.Ppp = Ppp + 2 * Ppv * dt + Pvv * dt * dt + sa2 * dt * dt * dt * dt / 4;
    this.Ppv = Ppv + Pvv * dt + sa2 * dt * dt * dt / 2;
    this.Pvv = Pvv + sa2 * dt * dt;
  }
  update(z) {
    const S = this.Ppp + this.r2;
    const Kp = this.Ppp / S, Kv = this.Ppv / S;
    const y = z - this.p;
    this.p += Kp * y; this.v += Kv * y;
    const { Ppp, Ppv, Pvv } = this;
    this.Ppp = (1 - Kp) * Ppp;
    this.Ppv = (1 - Kp) * Ppv;
    this.Pvv = Pvv - Kv * Ppv;
  }
}
function makeKF(x, y) {
  const rPos = video.videoWidth * 0.008;   // ~10 px measurement noise at 1280
  const sigmaA = video.videoWidth * 1.6;   // px/s² process noise (thrown objects accelerate)
  return { x: new KF1D(x, rPos, sigmaA), y: new KF1D(y, rPos, sigmaA) };
}

// ---------------------------------------------------------------- module
export default {
  id: "projectile",
  title: "Object speed · projectile",
  family: "camera",

  async init(ctx_) {
    root = ctx_.root;
    root.innerHTML = `
      <video data-el="video" playsinline muted autoplay
        style="position:absolute; inset:0; width:100%; height:100%; object-fit:cover; background:#000;"></video>
      <canvas data-el="overlay" style="position:absolute; inset:0; width:100%; height:100%;"></canvas>
      <div class="pillRow">
        <div class="pill" data-el="pillCam"><span class="dot"></span>CAM</div>
        <div class="pill" data-el="pillModel"><span class="dot"></span>MODEL</div>
        <div class="pill" data-el="pillTrack"><span class="dot"></span>TRACK</div>
      </div>
      <div style="position:absolute; top:10px; right:12px; z-index:20; display:flex; gap:8px;">
        <button class="ghostBtn accent" data-el="calBtn">Calibrate</button>
        <button class="ghostBtn" data-el="clearBtn">Clear target</button>
      </div>
      <div class="hintLine hidden" data-el="hint" style="top:60px;"></div>
      <div class="gatePanel" data-el="calPanel" style="display:none; background:rgba(6,8,15,0.55); z-index:26;">
        <p style="color:var(--text); font-weight:600;">Real length between the two marks?</p>
        <div style="display:flex; align-items:center; gap:10px;">
          <input type="number" data-el="calInput" min="0.01" max="100" step="0.01" value="1.00" inputmode="decimal">
          <span style="color:var(--dim); font-size:13px;">metres</span>
        </div>
        <div style="display:flex; gap:10px;">
          <button class="bigBtn" data-el="calSet" style="padding:10px 28px; font-size:14px;">Set scale</button>
          <button class="ghostBtn" data-el="calCancel">Cancel</button>
        </div>
      </div>
      <div class="readout">
        <div class="statRow">
          <div class="stat"><div class="v big" data-el="statMain">—</div><div class="l" data-el="statMainL">speed · px/s</div></div>
          <div class="stat"><div class="v" data-el="statMph">—</div><div class="l">mph</div></div>
          <div class="stat"><div class="v" data-el="statPx">—</div><div class="l">px/s</div></div>
        </div>
        <div class="statRow" style="margin-top:8px;">
          <div class="stat"><div class="v" style="font-size:13px;" data-el="statClass">—</div><div class="l">target</div></div>
          <div class="stat"><div class="v" style="font-size:13px;" data-el="statScale">—</div><div class="l">scale</div></div>
          <div class="stat"><div class="v" style="font-size:13px;" data-el="statDet">—</div><div class="l">detect hz</div></div>
          <div class="stat"><div class="v" style="font-size:13px;" data-el="statFps">—</div><div class="l">fps</div></div>
        </div>
        <div class="noteLine" data-el="note">Uncalibrated — speeds are pixels. Tap Calibrate and mark a known length for m/s.</div>
      </div>
      <div class="gatePanel" data-el="gate">
        <p>Detects and tracks an object with on-device ML (COCO-SSD + Kalman filter).
           Best with a ball; tap any detected object to track it instead.</p>
        <button class="bigBtn" data-el="startBtn">Start camera</button>
        <p class="err" data-el="gateErr"></p>
      </div>`;
    for (const el of root.querySelectorAll("[data-el]")) els[el.dataset.el] = el;
    video = els.video; overlay = els.overlay; ctx = overlay.getContext("2d");
    detectCanvas = document.createElement("canvas");
    dctx = detectCanvas.getContext("2d", { willReadFrequently: true });

    els.startBtn.addEventListener("click", onStartClick);
    els.calBtn.addEventListener("click", toggleCalibrate);
    els.clearBtn.addEventListener("click", () => { target = null; trail = []; updateHintForState(); });
    els.calSet.addEventListener("click", commitCalibration);
    els.calCancel.addEventListener("click", () => { calib.mode = false; calib.pts = []; els.calPanel.style.display = "none"; els.calBtn.textContent = "Calibrate"; updateHintForState(); });
    overlay.addEventListener("pointerdown", onTap);
    window.addEventListener("resize", resizeOverlay);
    resizeOverlay();

    loadModel(); // async in background — Start stays instant
  },

  async start() {
    running = true;
    lastFrameT = 0;
    if (stream) {
      rafId = requestAnimationFrame(render);
      if (!detectLoopActive) detectLoop();
    }
  },

  stop() {
    running = false;
    cancelAnimationFrame(rafId);
  },

  teardown() {
    this.stop();
    if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
    if (model && model.dispose) { try { model.dispose(); } catch (e) {} }
    model = null; modelState = "idle";
    window.removeEventListener("resize", resizeOverlay);
    latest = []; target = null; trail = [];
    els = {}; root = null;
  },

  // ------------------------------------------------ verification hooks (used by live-browser tests)
  _state() {
    return {
      modelState, running, ppm: calib.ppm,
      targetClass: target ? target.class : null,
      pos: target ? { x: target.kfx.p, y: target.kfy.p } : null,
      vel: target ? { x: target.kfx.v, y: target.kfy.v } : null,
      speedPx: target ? Math.hypot(target.kfx.v, target.kfy.v) : 0,
      detections: latest.length, detHz: detHzEma, fps: fpsEma,
    };
  },
  _injectDetection(cx, cy, cls = AUTO_CLASS, score = 0.9) {
    const d = { cx, cy, x: cx - 20, y: cy - 20, w: 40, h: 40, class: cls, score, t: performance.now() };
    latest = [d];
    associate([d], performance.now());
  },
  _setCalibration(ppm) { calib.ppm = ppm; persistCalibration(); refreshScaleReadout(); },
};

// ---------------------------------------------------------------- model
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = () => rej(new Error("script failed: " + src));
    document.head.appendChild(s);
  });
}

async function loadModel() {
  modelState = "loading";
  setPill(els.pillModel, "wait");
  try {
    if (!window.tf) await loadScript(new URL("../../lib/tfjs/tf.min.js", import.meta.url).href);
    if (!window.cocoSsd) await loadScript(new URL("../../lib/tfjs/coco-ssd.min.js", import.meta.url).href);
    model = await window.cocoSsd.load({
      base: "lite_mobilenet_v2",
      modelUrl: new URL("../../models/coco-ssd-lite/model.json", import.meta.url).href,
    });
    modelState = "ready";
    if (els.pillModel) setPill(els.pillModel, "ok");
    if (running && stream && !detectLoopActive) detectLoop();
  } catch (err) {
    console.error("COCO-SSD failed to load:", err);
    modelState = "failed";
    if (els.pillModel) {
      setPill(els.pillModel, "err");
      setHint("Object-detection model failed to load — check connection and reload.");
    }
  }
}

// ---------------------------------------------------------------- camera
async function onStartClick() {
  els.startBtn.disabled = true;
  setPill(els.pillCam, "wait");
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    setPill(els.pillCam, "ok");
    els.gate.style.display = "none";
    loadCalibration();
    updateHintForState();
    rafId = requestAnimationFrame(render);
    if (!detectLoopActive) detectLoop();
  } catch (err) {
    console.error("Camera failed:", err);
    setPill(els.pillCam, "err");
    els.gateErr.style.display = "block";
    els.gateErr.textContent = err && err.name === "NotAllowedError"
      ? "Camera permission denied. Allow camera access for this site in Settings → Safari, then reload."
      : "Could not open the rear camera (" + (err && err.name || err) + ").";
  } finally {
    els.startBtn.disabled = false;
  }
}

// ---------------------------------------------------------------- detection loop
async function detectLoop() {
  if (detectLoopActive) return;
  detectLoopActive = true;
  while (running && modelState === "ready" && stream) {
    if (!video.videoWidth || video.readyState < 2 || document.hidden) { await sleep(150); continue; }
    const vw = video.videoWidth, vh = video.videoHeight;
    detectCanvas.width = DETECT_W;
    detectCanvas.height = Math.round(DETECT_W * vh / vw);
    dctx.drawImage(video, 0, 0, detectCanvas.width, detectCanvas.height);
    const t0 = performance.now();
    let preds = [];
    try {
      preds = await model.detect(detectCanvas, 20, SCORE_MIN);
    } catch (err) {
      console.error("detect() failed:", err);
      await sleep(500);
      continue;
    }
    const now = performance.now();
    const inst = 1000 / Math.max(1, now - t0);
    detHzEma = detHzEma ? detHzEma + 0.15 * (inst - detHzEma) : inst;
    const k = vw / detectCanvas.width;
    latest = preds.map((p) => ({
      x: p.bbox[0] * k, y: p.bbox[1] * k, w: p.bbox[2] * k, h: p.bbox[3] * k,
      cx: (p.bbox[0] + p.bbox[2] / 2) * k, cy: (p.bbox[1] + p.bbox[3] / 2) * k,
      class: p.class, score: p.score, t: now,
    }));
    associate(latest, now);
    await sleep(0); // let the render loop breathe
  }
  detectLoopActive = false;
}

// Match detections to the tracked target (nearest same-class within a gate), or acquire one.
function associate(dets, now) {
  if (target) {
    const gate = Math.max(video.videoWidth * 0.18, 5 * Math.sqrt(target.kfx.Ppp + target.kfx.r2));
    let best = null, bestD = gate;
    for (const d of dets) {
      if (d.class !== target.class) continue;
      const dist = Math.hypot(d.cx - target.kfx.p, d.cy - target.kfy.p);
      if (dist < bestD) { bestD = dist; best = d; }
    }
    if (best) {
      if (now - target.lastMeas > LOST_S * 1000) { // re-acquired after a loss: restart the filter
        const kf = makeKF(best.cx, best.cy);
        target.kfx = kf.x; target.kfy = kf.y;
        trail = [];
      } else {
        target.kfx.update(best.cx);
        target.kfy.update(best.cy);
      }
      target.lastMeas = now;
    } else if (now - target.lastMeas > REACQ_S * 1000) {
      target = null; trail = [];
    }
    if (target) return;
  }
  // No target: auto-acquire the configured class.
  let best = null;
  for (const d of dets) if (d.class === AUTO_CLASS && d.score >= AUTO_SCORE && (!best || d.score > best.score)) best = d;
  if (best) acquire(best);
}

function acquire(d) {
  const kf = makeKF(d.cx, d.cy);
  target = { class: d.class, kfx: kf.x, kfy: kf.y, lastMeas: d.t || performance.now() };
  trail = [];
  updateHintForState();
}

// ---------------------------------------------------------------- taps: target select / calibration marks
function onTap(e) {
  if (!stream || !video.videoWidth) return;
  const v = screenToVideo(e.clientX, e.clientY);
  if (!v) return;
  if (calib.mode) {
    calib.pts.push(v);
    if (calib.pts.length === 2) {
      els.calPanel.style.display = "flex";
      els.calInput.focus();
    }
    return;
  }
  // Pick the smallest detection box containing the tap (or nearest center within 60 px).
  let best = null;
  for (const d of latest) {
    const inside = v.x >= d.x && v.x <= d.x + d.w && v.y >= d.y && v.y <= d.y + d.h;
    const near = Math.hypot(d.cx - v.x, d.cy - v.y) < video.videoWidth * 0.05;
    if ((inside || near) && (!best || d.w * d.h < best.w * best.h)) best = d;
  }
  if (best) acquire(best);
}

// ---------------------------------------------------------------- calibration
function toggleCalibrate() {
  calib.mode = !calib.mode;
  calib.pts = [];
  els.calPanel.style.display = "none";
  els.calBtn.textContent = calib.mode ? "Cancel calibration" : "Calibrate";
  updateHintForState();
}

function commitCalibration() {
  const metres = parseFloat(els.calInput.value);
  if (!(metres > 0) || calib.pts.length !== 2) return;
  const distPx = Math.hypot(calib.pts[0].x - calib.pts[1].x, calib.pts[0].y - calib.pts[1].y);
  if (distPx < 10) { setHint("Marks are too close together — tap two points farther apart."); return; }
  calib.ppm = distPx / metres;
  calib.mode = false; calib.pts = [];
  els.calPanel.style.display = "none";
  els.calBtn.textContent = "Calibrate";
  persistCalibration();
  refreshScaleReadout();
  updateHintForState();
}

function persistCalibration() {
  localStorage.setItem(CAL_KEY, JSON.stringify({ ppm: calib.ppm, vw: video.videoWidth, ts: Date.now() }));
}
function loadCalibration() {
  try {
    const saved = JSON.parse(localStorage.getItem(CAL_KEY));
    if (saved && saved.ppm > 0 && saved.vw > 0) {
      calib.ppm = saved.ppm * (video.videoWidth / saved.vw); // rescale if the resolution changed
    }
  } catch (e) {}
  refreshScaleReadout();
}
function refreshScaleReadout() {
  els.statScale.textContent = calib.ppm ? `${Math.round(calib.ppm)} px/m` : "—";
  els.note.textContent = calib.ppm
    ? "Speed is real in the calibrated plane (same distance from the camera as the marked length)."
    : "Uncalibrated — speeds are pixels. Tap Calibrate and mark a known length for m/s.";
}

function updateHintForState() {
  if (calib.mode) setHint(calib.pts.length === 0
    ? "Tap the two ends of a known length in the scene (a metre stick, a door width…)."
    : "Tap the second end of the known length.");
  else if (!target) setHint(`Waiting for a ${AUTO_CLASS} — or tap any detected object to track it.`);
  else setHint("");
}

// ---------------------------------------------------------------- coordinate mapping (object-fit: cover)
function coverTransform() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const dw = overlay.clientWidth, dh = overlay.clientHeight;
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
  const r = overlay.getBoundingClientRect();
  const vx = (x - r.left - t.ox) / t.s, vy = (y - r.top - t.oy) / t.s;
  if (vx < 0 || vy < 0 || vx > video.videoWidth || vy > video.videoHeight) return null;
  return { x: vx, y: vy };
}
function resizeOverlay() {
  if (!overlay) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  overlay.width = Math.round(overlay.clientWidth * dpr);
  overlay.height = Math.round(overlay.clientHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ---------------------------------------------------------------- render loop
function render(nowMs) {
  if (!running) return;
  rafId = requestAnimationFrame(render);
  if (!video.videoWidth) return;

  if (lastFrameT) {
    const inst = 1000 / (nowMs - lastFrameT);
    fpsEma = fpsEma ? fpsEma + 0.08 * (inst - fpsEma) : inst;
  }
  const dt = lastFrameT ? (nowMs - lastFrameT) / 1000 : 0;
  lastFrameT = nowMs;

  // Advance the filter every frame; measurements arrive asynchronously from the detector.
  const sinceMeas = target ? (nowMs - target.lastMeas) / 1000 : Infinity;
  if (target && dt > 0 && dt < 0.5 && sinceMeas < LOST_S) {
    target.kfx.predict(dt);
    target.kfy.predict(dt);
    trail.push({ x: target.kfx.p, y: target.kfy.p, t: nowMs });
  }
  while (trail.length && nowMs - trail[0].t > TRAIL_S * 1000) trail.shift();

  ctx.clearRect(0, 0, overlay.clientWidth, overlay.clientHeight);
  drawDetections(nowMs);
  drawCalibration();
  if (target && sinceMeas < LOST_S) drawTarget(nowMs, sinceMeas);

  // Pills + readout.
  if (target && sinceMeas < LOST_S) setPill(els.pillTrack, "ok");
  else if (target) setPill(els.pillTrack, "wait"); // lost — trying to re-acquire
  else setPill(els.pillTrack, stream ? "wait" : "");

  if (target && sinceMeas < LOST_S) {
    const spPx = Math.hypot(target.kfx.v, target.kfy.v);
    els.statPx.textContent = String(Math.round(spPx));
    if (calib.ppm) {
      const ms = spPx / calib.ppm;
      els.statMain.textContent = ms.toFixed(2);
      els.statMainL.textContent = "speed · m/s";
      els.statMph.textContent = (ms * MPH_PER_MS).toFixed(1);
    } else {
      els.statMain.textContent = String(Math.round(spPx));
      els.statMainL.textContent = "speed · px/s";
      els.statMph.textContent = "—";
    }
    els.statClass.textContent = target.class + (sinceMeas > 0.2 ? " (predicting)" : "");
  } else {
    els.statMain.textContent = "—";
    els.statMph.textContent = "—";
    els.statPx.textContent = "—";
    els.statClass.textContent = target ? target.class + " (lost)" : "—";
  }
  els.statDet.textContent = detHzEma ? detHzEma.toFixed(1) : "—";
  els.statFps.textContent = fpsEma ? String(Math.round(fpsEma)) : "—";
}

function drawDetections(nowMs) {
  for (const d of latest) {
    if (nowMs - d.t > 600) continue;
    const a = videoToScreen(d.x, d.y), b = videoToScreen(d.x + d.w, d.y + d.h);
    if (!a || !b) continue;
    const isTarget = target && d.class === target.class &&
      Math.hypot(d.cx - target.kfx.p, d.cy - target.kfy.p) < video.videoWidth * 0.1;
    ctx.strokeStyle = isTarget ? "rgba(77,163,255,0.95)" : "rgba(232,238,252,0.35)";
    ctx.lineWidth = isTarget ? 2.5 : 1.5;
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.fillStyle = isTarget ? "rgba(77,163,255,0.95)" : "rgba(232,238,252,0.5)";
    ctx.font = "11px " + getComputedStyle(document.documentElement).getPropertyValue("--mono");
    ctx.fillText(`${d.class} ${(d.score * 100) | 0}%`, a.x + 3, a.y - 5);
  }
}

function drawCalibration() {
  if (!calib.mode && !calib.pts.length) return;
  ctx.strokeStyle = "#ffb347";
  ctx.fillStyle = "#ffb347";
  ctx.lineWidth = 2;
  const pts = calib.pts.map((p) => videoToScreen(p.x, p.y)).filter(Boolean);
  for (const p of pts) {
    ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, Math.PI * 2); ctx.fill();
  }
  if (pts.length === 2) {
    ctx.setLineDash([6, 5]);
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[1].x, pts[1].y); ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawTarget(nowMs, sinceMeas) {
  const t = coverTransform();
  const p = videoToScreen(target.kfx.p, target.kfy.p);
  if (!p || !t) return;
  const predicting = sinceMeas > 0.2;

  // Trail.
  for (let i = 1; i < trail.length; i++) {
    const a = videoToScreen(trail[i - 1].x, trail[i - 1].y), b = videoToScreen(trail[i].x, trail[i].y);
    if (!a || !b) continue;
    const age = (nowMs - trail[i].t) / (TRAIL_S * 1000);
    ctx.strokeStyle = `rgba(77, 163, 255, ${(1 - age) * 0.85})`;
    ctx.lineWidth = 3.5 * (1 - age) + 1;
    ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }

  // Velocity vector (0.25 s look-ahead).
  const speed = Math.hypot(target.kfx.v, target.kfy.v);
  if (speed > SPEED_MIN_PX) {
    const ex = p.x + target.kfx.v * 0.25 * t.s, ey = p.y + target.kfy.v * 0.25 * t.s;
    const ang = Math.atan2(ey - p.y, ex - p.x);
    ctx.strokeStyle = "#3ddc84"; ctx.fillStyle = "#3ddc84";
    ctx.lineWidth = 3; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - 11 * Math.cos(ang - 0.45), ey - 11 * Math.sin(ang - 0.45));
    ctx.lineTo(ex - 11 * Math.cos(ang + 0.45), ey - 11 * Math.sin(ang + 0.45));
    ctx.closePath(); ctx.fill();
  }

  // Marker — dashed while predicting through a gap.
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2.5;
  if (predicting) ctx.setLineDash([5, 4]);
  ctx.beginPath(); ctx.arc(p.x, p.y, 14, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff"; ctx.fill();
}
