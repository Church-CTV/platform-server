"""ctv-server — Direct-to-CTV live stream pipeline entry point."""

from __future__ import annotations

import argparse
import logging
import signal
import sys

from ctv_server.app import CTVServer
from ctv_server.config import load_config

logger = logging.getLogger("ctv-server")


def main() -> None:
    parser = argparse.ArgumentParser(description="ctv-server — Direct-to-CTV live stream pipeline")
    parser.add_argument("--config", "-c", default="config.yaml", help="Path to config file")
    parser.add_argument("--host", default=None, help="Server host (overrides config)")
    parser.add_argument("--port", type=int, default=None, help="Server port (overrides config)")
    parser.add_argument("--debug", action="store_true", help="Enable debug logging")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.debug else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    config = load_config(args.config)

    if args.host:
        config.server.host = args.host
    if args.port is not None:
        config.server.port = args.port

    app = CTVServer(config=config)

    # Graceful shutdown
    def shutdown_handler(signum: int, frame: object) -> None:
        logger.info("Shutting down...")
        app.shutdown()
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown_handler)
    signal.signal(signal.SIGTERM, shutdown_handler)

    logger.info("Starting ctv-server on %s:%d", config.server.host, config.server.port)
    logger.info("HLS directory: %s", config.hls.directory)
    logger.info("API will be available on port %d", config.server.port + 1)

    app.serve_forever()

    try:
        # Keep running
        while True:
            signal.pause()
    except AttributeError:
        # signal.pause() not available on Windows
        import time
        while True:
            time.sleep(1)


if __name__ == "__main__":
    main()
