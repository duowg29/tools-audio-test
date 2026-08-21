// Thu PCM float32 thô từ mic. MediaRecorder không dùng được: nó cho webm/opus,
// trong khi server (speech_service/wav_validation.py) chỉ nhận WAV PCM 16-bit
// mono 16 kHz và trả 400 invalid_audio với mọi định dạng khác.
class RecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      // Copy: buffer của worklet được tái sử dụng ở block sau.
      this.port.postMessage(new Float32Array(input[0]));
    }
    return true;
  }
}

registerProcessor("recorder-processor", RecorderProcessor);
