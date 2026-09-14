from pathlib import Path

import pandas as pd
import pytest

from training.backtest import DrawdownConfig, backtest, drawdown_multiplier, load_inputs
from training.risk import RiskConfig


def write_inputs(tmp_path: Path, periods: int = 32):
    timestamps = pd.date_range("2026-01-01", periods=periods, freq="D", tz="UTC")
    close = [100 + i * 0.25 for i in range(periods)]
    history = pd.DataFrame(
        {
            "timestamp": timestamps,
            "high": [price + 1.0 for price in close],
            "low": [price - 1.0 for price in close],
            "close": close,
        }
    )
    predictions = pd.DataFrame(
        {
            "timestamp": [timestamps[14], timestamps[16], timestamps[18]],
            "symbol": ["NIFTY"] * 3,
            "horizon": ["1d", "1d", "1d"],
            "prediction": ["UP", "DOWN", "FLAT"],
            "market_probability_down": [0.1, 0.7, 0.2],
            "market_probability_flat": [0.1, 0.1, 0.6],
            "market_probability_up": [0.8, 0.2, 0.2],
        }
    )
    history_path = tmp_path / "history.csv"
    prediction_path = tmp_path / "predictions.csv"
    history.to_csv(history_path, index=False)
    predictions.to_csv(prediction_path, index=False)
    return prediction_path, history_path


def test_drawdown_multiplier_is_causal_and_monotonic():
    config = DrawdownConfig(soft_drawdown=0.05, hard_drawdown=0.10)
    assert drawdown_multiplier(0.0, config) == 1.0
    assert drawdown_multiplier(0.05, config) == 1.0
    assert drawdown_multiplier(0.075, config) == pytest.approx(0.5)
    assert drawdown_multiplier(0.10, config) == 0.0
    assert drawdown_multiplier(0.20, config) == 0.0


def test_drawdown_config_rejects_invalid_thresholds():
    with pytest.raises(ValueError):
        drawdown_multiplier(0.05, DrawdownConfig(0.10, 0.05))


def test_backtest_uses_next_close_and_risk_weight(tmp_path):
    prediction_path, history_path = write_inputs(tmp_path)
    result = backtest(
        prediction_path,
        history_path,
        cost_bps=10,
        slippage_bps=5,
        initial_capital=100_000,
        risk_config=RiskConfig(atr_period=14, risk_per_trade=0.005),
    )
    metrics = result["metrics"]
    assert metrics["trades"] == 2
    assert result["trades"][0]["entry_price"] == pytest.approx(103.75)
    assert result["trades"][0]["exit_price"] == pytest.approx(104.0)
    assert result["trades"][0]["base_position_weight"] > 0
    assert result["trades"][0]["position_weight"] > 0
    assert result["trades"][0]["portfolio_return"] != result["trades"][0]["net_return"]
    assert metrics["final_equity"] > 0


def test_distribution_target_is_the_same_economic_exit_as_pnl(tmp_path):
    prediction_path, history_path = write_inputs(tmp_path, periods=24)
    predictions = pd.read_csv(prediction_path)
    # First signal enters on 2026-01-16 at 103.75. Its calibrated target is
    # 1% above entry and is printed by the next bar's high.
    for column, value in {
        "distribution_status": "CALIBRATED",
        "return_p15": -0.02,
        "return_p35": 0.01,
        "return_p55": 0.02,
        "return_p75": 0.03,
        "return_p85": 0.04,
    }.items():
        predictions[column] = value
    predictions.loc[0, "prediction"] = "UP"
    predictions.loc[0, "horizon"] = "3d"
    predictions = predictions.iloc[[0]]
    predictions.to_csv(prediction_path, index=False)

    history = pd.read_csv(history_path)
    # Make the first post-entry bar hit the 1% target while keeping the stop
    # untouched. The close is deliberately different so P&L proves the target
    # price, rather than the horizon close, was used.
    history.loc[16, "high"] = 106.0
    history.loc[16, "low"] = 104.0
    history.loc[16, "close"] = 104.25
    history.to_csv(history_path, index=False)

    result = backtest(prediction_path, history_path, initial_capital=100_000)
    trade = result["trades"][0]
    assert trade["exit_reason"] == "TARGET_1"
    assert trade["target_1_hit"] is True
    assert trade["stop_hit"] is False
    assert trade["exit_price"] == pytest.approx(trade["target_1_price"])
    assert trade["exit_price"] != pytest.approx(104.25)
    assert result["metrics"]["target_1_hit_rate"] == 1.0


def test_distribution_stop_is_the_same_economic_exit_as_pnl(tmp_path):
    prediction_path, history_path = write_inputs(tmp_path, periods=24)
    predictions = pd.read_csv(prediction_path)
    for column, value in {
        "distribution_status": "CALIBRATED",
        "return_p15": -0.02,
        "return_p35": 0.01,
        "return_p55": 0.02,
        "return_p75": 0.03,
        "return_p85": 0.04,
    }.items():
        predictions[column] = value
    predictions.loc[0, "prediction"] = "UP"
    predictions.loc[0, "horizon"] = "3d"
    predictions = predictions.iloc[[0]]
    predictions.to_csv(prediction_path, index=False)

    history = pd.read_csv(history_path)
    history.loc[16, "high"] = 104.0
    history.loc[16, "low"] = 101.0
    history.loc[16, "close"] = 103.0
    history.to_csv(history_path, index=False)

    result = backtest(prediction_path, history_path, initial_capital=100_000)
    trade = result["trades"][0]
    assert trade["exit_reason"] == "STOP"
    assert trade["stop_hit"] is True
    assert trade["target_1_hit"] is False
    assert trade["exit_price"] == pytest.approx(trade["stop_price"])
    assert result["metrics"]["stop_hit_rate"] == 1.0


def test_backtest_skips_overlapping_signals(tmp_path):
    prediction_path, history_path = write_inputs(tmp_path)
    predictions = pd.read_csv(prediction_path)
    predictions.loc[1, "horizon"] = "3d"
    predictions.loc[2, "prediction"] = "UP"
    predictions.to_csv(prediction_path, index=False)
    result = backtest(prediction_path, history_path, initial_capital=100_000)
    assert result["metrics"]["trades"] == 2
    assert result["trades"][1]["signal_timestamp"] == "2026-01-17T00:00:00+00:00"


def test_backtest_rejects_bad_history(tmp_path):
    prediction_path, history_path = write_inputs(tmp_path)
    history = pd.read_csv(history_path)
    history.loc[0, "close"] = 0
    history.to_csv(history_path, index=False)
    with pytest.raises(ValueError, match="positive"):
        backtest(prediction_path, history_path)


def test_prediction_key_allows_same_timestamp_for_different_symbols(tmp_path):
    prediction_path, history_path = write_inputs(tmp_path)
    predictions = pd.read_csv(prediction_path)
    duplicate = predictions.iloc[[0]].copy()
    duplicate["symbol"] = "BANKNIFTY"
    predictions = pd.concat([predictions, duplicate], ignore_index=True)
    predictions.to_csv(prediction_path, index=False)

    loaded_predictions, _ = load_inputs(prediction_path, history_path)
    assert len(loaded_predictions) == 4


def test_prediction_key_rejects_same_symbol_horizon_timestamp(tmp_path):
    prediction_path, history_path = write_inputs(tmp_path)
    predictions = pd.read_csv(prediction_path)
    duplicate = predictions.iloc[[0]].copy()
    predictions = pd.concat([predictions, duplicate], ignore_index=True)
    predictions.to_csv(prediction_path, index=False)

    with pytest.raises(ValueError, match="Prediction keys must be unique"):
        load_inputs(prediction_path, history_path)


def test_hard_drawdown_blocks_new_risk_without_freezing_future_signals(tmp_path):
    prediction_path, history_path = write_inputs(tmp_path)
    history = pd.read_csv(history_path)
    history.loc[16, "close"] = 70.0
    history.loc[16, "high"] = 71.0
    history.loc[16, "low"] = 69.0
    history.to_csv(history_path, index=False)

    result = backtest(
        prediction_path,
        history_path,
        initial_capital=100_000,
        risk_config=RiskConfig(atr_period=14, risk_per_trade=0.05),
        drawdown_config=DrawdownConfig(soft_drawdown=0.01, hard_drawdown=0.02),
    )
    assert result["trades"][0]["position_weight"] > 0
    blocked = [trade for trade in result["trades"] if trade["risk_status"] == "DRAWDOWN_THROTTLED"]
    assert blocked
    assert all(trade["position_weight"] == 0 for trade in blocked)
