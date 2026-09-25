import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from app import (  # noqa: E402
    MAX_PROMOTION_LOG_LOSS,
    META_FEATURE_NAMES,
    MIN_PROMOTION_ACCURACY_LIFT,
    MIN_PROMOTION_DIRECTIONAL_ACCURACY,
    _action_gate,
    _build_meta_features,
    _calibration_quality,
    _fit_meta,
    _meta_promotion,
    _normalize_horizon,
    _promotion_report,
    _training_frame,
)


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
    # Long enough to clear the ~100-row warmup of the longest market-v2 window
    # (sma100) plus the 3-day label shift and still exceed MIN_HISTORY.
    steps = np.arange(600, dtype=float)
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
    assert _action_gate("UP", np.asarray([0.1, 0.2, 0.7]), 0.01, True, 0.4)["status"] == "WATCH_LOW_EDGE"
    assert _action_gate("UP", np.asarray([0.1, 0.2, 0.7]), 0.01, False)["status"] == "ABSTAIN_MODEL_GATE"
    assert _action_gate("FLAT", np.asarray([0.2, 0.7, 0.1]), 0.0, True)["status"] == "WATCH_FLAT"


def test_promotion_report_exposes_confidence_intervals():
    actual = _actual()
    probabilities = np.asarray([
        [0.8, 0.1, 0.1] if value == 0 else
        [0.1, 0.8, 0.1] if value == 1 else
        [0.1, 0.1, 0.8]
        for value in actual
    ])
    report = _promotion_report(probabilities, actual)
    # Strong, consistent evidence keeps the whole bootstrap distribution above
    # the lift threshold, so the CI-bound check agrees with the point check.
    assert report["accuracy_lift_ci_low"] >= MIN_PROMOTION_ACCURACY_LIFT
    assert report["log_loss_ci_high"] <= MAX_PROMOTION_LOG_LOSS
    assert report["directional_accuracy_ci_low"] >= MIN_PROMOTION_DIRECTIONAL_ACCURACY
    assert report["checks"]["beats_majority_baseline_ci"] is True
    assert report["checks"]["probability_quality_ci"] is True
    assert report["checks"]["directional_accuracy_ci"] is True


def test_baseline_evidence_fails_confidence_interval_checks():
    actual = _actual()
    probabilities = np.tile([0.1, 0.8, 0.1], (len(actual), 1))
    report = _promotion_report(probabilities, actual)
    assert report["checks"]["beats_majority_baseline_ci"] is False
    assert report["checks"]["directional_accuracy_ci"] is False


def test_calibration_quality_needs_history():
    actual = np.asarray(([0, 1, 2] * 40)[:120], dtype=int)
    probabilities = np.tile([0.2, 0.6, 0.2], (len(actual), 1))
    # 120 rows split at 0.6 -> 72 fit rows, below MIN_CALIBRATION_HISTORY (100).
    assert _calibration_quality(probabilities, actual) is None


def test_calibration_quality_reports_bounded_gap():
    rng = np.random.default_rng(7)
    n = 400
    actual = rng.integers(0, 3, n)
    base = rng.dirichlet(np.ones(3), size=n)
    probabilities = base / base.sum(axis=1, keepdims=True)
    quality = _calibration_quality(probabilities, actual)
    assert quality is not None
    assert quality["eval_examples"] > 0
    assert 0.0 <= quality["gap"] <= 1.0
    assert 0.0 <= quality["brier"] <= 1.0


def _synthetic_meta(n=1200, seed=3, informative=True):
    """Build OOS base outputs + a correctness label.

    When informative=True the base call is correct with probability increasing
    in its confidence, so a meta layer can legitimately earn selective lift.
    """
    rng = np.random.default_rng(seed)
    confidence = rng.uniform(0.34, 0.95, n)
    p_correct = np.clip(0.2 + (confidence - 0.34) / (0.95 - 0.34), 0.05, 0.98) if informative else np.full(n, 0.5)
    correct = (rng.uniform(size=n) < p_correct).astype(int)
    rest = (1.0 - confidence) / 2.0
    raw_probs = np.column_stack([confidence, rest, rest])
    predicted_returns = rng.normal(0.0, 0.004, n)
    context = np.column_stack([rng.uniform(0.1, 0.4, n), rng.uniform(0.005, 0.03, n)])
    residuals = rng.normal(0.0, 0.006, 400)
    meta_x = _build_meta_features(raw_probs, predicted_returns, context, residuals)
    return meta_x, correct


def test_meta_features_have_expected_shape_and_names():
    meta_x, _ = _synthetic_meta(n=50)
    assert meta_x.shape == (50, len(META_FEATURE_NAMES))
    assert np.isfinite(meta_x).all()
    # confidence column equals the max probability column
    conf_col = META_FEATURE_NAMES.index("confidence")
    assert (meta_x[:, conf_col] >= meta_x[:, META_FEATURE_NAMES.index("prob_down")] - 1e-9).all()


def test_meta_layer_promotes_when_correctness_is_predictable():
    meta_x, correct = _synthetic_meta(informative=True)
    classifier, report = _fit_meta(meta_x, correct)
    assert classifier is not None
    assert report["meta_ready"] is True
    assert report["checks"]["auc_beats_chance"] is True
    assert report["checks"]["selective_lift"] is True
    assert report["selected_coverage"] is not None
    # Selected subset must be at least as accurate as acting on everything.
    assert report["selected_accuracy"] >= report["unconditional_accuracy"]


def test_meta_layer_stays_dormant_on_pure_noise():
    meta_x, correct = _synthetic_meta(informative=False)
    _, report = _fit_meta(meta_x, correct)
    assert report["meta_ready"] is False


def test_meta_promotion_reports_coverage_curve():
    meta_x, correct = _synthetic_meta(informative=True)
    from app import _meta_walk_forward
    wf = _meta_walk_forward(meta_x, correct)
    assert wf is not None
    oos_prob, oos_correct, _ = wf
    report = _meta_promotion(oos_prob, oos_correct)
    assert set(report["coverage_accuracy"]) == {"20", "30", "40", "50"}
    assert 0.0 <= report["auc"] <= 1.0


def test_action_gate_meta_veto_only_tightens():
    base = ("UP", np.asarray([0.1, 0.2, 0.7]), 0.01, True)
    # No meta layer wired: base-only behaviour is preserved (backward compatible).
    assert _action_gate(*base)["status"] == "ACTIONABLE_LONG"
    # Ready meta layer that is confident the call is correct: still actionable.
    assert _action_gate(*base, meta_probability=0.8, meta_ready=True)["status"] == "ACTIONABLE_LONG"
    # Ready meta layer that predicts the call is likely wrong: vetoed.
    veto = _action_gate(*base, meta_probability=0.2, meta_ready=True)
    assert veto["status"] == "WATCH_LOW_EDGE"
    assert "META_CONFIDENCE_TOO_LOW" in veto["reasons"]
    # Unpromoted meta layer never regresses a promotion-ready base model.
    assert _action_gate(*base, meta_probability=0.2, meta_ready=False)["status"] == "ACTIONABLE_LONG"
