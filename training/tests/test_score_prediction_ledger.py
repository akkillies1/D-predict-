from __future__ import annotations

import pandas as pd
import pytest

from training.score_prediction_ledger import _score


def ledger() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "symbol": ["NIFTY"] * 6,
            "horizon": ["1d"] * 6,
            "fold": [1, 1, 1, 2, 2, 2],
            "prediction": ["UP", "DOWN", "FLAT", "UP", "DOWN", "UP"],
            "actual": ["UP", "DOWN", "FLAT", "DOWN", "DOWN", "UP"],
            "market_probability_down": [0.1, 0.8, 0.2, 0.7, 0.7, 0.1],
            "market_probability_flat": [0.1, 0.1, 0.7, 0.1, 0.2, 0.1],
            "market_probability_up": [0.8, 0.1, 0.1, 0.2, 0.1, 0.8],
        }
    )


def test_score_reports_accuracy_and_majority_lift() -> None:
    result = _score(ledger())
    assert result["examples"] == 6
    assert result["folds"] == 2
    assert result["accuracy"] == pytest.approx(5 / 6)
    assert result["majority_baseline_accuracy"] == pytest.approx(3 / 6)
    assert result["accuracy_lift_vs_majority"] == pytest.approx(1 / 3)
    assert result["directional_accuracy"] == pytest.approx(4 / 5)
    assert result["directional_coverage"] == pytest.approx(1.0)
    assert result["log_loss"] > 0
    assert result["brier_score"] > 0


def test_score_rejects_probabilities_that_do_not_sum_to_one() -> None:
    data = ledger()
    data.loc[0, "market_probability_up"] = 0.7
    with pytest.raises(ValueError, match="sum to 1"):
        _score(data)
