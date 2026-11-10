"""Tests for HTTP API."""

import json
import threading
import time
from http.client import HTTPConnection

from ctv_server.app import CTVServer, create_app


def _wait_for_api(app: CTVServer, timeout: float = 5) -> bool:
    api_port = app.hls_server.port + 1
    start = time.monotonic()
    while time.monotonic() - start < timeout:
        try:
            conn = HTTPConnection("127.0.0.1", api_port, timeout=0.5)
            conn.request("GET", "/api/health")
            conn.close()
            return True
        except Exception:
            time.sleep(0.1)
    return False


class TestHealthEndpoint:
    def test_health_returns_200(self):
        app = create_app()
        app.hls_server.port = 0  # Random available port
        thread = threading.Thread(target=app.serve_forever, daemon=True)
        thread.start()
        _wait_for_api(app)

        conn = HTTPConnection("127.0.0.1", app.hls_server.port + 1, timeout=2)
        conn.request("GET", "/api/health")
        resp = conn.getresponse()
        body = json.loads(resp.read().decode())

        assert resp.status == 200
        assert body["status"] == "ok"
        conn.close()

        app.shutdown()


class TestListStreamsEndpoint:
    def test_list_streams_empty(self):
        app = create_app()
        app.hls_server.port = 0
        thread = threading.Thread(target=app.serve_forever, daemon=True)
        thread.start()
        _wait_for_api(app)

        conn = HTTPConnection("127.0.0.1", app.hls_server.port + 1, timeout=2)
        conn.request("GET", "/api/streams")
        resp = conn.getresponse()
        body = json.loads(resp.read().decode())

        assert resp.status == 200
        assert body == {}
        conn.close()

        app.shutdown()


class TestStartStreamEndpoint:
    def test_start_stream_returns_200(self):
        app = create_app()
        app.hls_server.port = 0
        thread = threading.Thread(target=app.serve_forever, daemon=True)
        thread.start()
        _wait_for_api(app)

        payload = json.dumps({
            "protocol": "rtmp",
            "port": 1935,
            "stream_key": "live",
        }).encode()

        conn = HTTPConnection("127.0.0.1", app.hls_server.port + 1, timeout=2)
        conn.request(
            "POST",
            "/api/streams/test-stream",
            body=payload,
            headers={"Content-Type": "application/json"},
        )
        resp = conn.getresponse()
        body = json.loads(resp.read().decode())

        assert resp.status == 200
        assert body["stream_id"] == "test-stream"
        conn.close()

        app.shutdown()


class TestStopStreamEndpoint:
    def test_stop_stream_returns_200(self):
        app = create_app()
        app.hls_server.port = 0
        thread = threading.Thread(target=app.serve_forever, daemon=True)
        thread.start()
        _wait_for_api(app)

        conn = HTTPConnection("127.0.0.1", app.hls_server.port + 1, timeout=2)
        conn.request("DELETE", "/api/streams/nonexistent")
        resp = conn.getresponse()

        assert resp.status == 200
        conn.close()

        app.shutdown()


class TestConfigEndpoint:
    def test_config_returns_200(self):
        app = create_app()
        app.hls_server.port = 0
        thread = threading.Thread(target=app.serve_forever, daemon=True)
        thread.start()
        _wait_for_api(app)

        conn = HTTPConnection("127.0.0.1", app.hls_server.port + 1, timeout=2)
        conn.request("GET", "/api/config")
        resp = conn.getresponse()
        body = json.loads(resp.read().decode())

        assert resp.status == 200
        assert "server" in body
        assert "hls" in body
        assert "ingest" in body
        conn.close()

        app.shutdown()
