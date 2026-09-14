"""Validate historical OHLCV data before it enters research datasets.

The validator is intentionally provider-agnostic. It checks timestamp hygiene,
OHLC relationships, duplicates, gaps and basic volume integrity without
assuming that every market trades continuously.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path

import pandas as pd


@dataclass(frozen=True)
class ValidationIssue:
    code: str
    message: str
    count: int = 1


REQUIRED = ("open", "high", "low", "close")


def validate(frame: pd.DataFrame, frequency: str = "1d") -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    df = frame.copy()
    df.columns = [str(c).lower() for c in df.columns]

    if "timestamp" in df.columns:
        ts = pd.to_datetime(df["timestamp"], utc=True, errors="coerce")
    elif isinstance(df.index, pd.DatetimeIndex):
        ts = pd.to_datetime(df.index, utc=True, errors="coerce")
    else:
        return [ValidationIssue("NO_TIMESTAMP", "timestamp column or DatetimeIndex is required")]

    bad_ts = int(ts.isna().sum())
    if bad_ts:
        issues.append(ValidationIssue("INVALID_TIMESTAMP", "timestamps could not be parsed", bad_ts))
        ts = ts.dropna()

    if ts.duplicated().any():
        issues.append(ValidationIssue("DUPLICATE_TIMESTAMP", "duplicate observation timestamps", int(ts.duplicated().sum())))

    if not ts.is_monotonic_increasing:
        issues.append(ValidationIssue("NON_CHRONOLOGICAL", "timestamps are not monotonically increasing"))

    for column in REQUIRED:
        if column not in df.columns:
            issues.append(ValidationIssue("MISSING_COLUMN", f"required column missing: {column}"))
            continue
        values = pd.to_numeric(df[column], errors="coerce")
        bad = int(values.isna().sum())
        if bad:
            issues.append(ValidationIssue("NON_NUMERIC", f"{column} contains non-numeric values", bad))
        if (values <= 0).fillna(False).any():
            issues.append(ValidationIssue("NON_POSITIVE_PRICE", f"{column} contains non-positive prices", int((values <= 0).fillna(False).sum())))

    if all(column in df.columns for column in REQUIRED):
        o = pd.to_numeric(df["open"], errors="coerce")
        h = pd.to_numeric(df["high"], errors="coerce")
        l = pd.to_numeric(df["low"], errors="coerce")
        c = pd.to_numeric(df["close"], errors="coerce")
        bad_range = (h < l) | (h < o) | (h < c) | (l > o) | (l > c)
        bad_range = bad_range.fillna(False)
        if bad_range.any():
            issues.append(ValidationIssue("INVALID_OHLC_RANGE", "OHLC values violate high/low relationships", int(bad_range.sum())))

    if "volume" in df.columns:
        volume = pd.to_numeric(df["volume"], errors="coerce")
        bad_volume = (volume < 0).fillna(False)
        if bad_volume.any():
            issues.append(ValidationIssue("NEGATIVE_VOLUME", "volume cannot be negative", int(bad_volume.sum())))

    clean_ts = pd.Series(ts).drop_duplicates().sort_values()
    if len(clean_ts) > 2:
        delta = clean_ts.diff().dropna()
        expected = {"1d": pd.Timedelta(days=1), "1h": pd.Timedelta(hours=1), "15m": pd.Timedelta(minutes=15), "5m": pd.Timedelta(minutes=5), "1m": pd.Timedelta(minutes=1)}.get(frequency)
        if expected is not None:
            gaps = delta[delta > expected * 1.5]
            if len(gaps):
                issues.append(ValidationIssue("TIME_GAP", f"unexpected {frequency} gaps detected; weekends/market closures may be legitimate", len(gaps)))

    return issues


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate D-predict historical OHLCV data")
    parser.add_argument("path", type=Path)
    parser.add_argument("--frequency", default="1d")
    args = parser.parse_args()

    frame = pd.read_csv(args.path)
    issues = validate(frame, args.frequency)
    if not issues:
        print(f"OK: {args.path} passed historical data validation")
        return 0
    for issue in issues:
        print(f"{issue.code}: {issue.message} (count={issue.count})")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
