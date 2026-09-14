from __future__ import annotations

import pandas as pd
import pytest

from training.dataset import DatasetSpec, PointInTimeDataset, make_segments


def sample_frame() -> pd.DataFrame:
    index = pd.date_range("2026-01-01", periods=30, freq="D", tz="UTC")
    return pd.DataFrame(
        {
            "symbol": "TEST",
            "horizon": "1d",
            "feature_set_version": "market-v1",
            "source_cutoff": index,
            "feature": range(30),
            "target_return": [0.01] * 30,
        },
        index=index,
    )


def test_segments_are_chronological_and_purged() -> None:
    index = sample_frame().index
    segments = make_segments(index, purge_rows=1)
    assert [segment.name for segment in segments] == ["train", "validation", "test"]
    assert segments[0].end <= segments[1].start
    assert segments[1].end <= segments[2].start


def test_dataset_rejects_future_source_cutoff() -> None:
    frame = sample_frame()
    frame.loc[frame.index[5], "source_cutoff"] = frame.index[6]
    spec = DatasetSpec(
        instrument="TEST",
        frequency="1d",
        start=frame.index[0],
        end=frame.index[-1] + pd.Timedelta(days=1),
        feature_set_version="market-v1",
        label_horizon="1d",
    )
    dataset = PointInTimeDataset(spec, frame, make_segments(frame.index))
    with pytest.raises(ValueError, match="point-in-time violation"):
        dataset.validate()


def test_dataset_rejects_mixed_instruments() -> None:
    frame = sample_frame()
    frame.loc[frame.index[0], "symbol"] = "OTHER"
    spec = DatasetSpec(
        instrument="TEST",
        frequency="1d",
        start=frame.index[0],
        end=frame.index[-1] + pd.Timedelta(days=1),
        feature_set_version="market-v1",
        label_horizon="1d",
    )
    dataset = PointInTimeDataset(spec, frame, make_segments(frame.index))
    with pytest.raises(ValueError, match="different instrument"):
        dataset.validate()
