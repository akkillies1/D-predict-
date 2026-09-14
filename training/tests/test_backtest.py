from pathlib import Path

import pandas as pd
import pytest

from training.backtest import backtest


def write_inputs(tmp_path: Path):
    history = pd.DataFrame(
        {
            "timestamp": pd.date_range("2026-01-01", periods=8, freq="D", tz="UTC"),
            "close": [100, 101, 102, 100, 98, 99, 101, 103],
        }
    )
    predictions = pd.DataFrame(
        {
            "timestamp": [history.timestamp.iloc[0], history.timestamp.iloc[3], history.timestamp.iloc[5]],
            "symbol": ["NIFTY"] * 3,
            "horizon": ["1d", "1d", "1d"],
            "prediction": ["UP", "DOWN", "FLAT"],
        }
    )
    history_path = tmp_path / "history.csv"
    prediction_path = tmp_path / "predictions.csv"
    history.to_csv(history_path, index=False)
    predictions.to_csv(prediction_path, index=False)
    return prediction_path, history_path


def test_backtest_uses_next_close_and_costs(tmp_path):
    prediction_path, history_path = write_inputs(tmp_path)
    result = backtest(prediction_path, history_path, cost_bps=10, slippage_bps=5, initial_capital=100_000)
    metrics = result["metrics"]
    assert metrics["trades"] == 2
    assert result["trades"][0]["entry_price"] == 101
    assert result["trades"][0]["exit_price"] == 102
    assert result["trades"][0]["net_return"] < 0.01
    assert metrics["final_equity"] > 0


def test_backtest_skips_overlapping_signals(tmp_path):
    prediction_path, history_path = write_inputs(tmp_path)
    predictions = pd.read_csv(prediction_path)
    predictions.loc[1, "horizon"] = "3d"
    predictions.loc[2, "prediction"] = "UP"
    predictions.to_csv(prediction_path, index=False)
    result = backtest(prediction_path, history_path, initial_capital=100_000)
    assert result["metrics"]["trades"] == 2
    assert result["trades"][1]["signal_timestamp"] == "2026-01-06T00:00:00+00:00"


def test_backtest_rejects_bad_history(tmp_path):
    prediction_path, history_path = write_inputs(tmp_path)
    history = pd.read_csv(history_path)
    history.loc[0, "close"] = 0
    history.to_csv(history_path, index=False)
    with pytest.raises(ValueError, match="positive"):
        backtest(prediction_path, history_path)
