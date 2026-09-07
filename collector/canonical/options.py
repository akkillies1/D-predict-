"""Canonical representation of a single option contract's snapshot at a point in time."""

from dataclasses import dataclass
from datetime import date, datetime


@dataclass(frozen=True)
class CanonicalOptionSnapshot:
    instrument_symbol: str       # 'NIFTY'
    expiry_date: date
    strike: float
    option_type: str             # 'CE' or 'PE'
    market_timestamp: datetime   # actual market time of this snapshot (tz-aware)
    ltp: float | None
    bid: float | None
    ask: float | None
    volume: int | None
    oi: int | None
    oi_change: int | None
    iv: float | None
    delta: float | None
    gamma: float | None
    theta: float | None
    vega: float | None
    source: str                  # 'nse'
    source_version: str          # e.g. 'nse_adapter_v1'

    def validate_shape(self) -> None:
        if self.option_type not in ("CE", "PE"):
            raise ValueError(f"invalid option_type: {self.option_type}")
        if self.market_timestamp.tzinfo is None:
            raise ValueError("market_timestamp must be timezone-aware")
        if self.strike <= 0:
            raise ValueError(f"invalid strike: {self.strike}")
