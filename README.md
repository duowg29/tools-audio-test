# tools-audio-test

Bench test giọng nói cho **TinySpeech** — mô phỏng đúng cách **thiết bị thật**
gửi audio lên server, để những gì đo được ở đây khớp với trải nghiệm người dùng.

Đây chỉ là **client test**. Server chạy độc lập; tool không sửa gì trong repo
server, chỉ ghi file dữ liệu vào `fixtures/real/` khi bạn dùng mode DATASET.

## Vì sao không phải "gửi lên /transcribe rồi xem chữ"

App thật **không bao giờ** gọi `/transcribe` — đó là hop nội bộ giữa Intent API
và speech service. Hai đường thật:

| Tính năng | Đường thật |
| --- | --- |
| Flashcard / minigame / placement | `POST {speech}/api/speech/assess` |
| On-the-Go / Tiny Farm voice | **một call** `POST {intent}/intent/voice` → `{intent, confidence, transcript}` |

Và phần lớn chất lượng thực tế nằm ở **hành vi**, không phải ở endpoint: app
không gửi clip im lặng, tự dừng theo VAD, timeout 3s/8s/20s, coi `warm != true`
là server chết rồi rơi về Vosk. Bench này tái hiện cả những thứ đó.

## Chạy

```bash
# Server (repo tinytalk-intent-service) — một trong hai:
python3 speech_service_local.py                    # chỉ speech :8000
bash deploy/scripts/start_hybrid_with_ngrok.sh     # cả stack, gateway :8090

# Bench
python3 serve.py                                   # → http://localhost:5173
python3 serve.py --upstream http://127.0.0.1:8090  # trỏ qua gateway (cần cho mode ON-THE-GO)
```

Phải mở qua `http://localhost` — `file://` chặn ES module, AudioWorklet và
`getUserMedia`.

| Cờ | Ý nghĩa |
| --- | --- |
| `--upstream URL` | Server mặc định (`:8000` speech, `:8090` gateway) |
| `--allow-upstream HOST` | Cho phép host ngoài loopback, ví dụ `xxx.ngrok-free.app` |
| `--upstream-lock` | Không cho UI đổi server |
| `--fixtures-dir DIR` | Nơi ghi bộ mẫu (mặc định `…/speech_service/fixtures/real`) |
| `--fixtures-readonly` | Cấm ghi file |
| `--relay-timeout S` | Trần của relay, mặc định 25s (phải > 20s của client) |

## Ba mode

Chọn bằng radio, hoặc mở thẳng bằng `?mode=flashcard|otg|dataset`.

### FLASHCARD — `/api/speech/assess`

Đường của flashcard và các minigame. Nhập **expected text**, nói, tool chấm và
hiện chip **PASS / FAIL / DISMISSED** theo đúng luật `PracticeCompactAssess` của
app (0.55; từ ≥6 ký tự cần 0.62 + similarity 0.90; khớp y hệt hạ sàn còn
0.50/0.42; transcript rỗng dưới 0.15 thì app bỏ qua chứ không tính sai).

Đây là chỗ thấy được thứ mà nhìn accuracy trần không thấy: *server trả 0.58
nhưng trong app vẫn là trượt*.

Ghi âm bám thiết bị: cổng −48/−54 dB (một từ) hoặc −52/−58, tự dừng sau 1000 ms
im lặng, trần `(trimMax+0.9)s` với `trimMax = 2.0s` nếu expected ≤ 4 ký tự.
Timeout 3s một từ / 8s nhiều từ, **không retry** — đúng như app.

Trước khi gửi còn hai cửa nữa, cũng là hai cửa của app:
- `/health` với luật `warm != true` = chết → hiện `skipped · health_unhealthy`,
  **không** POST (đúng lúc app rơi về Vosk).
- Cổng năng lượng `rms > 0.006` → clip im lặng bị bỏ, hiện `skipped ·
  no_speech_energy`.

### ON-THE-GO — `/otg/intent/voice`

Một call ra thẳng intent. Chọn `current_screen`, `current_mode`,
`current_activity` (để trống thì field bị bỏ hẳn khỏi form, như app). Pre-roll
1000 ms, cần 3 poll có tiếng mới coi là bắt đầu nói, timeout 20s, trần 1 MB
(Intent API chặt hơn speech).

Cần **gateway :8090** đứng trước — đèn GATEWAY trên đầu trang cho biết có hay
không.

### DATASET — ghi bộ mẫu đánh giá

Thay cho việc gõ `arecord` rồi tự đặt tên 40–60 file theo
`docs/GHI_AM_DANH_GIA_TU_VUNG.md`. Nhập từ / nhãn / người, bench đặt tên đúng
quy ước `<từ>__<nhãn>__<người>__<số>.wav` và `serve.py` ghi thẳng vào
`fixtures/real/`, số thứ tự tự tăng, không bao giờ ghi đè.

Bảng tiến độ hiện ngay từng từ còn thiếu nhãn nào (`ship: 2/3 dung · 0/1 on`),
kèm nút chọn nhanh các cặp dễ nhầm. Nhãn `on` (tạp âm/im lặng) là ca **được
phép** không có tiếng nói — cổng năng lượng tự tắt cho nhãn này.

Chấm điểm vẫn để script của server làm, bench không tính lại:

```bash
cd tinytalk-intent-service && python3 speech_service/eval_real_wavs.py
```

## Relay same-origin

Mọi request đi qua `/relay/*` của `serve.py` chứ không gọi thẳng server. Không
phải cho tiện: **Intent API không cài CORS**, trình duyệt không thể gọi
`/otg/intent/voice` cross-origin — trong khi app native chẳng vướng CORS bao
giờ. Relay giữ nguyên body multipart, tự thêm `ngrok-skip-browser-warning`, bỏ
Cookie/Origin, và trả nguyên status + body lỗi của upstream.

Relay chỉ nghe 127.0.0.1, kiểm tra header `Host`, chặn redirect và chỉ đi tới
host trong allowlist.

## Đọc kết quả

| Gauge | Ý nghĩa |
| --- | --- |
| `latency` | thời gian round-trip đo từ trình duyệt |
| `rtf` | latency / độ dài audio; > 1.0 là chậm hơn thời gian thực |
| `stop` | vì sao ngừng ghi: im lặng sau khi nói / không nói gì / chạm trần |
| `voiced` | tổng thời gian có tiếng vượt cổng |
| `accuracy`, `similarity`, `gop`, `server` | số của assess |

Scope tô mờ phần **trước** lúc cổng mở, kèm vạch cam ở điểm bắt đầu nói — nhìn
là biết bench đang ngậm bao nhiêu im lặng ở đầu clip. Meter có hai vạch mốc ứng
với ngưỡng gate đang dùng.

## Giới hạn cần biết

- **Device-like, không phải device-identical.** Trình duyệt thu qua AGC / khử ồn
  / khử vọng nên −52 dBFS không đánh dấu cùng một sự kiện âm học như trên máy
  Android. Có công tắc **Raw mic** để tắt cả ba và ô sửa ngưỡng ngay trên UI.
- **Cổng năng lượng ≠ Silero.** Đường on-the-go thật dùng VAD neural; bench dùng
  cổng năng lượng nên nhạy với tiếng gõ bàn và kém nhạy với giọng nhỏ.
- **Gửi tuần tự.** `SPEECH_MAX_CONCURRENCY=1` là semaphore dùng chung cho cả
  assess lẫn transcribe, mà `/intent/voice` gọi transcribe bên trong. Đừng mở
  nhiều tab bắn cùng lúc.
- **Không giữ audio của các take.** Chỉ bản ghi hiện tại nghe lại / tải được.

## File

| File | Vai trò |
| --- | --- |
| `index.html` / `styles.css` | Giao diện rack 3 module: input · routing · kết quả |
| `modes.js` | Hằng số port từ Flutter, luật chấm và luật health — sửa số thì sửa ở đây |
| `vad.js` | Cổng âm lượng + tự dừng + pre-roll |
| `wav.js` | Resample, encode WAV, cổng năng lượng, decode file |
| `app.js` | Ghi âm, scope/meter, gọi API, render, dataset, takes |
| `recorder-worklet.js` | AudioWorklet đẩy PCM thô về main thread |
| `serve.py` | Static + relay same-origin + ghi fixture |
