"""Tests for stream manager."""

from unittest.mock import MagicMock, patch

from ctv_server.stream_manager import StreamManager


class TestStreamManager:
    def test_start_stream(self):
        mgr = StreamManager(hls_dir="/tmp/hls")

        with patch.object(mgr, "_start_stream") as mock_start:
            mgr.start_stream("church-main", protocol="rtmp", port=1935, stream_key="live")
            mock_start.assert_called_once_with(
                "church-main", protocol="rtmp", port=1935, stream_key="live"
            )

    def test_stop_stream(self):
        mgr = StreamManager(hls_dir="/tmp/hls")

        with patch.object(mgr, "_stop_stream") as mock_stop:
            mgr.stop_stream("church-main")
            mock_stop.assert_called_once_with("church-main")

    def test_get_stream_status_running(self):
        mgr = StreamManager(hls_dir="/tmp/hls")

        mock_ingest = MagicMock()
        mock_ingest.is_running.return_value = True
        mgr.streams = {"church-main": mock_ingest}

        status = mgr.get_stream_status("church-main")

        assert status["stream_id"] == "church-main"
        assert status["running"] is True

    def test_get_stream_status_stopped(self):
        mgr = StreamManager(hls_dir="/tmp/hls")

        mock_ingest = MagicMock()
        mock_ingest.is_running.return_value = False
        mgr.streams = {"church-main": mock_ingest}

        status = mgr.get_stream_status("church-main")

        assert status["stream_id"] == "church-main"
        assert status["running"] is False

    def test_get_stream_status_unknown(self):
        mgr = StreamManager(hls_dir="/tmp/hls")

        status = mgr.get_stream_status("unknown")

        assert status["stream_id"] == "unknown"
        assert status["running"] is False

    def test_list_streams(self):
        mgr = StreamManager(hls_dir="/tmp/hls")

        mock_ingest1 = MagicMock()
        mock_ingest1.is_running.return_value = True
        mock_ingest2 = MagicMock()
        mock_ingest2.is_running.return_value = False

        mgr.streams = {
            "church-main": mock_ingest1,
            "church-2": mock_ingest2,
        }

        streams = mgr.list_streams()

        assert len(streams) == 2
        assert "church-main" in streams
        assert "church-2" in streams
        assert streams["church-main"]["running"] is True
        assert streams["church-2"]["running"] is False

    def test_list_streams_empty(self):
        mgr = StreamManager(hls_dir="/tmp/hls")

        streams = mgr.list_streams()

        assert len(streams) == 0

    def test_get_hls_url(self):
        mgr = StreamManager(hls_dir="/tmp/hls", host="127.0.0.1", port=8080)

        url = mgr.get_hls_url("church-main")

        assert url == "http://127.0.0.1:8080/church-main.m3u8"

    def test_get_hls_url_with_subdir(self):
        mgr = StreamManager(
            hls_dir="/tmp/hls/streams",
            host="127.0.0.1",
            port=8080,
            hls_subdir=True,
        )

        url = mgr.get_hls_url("church-main")

        assert url == "http://127.0.0.1:8080/church-main/church-main.m3u8"
