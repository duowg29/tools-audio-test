import {
  CONFUSABLE_PAIRS,
  DEVICE,
  DIAGNOSTIC_PATHS,
  MODES,
  OTG_MODES,
  OTG_SCREENS,
  healthVerdict,
  scoreAssess,
} from "./modes.js";
import { STOP_REASON_VI, createUtteranceGate } from "./vad.js";
import {
  TARGET_SAMPLE_RATE,
  concatFloat32,
  dbfs,
  encodeWav,
  fileToWav,
  likelyContainsSpeech,
  peakLevel,
  resample,
} from "./wav.js";

const $ = (id) => document.getElementById(id);

const el = {
  baseUrl: $("base-url"),
  expected: $("expected-text"),
  language: $("language"),
  otgScreen: $("otg-screen"),
  otgScreens: $("otg-screens"),
  otgMode: $("otg-mode"),
  otgActivity: $("otg-activity"),
  dsWord: $("ds-word"),
  dsWords: $("ds-words"),
  dsPairs: $("ds-pairs"),
  dsOther: $("ds-other"),
  dsOtherWrap: $("ds-other-wrap"),
  dsSpeaker: $("ds-speaker"),
  autoSend: $("auto-send"),
  autoStop: $("auto-stop"),
  rawMic: $("raw-mic"),
  gateOn: $("gate-on"),
  gateOff: $("gate-off"),
  modeNote: $("mode-note"),
  diagList: $("diag-list"),
  recordBtn: $("record-btn"),
  sendBtn: $("send-btn"),
  downloadBtn: $("download-btn"),
  fileInput: $("file-input"),
  dropZone: $("drop-zone"),
  meter: $("meter"),
  tickOn: $("tick-on"),
  tickOff: $("tick-off"),
  peakValue: $("peak-value"),
  gateState: $("gate-state"),
  scope: $("scope"),
  scopeBadge: $("scope-badge"),
  clipTime: $("clip-time"),
  clipMeta: $("clip-meta"),
  playback: $("playback"),
  inputTag: $("input-tag"),
  outputTitle: $("output-title"),
  verdict: $("verdict"),
  transcript: $("transcript"),
  gauges: $("gauges"),
  statusTag: $("status-tag"),
  rawJson: $("raw-json"),
  history: $("history"),
  clearHistory: $("clear-history"),
  healthDot: $("health-dot"),
  healthText: $("health-text"),
  gwDot: $("gw-dot"),
  gwText: $("gw-text"),
  healthBtn: $("health-btn"),
  datasetPanel: $("dataset-panel"),
  dsProgress: $("ds-progress"),
  dsTotal: $("ds-total"),
  dsDir: $("ds-dir"),
};

const METER_SEGMENTS = 28;
const SCOPE_WINDOW_SECONDS = 4;
//: Thang meter phải xuống tới -60 dB, nếu không ngưỡng gate (-52/-58) rơi ra
//: ngoài màn hình và không ai thấy cổng đang làm việc.
const METER_FLOOR_DB = -60;

const state = {
  recording: false,
  sending: false,
  ctx: null,
  stream: null,
  node: null,
  source: null,
  gate: null,
  live: new Float32Array(0),
  clip: null, // { blob, samples, duration, speechStartSample, stopReason, voicedMs, energy }
  playbackUrl: null,
  takeNo: 0,
  rafId: 0,
  health: { at: 0, up: false, why: "", raw: null },
  config: null,
  dataset: null,
};

const modeInputs = [...document.querySelectorAll('input[name="mode"]')];
const labelInputs = [...document.querySelectorAll('input[name="ds-label"]')];
const currentMode = () => MODES[modeInputs.find((i) => i.checked).value];

// ── ngữ cảnh gửi ────────────────────────────────────────────────────────

function ctxOf() {
  const label = labelInputs.find((i) => i.checked)?.value || "dung";
  return {
    expected: el.expected.value,
    language: el.language.value.trim() || "en",
    screen: el.otgScreen.value.trim(),
    mode: el.otgMode.value,
    activity: el.otgActivity.value,
    word: el.dsWord.value.trim().toLowerCase(),
    label: label === "khac" ? `khac-${el.dsOther.value.trim().toLowerCase()}` : label,
    labelBucket: label,
    speaker: el.dsSpeaker.value.trim().toLowerCase(),
  };
}

function missingField(mode, ctx) {
  for (const need of mode.needs) {
    if (need === "expected" && !ctx.expected.trim()) return "expected text";
    if (need === "screen" && !ctx.screen) return "current_screen";
    if (need === "mode" && !ctx.mode) return "current_mode";
    if (need === "word" && !ctx.word) return "từ mong đợi";
    if (need === "speaker" && !ctx.speaker) return "người đọc";
    if (need === "label" && ctx.labelBucket === "khac" && !el.dsOther.value.trim()) {
      return "từ đọc thành";
    }
  }
  return null;
}

// ── cấu hình + lưu setting ──────────────────────────────────────────────

const SETTINGS_KEY = "tinyspeech-bench";

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    if (s.baseUrl) el.baseUrl.value = s.baseUrl;
    if (s.expected) el.expected.value = s.expected;
    if (s.language) el.language.value = s.language;
    if (s.screen) el.otgScreen.value = s.screen;
    if (s.activity) el.otgActivity.value = s.activity;
    if (s.word) el.dsWord.value = s.word;
    if (s.speaker) el.dsSpeaker.value = s.speaker;
    if (typeof s.autoSend === "boolean") el.autoSend.checked = s.autoSend;
    if (typeof s.autoStop === "boolean") el.autoStop.checked = s.autoStop;
    if (typeof s.rawMic === "boolean") el.rawMic.checked = s.rawMic;
    const m = modeInputs.find((i) => i.value === s.mode);
    if (m) m.checked = true;
    if (s.otgMode) state.savedOtgMode = s.otgMode;
  } catch {
    /* localStorage bị chặn — chạy với mặc định */
  }

  // ?mode=otg để mở thẳng một mode — tiện khi mở nhiều tab cạnh nhau.
  const wanted = new URLSearchParams(location.search).get("mode");
  const picked = modeInputs.find((i) => i.value === wanted);
  if (picked) picked.checked = true;
}

function saveSettings() {
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        baseUrl: el.baseUrl.value.trim(),
        mode: currentMode().id,
        expected: el.expected.value,
        language: el.language.value.trim(),
        screen: el.otgScreen.value.trim(),
        otgMode: el.otgMode.value,
        activity: el.otgActivity.value,
        word: el.dsWord.value.trim(),
        speaker: el.dsSpeaker.value.trim(),
        autoSend: el.autoSend.checked,
        autoStop: el.autoStop.checked,
        rawMic: el.rawMic.checked,
      }),
    );
  } catch {
    /* ignore */
  }
}

async function loadConfig() {
  try {
    const res = await fetch("/bench/config");
    state.config = await res.json();
    if (!el.baseUrl.value.trim()) el.baseUrl.value = state.config.upstream;
    if (state.config.upstream_locked) {
      el.baseUrl.value = state.config.upstream;
      el.baseUrl.disabled = true;
      el.baseUrl.title = "Đã khoá bằng --upstream-lock";
    }
    el.dsDir.textContent = `${state.config.fixtures_dir}${state.config.fixtures_writable ? "" : "  [CHỈ ĐỌC]"}`;
  } catch {
    // Mở bằng static server khác thì không có /bench/config — vẫn chạy được
    // mọi thứ trừ relay và ghi fixture.
    if (!el.baseUrl.value.trim()) el.baseUrl.value = "http://127.0.0.1:8000";
    el.dsDir.textContent = "không đọc được /bench/config — hãy chạy qua serve.py";
  }
}

const upstream = () => el.baseUrl.value.trim().replace(/\/+$/, "");

/** Mọi request đi qua relay same-origin của serve.py.
 *
 * Không phải để tiện — Intent API không có CORS nên trình duyệt KHÔNG THỂ gọi
 * thẳng /otg/intent/voice. App native không vướng CORS, nên relay mới là bản mô
 * phỏng đúng, chứ không phải một đường tắt.
 */
function relay(path, init = {}) {
  const headers = { "X-Bench-Upstream": upstream(), ...(init.headers || {}) };
  return fetch(`/relay${path}`, { ...init, headers });
}

// ── health ──────────────────────────────────────────────────────────────

async function checkHealthQuick({ force = false } = {}) {
  const now = performance.now();
  if (!force && state.health.at && now - state.health.at < DEVICE.healthCacheMs) {
    return state.health;
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), DEVICE.healthTimeoutMs);
  try {
    const res = await relay("/health", { signal: ctl.signal });
    const data = await res.json();
    const v = res.ok ? healthVerdict(data) : { up: false, why: `HTTP ${res.status}` };
    state.health = { at: now, up: v.up, why: v.why, raw: data };
  } catch (err) {
    state.health = { at: now, up: false, why: err.name === "AbortError" ? "timeout 1.5s" : err.message, raw: null };
  } finally {
    clearTimeout(timer);
  }

  const h = state.health;
  el.healthDot.className = `led ${h.up ? "ok" : "bad"}`;
  el.healthText.textContent = h.up
    ? `${h.raw?.model || "?"} · ${h.raw?.device || "?"}`
    : h.why;
  return h;
}

async function checkGateway() {
  try {
    const res = await relay("/gateway/health");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    el.gwDot.className = "led ok";
    el.gwText.textContent = `→ ${data.intent_prefix || "/otg"}`;
    return true;
  } catch {
    el.gwDot.className = "led warn";
    el.gwText.textContent = "không thấy (chỉ speech)";
    return false;
  }
}

// ── meter + scope ───────────────────────────────────────────────────────

const segments = [];
for (let i = 0; i < METER_SEGMENTS; i++) {
  const seg = document.createElement("i");
  if (i >= METER_SEGMENTS - 3) seg.classList.add("hot");
  else if (i >= METER_SEGMENTS - 8) seg.classList.add("mid");
  segments.push(seg);
  el.meter.appendChild(seg);
}

const meterPct = (db) => Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / -METER_FLOOR_DB));

function drawMeter(db) {
  const lit = Math.round(meterPct(db) * METER_SEGMENTS);
  segments.forEach((seg, i) => seg.classList.toggle("on", i < lit));
  el.peakValue.textContent = db === -Infinity ? "-∞ dB" : `${db.toFixed(1)} dB`;
}

function resetMeter() {
  segments.forEach((seg) => seg.classList.remove("on"));
  el.peakValue.textContent = "—";
}

function placeGateTicks() {
  const { gateOnDb, gateOffDb } = gateThresholds();
  el.tickOn.style.left = `${meterPct(gateOnDb) * 100}%`;
  el.tickOff.style.left = `${meterPct(gateOffDb) * 100}%`;
  el.tickOn.title = `gate on ${gateOnDb} dB`;
  el.tickOff.title = `gate off ${gateOffDb} dB`;
}

const ctx2d = el.scope.getContext("2d");

function fitScope() {
  const dpr = window.devicePixelRatio || 1;
  const rect = el.scope.getBoundingClientRect();
  if (!rect.width) return;
  el.scope.width = Math.round(rect.width * dpr);
  el.scope.height = Math.round(rect.height * dpr);
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawScope(samples, color = "#35d6a4", speechStartSample = -1) {
  const w = el.scope.clientWidth;
  const h = el.scope.clientHeight;
  if (!w || !h) return;

  ctx2d.clearRect(0, 0, w, h);

  ctx2d.strokeStyle = "rgba(255,255,255,0.05)";
  ctx2d.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = (h / 4) * i;
    ctx2d.beginPath();
    ctx2d.moveTo(0, y);
    ctx2d.lineTo(w, y);
    ctx2d.stroke();
  }
  ctx2d.strokeStyle = "rgba(255,255,255,0.12)";
  ctx2d.beginPath();
  ctx2d.moveTo(0, h / 2);
  ctx2d.lineTo(w, h / 2);
  ctx2d.stroke();

  if (!samples || samples.length === 0) return;

  // Phần trước lúc cổng mở: tô mờ, để thấy ngay bench đã ngậm bao nhiêu im lặng.
  if (speechStartSample > 0) {
    const x = (speechStartSample / samples.length) * w;
    ctx2d.fillStyle = "rgba(255,255,255,0.045)";
    ctx2d.fillRect(0, 0, x, h);
    ctx2d.strokeStyle = "rgba(255,180,84,0.65)";
    ctx2d.beginPath();
    ctx2d.moveTo(x, 0);
    ctx2d.lineTo(x, h);
    ctx2d.stroke();
  }

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

// ── ghi âm ──────────────────────────────────────────────────────────────

function gateThresholds() {
  const mode = currentMode();
  const base = mode.recording(ctxOf());
  const on = Number(el.gateOn.value);
  const off = Number(el.gateOff.value);
  return {
    gateOnDb: Number.isFinite(on) ? on : base.gateOnDb,
    gateOffDb: Number.isFinite(off) ? off : base.gateOffDb,
  };
}

function seedGateInputs() {
  const base = currentMode().recording(ctxOf());
  el.gateOn.value = String(base.gateOnDb);
  el.gateOff.value = String(base.gateOffDb);
  placeGateTicks();
}

async function startRecording() {
  const mode = currentMode();
  const ctx = ctxOf();
  const missing = missingField(mode, ctx);
  if (missing) {
    showError(`Thiếu ${missing}.`);
    return;
  }

  const raw = el.rawMic.checked;
  state.stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: !raw,
      noiseSuppression: !raw,
      autoGainControl: !raw,
    },
  });

  state.ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  await state.ctx.audioWorklet.addModule("recorder-worklet.js");

  state.source = state.ctx.createMediaStreamSource(state.stream);
  state.node = new AudioWorkletNode(state.ctx, "recorder-processor");
  state.live = new Float32Array(0);

  const rec = mode.recording(ctx);
  const { gateOnDb, gateOffDb } = gateThresholds();
  const off = !el.autoStop.checked;

  state.gate = createUtteranceGate({
    sampleRate: state.ctx.sampleRate,
    gateOnDb,
    gateOffDb,
    pollMs: DEVICE.pollMs,
    minSpeechFrames: rec.minSpeechFrames,
    // Tắt auto-stop = chỉ tắt các mốc thời gian, cổng vẫn chạy để còn nhìn thấy.
    silenceAfterSpeechMs: off ? Infinity : rec.silenceAfterSpeechMs,
    inactivityStopMs: off ? Infinity : rec.inactivityStopMs,
    maxMs: off ? Infinity : rec.maxMs,
    preRollMs: rec.preRollMs,
    onTick: ({ level, state: gs }) => {
      drawMeter(level);
      el.gateState.textContent = gs.toLowerCase();
      if (gs === "SPEECH") setScopeBadge("● speech", "live");
      else if (gs === "TRAILING") setScopeBadge("▁ trailing", "gate");
      else setScopeBadge("armed · chờ tiếng", "armed");
    },
    onStop: (result) => finishRecording(result, mode, ctx),
  });

  const windowSamples = state.ctx.sampleRate * SCOPE_WINDOW_SECONDS;
  state.node.port.onmessage = (event) => {
    state.gate?.push(event.data);
    state.live = concatFloat32([state.live, event.data]);
    if (state.live.length > windowSamples) state.live = state.live.slice(-windowSamples);
  };

  state.source.connect(state.node);
  // Worklet cần một đích để được pull; gain 0 giữ im lặng, tránh vọng loa.
  const silent = state.ctx.createGain();
  silent.gain.value = 0;
  state.node.connect(silent).connect(state.ctx.destination);

  state.recording = true;
  state.startedAt = performance.now();
  state.gate.start();
  el.recordBtn.classList.add("active");
  el.recordBtn.querySelector(".rec-label").textContent = "STOP";
  el.clipMeta.textContent = `đang thu · gate ${gateOnDb}/${gateOffDb} dB${off ? " · auto-stop tắt" : ""}`;
  tick();
}

function tick() {
  if (!state.recording) return;
  el.clipTime.textContent = formatTime((performance.now() - state.startedAt) / 1000);
  drawScope(state.live, "#ff8a72");
  state.rafId = requestAnimationFrame(tick);
}

async function teardownAudio() {
  state.node?.port.close();
  state.source?.disconnect();
  state.node?.disconnect();
  state.stream?.getTracks().forEach((t) => t.stop());
  const rate = state.ctx?.sampleRate || TARGET_SAMPLE_RATE;
  await state.ctx?.close();
  state.ctx = null;
  return rate;
}

async function finishRecording(result, mode, ctx) {
  state.recording = false;
  cancelAnimationFrame(state.rafId);
  el.recordBtn.classList.remove("active");
  el.recordBtn.querySelector(".rec-label").textContent = "RECORD";
  resetMeter();
  el.gateState.textContent = "idle";

  const ctxRate = await teardownAudio();
  state.live = new Float32Array(0);

  const reason = STOP_REASON_VI[result.reason] || result.reason;

  if (!result.samples.length) {
    setScopeBadge("no signal");
    el.clipMeta.textContent = "không thu được mẫu — kiểm tra quyền mic";
    return;
  }

  const samples = resample(result.samples, ctxRate);
  const ratio = samples.length / result.samples.length;
  const speechStart = result.speechStartSample > 0 ? Math.round(result.speechStartSample * ratio) : -1;

  // Cổng năng lượng của thiết bị. Ngoại lệ DUY NHẤT: mẫu dataset nhãn `on` vốn
  // phải KHÔNG có tiếng nói — chặn nó lại thì không bao giờ ghi được ca quan
  // trọng nhất của bộ test.
  const isNoiseSample = mode.id === "dataset" && ctx.labelBucket === "on";
  const energy = likelyContainsSpeech(samples, DEVICE.energy);

  setClip({
    blob: encodeWav(samples),
    samples,
    speechStartSample: speechStart,
    stopReason: result.reason,
    voicedMs: result.voicedMs,
    energy,
    note: `mic ${ctxRate} Hz`,
  });
  setScopeBadge(`dừng: ${reason}`, "armed");

  if (!isNoiseSample && !energy.ok) {
    // Thiết bị thật im lặng bỏ qua clip không có năng lượng tiếng nói. Bench mà
    // vẫn gửi là đang đo một tình huống không tồn tại trong thực tế.
    skip("no_speech_energy", `rms ${energy.rms.toFixed(4)} · peak frame ${energy.peakFrameRms.toFixed(4)}`, mode);
    return;
  }
  if (!result.sawSpeech && !isNoiseSample) {
    skip("no_speech_energy", `không có tiếng vượt cổng (${reason})`, mode);
    return;
  }

  if (el.autoSend.checked) await send();
}

function setClip({ blob, samples, speechStartSample, stopReason, voicedMs, energy, note }) {
  state.clip = {
    blob,
    samples,
    duration: samples.length / TARGET_SAMPLE_RATE,
    speechStartSample,
    stopReason,
    voicedMs,
    energy,
  };

  el.sendBtn.disabled = false;
  el.downloadBtn.disabled = false;
  el.clipTime.textContent = formatTime(state.clip.duration);
  el.clipMeta.textContent = `${note} → 16k mono · ${(blob.size / 1024).toFixed(0)} KB`;
  el.clipMeta.title = `${note} → PCM 16-bit mono 16 kHz · ${(blob.size / 1024).toFixed(1)} KB`;

  drawScope(samples, "#35d6a4", speechStartSample);

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

// ── gửi ─────────────────────────────────────────────────────────────────

function skip(code, detail, mode) {
  el.verdict.hidden = false;
  el.verdict.textContent = "SKIPPED";
  el.verdict.className = "verdict skip";
  el.transcript.className = "readout-text placeholder";
  el.transcript.textContent = `Thiết bị thật sẽ KHÔNG gửi clip này — ${detail}`;
  el.gauges.innerHTML = "";
  addGauge("skip", code, "warn");
  if (state.clip) {
    addGauge("stop", STOP_REASON_VI[state.clip.stopReason] || state.clip.stopReason);
    addGauge("audio", `${state.clip.duration.toFixed(2)} s`);
  }
  setStatus("skipped", "warn");
  addTake({ text: `skipped · ${code}`, endpoint: mode.label, elapsed: 0, ok: false });
}

async function send() {
  if (!state.clip || state.sending) return;
  const mode = currentMode();
  const ctx = ctxOf();

  const missing = missingField(mode, ctx);
  if (missing) {
    showError(`Thiếu ${missing}.`);
    return;
  }
  if (state.clip.blob.size > mode.maxBytes) {
    skip("audio_too_large", `${(state.clip.blob.size / 1024).toFixed(0)} KB > ${(mode.maxBytes / 1024) | 0} KB`, mode);
    return;
  }

  if (mode.id === "dataset") return saveFixture(ctx);

  // App coi warm != true là server chết và rơi về Vosk — không hề gửi. Bench
  // phải tái hiện đúng chỗ đó.
  if (mode.requireHealthy) {
    const h = await checkHealthQuick();
    if (!h.up) {
      skip("health_unhealthy", `${h.why} → app sẽ rơi về Vosk`, mode);
      return;
    }
  }

  const form = mode.buildForm(state.clip.blob, ctx);
  const timeoutMs = mode.timeoutMs(ctx);
  await post(mode.path, form, timeoutMs, (data, elapsed) => render(mode, data, elapsed, ctx), mode.label);
}

async function post(path, form, timeoutMs, onOk, label) {
  setSending(true);
  const started = performance.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);

  try {
    const res = await relay(path, { method: "POST", body: form, signal: ctl.signal });
    const elapsed = Math.round(performance.now() - started);
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const detail = data.detail || data;
      showError(`HTTP ${res.status} · ${detail.message || detail.error || res.statusText}`);
      el.gauges.innerHTML = "";
      addGauge("latency", `${elapsed} ms`);
      if (detail.code || detail.error) addGauge("code", detail.code || detail.error, "warn");
      el.rawJson.textContent = JSON.stringify(data, null, 2);
      setStatus(`HTTP ${res.status}`, "err");
      addTake({ text: `HTTP ${res.status} · ${detail.code || detail.error || ""}`, endpoint: label, elapsed, ok: false });
      return;
    }
    onOk(data, elapsed);
  } catch (err) {
    const elapsed = Math.round(performance.now() - started);
    const timedOut = err.name === "AbortError";
    showError(
      timedOut
        ? `Quá ${timeoutMs} ms — app thật đã bỏ cuộc ở đây (không retry).`
        : `Không gọi được server: ${err.message}`,
    );
    el.gauges.innerHTML = "";
    addGauge("latency", `${elapsed} ms`, "warn");
    if (timedOut) addGauge("timeout", `${timeoutMs} ms`, "warn");
    el.rawJson.textContent = "—";
    setStatus(timedOut ? "timeout" : "lỗi", "err");
    addTake({ text: timedOut ? `timeout ${timeoutMs}ms` : err.message, endpoint: label, elapsed, ok: false });
  } finally {
    clearTimeout(timer);
    setSending(false);
  }
}

function render(mode, data, elapsed, ctx) {
  el.gauges.innerHTML = "";
  el.rawJson.textContent = JSON.stringify(data, null, 2);

  if (mode.id === "otg") {
    const transcript = data.transcript || "";
    el.verdict.hidden = false;
    el.verdict.textContent = data.intent || "?";
    el.verdict.className = "verdict intent";
    el.transcript.className = transcript ? "readout-text" : "readout-text placeholder";
    el.transcript.textContent = transcript || "server không trả transcript";

    if (typeof data.confidence === "number") {
      addGauge("confidence", data.confidence.toFixed(3), data.confidence >= 0.7 ? "good" : "warn");
    }
    addTake({ text: `${data.intent} ← "${transcript}"`, endpoint: mode.label, elapsed, ok: true });
  } else {
    const transcript = data.transcribed_text ?? data.transcript ?? data.text ?? "";
    const verdict = scoreAssess({ expected: ctx.expected, accuracy: data.accuracy, transcript });
    el.verdict.hidden = false;
    el.verdict.textContent = verdict.verdict;
    el.verdict.className = `verdict ${verdict.verdict.toLowerCase()}`;
    el.verdict.title = verdict.why;
    el.transcript.className = transcript ? "readout-text" : "readout-text placeholder";
    el.transcript.textContent = transcript || "server trả về chuỗi rỗng";

    if (typeof data.accuracy === "number") {
      addGauge("accuracy", data.accuracy.toFixed(3), data.accuracy >= 0.55 ? "good" : "warn");
    }
    if (typeof verdict.similarity === "number") addGauge("similarity", verdict.similarity.toFixed(2));
    if (data.meta?.assess_ms) addGauge("server", `${Math.round(data.meta.assess_ms)} ms`);
    if (data.meta?.gop != null) addGauge("gop", Number(data.meta.gop).toFixed(3));
    addTake({
      text: `${verdict.verdict} · "${transcript || "(rỗng)"}"`,
      endpoint: mode.label,
      elapsed,
      ok: verdict.verdict === "PASS",
    });
  }

  addGauge("latency", `${elapsed} ms`, elapsed > 3000 ? "warn" : "good");
  addGauge("audio", `${state.clip.duration.toFixed(2)} s`);
  addGauge("rtf", (elapsed / 1000 / Math.max(state.clip.duration, 0.01)).toFixed(2));
  addGauge("stop", STOP_REASON_VI[state.clip.stopReason] || state.clip.stopReason);
  addGauge("voiced", `${state.clip.voicedMs} ms`);
  setStatus(`${elapsed} ms`, "ok");
}

function showError(message) {
  el.verdict.hidden = true;
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
  // SPEECH_MAX_CONCURRENCY=1 là semaphore dùng chung cho assess lẫn transcribe,
  // mà /intent/voice gọi transcribe bên trong. Gửi song song chỉ tổ xếp hàng.
  el.sendBtn.disabled = sending || !state.clip;
  el.recordBtn.disabled = sending;
  if (sending) {
    el.verdict.hidden = true;
    el.transcript.className = "readout-text placeholder";
    el.transcript.textContent = "đang xử lý trên server…";
    el.gauges.innerHTML = "";
    setStatus("processing", "busy");
  }
}

/** Lịch sử CHỈ giữ chữ và số — không blob, không samples, không data URL.
 * Đừng gắn lại nút nghe lại ở đây: giữ audio của mọi take là thứ đã cố ý bỏ. */
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
    `${new Date().toLocaleTimeString()} · ${endpoint} · ${elapsed} ms · ${(state.clip?.duration || 0).toFixed(2)}s`;
  el.history.prepend(li);
}

// ── dataset ─────────────────────────────────────────────────────────────

async function saveFixture(ctx) {
  setSending(true);
  const started = performance.now();
  try {
    const qs = new URLSearchParams({ word: ctx.word, label: ctx.label, speaker: ctx.speaker });
    const res = await fetch(`/fixtures/save?${qs}`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: state.clip.blob,
    });
    const data = await res.json();
    const elapsed = Math.round(performance.now() - started);

    if (!res.ok) {
      showError(`Không lưu được: ${data.message || data.error}`);
      setStatus(data.error || "lỗi", "err");
      addTake({ text: `save lỗi · ${data.error}`, endpoint: "DATASET", elapsed, ok: false });
      return;
    }

    el.verdict.hidden = false;
    el.verdict.textContent = "SAVED";
    el.verdict.className = "verdict pass";
    el.transcript.className = "readout-text";
    el.transcript.textContent = data.file;
    el.gauges.innerHTML = "";
    addGauge("audio", `${data.duration.toFixed(2)} s`);
    addGauge("size", `${(data.bytes / 1024).toFixed(0)} KB`);
    addGauge("stop", STOP_REASON_VI[state.clip.stopReason] || state.clip.stopReason);
    el.rawJson.textContent = JSON.stringify(data, null, 2);
    setStatus("đã lưu", "ok");
    addTake({ text: data.file, endpoint: "DATASET", elapsed, ok: true });
    renderDataset(data.counts);
  } catch (err) {
    showError(`Không gọi được serve.py: ${err.message}`);
    setStatus("lỗi", "err");
  } finally {
    setSending(false);
  }
}

async function refreshDataset() {
  try {
    const res = await fetch("/fixtures/list");
    renderDataset(await res.json());
  } catch {
    /* không chạy qua serve.py */
  }
}

function renderDataset(data) {
  if (!data) return;
  state.dataset = data;

  el.dsTotal.textContent = `${data.total} file · ${Object.keys(data.words).length} từ`;
  el.dsWords.innerHTML = "";
  for (const word of Object.keys(data.words).sort()) {
    const opt = document.createElement("option");
    opt.value = word;
    el.dsWords.appendChild(opt);
  }

  el.dsProgress.innerHTML = "";
  const words = Object.keys(data.words).sort();
  const current = el.dsWord.value.trim().toLowerCase();
  if (current && !words.includes(current)) words.push(current);

  if (!words.length) {
    el.dsProgress.innerHTML = '<p class="note note-sm">Chưa có mẫu nào. Nhập từ rồi bấm RECORD.</p>';
  }

  for (const word of words) {
    const counts = data.words[word] || {};
    const row = document.createElement("div");
    row.className = `ds-row${word === current ? " current" : ""}`;
    const name = document.createElement("b");
    name.textContent = word;
    row.appendChild(name);
    for (const [label, target] of Object.entries(data.target)) {
      const got = counts[label] || 0;
      const chip = document.createElement("span");
      chip.className = `ds-chip${got >= target ? " done" : ""}`;
      chip.textContent = `${got}/${target} ${label}`;
      row.appendChild(chip);
    }
    el.dsProgress.appendChild(row);
  }

  if (data.unparsed?.length) {
    const warn = document.createElement("p");
    warn.className = "note note-sm";
    warn.textContent = `${data.unparsed.length} file sai quy tắc tên, eval_real_wavs.py sẽ bỏ qua: ${data.unparsed.join(", ")}`;
    el.dsProgress.appendChild(warn);
  }
}

// ── UI theo mode ────────────────────────────────────────────────────────

function syncModeUi() {
  const mode = currentMode();
  for (const group of document.querySelectorAll(".fields")) {
    group.hidden = group.dataset.for !== mode.id;
  }
  el.dsOtherWrap.hidden = labelInputs.find((i) => i.checked)?.value !== "khac";
  el.datasetPanel.hidden = mode.id !== "dataset";
  el.outputTitle.textContent = mode.id === "otg" ? "Intent" : mode.id === "dataset" ? "Fixture" : "Transcript";
  el.inputTag.textContent = mode.id === "dataset" ? "ch 01 · ghi mẫu" : "ch 01 · mic";

  if (el.transcript.classList.contains("placeholder") && !state.clip) {
    el.transcript.textContent = {
      flashcard: "Nói vào mic — văn bản server nghe được sẽ hiện ở đây, kèm chip đạt/trượt theo luật của app.",
      otg: "Nói một câu lệnh — intent server chọn sẽ hiện ở đây, kèm transcript.",
      dataset: "Bấm RECORD để ghi một mẫu. Tên file lưu được sẽ hiện ở đây.",
    }[mode.id];
  }

  const rec = mode.recording(ctxOf());
  const bits = [
    mode.hint,
    `tự dừng sau ${rec.silenceAfterSpeechMs} ms im lặng`,
    `trần ${(rec.maxMs / 1000).toFixed(1)}s`,
  ];
  if (mode.path) bits.push(`timeout ${mode.timeoutMs(ctxOf())} ms`);
  if (rec.preRollMs) bits.push(`pre-roll ${rec.preRollMs} ms`);
  if (mode.id === "otg") bits.push("cổng năng lượng ≠ Silero: nhạy với tiếng gõ bàn");
  el.modeNote.textContent = bits.join(" · ");

  seedGateInputs();
  if (mode.id === "dataset") refreshDataset();
}

function buildStaticUi() {
  for (const s of OTG_SCREENS) {
    const opt = document.createElement("option");
    opt.value = s;
    el.otgScreens.appendChild(opt);
  }
  for (const m of OTG_MODES) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    el.otgMode.appendChild(opt);
  }
  if (state.savedOtgMode) el.otgMode.value = state.savedOtgMode;

  for (const [a, b] of CONFUSABLE_PAIRS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pair";
    btn.textContent = `${a}/${b}`;
    btn.title = "Cặp dễ nhầm — mẫu đáng ghi nhất";
    btn.onclick = () => {
      el.dsWord.value = a;
      el.dsOther.value = b;
      saveSettings();
      refreshDataset();
    };
    el.dsPairs.appendChild(btn);
  }

  for (const d of DIAGNOSTIC_PATHS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-ghost";
    btn.textContent = d.label;
    btn.title = d.hint;
    btn.onclick = () => sendDiagnostic(d.path);
    el.diagList.appendChild(btn);
  }
}

async function sendDiagnostic(path) {
  if (!state.clip || state.sending) return;
  const form = new FormData();
  form.append("audio", state.clip.blob, "audio.wav");
  form.append("language", el.language.value.trim() || "en");
  if (el.expected.value.trim()) form.append("expected_text", el.expected.value.trim());

  await post(path, form, 20000, (data, elapsed) => {
    const text = data.transcript ?? data.text ?? data.transcribed_text ?? "";
    el.verdict.hidden = true;
    el.transcript.className = text ? "readout-text" : "readout-text placeholder";
    el.transcript.textContent = text || "chuỗi rỗng";
    el.gauges.innerHTML = "";
    addGauge("latency", `${elapsed} ms`);
    addGauge("audio", `${state.clip.duration.toFixed(2)} s`);
    if (typeof data.confidence === "number") addGauge("confidence", data.confidence.toFixed(3));
    el.rawJson.textContent = JSON.stringify(data, null, 2);
    setStatus(`${elapsed} ms`, "ok");
    addTake({ text: text || "(rỗng)", endpoint: path, elapsed, ok: true });
  }, path);
}

// ── wiring ──────────────────────────────────────────────────────────────

async function toggleRecord() {
  if (state.sending) return;
  try {
    if (state.recording) state.gate?.stop("manual");
    else await startRecording();
  } catch (err) {
    state.recording = false;
    cancelAnimationFrame(state.rafId);
    await teardownAudio();
    el.recordBtn.classList.remove("active");
    el.recordBtn.querySelector(".rec-label").textContent = "RECORD";
    setScopeBadge("mic error");
    el.clipMeta.textContent = `lỗi mic: ${err.message}`;
  }
}

el.recordBtn.addEventListener("click", toggleRecord);
el.sendBtn.addEventListener("click", send);

document.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || e.repeat) return;
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || document.activeElement === el.playback) return;
  e.preventDefault();
  toggleRecord();
});

el.downloadBtn.addEventListener("click", () => {
  if (!state.clip) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(state.clip.blob);
  a.download = `tinyspeech-take-${String(state.takeNo + 1).padStart(2, "0")}.wav`;
  a.click();
  URL.revokeObjectURL(a.href);
});

async function loadFile(file) {
  if (!file) return;
  try {
    setScopeBadge("decoding…");
    const blob = await fileToWav(file);
    const view = new DataView(await blob.arrayBuffer());
    const samples = new Float32Array((blob.size - 44) / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(44 + i * 2, true) / 0x8000;
    setClip({
      blob,
      samples,
      speechStartSample: -1,
      stopReason: "file",
      voicedMs: 0,
      energy: likelyContainsSpeech(samples, DEVICE.energy),
      note: file.name,
    });
    setScopeBadge(`file · peak ${dbfs(peakLevel(samples)).toFixed(1)} dB`, "armed");
    if (el.autoSend.checked) await send();
  } catch (err) {
    setScopeBadge("decode error");
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

el.healthBtn.addEventListener("click", () => {
  checkHealthQuick({ force: true });
  checkGateway();
});

modeInputs.forEach((i) =>
  i.addEventListener("change", () => {
    syncModeUi();
    saveSettings();
  }),
);
labelInputs.forEach((i) => i.addEventListener("change", syncModeUi));

for (const input of [el.baseUrl, el.language, el.expected, el.otgScreen, el.otgMode, el.otgActivity, el.dsWord, el.dsSpeaker, el.autoSend, el.autoStop, el.rawMic]) {
  input.addEventListener("change", () => {
    saveSettings();
    if (input === el.expected) syncModeUi();
    if (input === el.dsWord) refreshDataset();
    if (input === el.baseUrl) {
      state.health.at = 0;
      checkHealthQuick({ force: true });
      checkGateway();
    }
  });
}

for (const input of [el.gateOn, el.gateOff]) {
  input.addEventListener("change", placeGateTicks);
}

window.addEventListener("resize", () => {
  fitScope();
  drawScope(
    state.recording ? state.live : state.clip?.samples,
    state.recording ? "#ff8a72" : "#35d6a4",
    state.recording ? -1 : state.clip?.speechStartSample ?? -1,
  );
});

loadSettings();
buildStaticUi();
await loadConfig();
syncModeUi();
fitScope();
drawScope(null);
setScopeBadge("idle");
checkHealthQuick({ force: true });
checkGateway();
refreshDataset();
