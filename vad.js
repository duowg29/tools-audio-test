/**
 * Cổng âm lượng + tự dừng, mô phỏng cách thiết bị thật kết thúc một lượt nói.
 *
 * Ba điểm bám sát thiết bị, đừng "cải tiến" cho mượt hơn:
 *
 * 1. **Quyết định theo nhịp 60 ms**, không phải theo từng block audio. Dart gọi
 *    `_recorder.getAmplitude()` trong một Timer.periodic 60 ms; chạy mịn gấp 3
 *    sẽ cho đặc tính thời gian khác thiết bị, mà thời gian mới là thứ đang đo.
 *
 * 2. **Dùng ĐỈNH (peak) → dBFS**, không dùng RMS. `getAmplitude()` trả
 *    `max(current, max)`. Đo bằng RMS thì thấp hơn 6-10 dB, ngưỡng -52 sẽ đánh
 *    dấu một sự kiện âm học hoàn toàn khác.
 *
 * 3. **Trễ hysteresis**: đang nói thì so với ngưỡng OFF, chưa nói thì so với
 *    ngưỡng ON — đúng `_gatedHasSound`. Một ngưỡng duy nhất sẽ nhấp nháy liên
 *    tục ở đoạn cuối từ.
 *
 * ARMED ──hot đủ minSpeechPolls──▶ SPEECH ──hết hot──▶ TRAILING ──im đủ lâu──▶ STOP
 *   └── quá inactivityStopMs ─▶ STOP(inactivity)     └── hot lại ─▶ SPEECH
 *   bất kỳ lúc nào: quá maxMs ─▶ STOP(max_duration)
 */

import { concatFloat32, dbfs, peakLevel } from "./wav.js";

const FRAME_SAMPLES = 320; // 20 ms @ 16 kHz — cùng cỡ frame với energy gate

export function createUtteranceGate({
  sampleRate = 16000,
  gateOnDb = -52,
  gateOffDb = -58,
  pollMs = 60,
  minSpeechFrames = 1,
  silenceAfterSpeechMs = 1000,
  inactivityStopMs = 3000,
  maxMs = 3000,
  preRollMs = 0,
  onTick = () => {},
  onStop = () => {},
} = {}) {
  const ringSize = Math.max(0, Math.round((preRollMs / 1000) * sampleRate));
  const ring = ringSize ? new Float32Array(ringSize) : null;
  let ringWrite = 0;
  let ringFilled = 0;

  let chunks = [];
  let capturing = preRollMs === 0; // assess/dataset giữ từ lúc bấm ghi
  let leftover = new Float32Array(0);

  let state = "ARMED";
  let tickPeak = 0;
  let hotPolls = 0;
  let voicedPolls = 0;
  let trailStart = 0;
  let speechStartSample = 0;
  let captured = 0;
  let startedAt = 0;
  let timer = 0;
  let stopped = false;

  function pushRing(block) {
    if (!ring) return;
    for (let i = 0; i < block.length; i++) {
      ring[ringWrite] = block[i];
      ringWrite = (ringWrite + 1) % ringSize;
      if (ringFilled < ringSize) ringFilled++;
    }
  }

  function drainRing() {
    if (!ring || !ringFilled) return new Float32Array(0);
    const out = new Float32Array(ringFilled);
    const start = (ringWrite - ringFilled + ringSize) % ringSize;
    for (let i = 0; i < ringFilled; i++) out[i] = ring[(start + i) % ringSize];
    ringFilled = 0;
    return out;
  }

  /** Gọi từ onmessage của worklet với mỗi block Float32Array. */
  function push(block) {
    if (stopped) return;

    if (capturing) {
      chunks.push(block);
      captured += block.length;
    } else {
      pushRing(block);
    }

    // Gom về frame 320 mẫu rồi mới lấy đỉnh, để mức đo không phụ thuộc kích
    // thước block của worklet (128 mẫu).
    const merged = leftover.length ? concatFloat32([leftover, block]) : block;
    let offset = 0;
    while (offset + FRAME_SAMPLES <= merged.length) {
      const p = peakLevel(merged.subarray(offset, offset + FRAME_SAMPLES));
      if (p > tickPeak) tickPeak = p;
      offset += FRAME_SAMPLES;
    }
    leftover = merged.slice(offset);
  }

  function tick() {
    if (stopped) return;

    const now = performance.now();
    const elapsed = now - startedAt;
    const level = dbfs(tickPeak);
    tickPeak = 0;

    // Hysteresis: đang nói thì dùng ngưỡng nhả, chưa nói thì dùng ngưỡng bắt.
    const hot = level > (state === "SPEECH" ? gateOffDb : gateOnDb);
    hotPolls = hot ? hotPolls + 1 : 0;
    if (state === "SPEECH" || state === "TRAILING") voicedPolls += hot ? 1 : 0;

    if (elapsed > maxMs) {
      finish("max_duration");
      return;
    }

    if (state === "ARMED") {
      if (hotPolls >= minSpeechFrames) {
        if (!capturing) {
          // Pre-roll: chèn phần trước lúc phát hiện tiếng vào đầu utterance,
          // nếu không sẽ cụt mất phụ âm đầu.
          const pre = drainRing();
          if (pre.length) {
            chunks.push(pre);
            captured += pre.length;
          }
          capturing = true;
        }
        speechStartSample = Math.max(0, captured - Math.round((pollMs / 1000) * sampleRate));
        state = "SPEECH";
      } else if (elapsed > inactivityStopMs) {
        finish("inactivity");
        return;
      }
    } else if (state === "SPEECH") {
      if (!hot) {
        state = "TRAILING";
        trailStart = now;
      }
    } else if (state === "TRAILING") {
      if (hot) {
        state = "SPEECH";
      } else if (now - trailStart > silenceAfterSpeechMs) {
        finish("silence_after_speech");
        return;
      }
    }

    onTick({ level, state, elapsed, hot });
  }

  function finish(reason) {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    timer = 0;
    const samples = concatFloat32(chunks);
    chunks = [];
    onStop({
      reason,
      samples,
      speechStartSample: state === "ARMED" ? -1 : speechStartSample,
      voicedMs: voicedPolls * pollMs,
      sawSpeech: state !== "ARMED",
    });
  }

  return {
    push,
    start() {
      startedAt = performance.now();
      timer = setInterval(tick, pollMs);
    },
    stop(reason = "manual") {
      finish(reason);
    },
    get state() {
      return state;
    },
    get stopped() {
      return stopped;
    },
  };
}

/** Nhãn tiếng Việt cho lý do dừng — dùng chung giữa gauge và lịch sử takes. */
export const STOP_REASON_VI = {
  silence_after_speech: "im lặng sau khi nói",
  inactivity: "không nói gì",
  max_duration: "chạm trần thời gian",
  manual: "bấm dừng",
};
