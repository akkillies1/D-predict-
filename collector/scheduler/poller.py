"""Scheduler / poller. Each poll is one 'ingestion run' — gets a fresh
ingestion_run_id so every persisted row can be traced back to exactly which
run produced it. This module orchestrates; it contains no NSE/Yahoo-specific
logic and no business decisions (see collector-level rule in adapters/nse.py).
"""

import time
import uuid

from collector.adapters.nse import NSEAdapter
from collector.adapters.yahoo import YahooAdapter
from collector.config import config
from collector.logging_config import get_logger
from collector.persistence.postgres import PostgresPersistence
from collector.validation.market_data import validate_option_snapshot, validate_price_bar

logger = get_logger(__name__)


class Poller:
    def __init__(self):
        self._nse = NSEAdapter()
        self._yahoo = YahooAdapter()
        self._db = PostgresPersistence()

    def run_option_chain_poll(self) -> None:
        run_id = uuid.uuid4()
        for symbol in self._db.active_symbols():
            if symbol not in {"NIFTY", "BANKNIFTY"}:
                logger.info("skipping NSE option chain for non-index symbol %s", symbol)
                continue
            try:
                snapshots = self._nse.fetch_option_chain(symbol)
            except Exception:
                logger.exception("nse fetch failed for %s (run=%s)", symbol, run_id)
                continue

            valid, dropped = [], 0
            for snap in snapshots:
                problems = validate_option_snapshot(snap)
                if problems:
                    dropped += 1
                    logger.warning("dropped option snapshot %s: %s", snap, problems)
                else:
                    valid.append(snap)

            if valid:
                self._db.save_option_snapshots(valid, run_id)
            logger.info(
                "option_chain_poll symbol=%s run=%s saved=%d dropped=%d",
                symbol, run_id, len(valid), dropped,
            )

    def run_price_bar_poll(self) -> None:
        run_id = uuid.uuid4()
        for symbol in self._db.active_symbols():
            try:
                bars = self._yahoo.fetch_price_bars(symbol)
            except Exception:
                logger.exception("yahoo fetch failed for %s (run=%s)", symbol, run_id)
                continue

            valid, dropped = [], 0
            for bar in bars:
                problems = validate_price_bar(bar)
                if problems:
                    dropped += 1
                    logger.warning("dropped price bar %s: %s", bar, problems)
                else:
                    valid.append(bar)

            if valid:
                self._db.save_price_bars(valid, run_id)
            logger.info(
                "price_bar_poll symbol=%s run=%s saved=%d dropped=%d",
                symbol, run_id, len(valid), dropped,
            )

    def _symbols(self) -> list[str]:
        return self._db.active_symbols()

    def run_forever(self) -> None:
        """Simple blocking loop for a first version. Swap for a proper
        scheduler (APScheduler / cron-triggered invocation) once this is stable."""
        last_option_poll = 0.0
        last_price_poll = 0.0

        while True:
            now = time.monotonic()
            if now - last_option_poll >= config.option_chain_poll_seconds:
                self.run_option_chain_poll()
                last_option_poll = now
            if now - last_price_poll >= config.price_bar_poll_seconds:
                self.run_price_bar_poll()
                last_price_poll = now
            time.sleep(1)
