import {
  TARGET_SAMPLE_RATE,
  concatFloat32,
  encodeWav,
  fileToWav,
  peakLevel,
  resample,
} from "./wav.js";

const $ = (id) => document.getElementById(id);

const el = {
  baseUrl: $("base-url"),
  language: $("language"),
  autoSend: $("auto-send"),
  expectedWrap: $("expected-wrap"),
  expectedText: $("expected-text"),
  recordBtn: $("record-btn"),
  sendBtn: $("send-btn"),
  downloadBtn: $("download-btn"),
  fileInput: $("file-input"),
  dropZone: $("drop-zone"),
  meter: $("meter"),
  peakValue: $("peak-value"),
  scope: $("scope"),
  scopeBadge: $("scope-badge"),
  clipTime: $("clip-time"),
  clipMeta: $("clip-meta"),
  playback: $("playback"),
  transcript: $("transcript"),
  gauges: $("gauges"),
  statusTag: $("status-tag"),
  rawJson: $("raw-json"),
  history: $("history"),
  clearHistory: $("clear-history"),
  healthDot: $("health-dot"),
  healthText: $("health-text"),
  healthBtn: $("health-btn"),
};

const METER_SEGMENTS = 28;
const SCOPE_WINDOW_SECONDS = 4;

const state = {
  recording: false,
  sending: false,
  ctx: null,
  stream: null,
  node: null,
  source: null,
  chunks: [],
  live: new Float32Array(0), // đuôi tín hiệu để vẽ scope lúc đang ghi
  startedAt: 0,
  peakHold: 0,
  wavBlob: null,
  wavSamples: null,
  wavDuration: 0,
  playbackUrl: null,
  takeNo: 0,
  rafId: 0,
};

// ---------------- endpoint helpers ----------------

const endpointInputs = [...document.querySelectorAll('input[name="endpoint"]')];
const currentEndpoint = () => endpointInputs.find((i) => i.checked).value;

function syncEndpointUi() {
  el.expectedWrap.hidden = currentEndpoint() !== "/api/speech/assess";
}

// ---------------- settings ----------------

const SETTINGS_KEY = "tinyspeech-audio-test";

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    if (saved.baseUrl) el.baseUrl.value = saved.baseUrl;
    if (saved.language) el.language.value = saved.language;
    if (saved.expectedText) el.expectedText.value = saved.expectedText;
    if (typeof saved.autoSend === "boolean") el.autoSend.checked = saved.autoSend;
    const match = endpointInputs.find((i) => i.value === saved.endpoint);
    if (match) match.checked = true;
  } catch {
    /* localStorage bị chặn — chạy với mặc định */
  }
}

function saveSettings() {
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        baseUrl: el.baseUrl.value.trim(),
        endpoint: currentEndpoint(),
        language: el.language.value.trim(),
        expectedText: el.expectedText.value,
        autoSend: el.autoSend.checked,
      }),
    );
  } catch {
    /* ignore */
  }
}

const baseUrl = () => el.baseUrl.value.trim().replace(/\/+$/, "");

// ---------------- meter ----------------

const segments = [];
for (let i = 0; i < METER_SEGMENTS; i++) {
  const seg = document.createElement("i");
  if (i >= METER_SEGMENTS - 3) seg.classList.add("hot");
  else if (i >= METER_SEGMENTS - 8) seg.classList.add("mid");
  segments.push(seg);
  el.meter.appendChild(seg);
}

function drawMeter(peak) {
  // Thang dB dễ đọc hơn biên độ tuyến tính: giọng nói bình thường nằm giữa dải.
  const db = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  const ratio = Math.max(0, Math.min(1, (db + 48) / 48));
  const lit = Math.round(ratio * METER_SEGMENTS);
  segments.forEach((seg, i) => seg.classList.toggle("on", i < lit));
  el.peakValue.textContent = db === -Infinity ? "-∞ dB" : `${db.toFixed(1)} dB`;
}

function resetMeter() {
  segments.forEach((seg) => seg.classList.remove("on"));
  el.peakValue.textContent = "—";
}

// ---------------- scope ----------------

const ctx2d = el.scope.getContext("2d");

function fitScope() {
  const dpr = window.devicePixelRatio || 1;
  const rect = el.scope.getBoundingClientRect();
  if (!rect.width) return;
  el.scope.width = Math.round(rect.width * dpr);
  el.scope.height = Math.round(rect.height * dpr);
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawScope(samples, color = "#35d6a4") {
  const w = el.scope.clientWidth;
  const h = el.scope.clientHeight;
  if (!w || !h) return;

  ctx2d.clearRect(0, 0, w, h);

  // lưới
  ctx2d.strokeStyle = "rgba(255,255,255,0.05)";
  ctx2d.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = (h / 4) * i;
    ctx2d.beginPath();
    ctx2d.moveTo(0, y);
    ctx2d.lineTo(w, y);
    ctx2d.stroke();
  }

  // đường 0 dB
  ctx2d.strokeStyle = "rgba(255,255,255,0.12)";
  ctx2d.beginPath();
  ctx2d.moveTo(0, h / 2);
  ctx2d.lineTo(w, h / 2);
  ctx2d.stroke();

  if (!samples || samples.length === 0) return;

  // Vẽ min/max mỗi cột pixel — giữ được đỉnh transient thay vì lấy mẫu thưa.
  const step = samples.length / w;
  ctx2d.fillStyle = color;
  for (let x = 0; x < w; x++) {
    const start = Math.floor(x * step);
    const end = Math.min(samples.length, Math.floor((x + 1) * step));
    let min = 1;
    let max = -1;
    for (let i = start; i < end; i++) {
      const v = samples[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (end <= start) { min = 0; max = 0; }
    const y1 = ((1 - max) / 2) * h;
    const y2 = ((1 - min) / 2) * h;
    ctx2d.fillRect(x, y1, 1, Math.max(1.2, y2 - y1));
  }
}

function setScopeBadge(text, kind = "") {
  el.scopeBadge.textContent = text;
  el.scopeBadge.className = `scope-badge ${kind}`;
}

// ---------------- health ----------------

async function checkHealth() {
  setHealth("unknown", "đang kiểm tra…");
  try {
    const res = await fetch(`${baseUrl()}/health`);
    const data = await res.json();
    const ok = data.status === "healthy";
    setHealth(
      ok ? "ok" : "warn",
      `${data.status} · ${data.model || "?"} · ${data.device || "?"}`,
    );
  } catch (err) {
    setHealth("bad", `offline (${err.message})`);
  }
}

function setHealth(kind, text) {
  el.healthDot.className = `led ${kind}`;
  el.healthText.textContent = text;
}

// ---------------- recording ----------------

async function startRecording() {
  state.stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  // Xin thẳng 16 kHz; nếu trình duyệt ép rate khác thì resample lúc encode.
  state.ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  await state.ctx.audioWorklet.addModule("recorder-worklet.js");

  state.source = state.ctx.createMediaStreamSource(state.stream);
  state.node = new AudioWorkletNode(state.ctx, "recorder-processor");
  state.chunks = [];
  state.live = new Float32Array(0);
  state.peakHold = 0;

  const windowSamples = state.ctx.sampleRate * SCOPE_WINDOW_SECONDS;
  state.node.port.onmessage = (event) => {
    state.chunks.push(event.data);
    state.live = concatFloat32([state.live, event.data]);
    if (state.live.length > windowSamples) state.live = state.live.slice(-windowSamples);
    state.peakHold = Math.max(state.peakHold, peakLevel(event.data));
  };

  state.source.connect(state.node);
  // Worklet cần một đích để được pull; gain 0 giữ im lặng, tránh vọng loa.
  const silent = state.ctx.createGain();
  silent.gain.value = 0;
  state.node.connect(silent).connect(state.ctx.destination);

  state.recording = true;
  state.startedAt = performance.now();
  el.recordBtn.classList.add("active");
  el.recordBtn.querySelector(".rec-label").textContent = "STOP";
  setScopeBadge("● recording", "live");
  el.clipMeta.textContent = "đang thu…";
  tick();
}

function tick() {
  if (!state.recording) return;
  const elapsed = (performance.now() - state.startedAt) / 1000;
  el.clipTime.textContent = formatTime(elapsed);
  drawScope(state.live, "#ff8a72");
  drawMeter(state.peakHold);
  state.peakHold *= 0.82; // ballistics kiểu VU: rơi mềm thay vì nhảy giật
  state.rafId = requestAnimationFrame(tick);
}

async function stopRecording() {
  state.recording = false;
  cancelAnimationFrame(state.rafId);
  el.recordBtn.classList.remove("active");
  el.recordBtn.querySelector(".rec-label").textContent = "RECORD";
  resetMeter();

  state.node?.port.close();
  state.source?.disconnect();
  state.node?.disconnect();
  state.stream?.getTracks().forEach((t) => t.stop());
  const ctxRate = state.ctx?.sampleRate || TARGET_SAMPLE_RATE;
  await state.ctx?.close();
  state.ctx = null;

  const raw = concatFloat32(state.chunks);
  state.chunks = [];
  state.live = new Float32Array(0);

  if (raw.length === 0) {
    setScopeBadge("no signal", "");
    el.clipMeta.textContent = "không thu được mẫu — kiểm tra quyền mic";
    return;
  }

  const samples = resample(raw, ctxRate);
  setClip(encodeWav(samples), samples, `mic · ${ctxRate} Hz`);

  if (el.autoSend.checked) await send();
}

function setClip(blob, samples, note) {
  state.wavBlob = blob;
  state.wavSamples = samples;
  state.wavDuration = samples.length / TARGET_SAMPLE_RATE;

  el.sendBtn.disabled = false;
  el.downloadBtn.disabled = false;
  el.clipTime.textContent = formatTime(state.wavDuration);
  el.clipMeta.textContent = `${note} → 16k mono · ${(blob.size / 1024).toFixed(0)} KB`;
  el.clipMeta.title = `${note} → PCM 16-bit mono 16 kHz · ${(blob.size / 1024).toFixed(1)} KB`;

  drawScope(samples);
  const peakDb = 20 * Math.log10(Math.max(peakLevel(samples), 1e-6));
  setScopeBadge(`clip · peak ${peakDb.toFixed(1)} dB`, "armed");

  if (state.playbackUrl) URL.revokeObjectURL(state.playbackUrl);
  state.playbackUrl = URL.createObjectURL(blob);
  el.playback.src = state.playbackUrl;
  el.playback.hidden = false;
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds * 100) % 100);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

// ---------------- send ----------------

async function send() {
  if (!state.wavBlob || state.sending) return;

  const endpoint = currentEndpoint();
  const expected = el.expectedText.value.trim();
  if (endpoint === "/api/speech/assess" && !expected) {
    showError("Endpoint assess cần expected text.");
    el.expectedText.focus();
    return;
  }

  const form = new FormData();
  form.append("audio", state.wavBlob, "recording.wav");
  form.append("language", el.language.value.trim() || "en");
  if (expected) form.append("expected_text", expected);

  setSending(true);
  const started = performance.now();
  try {
    const res = await fetch(`${baseUrl()}${endpoint}`, { method: "POST", body: form });
    const elapsed = Math.round(performance.now() - started);
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const detail = data.detail || data;
      showError(`HTTP ${res.status} · ${detail.message || detail.error || res.statusText}`);
      el.gauges.innerHTML = "";
      if (detail.code) addGauge("code", detail.code);
      el.rawJson.textContent = JSON.stringify(data, null, 2);
      setStatus("error", "err");
      addTake({ text: `HTTP ${res.status} ${detail.code || detail.error || ""}`, endpoint, elapsed, ok: false });
      return;
    }

    render(data, endpoint, elapsed);
  } catch (err) {
    showError(`Không gọi được server: ${err.message}`);
    el.rawJson.textContent = "—";
    setStatus("error", "err");
    addTake({ text: err.message, endpoint, elapsed: 0, ok: false });
  } finally {
    setSending(false);
  }
}

function render(data, endpoint, elapsed) {
  const text = data.transcript ?? data.transcribed_text ?? data.text ?? "";
  el.transcript.className = text ? "readout-text" : "readout-text placeholder";
  el.transcript.textContent = text || "server trả về chuỗi rỗng";

  el.gauges.innerHTML = "";
  addGauge("latency", `${elapsed} ms`, elapsed > 3000 ? "warn" : "good");
  addGauge("audio", `${state.wavDuration.toFixed(2)} s`);
  addGauge("rtf", (elapsed / 1000 / Math.max(state.wavDuration, 0.01)).toFixed(2));
  if (typeof data.confidence === "number") {
    addGauge("confidence", data.confidence.toFixed(3), data.confidence >= 0.7 ? "good" : "warn");
  }
  if (typeof data.accuracy === "number") {
    addGauge("accuracy", data.accuracy.toFixed(3), data.accuracy >= 0.7 ? "good" : "warn");
  }
  if (data.meta?.assess_ms) addGauge("server", `${Math.round(data.meta.assess_ms)} ms`);

  el.rawJson.textContent = JSON.stringify(data, null, 2);
  setStatus(`${elapsed} ms`, "ok");
  addTake({ text: text || "(rỗng)", endpoint, elapsed, ok: true });
}

function showError(message) {
  el.transcript.className = "readout-text error";
  el.transcript.textContent = message;
}

function addGauge(label, value, kind = "") {
  const div = document.createElement("div");
  div.className = `gauge ${kind}`;
  div.innerHTML = "<b></b><span></span>";
  div.querySelector("b").textContent = value;
  div.querySelector("span").textContent = label;
  el.gauges.appendChild(div);
}

function setStatus(text, kind = "") {
  el.statusTag.textContent = text;
  el.statusTag.className = `module-tag ${kind}`;
}

function setSending(sending) {
  state.sending = sending;
  // Model chạy 1 request một lúc (SPEECH_MAX_CONCURRENCY=1); khoá transport để
  // không tự xếp hàng chồng lên nhau.
  el.sendBtn.disabled = sending || !state.wavBlob;
  el.recordBtn.disabled = sending;
  if (sending) {
    el.transcript.className = "readout-text placeholder";
    el.transcript.textContent = "đang xử lý trên server…";
    el.gauges.innerHTML = "";
    setStatus("processing", "busy");
  }
}

function addTake({ text, endpoint, elapsed, ok }) {
  el.history.querySelector(".takes-empty")?.remove();
  state.takeNo += 1;

  const li = document.createElement("li");
  li.className = ok ? "take" : "take err";
  li.innerHTML =
    '<span class="take-no"></span><span class="take-text"></span><span class="take-meta"></span>';
  li.querySelector(".take-no").textContent = String(state.takeNo).padStart(2, "0");
  li.querySelector(".take-text").textContent = text;
  li.querySelector(".take-meta").textContent =
    `${new Date().toLocaleTimeString()} · ${endpoint} · ${elapsed} ms · ${state.wavDuration.toFixed(2)}s`;
  el.history.prepend(li);
}

// ---------------- wiring ----------------

async function toggleRecord() {
  if (state.sending) return;
  try {
    if (state.recording) await stopRecording();
    else await startRecording();
  } catch (err) {
    state.recording = false;
    cancelAnimationFrame(state.rafId);
    el.recordBtn.classList.remove("active");
    el.recordBtn.querySelector(".rec-label").textContent = "RECORD";
    setScopeBadge("mic error", "");
    el.clipMeta.textContent = `lỗi mic: ${err.message}`;
  }
}

el.recordBtn.addEventListener("click", toggleRecord);
el.sendBtn.addEventListener("click", send);

document.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || e.repeat) return;
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement === el.playback) return;
  e.preventDefault();
  toggleRecord();
});

el.downloadBtn.addEventListener("click", () => {
  if (!state.wavBlob) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(state.wavBlob);
  a.download = `tinyspeech-take-${String(state.takeNo + 1).padStart(2, "0")}.wav`;
  a.click();
  URL.revokeObjectURL(a.href);
});

async function loadFile(file) {
  if (!file) return;
  try {
    setScopeBadge("decoding…", "");
    const blob = await fileToWav(file);
    const pcm = new DataView(await blob.arrayBuffer());
    const samples = new Float32Array((blob.size - 44) / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = pcm.getInt16(44 + i * 2, true) / 0x8000;
    setClip(blob, samples, file.name);
    if (el.autoSend.checked) await send();
  } catch (err) {
    setScopeBadge("decode error", "");
    el.clipMeta.textContent = `không đọc được file: ${err.message}`;
  }
}

el.fileInput.addEventListener("change", () => loadFile(el.fileInput.files?.[0]));

for (const type of ["dragenter", "dragover"]) {
  el.dropZone.addEventListener(type, (e) => {
    e.preventDefault();
    el.dropZone.classList.add("over");
  });
}
for (const type of ["dragleave", "drop"]) {
  el.dropZone.addEventListener(type, (e) => {
    e.preventDefault();
    el.dropZone.classList.remove("over");
  });
}
el.dropZone.addEventListener("drop", (e) => loadFile(e.dataTransfer?.files?.[0]));

el.clearHistory.addEventListener("click", () => {
  state.takeNo = 0;
  el.history.innerHTML = '<li class="takes-empty">Chưa có lần thử nào.</li>';
});

el.healthBtn.addEventListener("click", checkHealth);
endpointInputs.forEach((input) =>
  input.addEventListener("change", () => {
    syncEndpointUi();
    saveSettings();
  }),
);
for (const input of [el.baseUrl, el.language, el.expectedText, el.autoSend]) {
  input.addEventListener("change", saveSettings);
}

window.addEventListener("resize", () => {
  fitScope();
  drawScope(state.recording ? state.live : state.wavSamples, state.recording ? "#ff8a72" : "#35d6a4");
});

loadSettings();
syncEndpointUi();
fitScope();
drawScope(null);
setScopeBadge("idle");
checkHealth();
