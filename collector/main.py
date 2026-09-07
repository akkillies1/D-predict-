"""Entrypoint. Run with: python -m collector.main"""

from collector.logging_config import get_logger
from collector.scheduler.poller import Poller

logger = get_logger(__name__)


def main() -> None:
    logger.info("starting collector")
    poller = Poller()
    poller.run_forever()


if __name__ == "__main__":
    main()
