"""Tiny stdlib web server for the draft assistant."""

from __future__ import annotations

import socketserver
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler
from pathlib import Path

WEB_DIR = Path(__file__).parent / "web"


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        # Player data is refreshed by re-running update-data; don't let the
        # browser cache a stale copy mid-week.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003 - quieter logs
        pass


def serve(port: int = 8787, open_browser: bool = True) -> None:
    handler = partial(Handler, directory=str(WEB_DIR))
    with socketserver.TCPServer(("127.0.0.1", port), handler) as httpd:
        url = f"http://127.0.0.1:{port}"
        print(f"Draft Command running at {url}  (Ctrl-C to stop)")
        if open_browser:
            webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nbye")
