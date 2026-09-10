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
insert into option_contracts (instrument_id, expiry_date, strike, option_type)
select instrument_id, %(expiry_date)s, %(strike)s, %(option_type)s
from instruments where symbol = %(instrument_symbol)s
on conflict (instrument_id, expiry_date, strike, option_type) do nothing
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

    def _get_or_create_contract_id(self, symbol: str, expiry: date, strike: float, opt_type: str):
        params = {
            "instrument_symbol": symbol,
            "expiry_date": expiry,
            "strike": strike,
            "option_type": opt_type,
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
                    snap.instrument_symbol, snap.expiry_date, snap.strike, snap.option_type
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
