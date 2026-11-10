"""FFmpeg ingest manager — launches and controls HLS packaging subprocesses."""

from __future__ import annotations

import subprocess
from pathlib import Path


class FFmpegIngest:
    """Manages a single FFmpeg process that converts RTMP/SRT → HLS."""

    def __init__(
        self,
        stream_id: str,
        hls_dir: str,
        segment_duration: int = 4,
        ffmpeg_path: str = "ffmpeg",
        target_playlist_type: str = "event",
    ) -> None:
        self.stream_id = stream_id
        self.hls_dir = hls_dir
        self.segment_duration = segment_duration
        self.ffmpeg_path = ffmpeg_path
        self.target_playlist_type = target_playlist_type
        self.process: subprocess.Popen | None = None
        self._command: list[str] | None = None

    @property
    def hls_playlist_path(self) -> str:
        return str(Path(self.hls_dir) / f"{self.stream_id}.m3u8")

    @property
    def hls_segment_path(self) -> str:
        return str(Path(self.hls_dir) / self.stream_id)

    def build_command(
        self,
        protocol: str,
        port: int,
        stream_key: str = "live",
    ) -> list[str]:
        """Build the FFmpeg command for the given ingest protocol."""
        if protocol == "srt":
            input_url = f"srt://0.0.0.0:{port}?mode=listener"
        elif protocol == "rtmp":
            input_url = f"rtmp://0.0.0.0:{port}/{stream_key}/{self.stream_id}"
        else:
            raise ValueError(f"Unsupported protocol: {protocol}")

        return [
            self.ffmpeg_path,
            "-y",
            "-i", input_url,
            "-c:v", "copy",
            "-c:a", "aac",
            "-f", "hls",
            "-hls_time", str(self.segment_duration),
            "-hls_playlist_type", self.target_playlist_type,
            "-hls_segment_filename", f"{self.hls_segment_path}_%03d.ts",
            self.hls_playlist_path,
        ]

    def start(
        self,
        protocol: str | None = None,
        port: int | None = None,
        stream_key: str = "live",
    ) -> None:
        """Start the FFmpeg process. Optionally build command first."""
        if self._command is None:
            if protocol is None or port is None:
                raise RuntimeError("No command built; call build_command() first")
            self._command = self.build_command(protocol, port, stream_key)

        self.process = subprocess.Popen(
            self._command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def stop(self) -> None:
        """Stop the FFmpeg process."""
        if self.process is None:
            return

        self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()

        self.process = None

    def is_running(self) -> bool:
        """Check if the FFmpeg process is still alive."""
        if self.process is None:
            return False
        return self.process.poll() is None
