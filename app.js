import { GpuHasher } from "./gpu.js";
import { BatchTuner } from "./batch-tuner.js";

const ids = [
  "gpuSupport", "gpuName", "startButton", "stopButton", "statusDot", "statusText",
  "hashrate", "rateUnit", "totalHashes", "goodShares", "badShares",
  "rateChart", "chartEmpty", "peakRate", "chartTooltip",
  "formulaInput", "sampleHash", "targetHash", "matchBadge",
  "difficulty", "currentNonce", "lastMatch", "latency", "batchTime",
  "username", "miningKey", "rigName", "batchSize", "autoBatch", "batchHint", "poolUrl",
  "nodeName", "poolVersion", "uptime", "lastShare", "acceptance",
  "eventLog", "clearLog", "exportLog",
  "lifetimeHashes", "lifetimeGood", "lifetimeBad", "resetStats",
  "shareHistory", "shareCount",
  "notificationsEnabled", "soundEnabled",
  "helpButton", "helpDialog", "closeHelp",
];
const el = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
const numberFormat = new Intl.NumberFormat("en-US");

/* ---------- Persisted settings ---------- */

const persistedSettings = {
  username: "duco-gpu-lab.username",
  miningKey: "duco-gpu-lab.miningKey",
  rigName: "duco-gpu-lab.rigName",
  poolUrl: "duco-gpu-lab.poolUrl",
  batchSize: "duco-gpu-lab.batchSize",
  autoBatch: "duco-gpu-lab.autoBatch",
  notifications: "duco-gpu-lab.notifications",
  sound: "duco-gpu-lab.sound",
};
const LIFETIME_KEY = "duco-gpu-lab.lifetime";
const SHARES_KEY = "duco-gpu-lab.shareHistory";

const batchTuner = new BatchTuner([...el.batchSize.options].map(option => Number(option.value)));
let adapterPromise = null;
let webglModelCache = null;
let wakeLock = null;
let titleFlashTimer = 0;
let statsSaveTimer = 0;
const BASE_TITLE = "DUCO GPU Lab";

const state = {
  running: false, session: 0, hasher: null, requests: new Set(),
  startedAt: 0, lastShareAt: 0,
  totalHashes: 0, good: 0, bad: 0, rate: 0, peak: 0,
  rateSamples: Array(60).fill(0), latestJob: null,
  pools: [], poolIndex: 0, retryCount: 0,
};

const lifetime = { totalHashes: 0, good: 0, bad: 0 };
let shareHistory = [];

/* ---------- GPU detection (không đổi) ---------- */

function getMiningAdapter() {
  if (!navigator.gpu) return Promise.resolve(null);
  if (!adapterPromise) {
    adapterPromise = navigator.gpu.requestAdapter({ powerPreference: "high-performance" })
      .catch(error => { adapterPromise = null; throw error; });
  }
  return adapterPromise;
}

function webglGpuModel(info) {
  const vendor = info?.vendor?.trim().toLowerCase();
  if (!vendor) return "";
  if (webglModelCache?.vendor === vendor) return webglModelCache.name;
  let name = "";
  try {
    const gl = document.createElement("canvas").getContext("webgl2", { powerPreference: "high-performance" });
    const extension = gl?.getExtension("WEBGL_debug_renderer_info");
    const renderer = extension ? String(gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) || "") : "";
    const aliases = vendor === "amd" ? ["amd", "ati"] : [vendor];
    if (aliases.some(alias => renderer.toLowerCase().includes(alias))) {
      const angleModel = renderer.match(/^ANGLE \([^,]+,\s*([^,]+)(?:,|\))/i);
      name = (angleModel?.[1] || renderer)
        .replace(/\s*\(0x[\da-f]+\).*$/i, "")
        .replace(/\s+(?:Direct3D\d*|D3D\d*|Vulkan|OpenGL).*$/i, "")
        .trim();
    }
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch { /* Browser may restrict renderer details. */ }
  webglModelCache = { vendor, name };
  return name;
}

function showGpuName(info) {
  const description = info?.description?.trim();
  const device = info?.device?.trim();
  const vendor = info?.vendor?.trim();
  const architecture = info?.architecture?.trim();
  const webgpuModel = description || (device && !/^0x[\da-f]+$/i.test(device) ? device : "");
  const webglModel = webgpuModel ? "" : webglGpuModel(info);
  const name = webgpuModel || webglModel || [vendor, architecture].filter(Boolean).join(" ") || "GPU model unavailable";
  el.gpuName.textContent = name;
  el.gpuName.title = webglModel
    ? `${name} (reported by WebGL; WebGPU: ${[vendor, architecture].filter(Boolean).join(" ")})`
    : name;
}

async function detectGpu() {
  if (!navigator.gpu) { showGpuName(null); return; }
  try {
    const adapter = await getMiningAdapter();
    if (state.hasher) return;
    if (!adapter) {
      showGpuName(null);
      el.gpuSupport.textContent = "NO GPU ADAPTER";
      el.gpuSupport.classList.remove("supported");
      return;
    }
    showGpuName(adapter.info);
  } catch {
    if (!state.hasher) showGpuName(null);
  }
}

/* ---------- UI helpers ---------- */

function setStatus(text, kind = "idle") {
  el.statusText.textContent = text;
  el.statusDot.className = `status-dot ${kind}`;
}

function log(message, kind = "info") {
  const row = document.createElement("li");
  const time = document.createElement("time");
  const type = document.createElement("span");
  const detail = document.createElement("span");
  time.textContent = new Date().toLocaleTimeString("en-GB", { hour12: false });
  type.className = `log-type ${kind}`;
  type.textContent = kind.toUpperCase();
  detail.textContent = message;
  row.append(time, type, detail);
  el.eventLog.prepend(row);
  while (el.eventLog.children.length > 120) el.eventLog.lastElementChild.remove();
}

function flashTitle(message) {
  clearTimeout(titleFlashTimer);
  document.title = message;
  titleFlashTimer = setTimeout(() => { document.title = BASE_TITLE; }, 5000);
}

function shortRate(value) {
  if (value >= 1e9) return [value / 1e9, "GH/s"];
  if (value >= 1e6) return [value / 1e6, "MH/s"];
  if (value >= 1e3) return [value / 1e3, "kH/s"];
  return [value, "H/s"];
}

function formatRate(value) {
  const [amount, unit] = shortRate(value);
  return `${amount >= 100 ? amount.toFixed(0) : amount.toFixed(1)} ${unit}`;
}

function formatHashCount(value) {
  if (value < 1000) return numberFormat.format(value);
  const units = [[1e3, "K"], [1e6, "M"], [1e9, "B"], [1e12, "T"], [1e15, "Q"]];
  let index = units.findLastIndex(([scale]) => value >= scale);
  let amount = value / units[index][0];
  if (amount >= 999.5 && index < units.length - 1) amount = value / units[++index][0];
  return `${amount < 100 ? amount.toFixed(1) : amount.toFixed(0)}${units[index][1]}`;
}

/* ---------- Persistence ---------- */

function restoreSettings() {
  try {
    for (const [field, key] of Object.entries(persistedSettings)) {
      const saved = localStorage.getItem(key);
      if (saved === null) continue;
      const input = el[field];
      if (input.type === "checkbox") input.checked = saved === "true";
      else if (saved) input.value = saved;
    }
    const rawLifetime = localStorage.getItem(LIFETIME_KEY);
    if (rawLifetime) {
      const parsed = JSON.parse(rawLifetime);
      if (Number.isFinite(parsed.totalHashes)) lifetime.totalHashes = parsed.totalHashes;
      if (Number.isFinite(parsed.good)) lifetime.good = parsed.good;
      if (Number.isFinite(parsed.bad)) lifetime.bad = parsed.bad;
    }
    const rawShares = localStorage.getItem(SHARES_KEY);
    if (rawShares) {
      const parsed = JSON.parse(rawShares);
      if (Array.isArray(parsed)) shareHistory = parsed.slice(0, 20);
    }
  } catch { /* Storage may be unavailable; mining still works. */ }
}

function saveSettings() {
  try {
    for (const [field, key] of Object.entries(persistedSettings)) {
      const input = el[field];
      const value = input.type === "checkbox" ? String(input.checked) : input.value;
      localStorage.setItem(key, value);
    }
  } catch { /* Storage may be unavailable. */ }
}

function saveLifetimeStats() {
  try { localStorage.setItem(LIFETIME_KEY, JSON.stringify(lifetime)); } catch {}
}

function scheduleLifetimeSave() {
  if (statsSaveTimer) return;
  statsSaveTimer = setTimeout(() => { statsSaveTimer = 0; saveLifetimeStats(); }, 4000);
}

function saveShareHistory() {
  try { localStorage.setItem(SHARES_KEY, JSON.stringify(shareHistory)); } catch {}
}

/* ---------- Wake lock (không đổi) ---------- */

async function acquireWakeLock() {
  if (!state.running || wakeLock) return;
  if (!("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch (error) {
    log(`Screen wake lock unavailable: ${error.message || "denied"}.`, "warn");
  }
}

function releaseWakeLock() {
  const lock = wakeLock;
  wakeLock = null;
  lock?.release().catch(() => {});
}

document.addEventListener("visibilitychange", () => {
  if (state.running && document.visibilityState === "visible") acquireWakeLock();
});

/* ---------- Clipboard (không đổi) ---------- */

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy]");
  if (!button) return;
  const source = document.getElementById(button.dataset.copy);
  if (!source) return;
  const text = source.textContent;
  if (!text || /^(Waiting|No hash|Searching)/i.test(text)) return;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
    button.classList.add("copied");
    setTimeout(() => {
      button.textContent = "Copy";
      button.classList.remove("copied");
    }, 1200);
  } catch {
    log("Clipboard access was denied by the browser.", "warn");
  }
});

/* ---------- Notifications & sound ---------- */

function notifyShare(verdict) {
  if (!el.notificationsEnabled.checked) return;
  if (document.visibilityState === "visible") return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const accepted = verdict === "GOOD" || verdict === "BLOCK";
  try {
    new Notification(accepted ? "✓ Share accepted" : "✕ Share rejected", {
      body: accepted
        ? (verdict === "BLOCK" ? "The pool accepted a block reward." : "The pool confirmed your share.")
        : `Reason: ${verdict.slice(4) || "unknown"}`,
      tag: "duco-gpu-lab-share",
      silent: true,
    });
  } catch { /* Notification may throw in some browsers. */ }
}

async function requestNotifications() {
  if (!("Notification" in window)) {
    el.notificationsEnabled.checked = false;
    saveSettings();
    log("Desktop notifications are not supported by this browser.", "warn");
    return;
  }
  if (Notification.permission === "granted") return;
  if (Notification.permission === "denied") {
    el.notificationsEnabled.checked = false;
    saveSettings();
    log("Notification permission is blocked. Re-enable it in browser settings.", "warn");
    return;
  }
  try {
    const result = await Notification.requestPermission();
    if (result !== "granted") {
      el.notificationsEnabled.checked = false;
      saveSettings();
      log("Notification permission was denied.", "warn");
    } else {
      log("Desktop notifications enabled.");
    }
  } catch {
    el.notificationsEnabled.checked = false;
    saveSettings();
  }
}

let audioContext = null;
function playAlert(kind) {
  if (!el.soundEnabled.checked) return;
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === "suspended") audioContext.resume();
    const now = audioContext.currentTime;
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.connect(gain);
    gain.connect(audioContext.destination);
    if (kind === "good") {
      osc.type = "sine";
      osc.frequency.setValueAtTime(660, now);
      osc.frequency.setValueAtTime(880, now + 0.08);
    } else {
      osc.type = "triangle";
      osc.frequency.setValueAtTime(330, now);
      osc.frequency.setValueAtTime(220, now + 0.1);
    }
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.07, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
    osc.start(now);
    osc.stop(now + 0.3);
  } catch { /* Audio may be blocked until a user gesture. */ }
}

/* ---------- Keyboard shortcuts ---------- */

document.addEventListener("keydown", (event) => {
  if (event.target.closest("input, select, textarea, button, a, [contenteditable]")) return;
  if (event.key === "?" || (event.shiftKey && event.key === "/")) {
    event.preventDefault();
    if (!el.helpDialog.open) el.helpDialog.showModal();
    return;
  }
  if (event.key === "Escape") {
    if (el.helpDialog.open) { el.helpDialog.close(); return; }
    if (state.running) stop();
    return;
  }
  if (event.code === "Space") {
    event.preventDefault();
    if (state.running) stop(); else start();
    return;
  }
  if (event.key === "r" || event.key === "R") {
    if (!event.metaKey && !event.ctrlKey) { event.preventDefault(); resetStats(); }
  } else if (event.key === "c" || event.key === "C") {
    if (!event.metaKey && !event.ctrlKey) { event.preventDefault(); el.eventLog.replaceChildren(); log("Event log cleared."); }
  } else if (event.key === "e" || event.key === "E") {
    if (!event.metaKey && !event.ctrlKey) { event.preventDefault(); exportLog(); }
  }
});

el.helpButton.addEventListener("click", () => el.helpDialog.showModal());
el.closeHelp.addEventListener("click", () => el.helpDialog.close());

/* ---------- Metrics and chart ---------- */

function updateBatchHint() {
  el.batchHint.textContent = el.autoBatch.checked
    ? "Auto adjusts the selected size toward 55 to 95 ms per full batch. Stop waits for the current batch."
    : "Manual size. Check Batch time under Connection details. Stop waits for the current batch.";
}

function renderMetrics() {
  const [amount, unit] = shortRate(state.rate);
  el.hashrate.textContent = amount >= 100 ? amount.toFixed(0) : amount.toFixed(1);
  el.hashrate.title = formatRate(state.rate);
  el.rateUnit.textContent = unit;
  el.totalHashes.textContent = formatHashCount(state.totalHashes);
  el.totalHashes.title = `${numberFormat.format(state.totalHashes)} hashes`;
  el.goodShares.textContent = numberFormat.format(state.good);
  el.badShares.textContent = numberFormat.format(state.bad);
  el.peakRate.textContent = `PEAK ${formatRate(state.peak)}`;
  const shares = state.good + state.bad;
  el.acceptance.textContent = shares ? `${(100 * state.good / shares).toFixed(1)}%` : "--";
  el.lifetimeHashes.textContent = formatHashCount(lifetime.totalHashes);
  el.lifetimeHashes.title = `${numberFormat.format(lifetime.totalHashes)} hashes`;
  el.lifetimeGood.textContent = numberFormat.format(lifetime.good);
  el.lifetimeBad.textContent = numberFormat.format(lifetime.bad);
}

function drawChart() {
  const canvas = el.rateChart;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const width = Math.round(rect.width * dpr);
  const height = Math.round(rect.height * dpr);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = "rgba(170, 180, 186, .16)";
  ctx.lineWidth = dpr;
  for (let i = 1; i < 4; i++) {
    const y = Math.round(height * i / 4);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
  }
  if (!state.rateSamples.some(Boolean)) return;
  const max = Math.max(...state.rateSamples, 1) * 1.18;
  const points = state.rateSamples.map((value, i) => ({ x: width * i / 59, y: height - 22 * dpr - (height - 44 * dpr) * value / max }));
  ctx.beginPath();
  points.forEach((point, i) => i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
  const fill = ctx.createLinearGradient(0, 0, 0, height);
  fill.addColorStop(0, "rgba(243, 163, 106, .13)");
  fill.addColorStop(1, "rgba(243, 163, 106, 0)");
  ctx.lineTo(width, height); ctx.lineTo(0, height); ctx.closePath();
  ctx.fillStyle = fill; ctx.fill();
  ctx.beginPath();
  points.forEach((point, i) => i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
  ctx.strokeStyle = "#f3a36a"; ctx.lineWidth = 2 * dpr; ctx.lineJoin = "round"; ctx.stroke();
  const last = points.at(-1);
  ctx.beginPath(); ctx.arc(last.x, last.y, 3 * dpr, 0, Math.PI * 2); ctx.fillStyle = "#f3a36a"; ctx.fill();
}

el.rateChart.addEventListener("mousemove", (event) => {
  const rect = el.rateChart.getBoundingClientRect();
  if (!rect.width) return;
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  const index = Math.round(ratio * 59);
  const value = state.rateSamples[index];
  const secondsAgo = 59 - index;
  el.chartTooltip.textContent = `${formatRate(value)} · ${secondsAgo === 0 ? "now" : `${secondsAgo}s ago`}`;
  el.chartTooltip.style.left = `${(index / 59) * 100}%`;
  el.chartTooltip.hidden = false;
});
el.rateChart.addEventListener("mouseleave", () => { el.chartTooltip.hidden = true; });

function tick() {
  if (state.startedAt && state.running) {
    const seconds = Math.floor((Date.now() - state.startedAt) / 1000);
    el.uptime.textContent = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
      .map(value => String(value).padStart(2, "0")).join(":");
  }
  if (state.lastShareAt) el.lastShare.textContent = `${Math.floor((Date.now() - state.lastShareAt) / 1000)} s ago`;
  state.rateSamples.push(state.running ? state.rate : 0);
  state.rateSamples.shift();
  drawChart();
}

/* ---------- Pool protocol with failover ---------- */

function parsePools(value) {
  const urls = String(value).split(",").map(part => part.trim()).filter(Boolean);
  if (!urls.length) throw new Error("Enter at least one pool URL.");
  return urls.map(url => {
    const endpoint = new URL(url);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error("Pool URLs must use https:// without credentials or query strings.");
    }
    return { url, host: endpoint.host };
  });
}

function currentPool() { return state.pools[state.poolIndex]; }

function rotatePool() {
  if (state.pools.length < 2) return false;
  state.poolIndex = (state.poolIndex + 1) % state.pools.length;
  log(`Switching to fallback pool ${currentPool().host}.`, "warn");
  el.nodeName.textContent = currentPool().host;
  return true;
}

async function poolRequest(method, params) {
  if (!state.pools.length) throw new Error("No pool URL is configured.");
  const url = new URL("/legacy_job", currentPool().url);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set("nocache", Date.now());
  const controller = new AbortController();
  state.requests.add(controller);
  const timeout = setTimeout(() => controller.abort("Pool request timed out"), 20000);
  try {
    const response = await fetch(url, { method, signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error(`Pool returned HTTP ${response.status}.`);
    return (await response.text()).trim();
  } finally {
    clearTimeout(timeout);
    state.requests.delete(controller);
  }
}

function poolIdentity() {
  return { u: el.username.value.trim(), i: navigator.userAgent };
}

function parseJob(message) {
  const fields = message.split(",");
  if (fields.length !== 3 || !/^[0-9a-f]{40}$/i.test(fields[0]) ||
      !/^[0-9a-f]{40}$/i.test(fields[1]) || !/^\d+$/.test(fields[2])) {
    throw new Error(`Pool did not return a valid mining job: ${message.slice(0, 100)}`);
  }
  const difficulty = Number(fields[2]);
  if (!Number.isSafeInteger(difficulty) || difficulty < 1) throw new Error("Pool sent an invalid difficulty.");
  if (difficulty > Math.floor(GpuHasher.maxNonce / 100)) {
    throw new Error("Pool difficulty exceeds the supported GPU nonce range.");
  }
  return { previous: fields[0].toLowerCase(), target: fields[1].toLowerCase(), difficulty };
}

async function sha1Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/* ---------- Share history ---------- */

function recordShare({ nonce, verdict, latencyMs, difficulty }) {
  const accepted = verdict === "GOOD" || verdict === "BLOCK";
  shareHistory.unshift({
    at: Date.now(),
    nonce: String(nonce),
    verdict,
    accepted,
    block: verdict === "BLOCK",
    latencyMs,
    difficulty,
  });
  if (shareHistory.length > 20) shareHistory.length = 20;
  saveShareHistory();
  renderShareHistory();
}

function renderShareHistory() {
  const list = el.shareHistory;
  list.replaceChildren();
  const total = shareHistory.length;
  el.shareCount.textContent = `${total} share${total === 1 ? "" : "s"}`;
  if (!total) {
    const empty = document.createElement("li");
    empty.className = "share-empty";
    empty.textContent = "No shares submitted yet. Start mining to see results here.";
    list.append(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const share of shareHistory) {
    const row = document.createElement("li");
    row.className = `share-row ${share.accepted ? "accepted" : "rejected"}`;
    const time = document.createElement("time");
    time.textContent = new Date(share.at).toLocaleTimeString("en-GB", { hour12: false });
    time.title = new Date(share.at).toLocaleString();
    const badge = document.createElement("span");
    badge.className = "share-status";
    badge.textContent = share.accepted ? (share.block ? "BLOCK" : "GOOD") : "BAD";
    const nonce = document.createElement("code");
    nonce.textContent = `#${share.nonce}`;
    nonce.title = `Nonce ${share.nonce}`;
    const meta = document.createElement("span");
    meta.className = "share-meta";
    meta.textContent = `${share.latencyMs} ms · diff ${formatHashCount(share.difficulty)}`;
    row.append(time, badge, nonce, meta);
    fragment.append(row);
  }
  list.append(fragment);
}

/* ---------- Mining loop ---------- */

async function mineJob(job, session) {
  const maxNonce = job.difficulty * 100;
  let nextNonce = 0;
  let attempted = 0;
  const started = performance.now();
  let lastDisplay = 0;
  let lastFinished = started;
  const queued = [];
  const queueBatch = () => {
    const selectedBatchSize = Number(el.batchSize.value);
    const count = Math.min(selectedBatchSize, maxNonce - nextNonce + 1);
    const result = state.hasher.hashBatch(job.previous, job.target, nextNonce, count);
    result.catch(() => {});
    queued.push({ selectedBatchSize, count, result });
    nextNonce += count;
  };
  setStatus("GPU searching nonces", "active");
  while (state.running && session === state.session) {
    while (queued.length < 2 && nextNonce <= maxNonce) queueBatch();
    if (!queued.length) break;
    const batch = queued.shift();
    const result = await batch.result;
    if (!state.running || session !== state.session) return null;
    const finished = performance.now();
    const batchMs = finished - lastFinished;
    lastFinished = finished;
    el.batchTime.textContent = `${Math.round(batchMs)} ms`;
    if (el.autoBatch.checked && Number(el.batchSize.value) === batch.selectedBatchSize && batch.count === batch.selectedBatchSize) {
      const tuned = batchTuner.observe(batch.selectedBatchSize, batchMs);
      if (tuned !== batch.selectedBatchSize) {
        el.batchSize.value = String(tuned);
        saveSettings();
      }
    }
    attempted += result.count;
    state.totalHashes += result.count;
    lifetime.totalHashes += result.count;
    scheduleLifetimeSave();
    const lastNonce = result.start + result.count - 1;
    const seconds = Math.max((finished - started) / 1000, 0.001);
    const rawRate = attempted / seconds;
    state.rate = state.rate > 0 ? state.rate * 0.55 + rawRate * 0.45 : rawRate;
    state.peak = Math.max(state.peak, state.rate);
    if (result.found !== null || lastNonce >= maxNonce || finished - lastDisplay >= 200) {
      el.currentNonce.textContent = numberFormat.format(lastNonce);
      el.formulaInput.textContent = `${job.previous} + ${result.start}`;
      el.sampleHash.textContent = result.sample;
      el.chartEmpty.hidden = true;
      renderMetrics();
      lastDisplay = finished;
    }
    if (result.found !== null) {
      const matchedDigest = await sha1Hex(job.previous + result.found);
      if (matchedDigest !== job.target) throw new Error("GPU result failed independent SHA-1 verification.");
      if (!state.running || session !== state.session) return null;
      el.formulaInput.textContent = `${job.previous} + ${result.found}`;
      el.sampleHash.textContent = matchedDigest;
      el.lastMatch.textContent = numberFormat.format(result.found);
      el.matchBadge.textContent = "MATCH FOUND";
      el.matchBadge.classList.add("matched");
      log(`GPU found nonce ${result.found}. SHA-1 matches the pool target.`, "good");
      return { nonce: result.found, rate: state.rate, seconds };
    }
  }
  if (!state.running || session !== state.session) return null;
  log("No matching nonce within the full difficulty range. Requesting a new job.", "warn");
  return { exhausted: true };
}

async function runSession(session) {
  while (state.running && session === state.session) {
    try {
      setStatus("Requesting a pool job", "working");
      const job = parseJob(await poolRequest("GET", poolIdentity()));
      if (!state.running || session !== state.session) return;
      state.retryCount = 0;
      state.latestJob = job;
      el.poolVersion.textContent = "Legacy HTTP";
      el.difficulty.textContent = numberFormat.format(job.difficulty);
      el.targetHash.textContent = job.target;
      el.formulaInput.textContent = `${job.previous} + nonce`;
      el.sampleHash.textContent = "Searching on GPU";
      el.matchBadge.textContent = "SEARCHING";
      el.matchBadge.classList.remove("matched");
      log(`New job received at difficulty ${numberFormat.format(job.difficulty)}.`);
      const solution = await mineJob(job, session);
      if (!solution || !state.running || session !== state.session) return;
      if (solution.exhausted) {
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }
      const params = {
        ...poolIdentity(), r: solution.nonce, k: el.miningKey.value,
        s: `WebGPU Miner 1.1 (${el.rigName.value.trim() || "WebGPU-Lab"})`,
        j: job.target, h: solution.rate.toFixed(2), b: solution.seconds.toFixed(2),
      };
      setStatus("Waiting for pool verdict", "working");
      log(`Submitted nonce ${solution.nonce} at ${formatRate(solution.rate)}.`, "submit");
      const submittedAt = performance.now();
      const verdict = await poolRequest("POST", params);
      if (!state.running || session !== state.session) return;
      const latencyMs = Math.round(performance.now() - submittedAt);
      el.latency.textContent = `${latencyMs} ms`;
      state.lastShareAt = Date.now();
      recordShare({ nonce: solution.nonce, verdict, latencyMs, difficulty: job.difficulty });
      if (verdict === "GOOD" || verdict === "BLOCK") {
        state.good++;
        lifetime.good++;
        log(verdict === "BLOCK" ? "Pool accepted a block." : "Pool accepted the share.", "good");
        if (document.visibilityState === "hidden") flashTitle("✓ Share accepted");
        notifyShare(verdict);
        playAlert("good");
      } else if (verdict.startsWith("BAD")) {
        state.bad++;
        lifetime.bad++;
        log(`Pool rejected the share: ${verdict.slice(4) || "no reason given"}.`, "bad");
        if (document.visibilityState === "hidden") flashTitle("✕ Share rejected");
        notifyShare(verdict);
        playAlert("bad");
      } else {
        log(`Unexpected pool verdict: ${verdict.slice(0, 120)}`, "warn");
      }
      scheduleLifetimeSave();
      renderMetrics();
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (error) {
      if (!state.running || session !== state.session) return;
      if (/GPU|shader|invalid mining job|invalid difficulty|difficulty exceeds|SHA-1 verification|No high-performance|WebGPU is unavailable/i.test(error.message)) {
        fail(error);
        return;
      }
      state.retryCount++;
      if (state.retryCount >= 3 && state.pools.length > 1) {
        rotatePool();
        state.retryCount = 0;
      }
      const base = Math.min(state.retryCount * state.retryCount, 30);
      const jitter = Math.random() * 1.5;
      const delay = (base + jitter) * 1000;
      state.rate = 0;
      renderMetrics();
      setStatus(`Pool error. Retry in ${(delay / 1000).toFixed(1)} s`, "working");
      log(`Pool request failed: ${error.message}. Retrying.`, "warn");
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

function fail(error) {
  log(error.message || String(error), "bad");
  stop();
  setStatus(error.message || "Mining stopped after an error", "error");
}

/* ---------- Start / stop ---------- */

async function start() {
  if (state.running) return;
  const username = el.username.value.trim();
  if (!/^[A-Za-z0-9_]{1,32}$/.test(username)) {
    setStatus("Enter a valid Duino-Coin username", "error");
    el.username.focus();
    return;
  }
  if (/[,\r\n]/.test(el.rigName.value)) { fail(new Error("Rig name cannot contain commas or line breaks.")); return; }
  try {
    state.pools = parsePools(el.poolUrl.value);
    state.poolIndex = 0;
  } catch (error) {
    fail(error);
    return;
  }
  el.username.value = username;
  saveSettings();
  state.running = true;
  document.body.classList.add("mining");
  const session = ++state.session;
  state.startedAt = Date.now();
  state.lastShareAt = 0;
  state.totalHashes = state.good = state.bad = state.rate = state.peak = 0;
  state.rateSamples.fill(0);
  state.retryCount = 0;
  batchTuner.reset();
  el.uptime.textContent = "00:00:00";
  el.lastShare.textContent = "--";
  el.latency.textContent = "-- ms";
  el.batchTime.textContent = "-- ms";
  el.difficulty.textContent = "0";
  el.currentNonce.textContent = "0";
  el.lastMatch.textContent = "None yet";
  el.chartEmpty.hidden = false;
  el.matchBadge.textContent = "WAITING";
  el.matchBadge.classList.remove("matched");
  renderMetrics();
  el.nodeName.textContent = currentPool().host;
  el.poolVersion.textContent = "--";
  el.startButton.disabled = true;
  el.stopButton.disabled = false;
  for (const field of [el.username, el.miningKey, el.rigName, el.poolUrl]) field.disabled = true;
  setStatus("Initializing WebGPU", "working");
  log("Requesting high-performance WebGPU adapter and running SHA-1 self-test.");
  acquireWakeLock();
  try {
    if (!state.hasher) state.hasher = await GpuHasher.create(await getMiningAdapter());
    if (!state.running || session !== state.session) return;
    showGpuName(state.hasher.adapterInfo);
    el.gpuSupport.textContent = "GPU VERIFIED";
    el.gpuSupport.classList.add("supported");
    log("GPU SHA-1 self-tests passed, including a real pool job.", "good");
    state.hasher.device.lost.then(info => {
      state.hasher = null;
      adapterPromise = null;
      webglModelCache = null;
      if (state.running) fail(new Error(`GPU device lost: ${info.message || "unknown reason"}`));
    });
    log(`Connecting to ${currentPool().host} with the Mini Miner HTTP protocol.`);
    runSession(session);
  } catch (error) {
    if (state.running && session === state.session) fail(error);
  }
}

function stop() {
  if (!state.running) return;
  state.running = false;
  document.body.classList.remove("mining");
  state.session++;
  for (const request of state.requests) request.abort("Mining stopped");
  state.rate = 0;
  renderMetrics();
  el.startButton.disabled = false;
  el.stopButton.disabled = true;
  for (const field of [el.username, el.miningKey, el.rigName, el.poolUrl]) field.disabled = false;
  setStatus("Stopped", "idle");
  log("Mining stopped.");
  releaseWakeLock();
  saveLifetimeStats();
}

/* ---------- Reset & export ---------- */

function resetStats() {
  if (!confirm("Reset session and lifetime hashrate, accepted and rejected counters? This cannot be undone.")) return;
  state.totalHashes = state.good = state.bad = state.rate = state.peak = 0;
  state.rateSamples.fill(0);
  state.lastShareAt = 0;
  lifetime.totalHashes = lifetime.good = lifetime.bad = 0;
  shareHistory = [];
  saveLifetimeStats();
  saveShareHistory();
  renderShareHistory();
  renderMetrics();
  el.lastShare.textContent = "--";
  el.lastMatch.textContent = "None yet";
  log("Session and lifetime statistics were reset.", "warn");
}

function exportLog() {
  const lines = [];
  lines.push("DUCO GPU Lab event log");
  lines.push(`Exported: ${new Date().toISOString()}`);
  lines.push(`GPU: ${el.gpuName.textContent}`);
  lines.push(`User: ${el.username.value.trim() || "(none)"}`);
  lines.push(`Rig: ${el.rigName.value.trim() || "(none)"}`);
  lines.push(`Pools: ${el.poolUrl.value.trim() || "(none)"}`);
  lines.push(`Session hashes: ${state.totalHashes}`);
  lines.push(`Session accepted/rejected: ${state.good}/${state.bad}`);
  lines.push(`Lifetime hashes: ${lifetime.totalHashes}`);
  lines.push(`Lifetime accepted/rejected: ${lifetime.good}/${lifetime.bad}`);
  lines.push("");
  for (const row of [...el.eventLog.children].reverse()) {
    const time = row.querySelector("time")?.textContent ?? "";
    const type = row.querySelector(".log-type")?.textContent ?? "";
    const message = [...row.querySelectorAll("span")]
      .filter(node => !node.classList.contains("log-type"))
      .map(node => node.textContent).join(" ");
    lines.push(`${time}  ${type.padEnd(6)}  ${message}`);
  }
  const blob = new Blob([lines.join("\n")], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `duco-gpu-lab-log-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  log("Event log exported.", "good");
}

/* ---------- Wiring ---------- */

el.startButton.addEventListener("click", start);
el.stopButton.addEventListener("click", stop);
el.autoBatch.addEventListener("change", () => { batchTuner.reset(); updateBatchHint(); saveSettings(); });
el.batchSize.addEventListener("change", () => {
  el.autoBatch.checked = false;
  batchTuner.reset();
  updateBatchHint();
  saveSettings();
});
for (const field of ["username", "miningKey", "rigName", "poolUrl"]) {
  el[field].addEventListener("input", saveSettings);
}
el.notificationsEnabled.addEventListener("change", () => {
  saveSettings();
  if (el.notificationsEnabled.checked) requestNotifications();
});
el.soundEnabled.addEventListener("change", () => {
  saveSettings();
  if (el.soundEnabled.checked) playAlert("good");
});
el.clearLog.addEventListener("click", () => { el.eventLog.replaceChildren(); log("Event log cleared."); });
el.exportLog.addEventListener("click", exportLog);
el.resetStats.addEventListener("click", resetStats);
window.addEventListener("resize", drawChart);
window.addEventListener("beforeunload", (event) => {
  if (!state.running) return;
  event.preventDefault();
  event.returnValue = "";
});

/* ---------- Init ---------- */

restoreSettings();
updateBatchHint();
renderShareHistory();
renderMetrics();
el.gpuSupport.textContent = navigator.gpu ? "WEBGPU AVAILABLE" : "WEBGPU UNAVAILABLE";
el.gpuSupport.classList.toggle("supported", Boolean(navigator.gpu));
detectGpu();
drawChart();
setInterval(tick, 1000);
