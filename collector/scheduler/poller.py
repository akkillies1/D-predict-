"""Scheduler / poller. Each poll is one 'ingestion run' — gets a fresh
ingestion_run_id so every persisted row can be traced back to exactly which
run produced it. This module orchestrates; it contains no NSE/Yahoo-specific
logic and no business decisions (see collector-level rule in adapters/nse.py).
"""

import time
import uuid
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from collector.adapters.nse import NSEAdapter
from collector.adapters.yahoo import YahooAdapter, provider_symbol
from collector.config import config
from collector.logging_config import get_logger
from collector.options_radar import evaluate_option_rules
from collector.persistence.postgres import PostgresPersistence
from collector.radar import MIN_BARS_PRICE, RADAR_SYMBOLS, drop_partial_last_bar, evaluate_rules
from collector.validation.market_data import validate_option_snapshot, validate_price_bar

logger = get_logger(__name__)
IST = ZoneInfo("Asia/Kolkata")


def nse_session_active(now_utc: datetime | None = None) -> bool:
    """NSE regular session 09:15-15:30 IST Mon-Fri, with small edge buffers.
    Polling the chain outside these hours just earns rate-limit blocks."""
    ist = (now_utc or datetime.now(timezone.utc)).astimezone(IST)
    if ist.weekday() >= 5:
        return False
    minutes = ist.hour * 60 + ist.minute
    return 9 * 60 + 10 <= minutes <= 15 * 60 + 40


class Poller:
    def __init__(self):
        self._nse = NSEAdapter()
        self._yahoo = YahooAdapter()
        self._db = PostgresPersistence()
        self._radar_cursor = 0
        # NSE answers empty/403 for non-F&O symbols and outside session; after
        # a few silent empties a symbol is muted until the next IST open
        # instead of burning rate-limit budget on every poll.
        self._chain_empties: dict[str, int] = {}
        self._chain_muted_until: dict[str, datetime] = {}

    def _note_chain_result(self, symbol: str, got_rows: bool, now_utc: datetime) -> None:
        if got_rows:
            self._chain_empties[symbol] = 0
            return
        streak = self._chain_empties.get(symbol, 0) + 1
        self._chain_empties[symbol] = streak
        if streak >= 3:
            ist_now = now_utc.astimezone(IST)
            next_open = (ist_now + timedelta(days=1)).replace(
                hour=9, minute=15, second=0, microsecond=0
            ).astimezone(timezone.utc)
            self._chain_muted_until[symbol] = next_open
            self._chain_empties[symbol] = 0
            logger.info("nse chain muted for %s until %s (empty responses)", symbol, next_open.isoformat())

    def run_option_chain_poll(self) -> None:
        now_utc = datetime.now(timezone.utc)
        if not nse_session_active(now_utc):
            logger.debug("option_chain_poll skipped: NSE session closed")
            return
        run_id = uuid.uuid4()
        for symbol in self._db.active_symbols():
            until = self._chain_muted_until.get(symbol)
            if until is not None and now_utc < until:
                continue
            try:
                snapshots = self._nse.fetch_option_chain(symbol)
            except Exception:
                logger.exception("nse fetch failed for %s (run=%s)", symbol, run_id)
                self._note_chain_result(symbol, False, now_utc)
                continue

            self._note_chain_result(symbol, bool(snapshots), now_utc)
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
                bars_1m = self._yahoo.fetch_price_bars(symbol)
                bars_1d = self._yahoo.fetch_price_bars(symbol, period="5y", interval="1d")
                bars = bars_1m + bars_1d
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

    def run_price_bar_backfill(self) -> None:
        """One-time startup catch-up: yfinance caps 1m history at ~7 days, so
        this pulls the widest window available and lets the idempotent upsert
        fill whatever bars the collector missed while it was down."""
        run_id = uuid.uuid4()
        for symbol in self._db.active_symbols():
            try:
                bars = self._yahoo.fetch_price_bars(symbol, period="7d", interval="1m")
            except Exception:
                logger.exception("yahoo 1m backfill failed for %s (run=%s)", symbol, run_id)
                continue

            valid, dropped = [], 0
            for bar in bars:
                problems = validate_price_bar(bar)
                if problems:
                    dropped += 1
                    logger.warning("dropped backfill bar %s: %s", bar, problems)
                else:
                    valid.append(bar)

            if valid:
                self._db.save_price_bars(valid, run_id)
            logger.info(
                "price_bar_backfill symbol=%s run=%s saved=%d dropped=%d",
                symbol, run_id, len(valid), dropped,
            )

    def _raise_alerts(self, symbol: str, fired, closes, last_ts, basis: str, bars: int, run_id, new_to_radar: bool) -> int:
        """Persist rule triggers with the exact numbers that fired them;
        24h per-(symbol, rule) cooldown keeps one regime change from spam."""
        raised = 0
        for rule, evidence in fired:
            evidence = {**evidence, "basis": basis, "bars_evaluated": bars, "as_of": last_ts.isoformat()}
            if self._db.alert_is_recent(symbol, rule, config.alert_cooldown_hours):
                continue
            alert_id = self._db.insert_alert(symbol, rule, evidence, closes[-1], last_ts, new_to_radar)
            if alert_id is not None:
                raised += 1
                logger.info(
                    "buy_alert id=%s symbol=%s rule=%s new_to_radar=%s run=%s",
                    alert_id, symbol, rule, new_to_radar, run_id,
                )
        return raised

    def run_alert_sweep(self) -> None:
        """Radar sweep: rules run on persisted daily bars for tracked
        instruments; untracked radar candidates are fetched live in small
        rotation slices and only onboarded (activated + bars persisted) when
        a rule actually fires — never speculatively."""
        run_id = uuid.uuid4()
        raised = 0

        tracked = self._db.active_symbols()
        for symbol in tracked:
            rows = drop_partial_last_bar(self._db.daily_bars(symbol), lambda row: row["market_timestamp"])
            if len(rows) < MIN_BARS_PRICE:
                continue
            closes = [float(row["close"]) for row in rows]
            volumes = [None if row["volume"] is None else float(row["volume"]) for row in rows]
            fired = evaluate_rules(closes, volumes)
            if fired:
                raised += self._raise_alerts(symbol, fired, closes, rows[-1]["market_timestamp"], "stored_bars", len(closes), run_id, False)

        candidates = [symbol for symbol in RADAR_SYMBOLS if symbol not in set(tracked)]
        chunk = config.radar_sweep_chunk
        if candidates and chunk > 0:
            start = self._radar_cursor % len(candidates)
            slice_symbols = candidates[start:start + chunk]
            if len(slice_symbols) < chunk:
                slice_symbols += candidates[:chunk - len(slice_symbols)]
            self._radar_cursor = (start + chunk) % len(candidates)
            for symbol in slice_symbols:
                try:
                    bars = self._yahoo.fetch_price_bars(symbol, period="6mo", interval="1d")
                except Exception:
                    logger.exception("radar fetch failed for %s (run=%s)", symbol, run_id)
                    continue
                valid = [bar for bar in bars if not validate_price_bar(bar)]
                valid = drop_partial_last_bar(valid, lambda bar: bar.market_timestamp)
                if len(valid) < MIN_BARS_PRICE:
                    logger.debug("radar %s: only %d valid bars, below evaluation minimum", symbol, len(valid))
                    continue
                closes = [bar.close for bar in valid]
                volumes = [None if bar.volume is None else float(bar.volume) for bar in valid]
                fired = evaluate_rules(closes, volumes)
                if not fired:
                    continue
                new_to_radar = self._db.radar_active_count() < config.radar_max_onboarded
                if new_to_radar:
                    self._db.activate_radar_instrument(symbol, provider_symbol(symbol))
                    self._db.save_price_bars(valid, run_id)
                raised += self._raise_alerts(symbol, fired, closes, valid[-1].market_timestamp, "radar_fetch", len(closes), run_id, new_to_radar)

        raised += self._run_option_alerts(run_id)

        logger.info("alert_sweep run=%s tracked=%d radar_slice=%d alerts=%d", run_id, len(tracked), chunk, raised)

    def _run_option_alerts(self, run_id) -> int:
        """Option-evidence rules compare the two most recent SAME-SESSION
        chain snapshots (>=25 min apart) for symbols whose chains we actually
        store; nothing is inferred without two real observations."""
        raised = 0
        ist_today_open = datetime.now(IST).replace(
            hour=9, minute=15, second=0, microsecond=0
        ).astimezone(timezone.utc)
        for symbol in self._db.active_symbols():
            stamps = self._db.option_chain_timestamps(symbol, ist_today_open)
            if len(stamps) < 2:
                continue
            now_ts, then_ts = stamps[0], stamps[-1]
            gap_minutes = (now_ts - then_ts).total_seconds() / 60
            if gap_minutes < 25:
                continue
            now_legs = self._db.option_chain_legs(symbol, now_ts)
            then_legs = self._db.option_chain_legs(symbol, then_ts)
            spot = self._db.latest_daily_close(symbol)
            if not now_legs or not then_legs or spot is None:
                continue
            fired = evaluate_option_rules(now_legs, then_legs, spot, gap_minutes)
            if fired:
                raised += self._raise_alerts(
                    symbol, fired, [spot], now_ts, "option_chain", len(now_legs), run_id, False
                )
        return raised

    def _symbols(self) -> list[str]:
        return self._db.active_symbols()

    def run_forever(self) -> None:
        """Simple blocking loop for a first version. Swap for a proper
        scheduler (APScheduler / cron-triggered invocation) once this is stable."""
        last_option_poll = 0.0
        last_price_poll = 0.0
        last_alert_sweep = 0.0

        logger.info("starting collector with 1m price backfill")
        try:
            self.run_price_bar_backfill()
        except Exception:
            logger.exception("1m price backfill failed; continuing with live polls")

        while True:
            now = time.monotonic()
            if now - last_option_poll >= config.option_chain_poll_seconds:
                self.run_option_chain_poll()
                last_option_poll = now
            if now - last_price_poll >= config.price_bar_poll_seconds:
                self.run_price_bar_poll()
                last_price_poll = now
            if now - last_alert_sweep >= config.alert_sweep_seconds:
                try:
                    self.run_alert_sweep()
                except Exception:
                    logger.exception("alert sweep failed; continuing polls")
                last_alert_sweep = now
            time.sleep(1)
