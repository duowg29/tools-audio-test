#!/usr/bin/env python3
"""Static server cho tool test giọng nói.

Bắt buộc phải qua http://localhost — mở file:// sẽ hỏng cả ES module lẫn
AudioWorklet, và getUserMedia chỉ chạy trong secure context (localhost tính là
secure).
"""

from __future__ import annotations

import argparse
import http.server
import socketserver
import webbrowser
from functools import partial
from pathlib import Path

ROOT = Path(__file__).resolve().parent


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Tool sửa liên tục lúc test — đừng để trình duyệt giữ bản cũ.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):  # bớt ồn
        pass


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=5173)
    parser.add_argument("--no-open", action="store_true", help="Không tự mở trình duyệt")
    args = parser.parse_args()

    handler = partial(Handler, directory=str(ROOT))
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", args.port), handler) as httpd:
        url = f"http://localhost:{args.port}/"
        print(f"Tool test giọng nói: {url}  (Ctrl+C để dừng)")
        if not args.no_open:
            webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print()


if __name__ == "__main__":
    main()
