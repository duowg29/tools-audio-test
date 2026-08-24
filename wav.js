// Encode PCM → WAV đúng khuôn server yêu cầu: RIFF/WAVE, fmt PCM (format 1),
// 1 channel, 16000 Hz, 16-bit.
export const TARGET_SAMPLE_RATE = 16000;

/** Linear resample. Trình duyệt thường ép AudioContext về 48 kHz dù đã xin 16 kHz. */
export function resample(input, inputRate, outputRate = TARGET_SAMPLE_RATE) {
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const outLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[idx];
    const b = idx + 1 < input.length ? input[idx + 1] : a;
    output[i] = a + (b - a) * frac;
  }
  return output;
}

export function concatFloat32(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export function encodeWav(samples, sampleRate = TARGET_SAMPLE_RATE) {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeAscii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

/** Đọc WAV người dùng kéo vào, chuyển về mono 16 kHz 16-bit trước khi gửi. */
export async function fileToWav(file) {
  const arrayBuffer = await file.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, TARGET_SAMPLE_RATE);
  const decoded = await ctx.decodeAudioData(arrayBuffer);
  const channels = [];
  for (let c = 0; c < decoded.numberOfChannels; c++) channels.push(decoded.getChannelData(c));
  const mono = new Float32Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) {
    let sum = 0;
    for (const ch of channels) sum += ch[i];
    mono[i] = sum / channels.length;
  }
  return encodeWav(resample(mono, decoded.sampleRate));
}

export function peakLevel(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
  }
  return peak;
}

export function rms(samples, from = 0, to = samples.length) {
  if (to <= from) return 0;
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (to - from));
}

/** Port của `wavBytesLikelyContainSpeech` (flashcard_audio_recording_service.dart:51).
 *
 * Thiết bị thật KHÔNG gửi clip không có năng lượng tiếng nói — nó lặng lẽ bỏ
 * qua. Bench mà cứ gửi là đang đo một tình huống không tồn tại trong thực tế.
 *
 * Bản Dart đọc PCM16 rồi chia 32768; chạy thẳng trên Float32 trước lúc encode là
 * tương đương, chỉ lệch phần lượng tử hoá.
 */
export function likelyContainsSpeech(
  samples,
  { minRms = 0.006, minPeakFrameRms = 0.012, frameSamples = 320 } = {},
) {
  const overall = rms(samples);
  let peakFrame = 0;
  for (let start = 0; start + frameSamples <= samples.length; start += frameSamples) {
    const r = rms(samples, start, start + frameSamples);
    if (r > peakFrame) peakFrame = r;
  }
  return {
    ok: overall > minRms || peakFrame > minPeakFrameRms,
    rms: overall,
    peakFrameRms: peakFrame,
  };
}

export const dbfs = (level) => (level > 0 ? 20 * Math.log10(level) : -Infinity);
