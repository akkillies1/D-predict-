"""Qlib-inspired, D-predict-native dataset contracts.

The module intentionally defines a small research abstraction instead of
importing a complete external research framework. It keeps instrument,
calendar, feature, label, split, and provenance concerns explicit and
point-in-time safe.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import pandas as pd

SegmentName = Literal["train", "validation", "test"]


@dataclass(frozen=True)
class DatasetSpec:
    """Immutable description of one reproducible research dataset."""

    instrument: str
    frequency: str
    start: pd.Timestamp
    end: pd.Timestamp
    feature_set_version: str
    label_horizon: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "instrument", self.instrument.strip().upper())
        object.__setattr__(self, "frequency", self.frequency.strip().lower())
        object.__setattr__(self, "feature_set_version", self.feature_set_version.strip())
        object.__setattr__(self, "label_horizon", self.label_horizon.strip().lower())
        if not self.instrument:
            raise ValueError("instrument is required")
        if not self.frequency:
            raise ValueError("frequency is required")
        if self.start.tzinfo is None or self.end.tzinfo is None:
            raise ValueError("DatasetSpec start/end must be timezone-aware")
        if self.start >= self.end:
            raise ValueError("DatasetSpec start must be before end")
        if not self.feature_set_version:
            raise ValueError("feature_set_version is required")
        if not self.label_horizon:
            raise ValueError("label_horizon is required")


@dataclass(frozen=True)
class DatasetSegment:
    """A chronological, half-open slice used for train/validation/test."""

    name: SegmentName
    start: pd.Timestamp
    end: pd.Timestamp

    def __post_init__(self) -> None:
        if self.start.tzinfo is None or self.end.tzinfo is None:
            raise ValueError("DatasetSegment dates must be timezone-aware")
        if self.start >= self.end:
            raise ValueError("segment start must be before segment end")


def make_segments(
    index: pd.DatetimeIndex,
    *,
    train_fraction: float = 0.60,
    validation_fraction: float = 0.20,
    purge_rows: int = 0,
) -> tuple[DatasetSegment, ...]:
    """Create chronological train/validation/test segments with an optional purge gap.

    ``purge_rows`` removes observations immediately before each later segment.
    This prevents a future-return label in the earlier split from reaching into
    the next split. The returned segment boundaries are timestamp based, not
    row-number based, so they remain reproducible after filtering.
    """
    if not isinstance(index, pd.DatetimeIndex) or index.tz is None:
        raise ValueError("segment index must be a timezone-aware DatetimeIndex")
    if not index.is_monotonic_increasing or index.has_duplicates:
        raise ValueError("segment index must be unique and chronological")
    if len(index) < 3:
        raise ValueError("at least three observations are required")
    if not 0 < train_fraction < 1 or not 0 < validation_fraction < 1:
        raise ValueError("split fractions must be between 0 and 1")
    if train_fraction + validation_fraction >= 1:
        raise ValueError("train + validation fractions must be below 1")
    if purge_rows < 0:
        raise ValueError("purge_rows cannot be negative")

    train_end_pos = max(1, int(len(index) * train_fraction))
    validation_end_pos = max(train_end_pos + 1, int(len(index) * (train_fraction + validation_fraction)))
    validation_end_pos = min(validation_end_pos, len(index) - 1)

    train_end_pos = max(1, train_end_pos - purge_rows)
    validation_start_pos = min(train_end_pos + purge_rows, validation_end_pos - 1)
    validation_end_pos = max(validation_start_pos + 1, validation_end_pos - purge_rows)
    test_start_pos = min(validation_end_pos + purge_rows, len(index) - 1)

    bounds = (
        DatasetSegment("train", index[0], index[train_end_pos]),
        DatasetSegment("validation", index[validation_start_pos], index[validation_end_pos]),
        DatasetSegment("test", index[test_start_pos], index[-1] + (index[-1] - index[-2])),
    )
    return bounds


@dataclass(frozen=True)
class PointInTimeDataset:
    """Feature/label frame plus its immutable provenance contract."""

    spec: DatasetSpec
    frame: pd.DataFrame
    segments: tuple[DatasetSegment, ...]

    def validate(self) -> None:
        if self.frame.empty:
            raise ValueError("dataset is empty")
        if not isinstance(self.frame.index, pd.DatetimeIndex):
            raise ValueError("dataset index must be DatetimeIndex")
        if self.frame.index.tz is None:
            raise ValueError("dataset timestamps must be timezone-aware")
        if not self.frame.index.is_monotonic_increasing:
            raise ValueError("dataset timestamps must be chronological")
        if self.frame.index.has_duplicates:
            raise ValueError("dataset contains duplicate timestamps")
        if self.frame.index[0] < self.spec.start or self.frame.index[-1] >= self.spec.end:
            raise ValueError("dataset rows fall outside DatasetSpec bounds")
        if "symbol" in self.frame.columns:
            symbols = self.frame["symbol"].dropna().astype(str).str.upper().unique()
            if len(symbols) and set(symbols) != {self.spec.instrument}:
                raise ValueError("dataset contains rows for a different instrument")
        if "feature_set_version" in self.frame.columns:
            versions = self.frame["feature_set_version"].dropna().astype(str).unique()
            if len(versions) and set(versions) != {self.spec.feature_set_version}:
                raise ValueError("dataset contains a different feature_set_version")
        if "horizon" in self.frame.columns:
            horizons = self.frame["horizon"].dropna().astype(str).str.lower().unique()
            if len(horizons) and set(horizons) != {self.spec.label_horizon}:
                raise ValueError("dataset contains a different label horizon")
        if "source_cutoff" in self.frame.columns:
            cutoff = pd.to_datetime(self.frame["source_cutoff"], utc=True)
            if (cutoff > self.frame.index).any():
                raise ValueError("point-in-time violation: source_cutoff is after observation timestamp")
        seen: set[str] = set()
        previous_end: pd.Timestamp | None = None
        for segment in self.segments:
            if segment.name in seen:
                raise ValueError(f"duplicate segment: {segment.name}")
            seen.add(segment.name)
            if segment.start < self.spec.start or segment.end > self.spec.end:
                raise ValueError(f"segment {segment.name} falls outside dataset bounds")
            if previous_end is not None and segment.start < previous_end:
                raise ValueError("dataset segments overlap")
            previous_end = segment.end

    def slice(self, segment: SegmentName) -> pd.DataFrame:
        match = next((item for item in self.segments if item.name == segment), None)
        if match is None:
            raise KeyError(f"segment not defined: {segment}")
        return self.frame.loc[(self.frame.index >= match.start) & (self.frame.index < match.end)].copy()
