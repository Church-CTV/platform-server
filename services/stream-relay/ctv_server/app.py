"""ctv-server application — HTTP API + HLS server + stream manager."""

from __future__ import annotations

import json
import logging
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from typing import Any

from ctv_server.config import Config, load_config
from ctv_server.hls_server import HLSServer
from ctv_server.stream_manager import StreamManager

logger = logging.getLogger("ctv-server")


class _APIHandler(BaseHTTPRequestHandler):
    """Handle REST API requests."""

    app: "CTVServer"  # type: ignore[name-defined]

    def do_GET(self) -> None:
        if self.path == "/api/health":
            self._json_response(200, {"status": "ok"})
        elif self.path == "/api/streams":
            streams = self.app.stream_manager.list_streams()
            self._json_response(200, streams)
        elif self.path == "/api/config":
            cfg = self.app.config
            self._json_response(200, {
                "server": {
                    "host": cfg.server.host,
                    "port": cfg.server.port,
                },
                "hls": {
                    "directory": cfg.hls.directory,
                    "segment_duration": cfg.hls.segment_duration,
                    "target_playlist_type": cfg.hls.target_playlist_type,
                },
                "ingest": {
                    "rtmp_port": cfg.ingest.rtmp_port,
                    "srt_port": cfg.ingest.srt_port,
                    "ffmpeg_path": cfg.ingest.ffmpeg_path,
                },
            })
        else:
            self._json_response(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path.startswith("/api/streams/"):
            stream_id = self.path.split("/api/streams/")[1].split("?")[0]
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            result = self.app.stream_manager.start_stream(
                stream_id=stream_id,
                protocol=body.get("protocol", "rtmp"),
                port=body.get("port", 1935),
                stream_key=body.get("stream_key", "live"),
            )
            self._json_response(200, {"stream_id": stream_id, "status": "started"})
        else:
            self._json_response(404, {"error": "not found"})

    def do_DELETE(self) -> None:
        if self.path.startswith("/api/streams/"):
            stream_id = self.path.split("/api/streams/")[1].split("?")[0]
            self.app.stream_manager.stop_stream(stream_id)
            self._json_response(200, {"stream_id": stream_id, "status": "stopped"})
        else:
            self._json_response(404, {"error": "not found"})

    def _json_response(self, status: int, data: Any) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def log_message(self, format: str, *args: Any) -> None:
        logger.info(format, *args)


class CTVServer:
    """Main application — combines HLS server and API."""

    def __init__(self, config: Config | None = None) -> None:
        self.config = config or load_config()
        self.hls_server = HLSServer(
            host=self.config.server.host,
            port=self.config.server.port,
            hls_dir=self.config.hls.directory,
        )
        self.stream_manager = StreamManager(
            hls_dir=self.config.hls.directory,
            segment_duration=self.config.hls.segment_duration,
            target_playlist_type=self.config.hls.target_playlist_type,
            host=self.config.server.host,
            port=self.config.server.port,
            ffmpeg_path=self.config.ingest.ffmpeg_path,
        )
        self._api_server: HTTPServer | None = None
        self._api_thread: threading.Thread | None = None

    def serve_forever(self) -> None:
        """Start the HLS server and API server."""
        self.hls_server.serve_forever()

        api_port = self.hls_server.port + 1
        self._api_server = HTTPServer(
            (self.config.server.host, api_port),
            _APIHandler,
        )
        _APIHandler.app = self  # type: ignore[attr-defined]
        self._api_thread = threading.Thread(target=self._api_server.serve_forever, daemon=True)
        self._api_thread.start()

    def shutdown(self) -> None:
        """Stop all servers."""
        self.hls_server.shutdown()
        if self._api_server is not None:
            self._api_server.shutdown()
            self._api_server.server_close()


def create_app(config: Config | None = None) -> CTVServer:
    """Factory function for creating the CTVServer."""
    return CTVServer(config=config)