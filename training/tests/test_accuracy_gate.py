import pandas as pd
import pytest

from training.accuracy_gate import evaluate


STABLE = {"promotion_stability_ready": True}


def _ledger(tmp_path, rows=120, weak=False):
    actual = ["UP", "DOWN", "FLAT"] * (rows // 3) + ["UP"] * (rows % 3)
    if weak:
        prediction = ["FLAT"] * rows
        down = flat = up = [1 / 3] * rows
    else:
        prediction = actual.copy()
        down = [0.8 if value == "DOWN" else 0.1 for value in actual]
        flat = [0.8 if value == "FLAT" else 0.1 for value in actual]
        up = [0.8 if value == "UP" else 0.1 for value in actual]
    frame = pd.DataFrame({
        "prediction": prediction,
        "realized_class": actual,
        "outcome_status": ["SCORED"] * rows,
        "market_probability_down": down,
        "market_probability_flat": flat,
        "market_probability_up": up,
    })
    path = tmp_path / "realized.csv"
    frame.to_csv(path, index=False)
    return path


def test_strong_ledger_is_promotion_ready(tmp_path):
    result = evaluate(_ledger(tmp_path), min_examples=100, min_accuracy_lift=0.02, stability_result=STABLE)
    assert result["promotion_ready"] is True
    assert result["checks"]["minimum_examples"] is True
    assert result["checks"]["stability"] is True
    assert result["accuracy"] == 1.0


def test_weak_ledger_fails_gate(tmp_path):
    result = evaluate(_ledger(tmp_path, weak=True), min_examples=100, stability_result=STABLE)
    assert result["promotion_ready"] is False
    assert result["checks"]["beats_majority_baseline"] is False


def test_missing_stability_fails_promotion(tmp_path):
    result = evaluate(_ledger(tmp_path), min_examples=100)
    assert result["promotion_ready"] is False
    assert result["checks"]["stability"] is False


def test_no_scored_outcomes_fails(tmp_path):
    path = _ledger(tmp_path, rows=3)
    frame = pd.read_csv(path)
    frame["outcome_status"] = "PENDING"
    frame.to_csv(path, index=False)
    with pytest.raises(ValueError, match="no scored outcomes"):
        evaluate(path)
