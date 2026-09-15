import numpy as np
import pandas as pd
import pytest

from training.probability_calibration import CalibrationConfig, calibrate_oos, score_calibration


def _frame(rows=130):
    timestamps = pd.date_range("2025-01-01", periods=rows, freq="D", tz="UTC")
    actual = (["UP", "DOWN", "FLAT"] * ((rows + 2) // 3))[:rows]
    frame = pd.DataFrame({
        "timestamp": timestamps,
        "symbol": ["NIFTY"] * rows,
        "prediction": actual,
        "realized_class": actual,
        "outcome_status": ["SCORED"] * rows,
        "market_probability_down": [0.8 if x == "DOWN" else 0.1 for x in actual],
        "market_probability_flat": [0.8 if x == "FLAT" else 0.1 for x in actual],
        "market_probability_up": [0.8 if x == "UP" else 0.1 for x in actual],
    })
    return frame


def test_current_row_never_calibrates_itself():
    frame = _frame(130)
    result = calibrate_oos(frame, CalibrationConfig(min_history=20))
    assert result.loc[0, "calibration_status"] == "UNCALIBRATED"
    assert result.loc[19, "calibration_status"] == "UNCALIBRATED"
    assert result.loc[20, "calibration_status"] == "CALIBRATED"
    assert result.loc[20, "calibration_history_examples"] == 20


def test_calibration_preserves_probability_simplex():
    result = calibrate_oos(_frame(), CalibrationConfig(min_history=20))
    calibrated = result[result["calibration_status"] == "CALIBRATED"]
    sums = calibrated[["calibrated_probability_down", "calibrated_probability_flat", "calibrated_probability_up"]].sum(axis=1)
    assert np.allclose(sums.to_numpy(), 1.0, atol=1e-12)


def test_calibration_report_is_oos_only():
    result = calibrate_oos(_frame(), CalibrationConfig(min_history=20))
    report = score_calibration(result)
    assert report["examples"] == 110
    assert report["calibration_status"] == "CALIBRATED"
    assert report["log_loss"] >= 0
    assert report["multiclass_brier"] >= 0


def test_invalid_min_history_rejected():
    with pytest.raises(ValueError, match="at least 10"):
        CalibrationConfig(min_history=9).validate()
