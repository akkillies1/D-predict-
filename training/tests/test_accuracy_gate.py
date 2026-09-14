import pandas as pd
import pytest

from training.accuracy_gate import evaluate


def _ledger(tmp_path, rows=120, weak=False):
    actual = ["UP", "DOWN", "FLAT"] * (rows // 3) + ["UP"] * (rows % 3)
    if weak:
        prediction = ["FLAT"] * rows
    else:
        prediction = actual.copy()
    frame = pd.DataFrame({
        "prediction": prediction,
        "realized_class": actual,
        "outcome_status": ["SCORED"] * rows,
        "market_probability_down": [1 / 3] * rows,
        "market_probability_flat": [1 / 3] * rows,
        "market_probability_up": [1 / 3] * rows,
    })
    path = tmp_path / "realized.csv"
    frame.to_csv(path, index=False)
    return path


def test_strong_ledger_is_promotion_ready(tmp_path):
    result = evaluate(_ledger(tmp_path), min_examples=100, min_accuracy_lift=0.02)
    assert result["promotion_ready"] is True
    assert result["checks"]["minimum_examples"] is True
    assert result["accuracy"] == 1.0


def test_weak_ledger_fails_gate(tmp_path):
    result = evaluate(_ledger(tmp_path, weak=True), min_examples=100)
    assert result["promotion_ready"] is False
    assert result["checks"]["beats_majority_baseline"] is False


def test_no_scored_outcomes_fails(tmp_path):
    path = _ledger(tmp_path, rows=3)
    frame = pd.read_csv(path)
    frame["outcome_status"] = "PENDING"
    frame.to_csv(path, index=False)
    with pytest.raises(ValueError, match="no scored outcomes"):
        evaluate(path)
