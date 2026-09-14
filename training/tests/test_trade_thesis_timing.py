import pandas as pd

from training.trade_thesis_timing import attach_target_timing
from training.target_timing import TargetTimingConfig


def test_attach_target_timing_keeps_price_and_adds_eta():
    timestamps = pd.date_range("2025-01-01", periods=60, freq="min", tz="UTC")
    closes = [100.0 if i % 3 else 101.0 for i in range(60)]
    bars = pd.DataFrame({"timestamp": timestamps, "close": closes})
    thesis = {
        "decision": "EXECUTABLE", "direction": "LONG", "entry_price": 100.0,
        "targets": [{"price": 101.0, "probability": 0.65}],
    }
    enriched = attach_target_timing(thesis, bars, TargetTimingConfig(min_events=5, max_bars=3, resolution="1m"))
    assert enriched["targets"][0]["price"] == 101.0
    assert enriched["targets"][0]["time_to_target"]["status"] == "ESTIMATED"
    assert enriched["targets"][0]["time_to_target"]["eta"]["minutes"] == 3
