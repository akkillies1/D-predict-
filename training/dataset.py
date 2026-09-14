"""Qlib-inspired, D-predict-native dataset contracts.

This module intentionally defines a small research abstraction instead of
importing a complete external research framework. The contract is designed to
keep instrument/calendar/feature/label/segment concerns explicit and
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
        object.__setattr__(self, "instrument", self.instrument.upper())
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
    """A chronological slice used for train/validation/test."""

    name: SegmentName
    start: pd.Timestamp
    end: pd.Timestamp

    def __post_init__(self) -> None:
        if self.start.tzinfo is None or self.end.tzinfo is None:
            raise ValueError("DatasetSegment dates must be timezone-aware")
        if self.start >= self.end:
            raise ValueError("segment start must be before segment end")


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
        if "source_cutoff" in self.frame.columns:
            cutoff = pd.to_datetime(self.frame["source_cutoff"], utc=True)
            if (cutoff > self.frame.index).any():
                raise ValueError("point-in-time violation: source_cutoff is after observation timestamp")
        for segment in self.segments:
            if segment.start < self.spec.start or segment.end > self.spec.end:
                raise ValueError(f"segment {segment.name} falls outside dataset bounds")

    def slice(self, segment: SegmentName) -> pd.DataFrame:
        match = next((item for item in self.segments if item.name == segment), None)
        if match is None:
            raise KeyError(f"segment not defined: {segment}")
        return self.frame.loc[(self.frame.index >= match.start) & (self.frame.index < match.end)].copy()
