"""Leakage-safe target price and time-to-target estimation.

Price targets come from the return distribution. Time-to-target is a separate
first-passage model: it estimates how long comparable historical moves took to
reach the same target return. It never converts a daily horizon into fake
minutes/seconds. Sub-minute precision is only reported when the source bars
actually support that resolution.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import numpy as np
import pandas as pd


Resolution = Literal["1s", "5s", "15s", "30s", "1m", "5m", "15m", "30m", "1h", "1d"]
_RESOLUTION_SECONDS = {"1s": 1, "5s": 5, "15s": 15, "30s": 30, "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "1d": 86400}


@dataclass(frozen=True)
class TargetTimingConfig:
    min_events: int = 20
    max_bars: int = 390
    resolution: Resolution = "1d"

    def validate(self) -> None:
        if self.min_events < 5:
            raise ValueError("min_events must be at least 5")
        if self.max_bars < 1:
            raise ValueError("max_bars must be positive")
        if self.resolution not in _RESOLUTION_SECONDS:
            raise ValueError(f"unsupported resolution: {self.resolution}")


def _validate_bars(bars: pd.DataFrame) -> pd.DataFrame:
    required = {"timestamp", "close"}
    missing = required - set(bars.columns)
    if missing:
        raise ValueError(f"bars missing columns: {sorted(missing)}")
    frame = bars.copy()
    frame["timestamp"] = pd.to_datetime(frame["timestamp"], utc=True, errors="raise")
    frame["close"] = pd.to_numeric(frame["close"], errors="coerce")
    if frame["close"].isna().any() or (frame["close"] <= 0).any():
        raise ValueError("close must be positive and numeric")
    if frame["timestamp"].duplicated().any():
        raise ValueError("bar timestamps must be unique")
    return frame.sort_values("timestamp").reset_index(drop=True)


def _format_duration(seconds: float | None, resolution: Resolution) -> dict:
    if seconds is None:
        return {"seconds": None, "minutes": None, "hours": None, "days": None, "precision": resolution}
    return {
        "seconds": int(round(seconds)),
        "minutes": round(seconds / 60.0, 2),
        "hours": round(seconds / 3600.0, 2),
        "days": round(seconds / 86400.0, 4),
        "precision": resolution,
    }


def estimate_first_passage_times(
    bars: pd.DataFrame,
    entry_price: float,
    target_price: float,
    direction: str,
    config: TargetTimingConfig | None = None,
) -> dict:
    """Estimate empirical first-passage time to a target.

    Only completed historical episodes are used. The episode starts at each
    historical bar and ends at the first subsequent close crossing the target.
    This is an ETA distribution, not a promise of an exact arrival time.
    """
    config = config or TargetTimingConfig()
    config.validate()
    frame = _validate_bars(bars)
    if entry_price <= 0 or target_price <= 0:
        raise ValueError("prices must be positive")
    if direction not in {"LONG", "SHORT"}:
        raise ValueError("direction must be LONG or SHORT")
    target_return = target_price / entry_price - 1.0
    if direction == "SHORT":
        target_return = entry_price / target_price - 1.0
    if target_return <= 0:
        raise ValueError("target must be favorable to direction")

    durations: list[float] = []
    closes = frame["close"].to_numpy(float)
    timestamps = frame["timestamp"].to_numpy()
    for i in range(len(frame) - 1):
        base = closes[i]
        if direction == "LONG":
            hit = np.flatnonzero(closes[i + 1 : i + 1 + config.max_bars] >= base * (1.0 + target_return))
        else:
            hit = np.flatnonzero(closes[i + 1 : i + 1 + config.max_bars] <= base / (1.0 + target_return))
        if len(hit):
            j = i + 1 + int(hit[0])
            delta = (pd.Timestamp(timestamps[j]) - pd.Timestamp(timestamps[i])).total_seconds()
            durations.append(delta)

    if len(durations) < config.min_events:
        return {
            "status": "INSUFFICIENT_HISTORY",
            "events": len(durations),
            "target_price": float(target_price),
            "target_return": float(target_return if direction == "LONG" else -target_return),
            "eta": _format_duration(None, config.resolution),
        }

    values = np.asarray(durations, dtype=float)
    p25, p50, p75 = np.quantile(values, [0.25, 0.50, 0.75])
    return {
        "status": "ESTIMATED",
        "events": int(len(values)),
        "target_price": float(target_price),
        "target_return": float(target_return if direction == "LONG" else -target_return),
        "eta": _format_duration(float(p50), config.resolution),
        "eta_range": {
            "p25": _format_duration(float(p25), config.resolution),
            "p50": _format_duration(float(p50), config.resolution),
            "p75": _format_duration(float(p75), config.resolution),
        },
        "method": "empirical_first_passage_time",
        "warning": "ETA is probabilistic; it is not an exact arrival-time prediction.",
    }


def target_reach_timestamp(entry_timestamp: pd.Timestamp, eta_seconds: float) -> pd.Timestamp:
    """Convert an ETA into a display timestamp; caller must label it estimated."""
    return pd.Timestamp(entry_timestamp) + pd.to_timedelta(eta_seconds, unit="s")
