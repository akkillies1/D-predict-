"""Validation layer. Structural shape checks live on the canonical dataclasses
themselves (validate_shape); this module owns business-level checks — staleness,
sane numeric bounds, and required-field completeness — that decide whether a
record is trustworthy enough to persist.

The collector's rule: collect -> normalize -> VALIDATE -> persist -> log.
A record that fails validation is logged and dropped, never silently coerced.
"""

from datetime import datetime, timedelta, timezone

from collector.canonical.options import CanonicalOptionSnapshot
from collector.canonical.price import CanonicalPriceBar

MAX_STALENESS = timedelta(minutes=15)  # flag anything older than this as suspect


class ValidationError(Exception):
    pass


def validate_price_bar(bar: CanonicalPriceBar) -> list[str]:
    """Returns a list of problems (empty list = valid)."""
    problems: list[str] = []
    try:
        bar.validate_shape()
    except ValueError as e:
        problems.append(str(e))

    if bar.open <= 0 or bar.high <= 0 or bar.low <= 0 or bar.close <= 0:
        problems.append("non-positive OHLC value")

    age = datetime.now(timezone.utc) - bar.market_timestamp
    if age > MAX_STALENESS:
        problems.append(f"stale bar: {age} old")

    return problems


def validate_option_snapshot(snap: CanonicalOptionSnapshot) -> list[str]:
    problems: list[str] = []
    try:
        snap.validate_shape()
    except ValueError as e:
        problems.append(str(e))

    if snap.ltp is not None and snap.ltp < 0:
        problems.append("negative ltp")
    if snap.oi is not None and snap.oi < 0:
        problems.append("negative oi")
    if snap.iv is not None and not (0 < snap.iv < 500):
        problems.append(f"implausible iv: {snap.iv}")

    age = datetime.now(timezone.utc) - snap.market_timestamp
    if age > MAX_STALENESS:
        problems.append(f"stale snapshot: {age} old")

    return problems
