"""Canonical representation of an option contract snapshot.

Provider adapters map their native response into this type. Downstream code
must not infer contract metadata from a provider name, symbol list, or default.
"""

from dataclasses import dataclass
from datetime import date, datetime


@dataclass(frozen=True)
class CanonicalOptionSnapshot:
    instrument_symbol: str
    expiry_date: date
    strike: float
    option_type: str
    market_timestamp: datetime
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
    lot_size: int | None
    source: str
    source_version: str

    def validate_shape(self) -> None:
        if self.option_type not in ("CE", "PE"):
            raise ValueError(f"invalid option_type: {self.option_type}")
        if self.market_timestamp.tzinfo is None:
            raise ValueError("market_timestamp must be timezone-aware")
        if self.strike <= 0:
            raise ValueError(f"invalid strike: {self.strike}")
        if self.lot_size is not None and self.lot_size <= 0:
            raise ValueError(f"invalid lot_size: {self.lot_size}")
