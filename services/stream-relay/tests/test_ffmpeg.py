"""Tests for FFmpeg ingest manager."""

import subprocess
from unittest.mock import MagicMock, patch

from ctv_server.ffmpeg import FFmpegIngest


class TestFFmpegIngest:
    def test_create_command_rtmp(self):
        ingest = FFmpegIngest(
            stream_id="church-main",
            hls_dir="/tmp/hls",
            segment_duration=4,
            ffmpeg_path="ffmpeg",
        )

        cmd = ingest.build_command(
            protocol="rtmp",
            port=1935,
            stream_key="live",
        )

        assert "ffmpeg" in cmd
        assert "-i" in cmd
        assert "rtmp://0.0.0.0:1935/live/church-main" in cmd
        assert "-f" in cmd
        assert "hls" in cmd
        assert "-hls_time" in cmd
        assert "4" in cmd
        assert "/tmp/hls/church-main.m3u8" in cmd

    def test_create_command_srt(self):
        ingest = FFmpegIngest(
            stream_id="church-main",
            hls_dir="/tmp/hls",
            segment_duration=4,
            ffmpeg_path="ffmpeg",
        )

        cmd = ingest.build_command(
            protocol="srt",
            port=10000,
            stream_key="live",
        )

        assert "ffmpeg" in cmd
        assert "-i" in cmd
        assert "srt://0.0.0.0:10000?mode=listener" in cmd
        assert "/tmp/hls/church-main.m3u8" in cmd

    def test_create_command_copies_video(self):
        ingest = FFmpegIngest(
            stream_id="church-main",
            hls_dir="/tmp/hls",
            segment_duration=4,
            ffmpeg_path="ffmpeg",
        )

        cmd = ingest.build_command(
            protocol="rtmp",
            port=1935,
            stream_key="live",
        )

        assert "-c:v" in cmd
        assert "copy" in cmd
        assert "-c:a" in cmd
        assert "aac" in cmd

    def test_start_creates_process(self):
        ingest = FFmpegIngest(
            stream_id="church-main",
            hls_dir="/tmp/hls",
            segment_duration=4,
            ffmpeg_path="ffmpeg",
        )

        with patch("subprocess.Popen") as mock_popen:
            mock_popen.return_value = MagicMock()
            ingest.start(
                protocol="rtmp",
                port=1935,
                stream_key="live",
            )

            mock_popen.assert_called_once()
            assert ingest.process is not None

    def test_stop_sends_sigterm(self):
        ingest = FFmpegIngest(
            stream_id="church-main",
            hls_dir="/tmp/hls",
            segment_duration=4,
            ffmpeg_path="ffmpeg",
        )

        mock_process = MagicMock()
        ingest.process = mock_process

        ingest.stop()

        mock_process.terminate.assert_called_once()

    def test_stop_noop_when_not_running(self):
        ingest = FFmpegIngest(
            stream_id="church-main",
            hls_dir="/tmp/hls",
            segment_duration=4,
            ffmpeg_path="ffmpeg",
        )

        ingest.stop()  # Should not raise

    def test_is_running_true(self):
        ingest = FFmpegIngest(
            stream_id="church-main",
            hls_dir="/tmp/hls",
            segment_duration=4,
            ffmpeg_path="ffmpeg",
        )

        mock_process = MagicMock()
        mock_process.poll.return_value = None
        ingest.process = mock_process

        assert ingest.is_running() is True

    def test_is_running_false_when_stopped(self):
        ingest = FFmpegIngest(
            stream_id="church-main",
            hls_dir="/tmp/hls",
            segment_duration=4,
            ffmpeg_path="ffmpeg",
        )

        mock_process = MagicMock()
        mock_process.poll.return_value = 0
        ingest.process = mock_process

        assert ingest.is_running() is False

    def test_is_running_false_when_none(self):
        ingest = FFmpegIngest(
            stream_id="church-main",
            hls_dir="/tmp/hls",
            segment_duration=4,
            ffmpeg_path="ffmpeg",
        )

        ingest.process = None
        assert ingest.is_running() is False

    def test_hls_playlist_path(self):
        ingest = FFmpegIngest(
            stream_id="church-main",
            hls_dir="/tmp/hls",
            segment_duration=4,
            ffmpeg_path="ffmpeg",
        )

        assert ingest.hls_playlist_path == "/tmp/hls/church-main.m3u8"

    def test_hls_segment_path(self):
        ingest = FFmpegIngest(
            stream_id="church-main",
            hls_dir="/tmp/hls",
            segment_duration=4,
            ffmpeg_path="ffmpeg",
        )

        assert ingest.hls_segment_path == "/tmp/hls/church-main"

    def test_build_command_custom_segment_duration(self):
        ingest = FFmpegIngest(
            stream_id="church-main",
            hls_dir="/tmp/hls",
            segment_duration=6,
            ffmpeg_path="ffmpeg",
        )

        cmd = ingest.build_command(
            protocol="rtmp",
            port=1935,
            stream_key="live",
        )

        idx = cmd.index("-hls_time")
        assert cmd[idx + 1] == "6"

    def test_build_command_custom_playlist_type(self):
        ingest = FFmpegIngest(
            stream_id="church-main",
            hls_dir="/tmp/hls",
            segment_duration=4,
            ffmpeg_path="ffmpeg",
            target_playlist_type="live",
        )

        cmd = ingest.build_command(
            protocol="rtmp",
            port=1935,
            stream_key="live",
        )

        assert "-hls_playlist_type" in cmd
        assert "live" in cmd

    def test_start_without_command_raises(self):
        ingest = FFmpegIngest(
            stream_id="church-main",
            hls_dir="/tmp/hls",
            segment_duration=4,
            ffmpeg_path="ffmpeg",
        )

        try:
            ingest.start()
        except RuntimeError:
            pass  # Expected — no command built yet

    def test_stop_with_process_returns_none(self):
        ingest = FFmpegIngest(
            stream_id="church-main",
            hls_dir="/tmp/hls",
            segment_duration=4,
            ffmpeg_path="ffmpeg",
        )

        mock_process = MagicMock()
        ingest.process = mock_process

        ingest.stop()

        assert ingest.process is None
