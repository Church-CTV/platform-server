"""Tests for HLS HTTP server."""

import os
import threading
import time
from pathlib import Path
from http.client import HTTPConnection

from ctv_server.hls_server import HLSServer


def _wait_for_server(server: HLSServer, timeout: float = 5) -> bool:
    """Block until server is accepting connections."""
    start = time.monotonic()
    while time.monotonic() - start < timeout:
        try:
            conn = HTTPConnection(server.host, server.port, timeout=0.5)
            conn.request("GET", "/")
            conn.close()
            return True
        except Exception:
            time.sleep(0.1)
    return False


class TestHLSServer:
    def test_serves_m3u8_manifest(self, tmp_path):
        manifest = tmp_path / "test.m3u8"
        manifest.write_text("#EXTM3U\n#EXT-X-VERSION:3\n")

        server = HLSServer(host="127.0.0.1", port=0, hls_dir=str(tmp_path))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        _wait_for_server(server)

        conn = HTTPConnection(server.host, server.port, timeout=2)
        conn.request("GET", "/test.m3u8")
        resp = conn.getresponse()
        body = resp.read().decode()

        assert resp.status == 200
        ct = resp.getheader("Content-Type") or ""
        assert "application/x-mpegURL" in ct
        assert "#EXTM3U" in body
        conn.close()

        server.shutdown()

    def test_serves_ts_segments(self, tmp_path):
        segment = tmp_path / "test_001.ts"
        segment.write_bytes(b"\x00" * 1024)

        server = HLSServer(host="127.0.0.1", port=0, hls_dir=str(tmp_path))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        _wait_for_server(server)

        conn = HTTPConnection(server.host, server.port, timeout=2)
        conn.request("GET", "/test_001.ts")
        resp = conn.getresponse()
        body = resp.read()

        assert resp.status == 200
        assert len(body) == 1024
        conn.close()

        server.shutdown()

    def test_returns_404_for_missing_file(self, tmp_path):
        server = HLSServer(host="127.0.0.1", port=0, hls_dir=str(tmp_path))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        _wait_for_server(server)

        conn = HTTPConnection(server.host, server.port, timeout=2)
        conn.request("GET", "/nonexistent.m3u8")
        resp = conn.getresponse()

        assert resp.status == 404
        conn.close()

        server.shutdown()

    def test_serves_from_subdirectory(self, tmp_path):
        subdir = tmp_path / "streams" / "church-main"
        subdir.mkdir(parents=True)
        manifest = subdir / "live.m3u8"
        manifest.write_text("#EXTM3U\n")

        server = HLSServer(host="127.0.0.1", port=0, hls_dir=str(tmp_path))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        _wait_for_server(server)

        conn = HTTPConnection(server.host, server.port, timeout=2)
        conn.request("GET", "/streams/church-main/live.m3u8")
        resp = conn.getresponse()
        body = resp.read().decode()

        assert resp.status == 200
        assert "#EXTM3U" in body
        conn.close()

        server.shutdown()

    def test_default_port_is_8080(self):
        server = HLSServer(host="127.0.0.1", port=8080, hls_dir="/tmp/hls")
        assert server.port == 8080  # Before serve_forever

    def test_creates_hls_directory(self, tmp_path):
        hls_dir = tmp_path / "new_hls"
        assert not hls_dir.exists()

        server = HLSServer(host="127.0.0.1", port=0, hls_dir=str(hls_dir))
        assert hls_dir.exists()

    def test_content_length_header(self, tmp_path):
        manifest = tmp_path / "test.m3u8"
        manifest.write_text("#EXTM3U\n")

        server = HLSServer(host="127.0.0.1", port=0, hls_dir=str(tmp_path))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        _wait_for_server(f"127.0.0.1:{server.port}")

        conn = HTTPConnection(f"127.0.0.1:{server.port}", timeout=2)
        conn.request("GET", "/test.m3u8")
        resp = conn.getresponse()

        content_length = resp.getheader("Content-Length")
        assert content_length is not None
        assert int(content_length) > 0
        conn.close()

        server.shutdown()
