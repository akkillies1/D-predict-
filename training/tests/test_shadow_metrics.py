import pytest

from training.shadow_metrics import analyze


def state():
    predictions = []
    outcomes = [("UP", "UP", 0.8), ("DOWN", "UP", 0.7), ("UP", "UP", 0.6), ("FLAT", "FLAT", 0.5)]
    for index, (prediction, actual, confidence) in enumerate(outcomes):
        predictions.append({
            "timestamp": f"2026-01-0{index + 1}T00:00:00+00:00",
            "prediction": prediction,
            "prediction_confidence": confidence,
            "market_probability_down": 1 - confidence if prediction == "DOWN" else 0.1,
            "market_probability_flat": 0.1 if prediction != "FLAT" else confidence,
            "market_probability_up": confidence if prediction == "UP" else 0.1,
            "outcome_status": "SCORED",
            "realized_class": actual,
        })
    predictions.append({
        "timestamp": "2026-01-05T00:00:00+00:00",
        "prediction": "UP",
        "prediction_confidence": 0.9,
        "market_probability_down": 0.05,
        "market_probability_flat": 0.05,
        "market_probability_up": 0.9,
        "outcome_status": "PENDING",
        "realized_class": None,
    })
    return {
        "session_id": "test",
        "initial_capital": 100000,
        "virtual_equity": 101000,
        "max_drawdown": -0.02,
        "predictions": predictions,
    }


def test_metrics_exclude_pending_and_calculate_rolling_accuracy():
    result = analyze(state(), window=3)
    assert result["overall"]["examples"] == 4
    assert result["overall"]["accuracy"] == pytest.approx(0.75)
    assert result["rolling"]["examples"] == 3
    assert result["rolling"]["accuracy"] == pytest.approx(2 / 3)
    assert result["pending_predictions"] == 1
    assert result["live_orders_sent"] == 0


def test_calibration_has_all_confidence_buckets():
    result = analyze(state(), window=100)
    assert len(result["calibration"]) == 5
    assert result["overall"]["calibration_gap"] is not None
