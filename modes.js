/**
 * Hằng số và luật lấy từ client Flutter, gom về một chỗ để còn soát lại được.
 *
 * Vì sao ba mode chứ không phải danh sách endpoint: THIẾT BỊ THẬT KHÔNG BAO GIỜ
 * GỌI /transcribe. Đường thật chỉ có hai:
 *
 *   flashcard / minigame  →  POST {speech}/api/speech/assess
 *   on-the-go / tiny farm →  POST {intent}/intent/voice   (một call, ra luôn intent)
 *
 * `/transcribe` là hop nội bộ của app/pipeline/asr_client.py. Để nó ngang hàng
 * trên UI chính là thứ khiến bench cũ đo nhầm đường.
 *
 * Nguồn từng con số:
 *   tinytalk-games/lib/shared/speech_processing/flashcard/flashcard_audio_recording_service.dart
 *   tinytalk-games/lib/shared/speech_processing/flashcard/flashcard_hybrid_speech_service.dart
 *   tinytalk-games/lib/shared/speech_processing/assess/practice_remote_speech_assess.dart
 *   tinytalk-games/lib/shared/speech_processing/flashcard/remote_flashcard_speech_service.dart
 *   tiny-talk/lib/shared/on_the_go/services/on_the_go_record_service.dart
 *   tiny-talk/lib/shared/on_the_go/intent/intent_api/intent_api_service.dart
 */

export const DEVICE = {
  // Cổng biên độ, đơn vị dBFS. `record.getAmplitude()` trả max(current, max) —
  // tức là ĐỈNH, không phải RMS. Đo bằng RMS sẽ thấp hơn 6-10 dB và ngưỡng -52
  // mất hết ý nghĩa.
  gateOnDb: -52,
  gateOffDb: -58,
  // Biến thể "permissive" dùng cho flashcard một từ.
  gateOnPermissiveDb: -48,
  gateOffPermissiveDb: -54,
  pollMs: 60,
  inactivityStopMs: 3000,
  energy: { minRms: 0.006, minPeakFrameRms: 0.012, frameSamples: 320 },
  healthTimeoutMs: 1500,
  healthCacheMs: 45000,
};

//: Ngưỡng chấm đạt/trượt phía client (PracticeCompactAssess).
export const SCORING = {
  passThreshold: 0.55,
  longWordPassThreshold: 0.62,
  longWordNearCorrectSimilarity: 0.9,
  longWordExactMatchFloor: 0.42,
  shortExactMatchFloor: 0.5,
  emptyTranscriptDismissBelow: 0.15,
};

const norm = (s) => (s || "").trim().toLowerCase();

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

export function textSimilarity(a, b) {
  if (!a.length || !b.length) return 0;
  if (a === b) return 1;
  return Math.max(0, 1 - levenshtein(a, b) / Math.max(a.length, b.length));
}

/** Chấm y hệt `PracticeCompactAssess.passed()` + `shouldDismissEmptyTranscript`.
 *
 * Đây là chỗ bench trả lời được câu mà accuracy trần không trả lời được:
 * "server cho 0.58 — nhưng trong app thì đạt hay trượt?"
 */
export function scoreAssess({ expected, accuracy, transcript }) {
  const score = Math.min(1, Math.max(0, Number(accuracy) || 0));
  const t = norm(transcript);
  const e = norm(expected);

  if (!t && score < SCORING.emptyTranscriptDismissBelow) {
    return { verdict: "DISMISSED", why: `transcript rỗng, accuracy < ${SCORING.emptyTranscriptDismissBelow}` };
  }

  const exact = e.length > 0 && t === e;
  // Chú ý: độ dài tính sau khi BỎ khoảng trắng, không phải độ dài thô.
  const longWord = e.replace(/\s+/g, "").length >= 6;
  const similarity = textSimilarity(t, e);

  let pass;
  let why;
  if (longWord) {
    pass = exact
      ? score >= SCORING.longWordExactMatchFloor
      : similarity >= SCORING.longWordNearCorrectSimilarity && score >= SCORING.longWordPassThreshold;
    why = exact
      ? `từ dài, khớp y hệt → cần ≥ ${SCORING.longWordExactMatchFloor}`
      : `từ dài, similarity ${similarity.toFixed(2)} → cần ≥ ${SCORING.longWordNearCorrectSimilarity} và ≥ ${SCORING.longWordPassThreshold}`;
  } else {
    pass = score >= SCORING.passThreshold || (exact && score >= SCORING.shortExactMatchFloor);
    why = exact
      ? `khớp y hệt → cần ≥ ${SCORING.shortExactMatchFloor}`
      : `cần ≥ ${SCORING.passThreshold}`;
  }

  return { verdict: pass ? "PASS" : "FAIL", why, similarity };
}

/** Luật health của app (remote_flashcard_speech_service.dart:219-258).
 *
 * `warm != true` cũng là CHẾT — lúc đó app rơi về Vosk chứ không gọi server.
 * Bench phải từ chối gửi ở trạng thái này, nếu không sẽ đo một đường mà người
 * dùng thật không bao giờ đi.
 */
export function healthVerdict(data) {
  if (!data || typeof data !== "object") return { up: false, why: "body không phải JSON" };
  if (data.model_loaded === false) return { up: false, why: "model_loaded=false" };
  if ("warm" in data && data.warm !== true) return { up: false, why: "warm != true" };
  if (data.status === "starting" || data.status === "degraded") {
    return { up: false, why: `status=${data.status}` };
  }
  return { up: true, why: data.status || "healthy" };
}

const wordCount = (s) => norm(s).split(/\s+/).filter(Boolean).length;

export const MODES = {
  flashcard: {
    id: "flashcard",
    label: "FLASHCARD",
    path: "/api/speech/assess",
    hint: "chấm phát âm · đường của flashcard / minigame",
    filename: "audio.wav",
    requireHealthy: true,
    // speech_service/wav_validation.py
    maxBytes: 2 * 1024 * 1024,
    needs: ["expected"],

    timeoutMs: (ctx) => (wordCount(ctx.expected) <= 1 ? 3000 : 8000),

    recording(ctx) {
      const single = wordCount(ctx.expected) <= 1;
      // trimMax theo flashcard_hybrid_speech_service.dart:352 — độ dài expected
      // quyết định trần thời gian ghi.
      const trimMax = norm(ctx.expected).length <= 4 ? 2.0 : 3.0;
      return {
        gateOnDb: single ? DEVICE.gateOnPermissiveDb : DEVICE.gateOnDb,
        gateOffDb: single ? DEVICE.gateOffPermissiveDb : DEVICE.gateOffDb,
        minSpeechFrames: 1,
        silenceAfterSpeechMs: 1000, // nhánh whisper-compact
        inactivityStopMs: DEVICE.inactivityStopMs,
        maxMs: (trimMax + 0.9) * 1000,
        preRollMs: 0, // assess gửi nguyên buffer từ lúc bấm ghi, KHÔNG trim
      };
    },

    buildForm(blob, ctx) {
      const form = new FormData();
      form.append("audio", blob, this.filename);
      form.append("expected_text", ctx.expected.trim());
      form.append("language", ctx.language || "en");
      return form;
    },
  },

  otg: {
    id: "otg",
    label: "ON-THE-GO",
    path: "/otg/intent/voice",
    hint: "audio → intent trong một call · cần gateway :8090",
    filename: "utterance.wav",
    requireHealthy: false,
    // app/utils/wav_validation.py chặt hơn phía speech: 1 MB.
    maxBytes: 1024 * 1024,
    needs: ["screen", "mode"],

    timeoutMs: () => 20000,

    recording() {
      return {
        gateOnDb: DEVICE.gateOnDb,
        gateOffDb: DEVICE.gateOffDb,
        minSpeechFrames: 3, // kOnTheGoVadMinFrames
        silenceAfterSpeechMs: 1000, // kOnTheGoUtteranceSilenceMs
        inactivityStopMs: DEVICE.inactivityStopMs,
        maxMs: 15000, // trần an toàn của bench (thiết bị dựa vào Silero + session)
        preRollMs: 1000, // kOnTheGoPreRollMs
      };
    },

    buildForm(blob, ctx) {
      const form = new FormData();
      form.append("audio", blob, this.filename);
      form.append("current_screen", ctx.screen);
      form.append("current_mode", ctx.mode);
      // App chỉ đính field này khi khác null — bỏ hẳn, không gửi chuỗi rỗng.
      if (ctx.activity && ctx.activity.trim()) form.append("current_activity", ctx.activity.trim());
      return form;
    },
  },

  dataset: {
    id: "dataset",
    label: "DATASET",
    path: null, // ghi thẳng qua serve.py, không đụng server speech
    hint: "ghi bộ mẫu đánh giá vào fixtures/real",
    filename: null,
    requireHealthy: false,
    maxBytes: 2 * 1024 * 1024,
    needs: ["word", "label", "speaker"],

    timeoutMs: () => 10000,

    recording() {
      // Chậm hơn đường flashcard có chủ đích: tài liệu yêu cầu 1 từ, dưới ~3s,
      // và ĐỪNG CẮT CỤT hai đầu.
      return {
        gateOnDb: DEVICE.gateOnPermissiveDb,
        gateOffDb: DEVICE.gateOffPermissiveDb,
        minSpeechFrames: 1,
        silenceAfterSpeechMs: 1200,
        inactivityStopMs: 4000,
        maxMs: 3500,
        preRollMs: 0,
      };
    },
  },
};

/** Endpoint chẩn đoán — server-to-server, không phải đường thiết bị. */
export const DIAGNOSTIC_PATHS = [
  { path: "/transcribe", label: "/transcribe", hint: "hop nội bộ của Intent API" },
  { path: "/api/speech/recognize", label: "/api/speech/recognize", hint: "không có caller thật" },
];

export const OTG_MODES = [
  "system_command",
  "free_talk",
  "speaking",
  "story",
  "game",
  "mode",
  "song",
];

export const OTG_SCREENS = [
  "main_tab:roadmap",
  "main_tab:games",
  "main_tab:grammar",
  "main_tab:upgrade",
  "main_tab:profile",
  "game:flashcard",
];

/** Cặp dễ nhầm — README của fixtures nói đây là mẫu đáng ghi nhất. */
export const CONFUSABLE_PAIRS = [
  ["ship", "sheep"],
  ["way", "weigh"],
  ["dead", "day"],
  ["bad", "bed"],
  ["full", "fool"],
];
