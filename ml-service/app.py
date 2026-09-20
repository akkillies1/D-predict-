"""Canonical Python ML inference service for D-Predict.

The live engine calls this service instead of maintaining a second TypeScript
signal model. Training and inference both use training.build_dataset.make_features
and the same HistGradientBoosting configuration used by the research pipeline.
Before a production model is exposed, the service runs purge-aware expanding
walk-forward validation and fits isotonic calibration on strictly OOS forecasts.
The final model is then fit only on data available at the latest training cutoff.
"""
from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from threading import Lock

import numpy as np
import pandas as pd
import psycopg2
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import accuracy_score, log_loss

from training.build_dataset import FEATURE_SET_VERSION, make_features

FEATURE_COLUMNS = [
    "return_1", "return_5", "return_20", "sma5_ratio", "sma20_ratio", "sma50_ratio",
    "ema12_ratio", "ema26_ratio", "ema_spread", "rsi14", "atr14_pct", "volatility20",
    "volume_z20", "day_of_week",
]
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
MIN_ACTION_CONFIDENCE = 0.55
MIN_ACTION_MARGIN = 0.10
MIN_NET_EDGE_PROBABILITY = 0.55
ROUND_TRIP_COST = float(os.environ.get("SCANNER_ROUND_TRIP_COST", "0.002"))
DB_URL = os.environ.get("DATABASE_URL")

app = FastAPI(title="D-Predict ML Inference", version="1.0")
_cache: dict[str, "ModelBundle"] = {}
_cache_lock = Lock()


class PredictRequest(BaseModel):
    symbol: str
    as_of: str | None = None
    horizon: str = DEFAULT_HORIZON


@dataclass
class ModelBundle:
    horizon: str
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
    checks = {
        "minimum_examples": examples >= MIN_PROMOTION_EXAMPLES,
        "beats_majority_baseline": accuracy - majority_baseline >= MIN_PROMOTION_ACCURACY_LIFT,
        "probability_quality": probability_log_loss <= MAX_PROMOTION_LOG_LOSS,
        "directional_accuracy": directional_accuracy is not None and directional_accuracy >= MIN_PROMOTION_DIRECTIONAL_ACCURACY,
    }
    return {
        "examples": examples,
        "accuracy": accuracy,
        "majority_baseline": majority_baseline,
        "log_loss": probability_log_loss,
        "directional_accuracy": directional_accuracy,
        "checks": checks,
        "promotion_ready": all(checks.values()),
    }


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
    promotion_ready = promotion["promotion_ready"] and calibrated

    clf = _classifier()
    clf.fit(frame[FEATURE_COLUMNS], frame["target_class"].map(CLASS_MAP))
    reg = _regressor()
    reg.fit(frame[FEATURE_COLUMNS], frame["target_return"])
    training_end = pd.Timestamp(frame.index.max()).tz_convert("UTC")
    signature = hashlib.sha256(
        (symbol.upper() + "|" + horizon + "|" + FEATURE_SET_VERSION + "|" + training_end.isoformat()
         + "|histgb:lr=.05,max_iter=250,max_leaf_nodes=15,l2=1,seed=42|cal="
         + ("isotonic" if calibrated else "raw") + "|features=" + ",".join(FEATURE_COLUMNS)).encode()
    ).hexdigest()[:12]
    return ModelBundle(
        horizon=horizon,
        classifier=clf, regressor=reg, calibrators=calibrators, calibrated=calibrated,
        training_end=training_end, validation_examples=oos_examples,
        calibration_examples=oos_examples if calibrated else 0,
        oos_accuracy=promotion["accuracy"], oos_majority_baseline=promotion["majority_baseline"],
        oos_log_loss=promotion["log_loss"], oos_directional_accuracy=promotion["directional_accuracy"],
        return_residual_quantiles=tuple(float(value) for value in np.quantile(residuals, [0.1, 0.5, 0.9])),
        return_residuals=residuals,
        promotion_ready=promotion_ready,
        model_version=f"market-v1-{horizon}-histgb-{signature}",
    )


def _get_bundle(symbol: str, frame: pd.DataFrame, horizon: str) -> ModelBundle:
    key = f"{symbol.upper()}:{horizon}"
    training_end = pd.Timestamp(frame.index.max()).tz_convert("UTC")
    with _cache_lock:
        current = _cache.get(key)
        if current and current.training_end == training_end:
            return current
        bundle = _fit_bundle(symbol.upper(), frame, horizon)
        _cache[key] = bundle
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
    return {"ok": True, "service": "ml-inference", "feature_set_version": FEATURE_SET_VERSION, "default_horizon": DEFAULT_HORIZON, "supported_horizons": sorted(SUPPORTED_HORIZONS)}


@app.post("/predict")
def predict(request: PredictRequest):
    symbol = request.symbol.strip().upper()
    if not symbol or len(symbol) > 32:
        raise HTTPException(status_code=400, detail="INVALID_SYMBOL")
    horizon = _normalize_horizon(request.horizon)
    as_of = pd.Timestamp(request.as_of).tz_convert("UTC") if request.as_of else None
    raw = _load_daily(symbol, as_of)
    frame = _training_frame(raw, horizon)
    bundle = _get_bundle(symbol, frame, horizon)

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
        "calibration_status": "CALIBRATED" if bundle.calibrated else "UNCALIBRATED",
        "prediction_status": prediction_status,
        "action_status": action["status"], "action_reasons": action["reasons"],
        "promotion_checks": {
            "minimum_examples": bundle.validation_examples >= MIN_PROMOTION_EXAMPLES,
            "beats_majority_baseline": bundle.oos_accuracy - bundle.oos_majority_baseline >= MIN_PROMOTION_ACCURACY_LIFT,
            "probability_quality": bundle.oos_log_loss <= MAX_PROMOTION_LOG_LOSS,
            "directional_accuracy": bundle.oos_directional_accuracy is not None and bundle.oos_directional_accuracy >= MIN_PROMOTION_DIRECTIONAL_ACCURACY,
            "calibration_available": bundle.calibrated,
        },
        "oos_metrics": {
            "accuracy": bundle.oos_accuracy,
            "majority_baseline": bundle.oos_majority_baseline,
            "log_loss": bundle.oos_log_loss,
            "directional_accuracy": bundle.oos_directional_accuracy,
        },
        "model_version": bundle.model_version, "feature_set_version": FEATURE_SET_VERSION,
        "training_cutoff": bundle.training_end.isoformat(),
        "validation_oos_examples": bundle.validation_examples, "calibration_examples": bundle.calibration_examples,
        "features": {column: float(latest.iloc[0][column]) for column in FEATURE_COLUMNS},
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("ML_PORT", "4300")))
