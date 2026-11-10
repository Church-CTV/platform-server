"""Stream manager — orchestrates FFmpeg ingest and HLS serving."""

from __future__ import annotations

from ctv_server.ffmpeg import FFmpegIngest


class StreamManager:
    """Manages multiple streams: start, stop, status."""

    def __init__(
        self,
        hls_dir: str = "./hls",
        segment_duration: int = 4,
        target_playlist_type: str = "event",
        host: str = "0.0.0.0",
        port: int = 8080,
        ffmpeg_path: str = "ffmpeg",
        hls_subdir: bool = False,
    ) -> None:
        self.hls_dir = hls_dir
        self.segment_duration = segment_duration
        self.target_playlist_type = target_playlist_type
        self.host = host
        self.port = port
        self.ffmpeg_path = ffmpeg_path
        self.hls_subdir = hls_subdir
        self.streams: dict[str, FFmpegIngest] = {}

    def _make_ingest(self, stream_id: str) -> FFmpegIngest:
        if self.hls_subdir:
            hls_dir = f"{self.hls_dir}/{stream_id}"
        else:
            hls_dir = self.hls_dir
        return FFmpegIngest(
            stream_id=stream_id,
            hls_dir=hls_dir,
            segment_duration=self.segment_duration,
            ffmpeg_path=self.ffmpeg_path,
            target_playlist_type=self.target_playlist_type,
        )

    def start_stream(
        self,
        stream_id: str,
        protocol: str,
        port: int,
        stream_key: str = "live",
    ) -> None:
        """Start a stream by ID."""
        self._start_stream(stream_id, protocol=protocol, port=port, stream_key=stream_key)

    def _start_stream(
        self,
        stream_id: str,
        protocol: str,
        port: int,
        stream_key: str = "live",
    ) -> None:
        """Internal: create and start FFmpeg ingest."""
        ingest = self._make_ingest(stream_id)
        ingest.start(protocol=protocol, port=port, stream_key=stream_key)
        self.streams[stream_id] = ingest

    def stop_stream(self, stream_id: str) -> None:
        """Stop a stream by ID."""
        self._stop_stream(stream_id)

    def _stop_stream(self, stream_id: str) -> None:
        """Internal: stop and remove FFmpeg ingest."""
        if stream_id in self.streams:
            self.streams[stream_id].stop()
            del self.streams[stream_id]

    def get_stream_status(self, stream_id: str) -> dict:
        """Get status of a single stream."""
        ingest = self.streams.get(stream_id)
        if ingest is None:
            return {"stream_id": stream_id, "running": False}
        return {"stream_id": stream_id, "running": ingest.is_running()}

    def list_streams(self) -> dict:
        """Get status of all streams."""
        return {
            sid: {"stream_id": sid, "running": ingest.is_running()}
            for sid, ingest in self.streams.items()
        }

    def get_hls_url(self, stream_id: str) -> str:
        """Build the HLS manifest URL for a stream."""
        if self.hls_subdir:
            path = f"{stream_id}/{stream_id}.m3u8"
        else:
            path = f"{stream_id}.m3u8"
        return f"http://{self.host}:{self.port}/{path}"
