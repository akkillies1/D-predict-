from pathlib import Path

import pandas as pd
import pytest

from training.temporal_holdout import evaluate_holdout


def _write(path: Path, timestamps, prediction=None):
    actual = ["UP", "DOWN", "FLAT", "UP"]
    size = len(timestamps)
    if size > len(actual):
        raise ValueError("fixture supports at most four rows")
    prediction = prediction or actual[:size]
    frame = pd.DataFrame({
        "timestamp": timestamps,
        "symbol": ["NIFTY"] * size,
        "prediction": prediction,
        "realized_class": actual[:size],
        "outcome_status": ["SCORED"] * size,
        "market_probability_down": [0.1] * size,
        "market_probability_flat": [0.1] * size,
        "market_probability_up": [0.8] * size,
    })
    # Make probabilities consistent with the actual class while retaining a
    # deliberately simple fixture.
    for i, value in enumerate(frame["realized_class"]):
        frame.loc[i, "market_probability_down"] = 0.8 if value == "DOWN" else 0.1
        frame.loc[i, "market_probability_flat"] = 0.8 if value == "FLAT" else 0.1
        frame.loc[i, "market_probability_up"] = 0.8 if value == "UP" else 0.1
    frame.to_csv(path, index=False)


def test_holdout_must_be_strictly_later(tmp_path):
    dev = tmp_path / "dev.csv"
    test = tmp_path / "test.csv"
    _write(dev, pd.date_range("2026-01-01", periods=4, freq="D", tz="UTC"))
    _write(test, pd.date_range("2026-01-04", periods=4, freq="D", tz="UTC"))
    with pytest.raises(ValueError, match="strictly after"):
        evaluate_holdout(dev, test, min_examples=1)


def test_holdout_is_evaluated_without_retuning(tmp_path):
    dev = tmp_path / "dev.csv"
    test = tmp_path / "test.csv"
    _write(dev, pd.date_range("2026-01-01", periods=4, freq="D", tz="UTC"))
    _write(test, pd.date_range("2026-02-01", periods=4, freq="D", tz="UTC"))
    result = evaluate_holdout(dev, test, min_examples=4)
    assert result["evaluated_once"] is True
    assert result["retuning_performed"] is False
    assert result["promotion"] == "HOLDOUT_ONLY"
    assert result["accuracy"] == 1.0


def test_small_holdout_cannot_promote(tmp_path):
    dev = tmp_path / "dev.csv"
    test = tmp_path / "test.csv"
    _write(dev, pd.date_range("2026-01-01", periods=4, freq="D", tz="UTC"))
    _write(test, pd.date_range("2026-02-01", periods=2, freq="D", tz="UTC"))
    result = evaluate_holdout(dev, test, min_examples=4)
    assert result["promotion"] == "INSUFFICIENT_HOLDOUT"
    assert result["minimum_examples_pass"] is False
