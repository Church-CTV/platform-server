"""HLS HTTP server — serves .m3u8 manifests and .ts segments."""

from __future__ import annotations

import os
import threading
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from typing import Union

_StrPath = Union[str, "os.PathLike[str]"]


class _HLSHandler(SimpleHTTPRequestHandler):
    """Serve HLS files with correct content types."""

    def __init__(self, *args, hls_dir: str = "", **kwargs):
        super().__init__(*args, directory=hls_dir, **kwargs)

    def end_headers(self) -> None:
        # Cache headers for HLS segments
        if self.path.endswith(".ts"):
            self.send_header("Cache-Control", "no-cache")
        elif self.path.endswith(".m3u8"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def guess_type(self, path):  # type: ignore[override]
        p = str(path)
        if p.endswith(".m3u8"):
            return "application/x-mpegURL"
        return super().guess_type(path)


class HLSServer:
    """HTTP server for HLS manifests and segments."""

    def __init__(self, host: str = "0.0.0.0", port: int = 8080, hls_dir: str = "./hls") -> None:
        self.host = host
        self.port = port
        self.hls_dir = hls_dir

        os.makedirs(hls_dir, exist_ok=True)

        self._server: HTTPServer | None = None
        self._thread: threading.Thread | None = None

    def serve_forever(self) -> None:
        """Start serving in a background thread."""
        handler = lambda *a, **kw: _HLSHandler(*a, hls_dir=self.hls_dir, **kw)
        self._server = HTTPServer((self.host, self.port), handler)
        self.port = self._server.server_port  # Update with actual bound port
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def shutdown(self) -> None:
        """Stop the server."""
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()

    def get_url(self, path: str) -> str:
        """Build the full URL for an HLS file."""
        return f"http://{self.host}:{self.port}/{path.lstrip('/')}"
