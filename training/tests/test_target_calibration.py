import pandas as pd
import pytest

from training.target_calibration import evaluate


def _frame():
    return pd.DataFrame({
        "prediction_time": pd.date_range("2024-01-01", periods=4, tz="UTC"),
        "entry_time": pd.date_range("2024-01-02", periods=4, tz="UTC"),
        "direction": ["LONG", "LONG", "SHORT", "SHORT"],
        "target_1_probability": [0.65] * 4,
        "target_1_reached": [True, True, False, False],
        "target_2_probability": [0.45] * 4,
        "target_2_reached": [True, False, False, True],
        "target_3_probability": [0.25] * 4,
        "target_3_reached": [False, False, False, True],
        "stop_probability": [0.15] * 4,
        "stop_hit": [False, False, True, False],
    })


def test_scores_without_tuning():
    report = evaluate(_frame())
    assert report["examples"] == 4
    assert report["promotion"] == "NONE"
    assert report["targets"]["target_1"]["hit_rate"] == 0.5
    assert report["targets"]["target_1"]["brier"] > 0


def test_prediction_event_must_precede_entry():
    frame = _frame()
    frame.loc[0, "entry_time"] = frame.loc[0, "prediction_time"]
    with pytest.raises(ValueError, match="strictly after"):
        evaluate(frame)
