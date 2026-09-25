"""Canonical artifact-only Python ML inference service for D-Predict.

The live engine calls this service instead of maintaining a second TypeScript
signal model. A separate training job uses the shared feature implementation,
purge-aware walk-forward validation, isotonic calibration, and promotion gates
to produce a versioned artifact. This request path only loads that artifact;
it never trains or silently refreshes a model during inference.
"""
from __future__ import annotations

import hashlib
import os
import time
from dataclasses import dataclass
from pathlib import Path
from threading import Lock, Thread

import joblib
import numpy as np
import pandas as pd
import psycopg2
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, brier_score_loss, log_loss, roc_auc_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from training.build_dataset import FEATURE_COLUMNS, FEATURE_SET_VERSION, make_features

CLASS_NAMES = ["DOWN", "FLAT", "UP"]
CLASS_MAP = {"DOWN": 0, "FLAT": 1, "UP": 2}
SUPPORTED_HORIZONS = {"1d": 1, "3d": 3, "5d": 5}
DEFAULT_HORIZON = "1d"
MIN_HISTORY = 300
MIN_CALIBRATION_HISTORY = 100
MIN_PROMOTION_EXAMPLES = 100
MIN_PROMOTION_ACCURACY_LIFT = 0.02
MAX_PROMOTION_LOG_LOSS = 1.05
MIN_PROMOTION_DIRECTIONAL_ACCURACY = 0.52
# Calibration must be verified out-of-sample, not merely fit successfully. The
# isotonic calibrators ship fit on all walk-forward OOF rows; to estimate their
# honest quality we refit on the early OOF rows and score on the strictly-later
# remainder, mirroring training/probability_calibration.py's leakage-safe design.
MAX_PROMOTION_CALIBRATION_GAP = 0.10
CALIBRATION_EVAL_FRACTION = 0.6
MIN_CALIBRATION_EVAL_EXAMPLES = 30
# Promotion point estimates must clear thresholds at their bootstrap confidence
# bound, not just in expectation, so sampling noise cannot smuggle a weak model
# through a gate.
PROMOTION_BOOTSTRAP_ITERATIONS = 1000
PROMOTION_CONFIDENCE = 0.95
MIN_ACTION_CONFIDENCE = 0.55
MIN_ACTION_MARGIN = 0.10
MIN_NET_EDGE_PROBABILITY = 0.55
ROUND_TRIP_COST = float(os.environ.get("SCANNER_ROUND_TRIP_COST", "0.002"))
DB_URL = os.environ.get("DATABASE_URL")
MODEL_ARTIFACT_DIR = Path(os.environ.get("MODEL_ARTIFACT_DIR", "/app/models/live"))

# --- Meta layer ("predict the predictions"). The base 3-class model currently
# has no validated directional edge, so the meta model does NOT try to add one.
# It is a selective-prediction layer: it learns the probability that the base
# call is CORRECT and is only allowed to tighten the action gate. It earns
# promotion solely by proving, at a bootstrap confidence bound, that acting on
# its highest-confidence subset is more accurate than acting on everything. If
# it cannot prove that, meta_ready is False and /predict behaves exactly as the
# base-only path did. It can never manufacture or loosen edge. ---
META_CONTEXT_COLUMNS = ["volatility20", "atr14_pct"]
META_FEATURE_NAMES = [
    "prob_down", "prob_flat", "prob_up", "confidence", "margin", "entropy",
    "is_flat_call", "expected_return", "abs_expected_return", "edge_over_cost",
    "prob_net_positive", "volatility20", "atr14_pct",
]
META_REGRESSOR = LogisticRegression  # noqa: F811 (documentation alias)
MIN_META_EXAMPLES = 200
META_FOLDS = 4
META_PURGE_ROWS = 5
META_COVERAGE_LEVELS = (0.2, 0.3, 0.4, 0.5)
MIN_META_SELECTED_COVERAGE = 0.3
MIN_META_ACCURACY_LIFT = 0.03
MIN_META_AUC = 0.52
MIN_META_CONFIDENCE = 0.55
META_BOOTSTRAP_ITERATIONS = 1000
META_CONFIDENCE = 0.95
META_VERSION = "meta-v1"

app = FastAPI(title="D-Predict ML Inference", version="1.0")
_cache: dict[str, tuple[float, "ModelBundle"]] = {}
_cache_lock = Lock()
_train_lock = Lock()

# Automatic training cadence. Off by default so inference-only deployments are
# unaffected; enabled with AUTO_TRAIN_ENABLED. The scheduler is a separate
# nightly-ish loop, intentionally decoupled from the per-poll prediction path.
AUTO_TRAIN_ENABLED = os.environ.get("AUTO_TRAIN_ENABLED", "false").lower() in {"1", "true", "yes"}
AUTO_TRAIN_INTERVAL_HOURS = max(0.1, float(os.environ.get("AUTO_TRAIN_INTERVAL_HOURS", "24")))
AUTO_TRAIN_ON_STARTUP = os.environ.get("AUTO_TRAIN_ON_STARTUP", "false").lower() in {"1", "true", "yes"}
AUTO_TRAIN_HORIZONS = [h.strip().lower() for h in os.environ.get("AUTO_TRAIN_HORIZONS", DEFAULT_HORIZON).split(",") if h.strip()]


class TrainRequest(BaseModel):
    horizons: list[str] | None = None
    force_symbols: list[str] | None = None
    trigger: str = "MANUAL"


class PredictRequest(BaseModel):
    symbol: str
    as_of: str | None = None
    horizon: str = DEFAULT_HORIZON


@dataclass
class ModelBundle:
    horizon: str
    feature_set_version: str
    classifier: HistGradientBoostingClassifier
    regressor: HistGradientBoostingRegressor
    calibrators: list[IsotonicRegression | None]
    calibrated: bool
    training_end: pd.Timestamp
    validation_examples: int
    calibration_examples: int
    oos_accuracy: float
    oos_majority_baseline: float
    oos_log_loss: float
    oos_directional_accuracy: float | None
    accuracy_lift_ci_low: float
    log_loss_ci_high: float
    directional_accuracy_ci_low: float | None
    calibration_gap: float | None
    calibration_brier: float | None
    calibration_log_loss: float | None
    calibration_eval_examples: int
    calibration_verified: bool
    return_residual_quantiles: tuple[float, float, float]
    return_residuals: np.ndarray
    promotion_ready: bool
    meta_classifier: object | None
    meta_feature_names: list[str]
    meta_ready: bool
    meta_examples: int
    meta_oos_auc: float | None
    meta_oos_accuracy: float | None
    meta_oos_log_loss: float | None
    meta_auc_ci_low: float | None
    meta_coverage_accuracy: dict[str, float]
    meta_accuracy_lift_ci_low: float | None
    meta_selected_coverage: float | None
    meta_version: str
    model_version: str


def _db():
    if not DB_URL:
        raise RuntimeError("DATABASE_URL is required")
    return psycopg2.connect(DB_URL)


def _load_daily(symbol: str, as_of: pd.Timestamp | None = None) -> pd.DataFrame:
    cutoff = as_of.to_pydatetime() if as_of is not None else None
    sql = """
        select pb.market_timestamp as timestamp, pb.open, pb.high, pb.low, pb.close, pb.volume
        from price_bars pb
        join instruments i on i.instrument_id = pb.instrument_id
        where upper(i.symbol) = upper(%s)
          and pb.timeframe = '1d'
          and (%s::timestamptz is null or pb.market_timestamp <= %s::timestamptz)
        order by pb.market_timestamp
    """
    with _db() as conn:
        frame = pd.read_sql_query(sql, conn, params=(symbol, cutoff, cutoff), parse_dates=["timestamp"])
    if frame.empty:
        raise HTTPException(status_code=404, detail=f"No daily history for {symbol}")
    frame["timestamp"] = pd.to_datetime(frame["timestamp"], utc=True)
    return frame.drop_duplicates("timestamp").set_index("timestamp").sort_index()


def _normalize_horizon(value: str) -> str:
    horizon = str(value).strip().lower()
    if horizon not in SUPPORTED_HORIZONS:
        raise HTTPException(status_code=400, detail=f"Unsupported horizon {value}; choose one of {sorted(SUPPORTED_HORIZONS)}")
    return horizon


def _training_frame(raw: pd.DataFrame, horizon: str) -> pd.DataFrame:
    horizon_days = SUPPORTED_HORIZONS[horizon]
    features = make_features(raw)
    target = raw["close"].shift(-horizon_days) / raw["close"] - 1
    frame = features.copy()
    frame["target_return"] = target
    frame["target_class"] = np.select([target > 0.001, target < -0.001], ["UP", "DOWN"], default="FLAT")
    frame = frame.replace([np.inf, -np.inf], np.nan).dropna(subset=FEATURE_COLUMNS + ["target_return", "target_class"])
    if len(frame) < MIN_HISTORY:
        raise HTTPException(status_code=503, detail=f"Need at least {MIN_HISTORY} usable daily examples; found {len(frame)}")
    return frame


def _classifier() -> HistGradientBoostingClassifier:
    return HistGradientBoostingClassifier(
        learning_rate=0.05, max_iter=250, max_leaf_nodes=15,
        l2_regularization=1.0, random_state=42,
    )


def _regressor() -> HistGradientBoostingRegressor:
    return HistGradientBoostingRegressor(
        learning_rate=0.05, max_iter=250, max_leaf_nodes=15,
        l2_regularization=1.0, random_state=42, loss="squared_error",
    )


def _walk_forward(frame: pd.DataFrame, purge_rows: int, folds: int = 5) -> tuple[np.ndarray, np.ndarray, int, np.ndarray, np.ndarray, np.ndarray]:
    min_train = max(200, len(frame) // (folds + 2))
    remaining = len(frame) - min_train
    block = max(1, remaining // folds)
    raw_probs: list[np.ndarray] = []
    actual: list[int] = []
    predicted_returns: list[float] = []
    actual_returns: list[float] = []
    context_rows: list[np.ndarray] = []
    for fold in range(folds):
        train_end = min_train + fold * block
        valid_start = min(len(frame) - 1, train_end + purge_rows)
        valid_end = min(len(frame), valid_start + block)
        if valid_end <= valid_start:
            continue
        train = frame.iloc[:train_end]
        valid = frame.iloc[valid_start:valid_end]
        clf = _classifier()
        clf.fit(train[FEATURE_COLUMNS], train["target_class"].map(CLASS_MAP))
        reg = _regressor()
        reg.fit(train[FEATURE_COLUMNS], train["target_return"])
        raw_probs.append(clf.predict_proba(valid[FEATURE_COLUMNS]))
        actual.extend(valid["target_class"].map(CLASS_MAP).astype(int).tolist())
        predicted_returns.extend(reg.predict(valid[FEATURE_COLUMNS]).tolist())
        actual_returns.extend(valid["target_return"].astype(float).tolist())
        context_rows.append(valid[META_CONTEXT_COLUMNS].to_numpy(dtype=float))
    if not raw_probs:
        raise HTTPException(status_code=503, detail="Walk-forward validation produced no OOS rows")
    residuals = np.asarray(actual_returns, dtype=float) - np.asarray(predicted_returns, dtype=float)
    context = np.vstack(context_rows)
    return np.vstack(raw_probs), np.asarray(actual, dtype=int), int(sum(len(x) for x in raw_probs)), np.asarray(predicted_returns), residuals, context


def _promotion_report(raw_probs: np.ndarray, actual: np.ndarray) -> dict:
    predictions = np.argmax(raw_probs, axis=1)
    examples = int(len(actual))
    accuracy = float(accuracy_score(actual, predictions)) if examples else 0.0
    counts = np.bincount(actual, minlength=3)
    majority_baseline = float(counts.max() / examples) if examples else 1.0
    probability_log_loss = float(log_loss(actual, raw_probs, labels=[0, 1, 2]))
    directional_mask = np.isin(actual, [0, 2]) & np.isin(predictions, [0, 2])
    directional_accuracy = (float(np.mean(predictions[directional_mask] == actual[directional_mask]))
                            if np.any(directional_mask) else None)

    # Nonparametric bootstrap over OOF rows. Each replicate resamples the
    # validation set with replacement and recomputes the three promotion
    # statistics, giving a sampling distribution we take confidence bounds from.
    alpha = 1.0 - PROMOTION_CONFIDENCE
    lift_samples: list[float] = []
    loss_samples: list[float] = []
    directional_samples: list[float] = []
    if examples:
        rng = np.random.default_rng(42)
        for _ in range(PROMOTION_BOOTSTRAP_ITERATIONS):
            idx = rng.integers(0, examples, examples)
            a_b = actual[idx]
            p_b = predictions[idx]
            lift_samples.append(float(np.mean(a_b == p_b)) - float(np.bincount(a_b, minlength=3).max() / examples))
            try:
                loss_samples.append(float(log_loss(a_b, raw_probs[idx], labels=[0, 1, 2])))
            except ValueError:
                pass
            dm_b = directional_mask[idx]
            if np.any(dm_b):
                directional_samples.append(float(np.mean(p_b[dm_b] == a_b[dm_b])))

    def _bound(samples: list[float], quantile: float) -> float:
        arr = np.asarray(samples, dtype=float)
        return float(np.quantile(arr, quantile)) if arr.size else float("nan")

    accuracy_lift_ci_low = _bound(lift_samples, alpha / 2)
    log_loss_ci_high = _bound(loss_samples, 1 - alpha / 2)
    directional_accuracy_ci_low = _bound(directional_samples, alpha / 2) if directional_samples else None

    lift = accuracy - majority_baseline
    checks = {
        "minimum_examples": examples >= MIN_PROMOTION_EXAMPLES,
        "beats_majority_baseline": lift >= MIN_PROMOTION_ACCURACY_LIFT,
        "beats_majority_baseline_ci": not np.isnan(accuracy_lift_ci_low) and accuracy_lift_ci_low >= MIN_PROMOTION_ACCURACY_LIFT,
        "probability_quality": probability_log_loss <= MAX_PROMOTION_LOG_LOSS,
        "probability_quality_ci": not np.isnan(log_loss_ci_high) and log_loss_ci_high <= MAX_PROMOTION_LOG_LOSS,
        "directional_accuracy": directional_accuracy is not None and directional_accuracy >= MIN_PROMOTION_DIRECTIONAL_ACCURACY,
        "directional_accuracy_ci": (directional_accuracy_ci_low is not None
                                    and not np.isnan(directional_accuracy_ci_low)
                                    and directional_accuracy_ci_low >= MIN_PROMOTION_DIRECTIONAL_ACCURACY),
    }
    return {
        "examples": examples,
        "accuracy": accuracy,
        "majority_baseline": majority_baseline,
        "accuracy_lift": lift,
        "log_loss": probability_log_loss,
        "directional_accuracy": directional_accuracy,
        "accuracy_lift_ci_low": accuracy_lift_ci_low,
        "log_loss_ci_high": log_loss_ci_high,
        "directional_accuracy_ci_low": directional_accuracy_ci_low,
        "checks": checks,
        "promotion_ready": all(checks.values()),
    }


def _calibration_quality(raw_probs: np.ndarray, actual: np.ndarray) -> dict | None:
    """Leakage-safe out-of-sample estimate of isotonic calibration quality.

    The shipped calibrators use every OOF row, so scoring them on those same rows
    would be optimistically in-sample. Instead we fit fresh isotonic calibrators
    on the chronologically-early OOF rows and measure the calibration error on
    the strictly-later remainder. A large gap means the model's confidence is not
    trustworthy even where isotonic 'succeeded', so promotion is blocked.
    """
    n = int(len(actual))
    split = int(n * CALIBRATION_EVAL_FRACTION)
    if split < MIN_CALIBRATION_HISTORY or n - split < MIN_CALIBRATION_EVAL_EXAMPLES:
        return None
    fit_raw, fit_y = raw_probs[:split], actual[:split]
    eval_raw, eval_y = raw_probs[split:], actual[split:]
    eval_calibrators: list[IsotonicRegression] = []
    for cls_idx in range(3):
        raw = fit_raw[:, cls_idx]
        y = (fit_y == cls_idx).astype(float)
        if len(np.unique(raw)) < 2 or len(np.unique(y)) < 2:
            return None
        iso = IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds="clip")
        iso.fit(raw, y)
        eval_calibrators.append(iso)
    calibrated = np.column_stack([eval_calibrators[c].predict(eval_raw[:, c]) for c in range(3)])
    totals = calibrated.sum(axis=1, keepdims=True)
    totals[totals <= 0] = 1.0
    calibrated = calibrated / totals
    confidence = calibrated.max(axis=1)
    correct = (calibrated.argmax(axis=1) == eval_y).astype(float)
    gap = float(abs(confidence.mean() - correct.mean()))
    brier = float(np.mean([brier_score_loss((eval_y == c).astype(int), calibrated[:, c]) for c in range(3)]))
    cal_log_loss = float(log_loss(eval_y, calibrated, labels=[0, 1, 2]))
    return {"gap": gap, "brier": brier, "log_loss": cal_log_loss, "eval_examples": int(len(eval_y))}


def _probability_net_positive(prediction_index: int, expected_return: float, residuals: np.ndarray, round_trip_cost: float = ROUND_TRIP_COST) -> float:
    """P(the trade clears round-trip cost) under the empirical OOS residual law.

    Mirrors the /predict computation so meta-features are identical at training
    and serving time. residuals is the global OOS return-residual sample.
    """
    shocked = expected_return + residuals
    if prediction_index == 2:  # UP
        return float(np.mean(shocked > round_trip_cost))
    if prediction_index == 0:  # DOWN
        return float(np.mean(-shocked > round_trip_cost))
    return float(np.mean(np.abs(shocked) <= round_trip_cost))


def _build_meta_features(raw_probs: np.ndarray, predicted_returns: np.ndarray, context: np.ndarray, residuals: np.ndarray) -> np.ndarray:
    """Leakage-free meta-features derived only from per-fold OOS base outputs.

    Every input here (raw_probs, predicted_returns) came from a base model
    trained strictly on earlier rows, and context columns are point-in-time, so
    the meta layer never sees the label it is trying to predict except through
    the correctness target built separately.
    """
    n = raw_probs.shape[0]
    eps = 1e-12
    rows = np.empty((n, len(META_FEATURE_NAMES)), dtype=float)
    log3 = float(np.log(3.0))
    for i in range(n):
        p = np.asarray(raw_probs[i], dtype=float)
        ordered = np.sort(p)[::-1]
        confidence = float(ordered[0])
        margin = float(ordered[0] - ordered[1]) if p.size > 1 else confidence
        entropy = float(-np.sum(p * np.log(p + eps)) / log3)
        call = int(np.argmax(p))
        expected_return = float(predicted_returns[i])
        sign = 1.0 if call == 2 else (-1.0 if call == 0 else 0.0)
        edge_over_cost = sign * expected_return - ROUND_TRIP_COST
        pnp = _probability_net_positive(call, expected_return, residuals)
        rows[i] = [
            float(p[0]), float(p[1]), float(p[2]), confidence, margin, entropy,
            1.0 if call == 1 else 0.0, expected_return, abs(expected_return),
            edge_over_cost, pnp, float(context[i][0]), float(context[i][1]),
        ]
    return rows


def _meta_classifier_pipeline():
    # Simple, low-variance stacker: ~13 standardized features over a few hundred
    # OOS rows. A boosting meta-model would overfit the stack and fabricate edge.
    return make_pipeline(StandardScaler(), LogisticRegression(C=0.5, max_iter=1000, random_state=42))


def _meta_walk_forward(meta_x: np.ndarray, correct: np.ndarray, folds: int = META_FOLDS, purge_rows: int = META_PURGE_ROWS) -> tuple[np.ndarray, np.ndarray, np.ndarray] | None:
    """Nested purged walk-forward producing honest OOS meta predictions.

    The meta correctness-classifier is trained only on earlier OOS rows and
    scores a strictly-later, purge-separated block, so it never evaluates on rows
    it fit. Returns (oos_meta_prob, oos_correct, oos_row_index) over the scored
    subset, or None when there is not enough history or only one label class.
    """
    n = int(len(correct))
    if n < MIN_META_EXAMPLES:
        return None
    min_train = max(120, n // (folds + 2))
    remaining = n - min_train
    block = max(1, remaining // folds)
    prob_parts: list[np.ndarray] = []
    idx_parts: list[np.ndarray] = []
    for fold in range(folds):
        train_end = min_train + fold * block
        valid_start = min(n - 1, train_end + purge_rows)
        valid_end = min(n, valid_start + block)
        if valid_end <= valid_start:
            continue
        train_y = correct[:train_end]
        if len(np.unique(train_y)) < 2:
            continue
        clf = _meta_classifier_pipeline()
        clf.fit(meta_x[:train_end], train_y)
        proba = clf.predict_proba(meta_x[valid_start:valid_end])
        classes = list(clf.classes_)
        col = classes.index(1) if 1 in classes else classes[-1]
        prob_parts.append(proba[:, col])
        idx_parts.append(np.arange(valid_start, valid_end))
    if not prob_parts:
        return None
    oos_prob = np.concatenate(prob_parts)
    oos_idx = np.concatenate(idx_parts)
    return oos_prob, correct[oos_idx], oos_idx


def _selective_lift_samples(meta_prob: np.ndarray, correct: np.ndarray, coverage: float) -> tuple[float, float]:
    k = max(1, int(round(len(correct) * coverage)))
    order = np.argsort(meta_prob)[::-1][:k]
    selected_accuracy = float(np.mean(correct[order]))
    unconditional = float(np.mean(correct))
    return selected_accuracy, selected_accuracy - unconditional


def _meta_promotion(oos_prob: np.ndarray, oos_correct: np.ndarray) -> dict:
    """Bootstrap-CI promotion for the selective-prediction meta layer.

    meta_ready requires BOTH: (a) the correctness classifier beats a coin flip
    on AUC at its CI low, and (b) at some coverage >= MIN_META_SELECTED_COVERAGE,
    base-call accuracy on the meta-selected subset beats unconditional base
    accuracy by >= MIN_META_ACCURACY_LIFT at the CI low. The chosen coverage is
    the largest level that clears (b), so the gate acts on as many names as it
    can while still provably improving precision.
    """
    examples = int(len(oos_correct))
    unconditional = float(np.mean(oos_correct)) if examples else 0.0
    try:
        auc = float(roc_auc_score(oos_correct, oos_prob)) if len(np.unique(oos_correct)) > 1 else 0.5
    except ValueError:
        auc = 0.5
    accuracy = float(np.mean((oos_prob >= 0.5).astype(int) == oos_correct)) if examples else 0.0
    try:
        mlog = float(log_loss(oos_correct, np.clip(oos_prob, 1e-6, 1 - 1e-6), labels=[0, 1]))
    except ValueError:
        mlog = float("nan")
    coverage_accuracy = {f"{int(c * 100)}": _selective_lift_samples(oos_prob, oos_correct, c)[0] for c in META_COVERAGE_LEVELS}

    alpha = 1.0 - META_CONFIDENCE
    rng = np.random.default_rng(42)
    auc_samples: list[float] = []
    lift_samples: dict[float, list[float]] = {c: [] for c in META_COVERAGE_LEVELS}
    if examples:
        for _ in range(META_BOOTSTRAP_ITERATIONS):
            idx = rng.integers(0, examples, examples)
            c_b = oos_correct[idx]
            p_b = oos_prob[idx]
            if len(np.unique(c_b)) > 1:
                try:
                    auc_samples.append(float(roc_auc_score(c_b, p_b)))
                except ValueError:
                    pass
            for cov in META_COVERAGE_LEVELS:
                lift_samples[cov].append(_selective_lift_samples(p_b, c_b, cov)[1])

    def _q(samples: list[float], quantile: float) -> float:
        arr = np.asarray(samples, dtype=float)
        return float(np.quantile(arr, quantile)) if arr.size else float("nan")

    auc_ci_low = _q(auc_samples, alpha / 2)
    lift_ci_low = {cov: _q(lift_samples[cov], alpha / 2) for cov in META_COVERAGE_LEVELS}

    selected_coverage: float | None = None
    selected_lift_ci_low: float | None = None
    for cov in sorted(META_COVERAGE_LEVELS, reverse=True):
        if cov >= MIN_META_SELECTED_COVERAGE and not np.isnan(lift_ci_low[cov]) and lift_ci_low[cov] >= MIN_META_ACCURACY_LIFT:
            selected_coverage = cov
            selected_lift_ci_low = lift_ci_low[cov]
            break

    checks = {
        "minimum_examples": examples >= MIN_META_EXAMPLES,
        "auc_beats_chance": not np.isnan(auc_ci_low) and auc_ci_low >= MIN_META_AUC,
        "selective_lift": selected_coverage is not None,
    }
    return {
        "examples": examples,
        "unconditional_accuracy": unconditional,
        "auc": auc,
        "auc_ci_low": auc_ci_low,
        "accuracy": accuracy,
        "log_loss": mlog,
        "coverage_accuracy": coverage_accuracy,
        "coverage_lift_ci_low": {f"{int(c * 100)}": lift_ci_low[c] for c in META_COVERAGE_LEVELS},
        "selected_coverage": selected_coverage,
        "selected_accuracy": coverage_accuracy[f"{int(selected_coverage * 100)}"] if selected_coverage is not None else None,
        "accuracy_lift_ci_low": selected_lift_ci_low,
        "checks": checks,
        "meta_ready": examples >= MIN_META_EXAMPLES and bool(checks["auc_beats_chance"]) and bool(checks["selective_lift"]),
    }


def _fit_meta(meta_x: np.ndarray, correct: np.ndarray) -> tuple[object | None, dict]:
    """Evaluate the meta layer OOS, then fit a final classifier on all OOS rows."""
    wf = _meta_walk_forward(meta_x, correct)
    if wf is None:
        return None, {"meta_ready": False, "reason": "insufficient_oos_history_or_single_class", "examples": int(len(correct))}
    oos_prob, oos_correct, _ = wf
    report = _meta_promotion(oos_prob, oos_correct)
    classifier = None
    if len(np.unique(correct)) >= 2:
        classifier = _meta_classifier_pipeline()
        classifier.fit(meta_x, correct)
    return classifier, report


def _action_gate(prediction: str, probabilities: np.ndarray, expected_return: float, promotion_ready: bool, probability_net_positive: float = 1.0, round_trip_cost: float = ROUND_TRIP_COST, meta_probability: float | None = None, meta_ready: bool = False) -> dict:
    ordered = np.sort(probabilities)[::-1]
    confidence = float(ordered[0])
    margin = float(ordered[0] - ordered[1]) if len(ordered) > 1 else confidence
    reasons: list[str] = []
    if not promotion_ready:
        reasons.append("MODEL_PROMOTION_GATE_FAILED")
        return {"status": "ABSTAIN_MODEL_GATE", "reasons": reasons, "probability_margin": margin}
    if prediction == "FLAT":
        reasons.append("FLAT_CLASS_DOMINATES")
        return {"status": "WATCH_FLAT", "reasons": reasons, "probability_margin": margin}
    if confidence < MIN_ACTION_CONFIDENCE:
        reasons.append("CONFIDENCE_BELOW_ACTION_THRESHOLD")
    if margin < MIN_ACTION_MARGIN:
        reasons.append("PROBABILITY_MARGIN_TOO_NARROW")
    if prediction == "UP" and expected_return <= round_trip_cost:
        reasons.append("EXPECTED_RETURN_DOES_NOT_CLEAR_COST")
    if prediction == "DOWN" and expected_return >= -round_trip_cost:
        reasons.append("EXPECTED_RETURN_DOES_NOT_CLEAR_COST")
    if probability_net_positive < MIN_NET_EDGE_PROBABILITY:
        reasons.append("PROBABILITY_NET_EDGE_TOO_LOW")
    # Meta gate only tightens, and only when a validated meta layer exists. A
    # ready meta layer can veto an otherwise-actionable directional call it
    # believes is likely wrong; an absent/unpromoted meta layer imposes no extra
    # constraint, so it can never regress a base model that earned promotion.
    if meta_ready and (meta_probability is None or meta_probability < MIN_META_CONFIDENCE):
        reasons.append("META_CONFIDENCE_TOO_LOW")
    if reasons:
        return {"status": "WATCH_LOW_EDGE", "reasons": reasons, "probability_margin": margin}
    return {"status": "ACTIONABLE_LONG" if prediction == "UP" else "ACTIONABLE_SHORT", "reasons": ["CONFIDENCE_MARGIN_AND_NET_EDGE_CLEAR"], "probability_margin": margin}


def _none_if_nan(value) -> float | None:
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return None if np.isnan(f) else f


def _fit_bundle(symbol: str, frame: pd.DataFrame, horizon: str) -> ModelBundle:
    raw_probs, actual, oos_examples, predicted_returns, residuals, context = _walk_forward(frame, SUPPORTED_HORIZONS[horizon])
    promotion = _promotion_report(raw_probs, actual)
    calibrators: list[IsotonicRegression | None] = []
    for cls_idx in range(3):
        raw = raw_probs[:, cls_idx]
        y = (actual == cls_idx).astype(float)
        if len(actual) < MIN_CALIBRATION_HISTORY or len(np.unique(raw)) < 2 or len(np.unique(y)) < 2:
            calibrators.append(None)
        else:
            cal = IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds="clip")
            cal.fit(raw, y)
            calibrators.append(cal)
    calibrated = all(c is not None for c in calibrators)
    cal_quality = _calibration_quality(raw_probs, actual) if calibrated else None
    calibration_verified = cal_quality is not None and cal_quality["gap"] <= MAX_PROMOTION_CALIBRATION_GAP
    promotion_ready = promotion["promotion_ready"] and calibration_verified

    # Meta layer: predict whether the base call (argmax of raw OOS probs) is
    # correct. Trained/evaluated with its own nested purged walk-forward so it
    # can only earn promotion via honest selective-prediction lift.
    base_pred = np.argmax(raw_probs, axis=1)
    meta_correct = (base_pred == actual).astype(int)
    meta_x = _build_meta_features(raw_probs, predicted_returns, context, residuals)
    meta_classifier, meta_report = _fit_meta(meta_x, meta_correct)
    meta_ready = bool(meta_report.get("meta_ready"))

    clf = _classifier()
    clf.fit(frame[FEATURE_COLUMNS], frame["target_class"].map(CLASS_MAP))
    reg = _regressor()
    reg.fit(frame[FEATURE_COLUMNS], frame["target_return"])
    training_end = pd.Timestamp(frame.index.max()).tz_convert("UTC")
    signature = hashlib.sha256(
        (symbol.upper() + "|" + horizon + "|" + FEATURE_SET_VERSION + "|" + training_end.isoformat()
         + "|histgb:lr=.05,max_iter=250,max_leaf_nodes=15,l2=1,seed=42|cal="
         + ("isotonic" if calibration_verified else "raw")
         + "|" + META_VERSION + "=" + ("ready" if meta_ready else "dormant")
         + "|features=" + ",".join(FEATURE_COLUMNS)).encode()
    ).hexdigest()[:12]
    return ModelBundle(
        horizon=horizon,
        feature_set_version=FEATURE_SET_VERSION,
        classifier=clf, regressor=reg, calibrators=calibrators, calibrated=calibrated,
        training_end=training_end, validation_examples=oos_examples,
        calibration_examples=oos_examples if calibrated else 0,
        oos_accuracy=promotion["accuracy"], oos_majority_baseline=promotion["majority_baseline"],
        oos_log_loss=promotion["log_loss"], oos_directional_accuracy=promotion["directional_accuracy"],
        accuracy_lift_ci_low=promotion["accuracy_lift_ci_low"],
        log_loss_ci_high=promotion["log_loss_ci_high"],
        directional_accuracy_ci_low=promotion["directional_accuracy_ci_low"],
        calibration_gap=cal_quality["gap"] if cal_quality else None,
        calibration_brier=cal_quality["brier"] if cal_quality else None,
        calibration_log_loss=cal_quality["log_loss"] if cal_quality else None,
        calibration_eval_examples=cal_quality["eval_examples"] if cal_quality else 0,
        calibration_verified=calibration_verified,
        return_residual_quantiles=tuple(float(value) for value in np.quantile(residuals, [0.1, 0.5, 0.9])),
        return_residuals=residuals,
        promotion_ready=promotion_ready,
        meta_classifier=meta_classifier,
        meta_feature_names=list(META_FEATURE_NAMES),
        meta_ready=meta_ready,
        meta_examples=int(meta_report.get("examples", 0)),
        meta_oos_auc=_none_if_nan(meta_report.get("auc")),
        meta_oos_accuracy=_none_if_nan(meta_report.get("accuracy")),
        meta_oos_log_loss=_none_if_nan(meta_report.get("log_loss")),
        meta_auc_ci_low=_none_if_nan(meta_report.get("auc_ci_low")),
        meta_coverage_accuracy=dict(meta_report.get("coverage_accuracy", {})),
        meta_accuracy_lift_ci_low=_none_if_nan(meta_report.get("accuracy_lift_ci_low")),
        meta_selected_coverage=meta_report.get("selected_coverage"),
        meta_version=META_VERSION,
        model_version=f"{FEATURE_SET_VERSION}-{horizon}-histgb-{signature}",
    )


def _artifact_path(symbol: str, horizon: str) -> Path:
    safe_symbol = "".join(character for character in symbol.upper() if character.isalnum() or character in "._-")
    version_slug = FEATURE_SET_VERSION.replace("-", "_")
    return MODEL_ARTIFACT_DIR / f"{safe_symbol}_{horizon}_{version_slug}.joblib"


def _save_bundle(symbol: str, bundle: ModelBundle) -> Path:
    MODEL_ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    path = _artifact_path(symbol, bundle.horizon)
    temporary = path.with_suffix(path.suffix + ".tmp")
    joblib.dump(bundle, temporary)
    temporary.replace(path)
    return path


def _load_bundle(symbol: str, horizon: str) -> ModelBundle:
    path = _artifact_path(symbol, horizon)
    if not path.exists():
        raise HTTPException(status_code=503, detail={
            "code": "MODEL_ARTIFACT_UNAVAILABLE",
            "message": f"No validated model artifact is available for {symbol} {horizon}; run the training job before inference.",
            "artifact": str(path),
        })
    try:
        bundle = joblib.load(path)
    except Exception as error:
        raise HTTPException(status_code=503, detail={
            "code": "MODEL_ARTIFACT_INVALID",
            "message": f"Validated model artifact could not be loaded: {error}",
            "artifact": str(path),
        }) from error
    if not isinstance(bundle, ModelBundle) or bundle.horizon != horizon or bundle.feature_set_version != FEATURE_SET_VERSION:
        raise HTTPException(status_code=503, detail={
            "code": "MODEL_ARTIFACT_INVALID",
            "message": "Model artifact metadata does not match the requested horizon or feature set.",
            "artifact": str(path),
        })
    return bundle


def _get_bundle(symbol: str, horizon: str) -> ModelBundle:
    key = f"{symbol.upper()}:{horizon}"
    path = _artifact_path(symbol.upper(), horizon)
    try:
        mtime = path.stat().st_mtime
    except OSError:
        mtime = None
    with _cache_lock:
        current = _cache.get(key)
        # Reuse the cached bundle only when the artifact on disk is unchanged;
        # a retrained artifact (new mtime) forces a reload without a restart.
        if current and mtime is not None and current[0] == mtime:
            return current[1]
        bundle = _load_bundle(symbol.upper(), horizon)
        _cache[key] = (mtime if mtime is not None else 0.0, bundle)
        return bundle


def _calibrate(bundle: ModelBundle, raw: np.ndarray) -> np.ndarray:
    if not bundle.calibrated:
        return raw
    values = np.array([bundle.calibrators[i].predict([raw[i]])[0] for i in range(3)], dtype=float)
    total = float(values.sum())
    if total <= 0:
        return raw
    values /= total
    values[-1] = max(0.0, min(1.0, 1.0 - float(values[:-1].sum())))
    values[:-1] /= float(values.sum())
    return values


def _meta_probability(bundle: ModelBundle, meta_x: np.ndarray) -> float | None:
    """P(the base call is correct) from the meta layer, or None if dormant."""
    if bundle.meta_classifier is None:
        return None
    proba = bundle.meta_classifier.predict_proba(meta_x)[0]
    classes = list(bundle.meta_classifier.classes_)
    col = classes.index(1) if 1 in classes else classes[-1]
    return float(proba[col])


@app.get("/health")
def health():
    return {"ok": True, "service": "ml-inference", "feature_set_version": FEATURE_SET_VERSION, "default_horizon": DEFAULT_HORIZON, "supported_horizons": sorted(SUPPORTED_HORIZONS), "artifact_directory": str(MODEL_ARTIFACT_DIR), "training_inference_separated": True}


@app.post("/predict")
def predict(request: PredictRequest):
    symbol = request.symbol.strip().upper()
    if not symbol or len(symbol) > 32:
        raise HTTPException(status_code=400, detail="INVALID_SYMBOL")
    horizon = _normalize_horizon(request.horizon)
    as_of = pd.Timestamp(request.as_of).tz_convert("UTC") if request.as_of else None
    raw = _load_daily(symbol, as_of)
    bundle = _get_bundle(symbol, horizon)
    if as_of is not None and as_of < bundle.training_end:
        raise HTTPException(status_code=409, detail={
            "code": "MODEL_ARTIFACT_CUTOFF_MISMATCH",
            "message": "The requested as-of timestamp predates the artifact training cutoff; use a historical artifact trained at or before that timestamp.",
            "training_cutoff": bundle.training_end.isoformat(),
        })

    # Inference uses the latest feature row, even though it has no future label.
    # Training uses only rows with a known next-day target. This keeps live
    # inference on exactly the same feature implementation without leaking the label.
    live_features = make_features(raw).replace([np.inf, -np.inf], np.nan).dropna(subset=FEATURE_COLUMNS)
    if live_features.empty:
        raise HTTPException(status_code=503, detail="Insufficient history to build live features")
    latest = live_features.iloc[[-1]]
    latest_timestamp = pd.Timestamp(latest.index[-1]).tz_convert("UTC")
    raw_probs = bundle.classifier.predict_proba(latest[FEATURE_COLUMNS])[0]
    probs = _calibrate(bundle, raw_probs)
    prediction = CLASS_NAMES[int(np.argmax(probs))]
    expected_return = float(bundle.regressor.predict(latest[FEATURE_COLUMNS])[0])
    confidence = float(np.max(probs))
    prediction_status = "PROMOTION_READY" if bundle.promotion_ready else "ABSTAIN"
    return_interval = {"p10": expected_return + bundle.return_residual_quantiles[0], "p50": expected_return + bundle.return_residual_quantiles[1], "p90": expected_return + bundle.return_residual_quantiles[2]}
    if prediction == "UP":
        probability_net_positive = float(np.mean(expected_return + bundle.return_residuals > ROUND_TRIP_COST))
    elif prediction == "DOWN":
        probability_net_positive = float(np.mean(-(expected_return + bundle.return_residuals) > ROUND_TRIP_COST))
    else:
        probability_net_positive = float(np.mean(np.abs(expected_return + bundle.return_residuals) <= ROUND_TRIP_COST))
    meta_context = latest[META_CONTEXT_COLUMNS].to_numpy(dtype=float)
    meta_x = _build_meta_features(np.asarray(raw_probs).reshape(1, -1), np.array([expected_return]), meta_context, bundle.return_residuals)
    meta_probability = _meta_probability(bundle, meta_x)
    action = _action_gate(prediction, probs, expected_return, bundle.promotion_ready, probability_net_positive, meta_probability=meta_probability, meta_ready=bundle.meta_ready)

    # Freshness is reported independently of the action gate: a model can be
    # current while data is stale, or data live while the model lags the last bar.
    latest_data_ts = pd.Timestamp(raw.index.max()).tz_convert("UTC")
    data_age_days = (pd.Timestamp.now(tz="UTC") - latest_data_ts).total_seconds() / 86400.0
    model_status = "MODEL_STALE" if latest_data_ts > bundle.training_end else "READY"
    data_status = "DATA_STALE" if data_age_days > 3 else "LIVE"

    return {
        "ok": True, "symbol": symbol, "timestamp": latest_timestamp.isoformat(), "horizon": horizon,
        "model_status": model_status, "data_status": data_status,
        "prediction": prediction,
        "probabilities": {"DOWN": float(probs[0]), "FLAT": float(probs[1]), "UP": float(probs[2])},
        "raw_probabilities": {"DOWN": float(raw_probs[0]), "FLAT": float(raw_probs[1]), "UP": float(raw_probs[2])},
        "expected_return": expected_return, "confidence": confidence,
        "return_interval": return_interval, "probability_net_positive": probability_net_positive,
        "probability_margin": action["probability_margin"],
        "calibration_status": "CALIBRATED" if bundle.calibration_verified else ("UNCALIBRATED" if not bundle.calibrated else "CALIBRATION_UNVERIFIED"),
        "prediction_status": prediction_status,
        "action_status": action["status"], "action_reasons": action["reasons"],
        "promotion_checks": {
            "minimum_examples": bundle.validation_examples >= MIN_PROMOTION_EXAMPLES,
            "beats_majority_baseline": bundle.oos_accuracy - bundle.oos_majority_baseline >= MIN_PROMOTION_ACCURACY_LIFT,
            "beats_majority_baseline_ci": not np.isnan(bundle.accuracy_lift_ci_low) and bundle.accuracy_lift_ci_low >= MIN_PROMOTION_ACCURACY_LIFT,
            "probability_quality": bundle.oos_log_loss <= MAX_PROMOTION_LOG_LOSS,
            "probability_quality_ci": not np.isnan(bundle.log_loss_ci_high) and bundle.log_loss_ci_high <= MAX_PROMOTION_LOG_LOSS,
            "directional_accuracy": bundle.oos_directional_accuracy is not None and bundle.oos_directional_accuracy >= MIN_PROMOTION_DIRECTIONAL_ACCURACY,
            "directional_accuracy_ci": bundle.directional_accuracy_ci_low is not None and not np.isnan(bundle.directional_accuracy_ci_low) and bundle.directional_accuracy_ci_low >= MIN_PROMOTION_DIRECTIONAL_ACCURACY,
            "calibration_available": bundle.calibrated,
            "calibration_quality": bundle.calibration_verified,
        },
        "oos_metrics": {
            "accuracy": bundle.oos_accuracy,
            "majority_baseline": bundle.oos_majority_baseline,
            "accuracy_lift": bundle.oos_accuracy - bundle.oos_majority_baseline,
            "log_loss": bundle.oos_log_loss,
            "directional_accuracy": bundle.oos_directional_accuracy,
        },
        "confidence_intervals": {
            "level": PROMOTION_CONFIDENCE,
            "accuracy_lift_low": None if np.isnan(bundle.accuracy_lift_ci_low) else bundle.accuracy_lift_ci_low,
            "log_loss_high": None if np.isnan(bundle.log_loss_ci_high) else bundle.log_loss_ci_high,
            "directional_accuracy_low": bundle.directional_accuracy_ci_low,
        },
        "calibration_metrics": {
            "verified": bundle.calibration_verified,
            "gap": bundle.calibration_gap,
            "brier": bundle.calibration_brier,
            "log_loss": bundle.calibration_log_loss,
            "eval_examples": bundle.calibration_eval_examples,
            "max_gap_threshold": MAX_PROMOTION_CALIBRATION_GAP,
        },
        "meta_probability": meta_probability,
        "meta": {
            "version": bundle.meta_version,
            "ready": bundle.meta_ready,
            "probability": meta_probability,
            "min_confidence": MIN_META_CONFIDENCE,
            "examples": bundle.meta_examples,
            "oos_auc": bundle.meta_oos_auc,
            "oos_auc_ci_low": bundle.meta_auc_ci_low,
            "oos_accuracy": bundle.meta_oos_accuracy,
            "oos_log_loss": bundle.meta_oos_log_loss,
            "selected_coverage": bundle.meta_selected_coverage,
            "accuracy_lift_ci_low": bundle.meta_accuracy_lift_ci_low,
            "coverage_accuracy": bundle.meta_coverage_accuracy,
            "features": {name: float(meta_x[0][i]) for i, name in enumerate(bundle.meta_feature_names)},
        },
        "model_version": bundle.model_version, "feature_set_version": FEATURE_SET_VERSION,
        "training_cutoff": bundle.training_end.isoformat(),
        "validation_oos_examples": bundle.validation_examples, "calibration_examples": bundle.calibration_examples,
        "features": {column: float(latest.iloc[0][column]) for column in FEATURE_COLUMNS},
    }


@app.get("/training/coverage")
def training_coverage(horizons: str | None = None):
    import auto_train

    horizon_list = [h.strip().lower() for h in horizons.split(",")] if horizons else None
    try:
        return auto_train.coverage_report(horizon_list)
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"COVERAGE_FAILED: {error}") from error


@app.post("/train/auto")
def train_auto(request: TrainRequest):
    import auto_train

    if not _train_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail={"code": "TRAINING_IN_PROGRESS", "message": "Another training run is already active."})
    try:
        return auto_train.run_auto_training(
            trigger=request.trigger if request.trigger in {"AUTO_NEW_DATA", "SCHEDULED", "MANUAL"} else "MANUAL",
            horizons=request.horizons,
            force_symbols=request.force_symbols,
        )
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"AUTO_TRAINING_FAILED: {error}") from error
    finally:
        _train_lock.release()


@app.post("/train/stale")
def train_stale(request: TrainRequest):
    import auto_train

    if not _train_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail={"code": "TRAINING_IN_PROGRESS", "message": "Another training run is already active."})
    try:
        return auto_train.retrain_all_stale(request.horizons)
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"AUTO_TRAINING_FAILED: {error}") from error
    finally:
        _train_lock.release()


@app.post("/train/{symbol}")
def train_symbol(symbol: str, horizon: str = DEFAULT_HORIZON):
    import auto_train

    clean = symbol.strip().upper()
    if not clean or len(clean) > 32:
        raise HTTPException(status_code=400, detail="INVALID_SYMBOL")
    if not _train_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail={"code": "TRAINING_IN_PROGRESS", "message": "Another training run is already active."})
    try:
        return auto_train.train_single_symbol(clean, horizon, trigger="MANUAL")
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"TRAINING_FAILED: {error}") from error
    finally:
        _train_lock.release()


def _scheduler_loop() -> None:
    """Background cadence, decoupled from prediction polls. Never overlaps a
    manual/auto HTTP run because it shares the same training lock."""
    def _run(reason: str) -> None:
        if not _train_lock.acquire(blocking=False):
            print(f"[auto-train] skipped {reason}: another run active", flush=True)
            return
        try:
            import auto_train

            report = auto_train.run_auto_training(trigger="SCHEDULED", horizons=AUTO_TRAIN_HORIZONS)
            print(f"[auto-train] {reason} run {report['training_run_id']}: {report['summary']}", flush=True)
        except Exception as error:
            print(f"[auto-train] {reason} run failed: {error}", flush=True)
        finally:
            _train_lock.release()

    interval_seconds = AUTO_TRAIN_INTERVAL_HOURS * 3600.0
    if AUTO_TRAIN_ON_STARTUP:
        _run("startup")
    while True:
        time.sleep(interval_seconds)
        _run("scheduled")


if AUTO_TRAIN_ENABLED:
    Thread(target=_scheduler_loop, name="auto-train-scheduler", daemon=True).start()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("ML_PORT", "4300")))
