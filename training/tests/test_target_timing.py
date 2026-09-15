import pandas as pd
import pytest

from training.target_timing import TargetTimingConfig, estimate_first_passage_times


def _bars():
    timestamps = pd.date_range("2025-01-01", periods=60, freq="min", tz="UTC")
    closes = []
    for i in range(60):
        closes.append(100.0 if i % 3 else 101.0)
    return pd.DataFrame({"timestamp": timestamps, "close": closes})


def test_target_timing_reports_empirical_eta():
    bars = _bars()
    result = estimate_first_passage_times(
        bars, entry_price=100, target_price=101, direction="LONG",
        config=TargetTimingConfig(min_events=5, max_bars=3, resolution="1m"),
    )
    assert result["status"] == "ESTIMATED"
    # First-passage events from the 100-price bars occur after 1 or 2 minutes;
    # the empirical median is therefore 90 seconds.
    assert result["eta"]["seconds"] == 90
    assert result["eta"]["minutes"] == 1.5
    assert result["eta_range"]["p25"]["seconds"] <= result["eta_range"]["p50"]["seconds"] <= result["eta_range"]["p75"]["seconds"]


def test_insufficient_history_is_explicit():
    result = estimate_first_passage_times(
        _bars(), 100, 110, "LONG",
        TargetTimingConfig(min_events=100, max_bars=3, resolution="1m"),
    )
    assert result["status"] == "INSUFFICIENT_HISTORY"
    assert result["eta"]["seconds"] is None


def test_target_must_be_favorable():
    with pytest.raises(ValueError, match="favorable"):
        estimate_first_passage_times(_bars(), 100, 99, "LONG")
