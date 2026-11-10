"""ctv-server configuration."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml


@dataclass
class ServerConfig:
    host: str = "0.0.0.0"
    port: int = 8080


@dataclass
class HLSConfig:
    directory: str = "./hls"
    segment_duration: int = 4
    target_playlist_type: str = "event"


@dataclass
class IngestConfig:
    rtmp_port: int = 1935
    srt_port: int = 10000
    ffmpeg_path: str = "ffmpeg"


@dataclass
class Config:
    server: ServerConfig = field(default_factory=ServerConfig)
    hls: HLSConfig = field(default_factory=HLSConfig)
    ingest: IngestConfig = field(default_factory=IngestConfig)
    streams: dict = field(default_factory=dict)

    def __init__(
        self,
        server: ServerConfig | None = None,
        hls: HLSConfig | None = None,
        ingest: IngestConfig | None = None,
        streams: dict | None = None,
        # flat kwargs (convenience)
        server_host: str | None = None,
        server_port: int | None = None,
        hls_directory: str | None = None,
        hls_segment_duration: int | None = None,
        hls_target_playlist_type: str | None = None,
        ingest_rtmp_port: int | None = None,
        ingest_srt_port: int | None = None,
        ingest_ffmpeg_path: str | None = None,
    ) -> None:
        if server is None:
            server = ServerConfig()
        if hls is None:
            hls = HLSConfig()
        if ingest is None:
            ingest = IngestConfig()

        if server_host is not None:
            server.host = server_host
        if server_port is not None:
            server.port = server_port
        if hls_directory is not None:
            hls.directory = hls_directory
        if hls_segment_duration is not None:
            hls.segment_duration = hls_segment_duration
        if hls_target_playlist_type is not None:
            hls.target_playlist_type = hls_target_playlist_type
        if ingest_rtmp_port is not None:
            ingest.rtmp_port = ingest_rtmp_port
        if ingest_srt_port is not None:
            ingest.srt_port = ingest_srt_port
        if ingest_ffmpeg_path is not None:
            ingest.ffmpeg_path = ingest_ffmpeg_path

        object.__setattr__(self, "server", server)
        object.__setattr__(self, "hls", hls)
        object.__setattr__(self, "ingest", ingest)
        object.__setattr__(self, "streams", streams or {})

    @staticmethod
    def from_kwargs(
        server_host: str | None = None,
        server_port: int | None = None,
        hls_directory: str | None = None,
        hls_segment_duration: int | None = None,
        hls_target_playlist_type: str | None = None,
        ingest_rtmp_port: int | None = None,
        ingest_srt_port: int | None = None,
        ingest_ffmpeg_path: str | None = None,
        streams: dict | None = None,
    ) -> Config:
        server = ServerConfig()
        if server_host is not None:
            server.host = server_host
        if server_port is not None:
            server.port = server_port

        hls = HLSConfig()
        if hls_directory is not None:
            hls.directory = hls_directory
        if hls_segment_duration is not None:
            hls.segment_duration = hls_segment_duration
        if hls_target_playlist_type is not None:
            hls.target_playlist_type = hls_target_playlist_type

        ingest = IngestConfig()
        if ingest_rtmp_port is not None:
            ingest.rtmp_port = ingest_rtmp_port
        if ingest_srt_port is not None:
            ingest.srt_port = ingest_srt_port
        if ingest_ffmpeg_path is not None:
            ingest.ffmpeg_path = ingest_ffmpeg_path

        return Config(
            server=server,
            hls=hls,
            ingest=ingest,
            streams=streams or {},
        )


def load_config(path: str = "config.yaml") -> Config:
    """Load config from a YAML file."""
    config_path = Path(path)
    if not config_path.exists():
        return Config()

    with open(config_path) as f:
        data = yaml.safe_load(f) or {}

    server_data = data.get("server", {})
    hls_data = data.get("hls", {})
    ingest_data = data.get("ingest", {})
    streams_data = data.get("streams", {})

    return Config.from_kwargs(
        server_host=server_data.get("host"),
        server_port=server_data.get("port"),
        hls_directory=hls_data.get("directory"),
        hls_segment_duration=hls_data.get("segment_duration"),
        hls_target_playlist_type=hls_data.get("target_playlist_type"),
        ingest_rtmp_port=ingest_data.get("rtmp_port"),
        ingest_srt_port=ingest_data.get("srt_port"),
        ingest_ffmpeg_path=ingest_data.get("ffmpeg_path"),
        streams=streams_data,
    )
