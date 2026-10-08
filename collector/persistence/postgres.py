"""Persistence layer. Every insert is an idempotent upsert keyed on the
(instrument/contract, market_timestamp, source) uniqueness boundary defined in
the schema — re-polling the same moment updates provenance fields but never
creates a duplicate row.

This is the ONLY module that should know SQL. Everything above it works with
canonical dataclasses.
"""

import uuid
from datetime import date

import psycopg2
import psycopg2.extras

from collector.canonical.options import CanonicalOptionSnapshot
from collector.canonical.price import CanonicalPriceBar
from collector.config import config
from collector.logging_config import get_logger

logger = get_logger(__name__)

_PRICE_BAR_UPSERT = """
insert into price_bars (
    instrument_id, market_timestamp, collected_at, timeframe,
    open, high, low, close, volume, source, source_version, ingestion_run_id
)
select instrument_id, %(market_timestamp)s, now(), %(timeframe)s,
       %(open)s, %(high)s, %(low)s, %(close)s, %(volume)s,
       %(source)s, %(source_version)s, %(ingestion_run_id)s
from instruments where symbol = %(instrument_symbol)s
on conflict (instrument_id, timeframe, market_timestamp, source)
do update set collected_at = excluded.collected_at,
              source_version = excluded.source_version,
              ingestion_run_id = excluded.ingestion_run_id;
"""

_OPTION_CONTRACT_UPSERT = """
insert into option_contracts (instrument_id, expiry_date, strike, option_type, lot_size)
select instrument_id, %(expiry_date)s, %(strike)s, %(option_type)s, %(lot_size)s
from instruments where symbol = %(instrument_symbol)s
on conflict (instrument_id, expiry_date, strike, option_type) do update set lot_size = coalesce(excluded.lot_size, option_contracts.lot_size)
returning contract_id;
"""

_OPTION_CONTRACT_LOOKUP = """
select oc.contract_id from option_contracts oc
join instruments i on i.instrument_id = oc.instrument_id
where i.symbol = %(instrument_symbol)s
  and oc.expiry_date = %(expiry_date)s
  and oc.strike = %(strike)s
  and oc.option_type = %(option_type)s;
"""

_OPTION_SNAPSHOT_UPSERT = """
insert into option_snapshots (
    contract_id, market_timestamp, collected_at, ltp, bid, ask, volume,
    oi, oi_change, iv, delta, gamma, theta, vega,
    source, source_version, ingestion_run_id
) values (
    %(contract_id)s, %(market_timestamp)s, now(), %(ltp)s, %(bid)s, %(ask)s, %(volume)s,
    %(oi)s, %(oi_change)s, %(iv)s, %(delta)s, %(gamma)s, %(theta)s, %(vega)s,
    %(source)s, %(source_version)s, %(ingestion_run_id)s
)
on conflict (contract_id, market_timestamp, source)
do update set collected_at = excluded.collected_at,
              source_version = excluded.source_version,
              ingestion_run_id = excluded.ingestion_run_id;
"""


_CHAIN_TIMESTAMPS = """
select distinct os.market_timestamp
from option_snapshots os
join option_contracts oc on oc.contract_id = os.contract_id
join instruments i on i.instrument_id = oc.instrument_id
where i.symbol = %(symbol)s and os.market_timestamp >= %(since)s
order by os.market_timestamp desc
limit 2;
"""

_CHAIN_LEGS = """
select oc.expiry_date, oc.strike, oc.option_type, os.oi, os.iv
from option_snapshots os
join option_contracts oc on oc.contract_id = os.contract_id
join instruments i on i.instrument_id = oc.instrument_id
where i.symbol = %(symbol)s and os.market_timestamp = %(ts)s;
"""

_LATEST_DAILY_CLOSE = """
select pb.close
from price_bars pb
join instruments i on i.instrument_id = pb.instrument_id
where i.symbol = %(symbol)s and pb.timeframe = '1d'
order by pb.market_timestamp desc
limit 1;
"""


class PostgresPersistence:
    def __init__(self, dsn: str | None = None):
        self._dsn = dsn or config.database_url
        self._conn = psycopg2.connect(self._dsn)
        self._conn.autocommit = True

    def close(self) -> None:
        self._conn.close()

    def active_symbols(self) -> list[str]:
        with self._conn.cursor() as cur:
            cur.execute("select symbol from instruments where is_active = true order by symbol")
            return [row[0] for row in cur.fetchall()]

    def option_chain_timestamps(self, symbol: str, since) -> list:
        with self._conn.cursor() as cur:
            cur.execute(_CHAIN_TIMESTAMPS, {"symbol": symbol, "since": since})
            return [row[0] for row in cur.fetchall()]

    def option_chain_legs(self, symbol: str, ts) -> list[dict]:
        with self._conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(_CHAIN_LEGS, {"symbol": symbol, "ts": ts})
            return cur.fetchall()

    def latest_daily_close(self, symbol: str) -> float | None:
        with self._conn.cursor() as cur:
            cur.execute(_LATEST_DAILY_CLOSE, {"symbol": symbol})
            row = cur.fetchone()
            return float(row[0]) if row else None

    def save_price_bars(self, bars: list[CanonicalPriceBar], ingestion_run_id: uuid.UUID) -> None:
        with self._conn.cursor() as cur:
            for bar in bars:
                cur.execute(
                    _PRICE_BAR_UPSERT,
                    {
                        "instrument_symbol": bar.instrument_symbol,
                        "market_timestamp": bar.market_timestamp,
                        "timeframe": bar.timeframe,
                        "open": bar.open,
                        "high": bar.high,
                        "low": bar.low,
                        "close": bar.close,
                        "volume": bar.volume,
                        "source": bar.source,
                        "source_version": bar.source_version,
                        "ingestion_run_id": str(ingestion_run_id),
                    },
                )
        logger.info("persisted %d price bars", len(bars))

    def daily_bars(self, symbol: str, limit: int = 60) -> list[dict]:
        """Most recent daily closes/volumes, oldest first — the sweep's view
        of what the collector has already persisted for this instrument."""
        with self._conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                select pb.market_timestamp, pb.close, pb.volume
                from price_bars pb
                join instruments i on i.instrument_id = pb.instrument_id
                where i.symbol = %s and pb.timeframe = '1d'
                order by pb.market_timestamp desc
                limit %s
                """,
                (symbol, limit),
            )
            rows = cur.fetchall()
        return list(reversed(rows))

    def alert_is_recent(self, symbol: str, rule: str, cooldown_hours: int) -> bool:
        with self._conn.cursor() as cur:
            cur.execute(
                """
                select exists(
                    select 1 from buy_alerts
                    where symbol = %s and rule = %s
                      and created_at > now() - (%s || ' hours')::interval
                )
                """,
                (symbol, rule, str(cooldown_hours)),
            )
            return bool(cur.fetchone()[0])

    def insert_alert(
        self,
        symbol: str,
        rule: str,
        evidence: dict,
        price: float,
        market_timestamp,
        new_to_radar: bool,
    ) -> int | None:
        """Idempotent on (symbol, rule, market_timestamp): returns the alert
        id, or None when that exact bar/rule already alerted."""
        try:
            with self._conn.cursor() as cur:
                cur.execute(
                    """
                    insert into buy_alerts (symbol, rule, evidence, price, market_timestamp, new_to_radar)
                    values (%s, %s, %s, %s, %s, %s)
                    returning id
                    """,
                    (
                        symbol,
                        rule,
                        psycopg2.extras.Json(evidence),
                        price,
                        market_timestamp,
                        new_to_radar,
                    ),
                )
                return int(cur.fetchone()[0])
        except psycopg2.errors.UniqueViolation:
            self._conn.rollback()
            return None

    def radar_active_count(self) -> int:
        with self._conn.cursor() as cur:
            cur.execute("select count(*) from instruments where canonical_source = 'radar' and is_active = true")
            return int(cur.fetchone()[0])

    def activate_radar_instrument(self, symbol: str, provider_symbol: str) -> None:
        """First-touch onboarding: a radar trigger activates the instrument
        so the normal poll cycles start persisting its bars."""
        with self._conn.cursor() as cur:
            cur.execute(
                """
                insert into instruments (symbol, exchange, lot_size, is_active, provider_symbol, instrument_type, canonical_source)
                values (%s, 'NSE', 1, true, %s, 'EQUITY', 'radar')
                on conflict (symbol) do update set is_active = true
                """,
                (symbol, provider_symbol),
            )

    def _get_or_create_contract_id(self, symbol: str, expiry: date, strike: float, opt_type: str, lot_size: int | None):
        params = {
            "instrument_symbol": symbol,
            "expiry_date": expiry,
            "strike": strike,
            "option_type": opt_type,
            "lot_size": lot_size,
        }
        with self._conn.cursor() as cur:
            cur.execute(_OPTION_CONTRACT_UPSERT, params)
            row = cur.fetchone()
            if row:
                return row[0]
            cur.execute(_OPTION_CONTRACT_LOOKUP, params)
            return cur.fetchone()[0]

    def save_option_snapshots(
        self, snapshots: list[CanonicalOptionSnapshot], ingestion_run_id: uuid.UUID
    ) -> None:
        with self._conn.cursor() as cur:
            for snap in snapshots:
                contract_id = self._get_or_create_contract_id(
                    snap.instrument_symbol, snap.expiry_date, snap.strike, snap.option_type, snap.lot_size
                )
                cur.execute(
                    _OPTION_SNAPSHOT_UPSERT,
                    {
                        "contract_id": contract_id,
                        "market_timestamp": snap.market_timestamp,
                        "ltp": snap.ltp,
                        "bid": snap.bid,
                        "ask": snap.ask,
                        "volume": snap.volume,
                        "oi": snap.oi,
                        "oi_change": snap.oi_change,
                        "iv": snap.iv,
                        "delta": snap.delta,
                        "gamma": snap.gamma,
                        "theta": snap.theta,
                        "vega": snap.vega,
                        "source": snap.source,
                        "source_version": snap.source_version,
                        "ingestion_run_id": str(ingestion_run_id),
                    },
                )
        logger.info("persisted %d option snapshots", len(snapshots))
