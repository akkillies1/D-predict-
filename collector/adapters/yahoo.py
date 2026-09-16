"""Yahoo Finance adapter for 1-minute price bars.

The collector uses this adapter for every active symbol in PostgreSQL. It keeps
Yahoo-specific symbol mapping here so the scheduler remains provider-neutral.
"""

from datetime import timezone
from math import isfinite
from zoneinfo import ZoneInfo

import yfinance as yf

from collector.canonical.price import CanonicalPriceBar
from collector.config import config
from collector.logging_config import get_logger

logger = get_logger(__name__)

ADAPTER_VERSION = "yahoo_adapter_v2"
IST = ZoneInfo("Asia/Kolkata")


def _provider_symbol(symbol: str) -> str:
    """Map canonical local symbols to Yahoo identifiers without inventing data."""
    canonical = symbol.strip().upper()
    mapped = config.yahoo_symbol_map.get(canonical)
    if mapped:
        return mapped
    if canonical.endswith((".NS", ".BO")) or canonical.startswith("^"):
        return canonical
    return f"{canonical}.NS"


def _number(row, column: str) -> float | None:
    value = row[column]
    # yfinance can return a one-element Series when a DataFrame has a
    # MultiIndex. Convert that scalar shape without changing the data model.
    if hasattr(value, "iloc"):
        value = value.iloc[0]
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if isfinite(number) else None


class YahooAdapter:
    def fetch_price_bars(
        self, symbol: str, period: str = "1d", interval: str = "1m"
    ) -> list[CanonicalPriceBar]:
        yahoo_symbol = _provider_symbol(symbol)
        try:
            df = yf.download(
                yahoo_symbol,
                period=period,
                interval=interval,
                progress=False,
                auto_adjust=False,
                threads=False,
            )
        except Exception:
            logger.exception("yfinance download failed for %s (%s)", symbol, yahoo_symbol)
            return []

        if df is None or df.empty:
            logger.warning("yfinance returned no bars for %s (%s)", symbol, yahoo_symbol)
            return []

        bars: list[CanonicalPriceBar] = []
        for ts, row in df.iterrows():
            open_price = _number(row, "Open")
            high = _number(row, "High")
            low = _number(row, "Low")
            close = _number(row, "Close")
            volume = _number(row, "Volume") if "Volume" in row else None
            if any(value is None for value in (open_price, high, low, close)):
                continue

            market_ts = ts.to_pydatetime()
            if market_ts.tzinfo is None:
                market_ts = market_ts.replace(tzinfo=IST)
            market_ts = market_ts.astimezone(timezone.utc)

            bars.append(
                CanonicalPriceBar(
                    instrument_symbol=symbol,
                    market_timestamp=market_ts,
                    timeframe=interval,
                    open=open_price,
                    high=high,
                    low=low,
                    close=close,
                    volume=int(volume) if volume is not None else None,
                    source="yfinance",
                    source_version=ADAPTER_VERSION,
                )
            )

        logger.info("yahoo_adapter fetched %d bars for %s", len(bars), symbol)
        return bars
