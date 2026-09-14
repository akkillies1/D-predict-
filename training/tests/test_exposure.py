from pathlib import Path

import pandas as pd
import pytest

from training.exposure import ExposureConfig, attribute_and_limit_exposure


def history(values):
    timestamps = pd.date_range("2026-01-01", periods=len(values), freq="D", tz="UTC")
    return pd.DataFrame({"timestamp": timestamps, "close": values})


def budgets():
    timestamps = pd.date_range("2026-03-01", periods=2, freq="D", tz="UTC")
    return pd.DataFrame({
        "timestamp": timestamps,
        "symbol": ["NIFTY", "BANKNIFTY"],
        "prediction": ["UP", "UP"],
        "position_weight": [0.30, 0.30],
    })


def test_correlated_exposure_is_capped_point_in_time():
    base = [100 + i for i in range(80)]
    result = attribute_and_limit_exposure(
        budgets(),
        {"NIFTY": history(base), "BANKNIFTY": history([200 + 2 * i for i in range(80)])},
        ExposureConfig(max_symbol_weight=0.50, max_correlated_exposure=0.30, correlation_threshold=0.70, correlation_lookback=30),
    )
    assert result.iloc[0]["position_weight"] == pytest.approx(0.30)
    assert result.iloc[1]["position_weight"] == pytest.approx(0.0)
    assert result.iloc[1]["risk_status"] == "CORRELATED_EXPOSURE_LIMIT"
    assert result.iloc[1]["correlations"]["NIFTY"] > 0.99


def test_uncorrelated_instruments_can_both_pass():
    a = [100 + i for i in range(80)]
    b = [200 + (1 if i % 2 else -1) * i for i in range(80)]
    result = attribute_and_limit_exposure(
        budgets(),
        {"NIFTY": history(a), "BANKNIFTY": history(b)},
        ExposureConfig(max_symbol_weight=0.50, max_correlated_exposure=0.30, correlation_threshold=0.95, correlation_lookback=30),
    )
    assert result["position_weight"].tolist() == pytest.approx([0.30, 0.30])


def test_missing_history_is_explicit():
    result = attribute_and_limit_exposure(budgets(), {"NIFTY": history([100 + i for i in range(80)])})
    assert result.iloc[1]["position_weight"] == 0
    assert result.iloc[1]["risk_status"] == "EXPOSURE_DATA_UNAVAILABLE"


def test_invalid_config_rejected():
    with pytest.raises(ValueError):
        ExposureConfig(correlation_threshold=1.5).validate()
    with pytest.raises(ValueError):
        ExposureConfig(correlation_lookback=1).validate()
