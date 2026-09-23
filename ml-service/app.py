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
from dataclasses import dataclass
from pathlib import Path
from threading import Lock

import joblib
import numpy as np
import pandas as pd
import psycopg2
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import accuracy_score, brier_score_loss, log_loss

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

app = FastAPI(title="D-Predict ML Inference", version="1.0")
_cache: dict[str, tuple[float, "ModelBundle"]] = {}
_cache_lock = Lock()


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


def _walk_forward(frame: pd.DataFrame, purge_rows: int, folds: int = 5) -> tuple[np.ndarray, np.ndarray, int, np.ndarray, np.ndarray]:
    min_train = max(200, len(frame) // (folds + 2))
    remaining = len(frame) - min_train
    block = max(1, remaining // folds)
    raw_probs: list[np.ndarray] = []
    actual: list[int] = []
    predicted_returns: list[float] = []
    actual_returns: list[float] = []
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
    if not raw_probs:
        raise HTTPException(status_code=503, detail="Walk-forward validation produced no OOS rows")
    residuals = np.asarray(actual_returns, dtype=float) - np.asarray(predicted_returns, dtype=float)
    return np.vstack(raw_probs), np.asarray(actual, dtype=int), int(sum(len(x) for x in raw_probs)), np.asarray(predicted_returns), residuals


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


def _action_gate(prediction: str, probabilities: np.ndarray, expected_return: float, promotion_ready: bool, probability_net_positive: float = 1.0, round_trip_cost: float = ROUND_TRIP_COST) -> dict:
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
    if reasons:
        return {"status": "WATCH_LOW_EDGE", "reasons": reasons, "probability_margin": margin}
    return {"status": "ACTIONABLE_LONG" if prediction == "UP" else "ACTIONABLE_SHORT", "reasons": ["CONFIDENCE_MARGIN_AND_NET_EDGE_CLEAR"], "probability_margin": margin}


def _fit_bundle(symbol: str, frame: pd.DataFrame, horizon: str) -> ModelBundle:
    raw_probs, actual, oos_examples, _, residuals = _walk_forward(frame, SUPPORTED_HORIZONS[horizon])
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

    clf = _classifier()
    clf.fit(frame[FEATURE_COLUMNS], frame["target_class"].map(CLASS_MAP))
    reg = _regressor()
    reg.fit(frame[FEATURE_COLUMNS], frame["target_return"])
    training_end = pd.Timestamp(frame.index.max()).tz_convert("UTC")
    signature = hashlib.sha256(
        (symbol.upper() + "|" + horizon + "|" + FEATURE_SET_VERSION + "|" + training_end.isoformat()
         + "|histgb:lr=.05,max_iter=250,max_leaf_nodes=15,l2=1,seed=42|cal="
         + ("isotonic" if calibration_verified else "raw") + "|features=" + ",".join(FEATURE_COLUMNS)).encode()
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
    action = _action_gate(prediction, probs, expected_return, bundle.promotion_ready, probability_net_positive)

    return {
        "ok": True, "symbol": symbol, "timestamp": latest_timestamp.isoformat(), "horizon": horizon,
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
        "model_version": bundle.model_version, "feature_set_version": FEATURE_SET_VERSION,
        "training_cutoff": bundle.training_end.isoformat(),
        "validation_oos_examples": bundle.validation_examples, "calibration_examples": bundle.calibration_examples,
        "features": {column: float(latest.iloc[0][column]) for column in FEATURE_COLUMNS},
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("ML_PORT", "4300")))
