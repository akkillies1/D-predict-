from pathlib import Path

import pandas as pd
import pytest

from training.shadow import ShadowConfig, replay


def make_history():
    return pd.DataFrame({
        "timestamp": pd.date_range("2026-01-01", periods=8, freq="D", tz="UTC"),
        "close": [100, 101, 102, 101, 103, 104, 103, 105],
    })


def make_ledger():
    timestamps = pd.date_range("2026-01-01", periods=3, freq="D", tz="UTC")
    return pd.DataFrame({
        "timestamp": timestamps,
        "symbol": ["NIFTY"] * 3,
        "horizon": ["1d"] * 3,
        "prediction": ["UP", "DOWN", "UP"],
        "market_probability_down": [0.1, 0.7, 0.1],
        "market_probability_flat": [0.1, 0.1, 0.1],
        "market_probability_up": [0.8, 0.2, 0.8],
    })


def test_replay_scores_accuracy_and_virtual_capital():
    result = replay(make_ledger(), {"NIFTY": make_history()})
    summary = result["summary"]
    assert summary["resolved_predictions"] == 3
    assert summary["pending_predictions"] == 0
    assert summary["accuracy"] == pytest.approx(2 / 3)
    assert summary["live_orders_sent"] == 0
    assert summary["final_virtual_equity"] > 0
    assert result["predictions"][0]["accuracy_after"] == pytest.approx(1.0)


def test_replay_does_not_invent_missing_future_outcomes():
    ledger = make_ledger()
    ledger.loc[2, "timestamp"] = pd.Timestamp("2026-01-08", tz="UTC")
    result = replay(ledger, {"NIFTY": make_history()})
    assert result["summary"]["pending_predictions"] == 1
    assert result["predictions"][-1]["outcome_status"] == "PENDING"
    assert result["predictions"][-1]["realized_class"] is None


def test_replay_rejects_invalid_probabilities():
    ledger = make_ledger()
    ledger.loc[0, "market_probability_up"] = 0.9
    with pytest.raises(ValueError, match="sum to 1"):
        replay(ledger, {"NIFTY": make_history()})


def test_shadow_config_rejects_invalid_capital():
    with pytest.raises(ValueError):
        ShadowConfig(initial_capital=0).validate()
