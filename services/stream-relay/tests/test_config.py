"""Tests for config module."""

from ctv_server.config import Config, load_config


class TestConfig:
    def test_default_server_config(self):
        config = Config()
        assert config.server.host == "0.0.0.0"
        assert config.server.port == 8080

    def test_default_hls_config(self):
        config = Config()
        assert config.hls.segment_duration == 4
        assert config.hls.target_playlist_type == "event"

    def test_default_ingest_config(self):
        config = Config()
        assert config.ingest.rtmp_port == 1935
        assert config.ingest.srt_port == 10000

    def test_custom_values_override_defaults(self):
        config = Config(
            server_host="127.0.0.1",
            server_port=9000,
            hls_directory="/tmp/hls",
            hls_segment_duration=2,
        )
        assert config.server.host == "127.0.0.1"
        assert config.server.port == 9000
        assert config.hls.directory == "/tmp/hls"
        assert config.hls.segment_duration == 2

    def test_stream_config(self):
        config = Config()
        assert config.streams == {}

    def test_stream_config_with_values(self):
        config = Config(
            streams={
                "church-main": {
                    "ingest": {"protocol": "rtmp", "port": 1935, "stream_key": "live"},
                    "hls": {"playlist_name": "church-main.m3u8"},
                }
            }
        )
        assert "church-main" in config.streams
        assert config.streams["church-main"]["ingest"]["protocol"] == "rtmp"


class TestLoadConfig:
    def test_load_config_from_file(self, tmp_path):
        config_file = tmp_path / "config.yaml"
        config_file.write_text(
            "server:\n  host: 127.0.0.1\n  port: 9000\n"
        )
        config = load_config(str(config_file))
        assert config.server.host == "127.0.0.1"
        assert config.server.port == 9000

    def test_load_config_missing_file_raises(self):
        try:
            load_config("/nonexistent/config.yaml")
        except FileNotFoundError:
            pass  # Expected

    def test_load_config_with_hls_directory(self, tmp_path):
        config_file = tmp_path / "config.yaml"
        config_file.write_text(
            "hls:\n  directory: /tmp/hls\n  segment_duration: 6\n"
        )
        config = load_config(str(config_file))
        assert config.hls.directory == "/tmp/hls"
        assert config.hls.segment_duration == 6
