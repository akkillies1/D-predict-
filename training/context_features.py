"""Point-in-time cross-market context features.

All outputs at timestamp T use benchmark/sector observations at or before T.
The module intentionally contains no news, analyst opinions, or future labels.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Mapping

import numpy as np
import pandas as pd


@dataclass(frozen=True)
class ContextSpec:
    benchmark: str
    sector: str | None = None
    benchmark_frame_name: str | None = None
    sector_frame_name: str | None = None


@dataclass(frozen=True)
class ContextRow:
    benchmark: str
    sector: str | None
    benchmark_return_1: float | None
    benchmark_return_5: float | None
    benchmark_return_20: float | None
    sector_return_1: float | None
    sector_return_5: float | None
    sector_return_20: float | None
    relative_strength_1: float | None
    relative_strength_5: float | None
    relative_strength_20: float | None
    relative_strength_60: float | None
    stock_vs_sector_5: float | None

    def to_dict(self) -> dict:
        return asdict(self)


def _return_at_or_before(series: pd.Series, timestamp: pd.Timestamp, periods: int) -> float | None:
    s = pd.to_numeric(series, errors="coerce").dropna().sort_index()
    s = s.loc[s.index <= timestamp]
    if len(s) <= periods:
        return None
    value = s.iloc[-1] / s.iloc[-1 - periods] - 1.0
    return float(value) if np.isfinite(value) else None


def _relative(stock: float | None, benchmark: float | None) -> float | None:
    if stock is None or benchmark is None:
        return None
    # Difference is more stable than a quotient when benchmark return is close to zero.
    value = stock - benchmark
    return float(value) if np.isfinite(value) else None


def build_context_row(
    timestamp: pd.Timestamp,
    stock_close: pd.Series,
    benchmark_close: pd.Series,
    spec: ContextSpec,
    sector_close: pd.Series | None = None,
) -> ContextRow:
    timestamp = pd.Timestamp(timestamp)
    if timestamp.tzinfo is None:
        timestamp = timestamp.tz_localize("UTC")
    else:
        timestamp = timestamp.tz_convert("UTC")

    stock_returns = {p: _return_at_or_before(stock_close, timestamp, p) for p in (1, 5, 20, 60)}
    benchmark_returns = {p: _return_at_or_before(benchmark_close, timestamp, p) for p in (1, 5, 20)}
    sector_returns = {
        p: _return_at_or_before(sector_close, timestamp, p) if sector_close is not None else None
        for p in (1, 5, 20)
    }
    return ContextRow(
        benchmark=spec.benchmark,
        sector=spec.sector,
        benchmark_return_1=benchmark_returns[1],
        benchmark_return_5=benchmark_returns[5],
        benchmark_return_20=benchmark_returns[20],
        sector_return_1=sector_returns[1],
        sector_return_5=sector_returns[5],
        sector_return_20=sector_returns[20],
        relative_strength_1=_relative(stock_returns[1], benchmark_returns[1]),
        relative_strength_5=_relative(stock_returns[5], benchmark_returns[5]),
        relative_strength_20=_relative(stock_returns[20], benchmark_returns[20]),
        relative_strength_60=stock_returns[60],
        stock_vs_sector_5=_relative(stock_returns[5], sector_returns[5]),
    )
