// Reality Engine · Physics — Phase 1 hub.
// Each experiment is a self-contained module in ./experiments/ that default-exports:
//   { id, title, family: "sensor"|"camera", icon, blurb,
//     async init(ctx),  // build DOM under ctx.root; ctx = { root }
//     async start(),    // begin sensors/camera work (also called on tab-visible resume)
//     stop(),           // pause all work (tab hidden, or before teardown)
//     teardown() }      // release everything (streams, listeners); hub clears ctx.root
// The hub only knows this interface — adding experiment #3, #4… is a registry entry + module file.

const REGISTRY = [
  {
    id: "pendulum",
    title: "Pendulum · period & g",
    family: "sensor",
    icon: "🪀",
    blurb: "Swing the phone on a string — measures period T from the gyroscope and computes g from your length.",
    load: () => import("./experiments/pendulum.js"),
  },
  {
    id: "projectile",
    title: "Object speed · projectile",
    family: "camera",
    icon: "⚾",
    blurb: "ML object detection + Kalman tracking. Calibrate a known length to read real speed in m/s and mph.",
    load: () => import("./experiments/projectile.js"),
  },
  { id: "freefall", title: "Free fall · measure g", family: "sensor", icon: "🍎",
    blurb: "Drop the phone onto a cushion — time in free fall from the accelerometer.", soon: true },
  { id: "spring", title: "Spring oscillation", family: "sensor", icon: "🌀",
    blurb: "Bounce the phone on a spring or elastic — frequency and damping.", soon: true },
  { id: "sound", title: "Speed of sound", family: "sensor", icon: "🔊",
    blurb: "Clap-echo timing with the microphone.", soon: true },
  { id: "bodymotion", title: "Body motion", family: "camera", icon: "🏃",
    blurb: "Pose tracking for throws and swings — joint speeds and release angles.", soon: true },
];

const hub = document.getElementById("hub");
const expView = document.getElementById("expView");
const expRoot = document.getElementById("expRoot");
const expTitle = document.getElementById("expTitle");
const expTag = document.getElementById("expTag");

let active = null; // { mod, entry }

// ---------------------------------------------------------------- hub cards
const cardsEl = document.getElementById("cards");
for (const entry of REGISTRY) {
  const card = document.createElement("button");
  card.className = "card" + (entry.soon ? " soon" : "");
  card.innerHTML = `
    <span class="tag ${entry.family}">${entry.family.toUpperCase()}</span>
    <span class="icon">${entry.icon}</span>
    <span class="name">${entry.title}</span>
    <span class="blurb">${entry.blurb}</span>
    ${entry.soon ? '<span class="soonNote">COMING SOON</span>' : '<span class="go">Open →</span>'}`;
  if (!entry.soon) card.addEventListener("click", () => openExperiment(entry));
  cardsEl.appendChild(card);
}

// ---------------------------------------------------------------- lifecycle
async function openExperiment(entry) {
  if (active) return;
  expTitle.textContent = entry.title;
  expTag.textContent = entry.family.toUpperCase();
  expTag.className = "tag " + entry.family;
  expRoot.innerHTML = "";
  hub.style.display = "none";
  expView.classList.add("open");
  try {
    const mod = (await entry.load()).default;
    active = { mod, entry };
    await mod.init({ root: expRoot });
    await mod.start();
    if (location.hash.includes("debug")) window.__exp = mod; // verification hook
  } catch (err) {
    console.error(`Experiment "${entry.id}" failed:`, err);
    expRoot.innerHTML = `<div class="gatePanel"><p style="color:var(--bad)">This experiment failed to load
      (${err && err.message || err}). Go back and try again.</p></div>`;
  }
}

function closeExperiment() {
  if (active) {
    try { active.mod.stop(); } catch (e) { console.error(e); }
    try { active.mod.teardown(); } catch (e) { console.error(e); }
    active = null;
  }
  window.__exp = undefined;
  expRoot.innerHTML = "";
  expView.classList.remove("open");
  hub.style.display = "";
}

document.getElementById("backBtn").addEventListener("click", closeExperiment);

// Pause the active experiment when the tab is hidden (keep the phone cool).
document.addEventListener("visibilitychange", () => {
  if (!active) return;
  try {
    if (document.hidden) active.mod.stop();
    else active.mod.start();
  } catch (e) { console.error(e); }
});
