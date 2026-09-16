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

from training.build_dataset import FEATURE_SET_VERSION, make_features

FEATURE_COLUMNS = [
    "return_1", "return_5", "return_20", "sma5_ratio", "sma20_ratio", "sma50_ratio",
    "ema12_ratio", "ema26_ratio", "ema_spread", "rsi14", "atr14_pct", "volatility20",
    "volume_z20", "day_of_week",
]
CLASS_NAMES = ["DOWN", "FLAT", "UP"]
CLASS_MAP = {"DOWN": 0, "FLAT": 1, "UP": 2}
HORIZON = "1d"
PURGE_ROWS = 1
MIN_HISTORY = 300
MIN_CALIBRATION_HISTORY = 100
DB_URL = os.environ.get("DATABASE_URL")

app = FastAPI(title="D-Predict ML Inference", version="1.0")
_cache: dict[str, "ModelBundle"] = {}
_cache_lock = Lock()


class PredictRequest(BaseModel):
    symbol: str
    as_of: str | None = None


@dataclass
class ModelBundle:
    classifier: HistGradientBoostingClassifier
    regressor: HistGradientBoostingRegressor
    calibrators: list[IsotonicRegression | None]
    calibrated: bool
    training_end: pd.Timestamp
    validation_examples: int
    calibration_examples: int
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


def _training_frame(raw: pd.DataFrame) -> pd.DataFrame:
    features = make_features(raw)
    target = raw["close"].shift(-1) / raw["close"] - 1
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


def _walk_forward(frame: pd.DataFrame, folds: int = 5) -> tuple[np.ndarray, np.ndarray, int]:
    min_train = max(200, len(frame) // (folds + 2))
    remaining = len(frame) - min_train
    block = max(1, remaining // folds)
    raw_probs: list[np.ndarray] = []
    actual: list[int] = []
    for fold in range(folds):
        train_end = min_train + fold * block
        valid_start = min(len(frame) - 1, train_end + PURGE_ROWS)
        valid_end = min(len(frame), valid_start + block)
        if valid_end <= valid_start:
            continue
        train = frame.iloc[:train_end]
        valid = frame.iloc[valid_start:valid_end]
        clf = _classifier()
        clf.fit(train[FEATURE_COLUMNS], train["target_class"].map(CLASS_MAP))
        raw_probs.append(clf.predict_proba(valid[FEATURE_COLUMNS]))
        actual.extend(valid["target_class"].map(CLASS_MAP).astype(int).tolist())
    if not raw_probs:
        raise HTTPException(status_code=503, detail="Walk-forward validation produced no OOS rows")
    return np.vstack(raw_probs), np.asarray(actual, dtype=int), int(sum(len(x) for x in raw_probs))


def _fit_bundle(symbol: str, frame: pd.DataFrame) -> ModelBundle:
    raw_probs, actual, oos_examples = _walk_forward(frame)
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

    clf = _classifier()
    clf.fit(frame[FEATURE_COLUMNS], frame["target_class"].map(CLASS_MAP))
    reg = _regressor()
    reg.fit(frame[FEATURE_COLUMNS], frame["target_return"])
    training_end = pd.Timestamp(frame.index.max()).tz_convert("UTC")
    signature = hashlib.sha256(
        (symbol.upper() + "|" + HORIZON + "|" + FEATURE_SET_VERSION + "|" + training_end.isoformat()
         + "|histgb:lr=.05,max_iter=250,max_leaf_nodes=15,l2=1,seed=42|cal="
         + ("isotonic" if calibrated else "raw") + "|features=" + ",".join(FEATURE_COLUMNS)).encode()
    ).hexdigest()[:12]
    return ModelBundle(
        classifier=clf, regressor=reg, calibrators=calibrators, calibrated=calibrated,
        training_end=training_end, validation_examples=oos_examples,
        calibration_examples=oos_examples if calibrated else 0,
        model_version=f"market-v1-{HORIZON}-histgb-{signature}",
    )


def _get_bundle(symbol: str, frame: pd.DataFrame) -> ModelBundle:
    key = symbol.upper()
    training_end = pd.Timestamp(frame.index.max()).tz_convert("UTC")
    with _cache_lock:
        current = _cache.get(key)
        if current and current.training_end == training_end:
            return current
        bundle = _fit_bundle(key, frame)
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
    return {"ok": True, "service": "ml-inference", "feature_set_version": FEATURE_SET_VERSION, "model_horizon": HORIZON}


@app.post("/predict")
def predict(request: PredictRequest):
    symbol = request.symbol.strip().upper()
    if not symbol or len(symbol) > 32:
        raise HTTPException(status_code=400, detail="INVALID_SYMBOL")
    as_of = pd.Timestamp(request.as_of).tz_convert("UTC") if request.as_of else None
    raw = _load_daily(symbol, as_of)
    frame = _training_frame(raw)
    bundle = _get_bundle(symbol, frame)

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

    return {
        "ok": True, "symbol": symbol, "timestamp": latest_timestamp.isoformat(), "horizon": HORIZON,
        "prediction": prediction,
        "probabilities": {"DOWN": float(probs[0]), "FLAT": float(probs[1]), "UP": float(probs[2])},
        "raw_probabilities": {"DOWN": float(raw_probs[0]), "FLAT": float(raw_probs[1]), "UP": float(raw_probs[2])},
        "expected_return": expected_return, "confidence": confidence,
        "calibration_status": "CALIBRATED" if bundle.calibrated else "UNCALIBRATED",
        "model_version": bundle.model_version, "feature_set_version": FEATURE_SET_VERSION,
        "training_cutoff": bundle.training_end.isoformat(),
        "validation_oos_examples": bundle.validation_examples, "calibration_examples": bundle.calibration_examples,
        "features": {column: float(latest.iloc[0][column]) for column in FEATURE_COLUMNS},
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("ML_PORT", "4300")))
