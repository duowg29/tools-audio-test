#!/usr/bin/env python3
"""Máy chủ cục bộ cho bench test giọng nói.

Ba việc, không hơn:

1. **Phục vụ file tĩnh.** Bắt buộc qua http://localhost — mở `file://` là hỏng
   cả ES module lẫn AudioWorklet, và getUserMedia chỉ chạy trong secure context.

2. **Relay `/relay/*` → server thật.** Intent API (:8088) KHÔNG cài CORS, nên
   trình duyệt không thể gọi thẳng `/otg/intent/voice` — kể cả qua gateway hay
   ngrok. App native không vướng CORS, nên muốn mô phỏng đúng thiết bị thì bench
   phải là same-origin. Relay forward nguyên body multipart (không parse, không
   encode lại) để boundary sống sót.

3. **Ghi fixture `/fixtures/save`.** Bộ mẫu đánh giá trong
   `docs/GHI_AM_DANH_GIA_TU_VUNG.md` cần 40-60 file đặt tên đúng quy ước; ghi
   tay bằng arecord rất dễ sai tên. Chỉ ghi FILE DỮ LIỆU, không bao giờ đụng code
   của repo server.

BẢO MẬT — process này ghi được file, nên đọc kỹ trước khi sửa:
  * Bind 127.0.0.1. KHÔNG thêm cờ --host, KHÔNG đổi thành 0.0.0.0.
  * Kiểm tra header Host mọi request (loopback không tự bảo vệ khỏi
    DNS-rebinding: một trang web độc có thể trỏ tên miền về 127.0.0.1).
  * Upstream phải qua allowlist — relay không được thành bàn đạp SSRF.
  * Tên file fixture dựng từ regex chặt, rồi vẫn assert lại nằm trong root.
"""

from __future__ import annotations

import argparse
import http.server
import json
import os
import re
import socket
import struct
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent

#: Trần body cho relay. WAV hợp lệ tối đa 2 MB; 4 MiB là dư cho multipart overhead.
MAX_RELAY_BYTES = 4 * 1024 * 1024
#: Trần body cho fixture (server speech cũng chặn 2 MB).
MAX_FIXTURE_BYTES = 2 * 1024 * 1024

#: Header hop-by-hop — lấy đúng danh sách của cpu_inference/hybrid_gateway.py để
#: hai proxy hành xử giống nhau.
HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
}

#: Tên từ/người: chặn luôn `..`, `/`, NUL và cả `__` (dấu phân cách của quy ước tên).
RE_TOKEN = re.compile(r"[a-z0-9][a-z0-9-]{0,31}")
RE_LABEL = re.compile(r"dung|ngong|on|khac-[a-z0-9][a-z0-9-]{0,31}")

#: Công thức bộ mẫu, theo speech_service/fixtures/real/README.md.
DATASET_TARGET = {"dung": 3, "ngong": 2, "khac": 1, "on": 1}


class BenchError(Exception):
    """Lỗi có mã ổn định để UI hiển thị, kèm HTTP status."""

    def __init__(self, status: int, code: str, message: str = ""):
        super().__init__(code)
        self.status = status
        self.code = code
        self.message = message or code


# ── Upstream ────────────────────────────────────────────────────────────


def _allowed_upstream(raw: str, allow_hosts: set[str]) -> str:
    """Chuẩn hoá + kiểm tra upstream. Trả về base URL không có dấu / cuối."""
    parsed = urllib.parse.urlsplit(raw.strip())
    if parsed.scheme not in ("http", "https"):
        raise BenchError(403, "upstream_not_allowed", "scheme phải là http/https")
    if parsed.username or parsed.password:
        raise BenchError(403, "upstream_not_allowed", "không nhận userinfo")
    if parsed.query or parsed.fragment:
        raise BenchError(403, "upstream_not_allowed", "upstream không được mang query")

    host = (parsed.hostname or "").lower()
    if host not in {"127.0.0.1", "localhost", "::1"} and host not in allow_hosts:
        raise BenchError(
            403,
            "upstream_not_allowed",
            f"host {host!r} không nằm trong allowlist (thêm bằng --allow-upstream)",
        )

    path = parsed.path.rstrip("/")
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Chặn redirect: 302 của upstream không được dùng để nhảy sang host khác."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise BenchError(502, "upstream_redirect", f"upstream trả {code} → {newurl}")


_opener = urllib.request.build_opener(_NoRedirect)


# ── WAV ─────────────────────────────────────────────────────────────────


def _validate_wav(data: bytes) -> float:
    """Soi gương speech_service/wav_validation.py — PCM 16-bit mono 16 kHz.

    Không bao giờ ghi xuống đĩa một file mà eval_real_wavs.py sẽ nghẹn.
    Trả về độ dài (giây).
    """
    if len(data) < 44 or data[0:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise BenchError(400, "invalid_wav_header")

    offset = 12
    fmt_found = False
    data_size = 0
    audio_format = channels = sample_rate = bits = 0

    while offset + 8 <= len(data):
        chunk_id = data[offset : offset + 4]
        chunk_size = struct.unpack_from("<I", data, offset + 4)[0]
        start = offset + 8
        if chunk_id == b"fmt ":
            if chunk_size < 16:
                raise BenchError(400, "invalid_fmt_chunk")
            audio_format, channels, sample_rate, _, _, bits = struct.unpack_from(
                "<HHIIHH", data, start
            )
            fmt_found = True
        elif chunk_id == b"data":
            data_size = chunk_size
        offset = start + chunk_size + (chunk_size % 2)

    if not fmt_found:
        raise BenchError(400, "missing_fmt_chunk")
    if audio_format != 1:
        raise BenchError(400, "unsupported_audio_format")
    if channels != 1:
        raise BenchError(400, "invalid_channels")
    if sample_rate != 16000:
        raise BenchError(400, "invalid_sample_rate")
    if bits != 16:
        raise BenchError(400, "invalid_sample_width")

    duration = data_size / (sample_rate * channels * (bits // 8))
    if duration > 30:
        raise BenchError(400, "audio_too_long")
    return duration


# ── Fixture store ───────────────────────────────────────────────────────


def _parse_stem(stem: str) -> tuple[str, str, str] | None:
    """Cùng luật với eval_real_wavs.parse_name: split('__'), cần >= 3 phần."""
    parts = stem.split("__")
    if len(parts) < 3:
        return None
    word, label, speaker = (p.strip().lower() for p in parts[:3])
    if not word or not label or not speaker:
        return None
    return word, label, speaker


def _bucket(label: str) -> str:
    """eval_real_wavs gom mọi nhãn `khac-*` vào một rổ."""
    return "khac" if label.startswith("khac") else label


def list_fixtures(root: Path) -> dict:
    words: dict[str, dict[str, int]] = {}
    unparsed: list[str] = []
    total = 0

    if root.is_dir():
        for path in sorted(root.glob("*.wav")):
            parsed = _parse_stem(path.stem)
            if not parsed:
                unparsed.append(path.name)
                continue
            word, label, _speaker = parsed
            words.setdefault(word, {}).setdefault(_bucket(label), 0)
            words[word][_bucket(label)] += 1
            total += 1

    return {
        "dir": str(root),
        "exists": root.is_dir(),
        "total": total,
        "words": words,
        "unparsed": unparsed,
        "target": DATASET_TARGET,
    }


def save_fixture(root: Path, word: str, label: str, speaker: str, data: bytes) -> dict:
    word = (word or "").strip().lower()
    label = (label or "").strip().lower()
    speaker = (speaker or "").strip().lower()

    if not RE_TOKEN.fullmatch(word):
        raise BenchError(400, "bad_word", "từ chỉ gồm a-z 0-9 và dấu -")
    if not RE_TOKEN.fullmatch(speaker):
        raise BenchError(400, "bad_speaker", "tên người chỉ gồm a-z 0-9 và dấu -")
    if not RE_LABEL.fullmatch(label):
        raise BenchError(400, "bad_label", "nhãn phải là dung | ngong | on | khac-<từ>")
    if len(data) < 44:
        raise BenchError(400, "empty_audio")
    if len(data) > MAX_FIXTURE_BYTES:
        raise BenchError(400, "audio_too_large")

    duration = _validate_wav(data)

    root.mkdir(parents=True, exist_ok=True)
    prefix = f"{word}__{label}__{speaker}__"

    n = 0
    for existing in root.glob(f"{prefix}*.wav"):
        tail = existing.stem[len(prefix) :]
        if tail.isdigit():
            n = max(n, int(tail))

    # O_EXCL, KHÔNG open(..., "wb"): ghi đè một bản thu là mất công cả buổi.
    for _ in range(50):
        n += 1
        target = (root / f"{prefix}{n}.wav").resolve()
        if target.parent != root.resolve():
            raise BenchError(400, "path_escape")
        try:
            fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except FileExistsError:
            continue
        try:
            os.write(fd, data)
            os.fsync(fd)
        finally:
            os.close(fd)
        return {
            "file": target.name,
            "n": n,
            "bytes": len(data),
            "duration": round(duration, 3),
            "dir": str(root),
        }

    raise BenchError(500, "index_exhausted", "không tìm được số thứ tự trống")


# ── HTTP ────────────────────────────────────────────────────────────────


class Handler(http.server.SimpleHTTPRequestHandler):
    # Cấu hình gắn vào class lúc main() chạy.
    upstream = "http://127.0.0.1:8000"
    upstream_locked = False
    allow_hosts: set[str] = set()
    fixtures_dir = ROOT / "fixtures"
    fixtures_readonly = False
    relay_timeout = 25.0
    port = 5173

    protocol_version = "HTTP/1.1"

    # ── helpers ──

    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").lower()
        if not host:  # curl HTTP/1.0
            return True
        allowed = {
            f"localhost:{self.port}",
            f"127.0.0.1:{self.port}",
            f"[::1]:{self.port}",
            "localhost",
            "127.0.0.1",
        }
        return host in allowed

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _fail(self, exc: BenchError) -> None:
        self._json(exc.status, {"error": exc.code, "message": exc.message})

    def _read_body(self, limit: int) -> bytes:
        if (self.headers.get("Transfer-Encoding") or "").lower() == "chunked":
            raise BenchError(411, "chunked_not_supported", "cần Content-Length")
        length = int(self.headers.get("Content-Length") or 0)
        if length > limit:
            raise BenchError(413, "body_too_large", f"tối đa {limit} byte")
        return self.rfile.read(length) if length else b""

    def _target_upstream(self) -> str:
        raw = self.headers.get("X-Bench-Upstream")
        if raw and not self.upstream_locked:
            return _allowed_upstream(raw, self.allow_hosts)
        return self.upstream

    # ── relay ──

    def _relay(self, path: str, method: str) -> None:
        body = self._read_body(MAX_RELAY_BYTES) if method == "POST" else None
        base = self._target_upstream()
        url = base + ("/" + path.lstrip("/") if path else "/")

        headers = {
            # ngrok trả một trang cảnh báo HTML thay vì JSON nếu thiếu header này;
            # app thật (speech_service_config.dart) luôn gửi nó.
            "ngrok-skip-browser-warning": "true",
            "Accept": self.headers.get("Accept", "*/*"),
        }
        ctype = self.headers.get("Content-Type")
        if ctype:
            # Copy nguyên xi: boundary của multipart nằm trong đây.
            headers["Content-Type"] = ctype

        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with _opener.open(req, timeout=self.relay_timeout) as res:
                payload = res.read()
                status = res.status
                res_ctype = res.headers.get("Content-Type", "application/octet-stream")
        except urllib.error.HTTPError as e:
            # Đi thẳng qua, giữ nguyên status + body: 400 của assess mang
            # detail.error=invalid_audio mà UI cần đọc đúng.
            payload = e.read()
            status = e.code
            res_ctype = e.headers.get("Content-Type", "application/json")
        except BenchError as e:
            self._fail(e)
            return
        except (TimeoutError, socket.timeout):
            self._fail(BenchError(504, "relay_timeout", f"upstream im quá {self.relay_timeout}s"))
            return
        except urllib.error.URLError as e:
            self._fail(BenchError(502, "upstream_unreachable", f"{base}: {e.reason}"))
            return
        except OSError as e:
            self._fail(BenchError(502, "relay_failed", str(e)))
            return

        self.send_response(status)
        self.send_header("Content-Type", res_ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    # ── routes ──

    def do_GET(self) -> None:  # noqa: N802
        if not self._host_ok():
            self._fail(BenchError(403, "bad_host"))
            return

        route = urllib.parse.urlsplit(self.path).path
        try:
            if route == "/bench/config":
                self._json(
                    200,
                    {
                        "upstream": self.upstream,
                        "upstream_locked": self.upstream_locked,
                        "allow_hosts": sorted(self.allow_hosts),
                        "fixtures_dir": str(self.fixtures_dir),
                        "fixtures_writable": not self.fixtures_readonly,
                    },
                )
                return
            if route == "/fixtures/list":
                self._json(200, list_fixtures(self.fixtures_dir))
                return
            if route.startswith("/relay/") or route == "/relay":
                self._relay(route[len("/relay") :], "GET")
                return
        except BenchError as e:
            self._fail(e)
            return

        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        if not self._host_ok():
            self._fail(BenchError(403, "bad_host"))
            return

        parts = urllib.parse.urlsplit(self.path)
        route = parts.path
        try:
            if route.startswith("/relay/") or route == "/relay":
                self._relay(route[len("/relay") :], "POST")
                return
            if route == "/fixtures/save":
                if self.fixtures_readonly:
                    raise BenchError(403, "fixtures_readonly")
                q = urllib.parse.parse_qs(parts.query)
                data = self._read_body(MAX_FIXTURE_BYTES)
                saved = save_fixture(
                    self.fixtures_dir,
                    q.get("word", [""])[0],
                    q.get("label", [""])[0],
                    q.get("speaker", [""])[0],
                    data,
                )
                saved["counts"] = list_fixtures(self.fixtures_dir)
                self._json(201, saved)
                return
        except BenchError as e:
            self._fail(e)
            return

        self._fail(BenchError(404, "not_found", route))

    def end_headers(self) -> None:
        # Tool sửa liên tục lúc test — đừng để trình duyệt giữ bản cũ.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):  # bớt ồn
        pass


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=5173)
    parser.add_argument("--no-open", action="store_true", help="Không tự mở trình duyệt")
    parser.add_argument(
        "--upstream",
        default="http://127.0.0.1:8000",
        help="Server mặc định của relay (:8000 speech, :8090 gateway hybrid)",
    )
    parser.add_argument(
        "--allow-upstream",
        action="append",
        default=[],
        metavar="HOST",
        help="Cho phép thêm host ngoài loopback, ví dụ xxx.ngrok-free.app",
    )
    parser.add_argument(
        "--upstream-lock",
        action="store_true",
        help="Không cho UI đổi upstream (bỏ qua header X-Bench-Upstream)",
    )
    parser.add_argument(
        "--fixtures-dir",
        default=str(
            ROOT.parent / "tinytalk-intent-service" / "speech_service" / "fixtures" / "real"
        ),
        help="Nơi ghi bộ mẫu đánh giá",
    )
    parser.add_argument("--fixtures-readonly", action="store_true", help="Cấm ghi fixture")
    parser.add_argument("--relay-timeout", type=float, default=25.0)
    args = parser.parse_args()

    allow_hosts = {h.strip().lower() for h in args.allow_upstream if h.strip()}
    try:
        upstream = _allowed_upstream(args.upstream, allow_hosts)
    except BenchError as e:
        parser.error(f"--upstream: {e.message}")
        return

    Handler.upstream = upstream
    Handler.upstream_locked = args.upstream_lock
    Handler.allow_hosts = allow_hosts
    Handler.fixtures_dir = Path(args.fixtures_dir).expanduser().resolve()
    Handler.fixtures_readonly = args.fixtures_readonly
    Handler.relay_timeout = args.relay_timeout
    Handler.port = args.port
    Handler.directory = str(ROOT)  # SimpleHTTPRequestHandler đọc thuộc tính này

    # ThreadingHTTPServer, không phải TCPServer: một call OTG kéo dài 20s sẽ
    # treo toàn bộ file tĩnh nếu server chỉ có một luồng.
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    http.server.ThreadingHTTPServer.daemon_threads = True

    with http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler) as httpd:
        url = f"http://localhost:{args.port}/"
        print(f"Bench test giọng nói : {url}")
        print(f"Relay → upstream     : {upstream}{' (khoá)' if args.upstream_lock else ''}")
        # In thật to: không ai được phát hiện ra sai thư mục sau 50 bản thu.
        print(
            f"Ghi fixture vào      : {Handler.fixtures_dir}"
            f"{'  [CHỈ ĐỌC]' if args.fixtures_readonly else ''}"
        )
        print("Ctrl+C để dừng.")
        if not args.no_open:
            webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print()


if __name__ == "__main__":
    main()
