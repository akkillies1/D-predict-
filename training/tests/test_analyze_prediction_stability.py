from pathlib import Path

import pandas as pd

from training.analyze_prediction_stability import analyze


def test_stability_analysis_reports_confidence_calibration_folds_and_regimes(tmp_path: Path):
    timestamps = pd.date_range("2026-01-01", periods=80, freq="D", tz="UTC")
    close = [100.0]
    for index in range(1, 80):
        close.append(close[-1] * (1.01 if index % 3 else 0.99))
    history = pd.DataFrame({"timestamp": timestamps, "close": close})
    history_path = tmp_path / "nifty.csv"
    history.to_csv(history_path, index=False)

    rows = []
    classes = ["UP", "DOWN", "FLAT"]
    for index in range(45, 75):
        actual = classes[index % 3]
        prediction = actual if index % 4 else classes[(index + 1) % 3]
        rows.append({
            "timestamp": timestamps[index],
            "symbol": "NIFTY",
            "horizon": "1d",
            "fold": index % 3,
            "prediction": prediction,
            "realized_class": actual,
            "realized_return": 0.01 if actual == "UP" else (-0.01 if actual == "DOWN" else 0.0),
            "outcome_status": "SCORED",
            "market_probability_down": 0.1 if prediction == "UP" else 0.7 if prediction == "DOWN" else 0.1,
            "market_probability_flat": 0.1 if prediction != "FLAT" else 0.8,
            "market_probability_up": 0.8 if prediction == "UP" else 0.2 if prediction == "DOWN" else 0.1,
        })
    ledger_path = tmp_path / "realized.csv"
    pd.DataFrame(rows).to_csv(ledger_path, index=False)

    result = analyze(ledger_path, history_path)

    assert result["overall"]["examples"] == 30
    assert len(result["confidence_buckets"]) == 5
    assert len(result["calibration"]) == 5
    assert len(result["fold_stability"]["folds"]) == 3
    assert "regimes" in result["regime_stability"]
    assert result["regime_stability"]["method"].startswith("evaluation-only proxy")
