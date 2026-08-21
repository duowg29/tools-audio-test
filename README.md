# tools-audio-test

Tool web để test tính năng nhận diện giọng nói của **TinySpeech**
(`tinytalk-intent-service/speech_service`): bật mic → nói → tool encode WAV →
POST lên server → hiện văn bản server trả về ở ô bên cạnh để tự đối chiếu.

Đây chỉ là **client test**. Server chạy độc lập, tool không đụng vào repo server.

## Chạy

```bash
# 1) Server TinySpeech (repo tinytalk-intent-service), port 8000
python3 speech_service_local.py

# 2) Tool này
python3 serve.py            # mở http://localhost:5173
```

Phải mở qua `http://localhost` — `file://` sẽ chặn ES module, AudioWorklet và
`getUserMedia` (mic chỉ chạy trong secure context).

## Bố cục

Ba module kiểu rack thiết bị, đọc từ trái sang phải theo đúng đường tín hiệu:

| Module | Nội dung |
| --- | --- |
| **INPUT** | Scope sóng, VU meter LED (thang dB), transport REC, nghe lại, tải `.wav`, kéo thả file |
| **ROUTING** | Server URL, chọn endpoint, language, auto-send, expected text |
| **TRANSCRIPT** | Màn readout văn bản, các gauge (latency / RTF / confidence…), JSON thô, danh sách **takes** |

## Dùng

1. Kiểm tra LED **SERVER** ở góc trên: xanh = model đã warm (bấm ⟳ để check lại).
2. Chọn endpoint, ngôn ngữ (`en` / `vi`).
3. Nhấn **RECORD** (hoặc phím `Space`), nói, nhấn lần nữa để dừng → mặc định tự gửi.
4. Đọc văn bản ở màn readout bên phải; scope cho thấy có thu được tín hiệu thật hay không.
5. Nghe lại bản ghi hoặc **Tải .wav** khi muốn giữ mẫu lỗi làm fixture.

Kéo thả / chọn file audio có sẵn cũng được — tool tự decode, trộn mono, resample
16 kHz rồi gửi, nên test lại fixture cũ không cần convert tay.

Gauge **RTF** = thời gian xử lý / độ dài audio; > 1.0 nghĩa là server chậm hơn
thời gian thực.

| Endpoint | Trả về | Dùng khi |
| --- | --- | --- |
| `/transcribe` | `{transcript}` | Test STT thuần (đường OTG / intent-service) |
| `/api/speech/recognize` | `text` + `confidence` | Muốn xem thêm độ tin cậy |
| `/api/speech/assess` | `accuracy` + `characters` | Chấm phát âm, cần `expected_text` |

## Vì sao encode WAV thủ công

`speech_service/wav_validation.py` chỉ nhận **PCM 16-bit mono 16 kHz**, sai một
tiêu chí là 400 `invalid_audio`. `MediaRecorder` của trình duyệt cho webm/opus
nên không dùng được — tool thu PCM float32 qua AudioWorklet, resample về 16 kHz
(trình duyệt hay ép AudioContext lên 48 kHz) rồi tự ghép header RIFF.

Giới hạn phía server: ≤ 30s và ≤ 2 MB mỗi lần
(`SPEECH_MAX_DURATION_SECONDS`, `SPEECH_MAX_WAV_BYTES`).

## Gửi tuần tự

Model chạy `SPEECH_MAX_CONCURRENCY=1` — hai request song song chỉ xếp hàng, và
với stack hybrid còn có nguy cơ treo. Tool khoá nút gửi/ghi khi đang có request,
đừng mở nhiều tab bắn cùng lúc.

## File

| File | Vai trò |
| --- | --- |
| `index.html` / `styles.css` | Giao diện rack 3 module: input · routing · transcript |
| `app.js` | Ghi âm, scope + meter, gọi API, render kết quả, takes, lưu setting |
| `wav.js` | Resample + encode WAV, decode file người dùng chọn |
| `recorder-worklet.js` | AudioWorklet đẩy PCM thô về main thread |
| `serve.py` | Static server localhost (no-store cache) |
