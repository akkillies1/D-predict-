from pathlib import Path

import pandas as pd
import pytest

from training.score_realized_outcomes import score_file


def test_scores_future_trading_day_and_pending(tmp_path: Path):
    history = pd.DataFrame(
        {
            "timestamp": pd.date_range("2026-01-01", periods=6, freq="D", tz="UTC"),
            "close": [100, 101, 99, 102, 103, 104],
        }
    )
    history_path = tmp_path / "nifty.csv"
    history.to_csv(history_path, index=False)

    ledger = pd.DataFrame(
        {
            "timestamp": [history.timestamp.iloc[0], history.timestamp.iloc[2], history.timestamp.iloc[5]],
            "symbol": ["NIFTY"] * 3,
            "horizon": ["1d", "3d", "1d"],
            "prediction": ["UP", "UP", "UP"],
            "market_probability_down": [0.1, 0.1, 0.1],
            "market_probability_flat": [0.1, 0.1, 0.1],
            "market_probability_up": [0.8, 0.8, 0.8],
        }
    )
    ledger_path = tmp_path / "ledger.csv"
    output_path = tmp_path / "scored.csv"
    ledger.to_csv(ledger_path, index=False)

    summary = score_file(ledger_path, history_path, output_path)
    scored = pd.read_csv(output_path)

    assert summary["examples"] == 2
    assert summary["pending"] == 1
    assert scored.loc[0, "outcome_status"] == "SCORED"
    assert scored.loc[0, "realized_class"] == "UP"
    assert scored.loc[1, "realized_class"] == "UP"
    assert scored.loc[2, "outcome_status"] == "PENDING"


def test_rejects_missing_prediction_timestamp(tmp_path: Path):
    history = pd.DataFrame(
        {
            "timestamp": pd.date_range("2026-01-01", periods=3, freq="D", tz="UTC"),
            "close": [100, 101, 102],
        }
    )
    history_path = tmp_path / "nifty.csv"
    history.to_csv(history_path, index=False)
    ledger = pd.DataFrame(
        {
            "timestamp": ["2026-02-01T00:00:00Z"],
            "symbol": ["NIFTY"],
            "horizon": ["1d"],
            "prediction": ["UP"],
            "market_probability_down": [0.1],
            "market_probability_flat": [0.1],
            "market_probability_up": [0.8],
        }
    )
    ledger_path = tmp_path / "ledger.csv"
    ledger.to_csv(ledger_path, index=False)

    with pytest.raises(ValueError, match="absent from historical source"):
        score_file(ledger_path, history_path)
