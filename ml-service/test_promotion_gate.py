import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from app import _action_gate, _normalize_horizon, _promotion_report, _training_frame  # noqa: E402


def _actual(rows=120):
    return np.asarray(([0, 1, 2] * ((rows + 2) // 3))[:rows], dtype=int)


def test_strong_oos_evidence_is_promotion_ready():
    actual = _actual()
    probabilities = np.asarray([
        [0.8, 0.1, 0.1] if value == 0 else
        [0.1, 0.8, 0.1] if value == 1 else
        [0.1, 0.1, 0.8]
        for value in actual
    ])
    report = _promotion_report(probabilities, actual)
    assert report["promotion_ready"] is True
    assert report["checks"]["minimum_examples"] is True
    assert report["checks"]["beats_majority_baseline"] is True
    assert report["checks"]["probability_quality"] is True
    assert report["checks"]["directional_accuracy"] is True


def test_baseline_level_oos_evidence_abstains():
    actual = _actual()
    probabilities = np.tile([0.1, 0.8, 0.1], (len(actual), 1))
    report = _promotion_report(probabilities, actual)
    assert report["promotion_ready"] is False
    assert report["checks"]["beats_majority_baseline"] is False
    assert report["checks"]["directional_accuracy"] is False


def test_horizon_validation_is_explicit():
    assert _normalize_horizon("3D") == "3d"
    assert _normalize_horizon("5d") == "5d"
    try:
        _normalize_horizon("2d")
    except Exception as exc:
        assert "Unsupported horizon" in str(exc)
    else:
        raise AssertionError("unsupported horizon must be rejected")


def test_three_day_training_label_uses_three_future_closes():
    steps = np.arange(400, dtype=float)
    closes = 100.0 + steps * 0.2 + np.sin(steps * 0.4) * 2.0
    index = pd.date_range("2025-01-01", periods=len(closes), freq="D", tz="UTC")
    raw = pd.DataFrame({
        "open": closes,
        "high": closes + 1,
        "low": closes - 1,
        "close": closes,
        "volume": 1000.0 + (steps % 17) * 10.0,
    }, index=index)
    frame = _training_frame(raw, "3d")
    first = frame.iloc[0]
    first_position = raw.index.get_loc(frame.index[0])
    expected = closes[first_position + 3] / closes[first_position] - 1
    assert abs(float(first["target_return"]) - expected) < 1e-12


def test_action_gate_requires_net_edge_and_margin():
    assert _action_gate("UP", np.asarray([0.1, 0.2, 0.7]), 0.01, True)["status"] == "ACTIONABLE_LONG"
    assert _action_gate("UP", np.asarray([0.1, 0.2, 0.7]), 0.001, True)["status"] == "WATCH_LOW_EDGE"
    assert _action_gate("UP", np.asarray([0.1, 0.2, 0.7]), 0.01, False)["status"] == "ABSTAIN_MODEL_GATE"
    assert _action_gate("FLAT", np.asarray([0.2, 0.7, 0.1]), 0.0, True)["status"] == "WATCH_FLAT"
