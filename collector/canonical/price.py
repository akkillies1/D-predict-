"""Canonical representation of a price bar, independent of any data source."""

from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class CanonicalPriceBar:
    instrument_symbol: str      # 'NIFTY' — resolved to instrument_id at persistence time
    market_timestamp: datetime  # actual market time of the bar (tz-aware)
    timeframe: str              # '1m', '5m', '1d'
    open: float
    high: float
    low: float
    close: float
    volume: int | None
    source: str                 # 'yfinance', 'nse'
    source_version: str         # adapter version, e.g. 'yahoo_adapter_v1'

    def validate_shape(self) -> None:
        """Cheap structural checks an adapter should run before emitting a bar.
        Business validation (staleness, sanity bounds) lives in validation/, not here.
        """
        if self.market_timestamp.tzinfo is None:
            raise ValueError("market_timestamp must be timezone-aware")
        if not (self.low <= self.open <= self.high and self.low <= self.close <= self.high):
            raise ValueError(f"OHLC bounds violated: {self}")
