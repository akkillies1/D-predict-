"""Train a conservative meta-model over out-of-sample model predictions.

The meta layer accepts any available predictor probabilities. Event probability
can be added later when enough historically timestamped event labels exist.
If only the market model is present, this acts as a calibration/quality gate.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, balanced_accuracy_score, log_loss
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline

ROOT = Path(__file__).resolve().parents[1]
PRED_DIR = ROOT / "data" / "predictions"
MODEL_DIR = ROOT / "models"


def load_predictions(symbol: str, horizon: str) -> pd.DataFrame:
    path = PRED_DIR / f"{symbol.lower()}_{horizon}_walk_forward.csv"
    if not path.exists():
        raise FileNotFoundError(f"Missing {path}; run walk_forward.py first")
    return pd.read_csv(path, parse_dates=["timestamp"]).sort_values("timestamp").reset_index(drop=True)


def train(symbol: str, horizon: str, test_fraction: float) -> dict:
    df = load_predictions(symbol, horizon)
    feature_candidates = [
        "market_probability_down", "market_probability_flat", "market_probability_up",
        "event_probability_down", "event_probability_flat", "event_probability_up",
        "regime_confidence", "novelty_score",
    ]
    features = [col for col in feature_candidates if col in df.columns]
    if len(features) < 3:
        raise RuntimeError("Meta model needs at least the market probability columns")
    df = df.dropna(subset=features + ["actual"]).copy()
    classes = {"DOWN": 0, "FLAT": 1, "UP": 2}
    X = df[features]
    y = df["actual"].map(classes)
    split = max(1, int(len(df) * (1 - test_fraction)))
    train_x, test_x = X.iloc[:split], X.iloc[split:]
    train_y, test_y = y.iloc[:split], y.iloc[split:]
    if len(test_x) < 25:
        raise RuntimeError("Too little final test data for meta-model")

    model = make_pipeline(
        StandardScaler(),
        LogisticRegression(max_iter=1000, multi_class="auto", C=0.5, random_state=42),
    )
    model.fit(train_x, train_y)
    pred = model.predict(test_x)
    proba = model.predict_proba(test_x)
    metrics = {
        "symbol": symbol.upper(),
        "horizon": horizon,
        "features": features,
        "examples": len(df),
        "train_examples": len(train_x),
        "test_examples": len(test_x),
        "accuracy": round(float(accuracy_score(test_y, pred)), 6),
        "balanced_accuracy": round(float(balanced_accuracy_score(test_y, pred)), 6),
        "log_loss": round(float(log_loss(test_y, proba, labels=[0, 1, 2])), 6),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "model": "logistic-meta-calibrator",
    }
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    path = MODEL_DIR / f"{symbol.lower()}_{horizon}_meta_v1.joblib"
    joblib.dump({"model": model, "features": features, "classes": ["DOWN", "FLAT", "UP"]}, path)
    (MODEL_DIR / f"{symbol.lower()}_{horizon}_meta_v1.metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    print(json.dumps(metrics, indent=2))
    return metrics


def main() -> None:
    parser = argparse.ArgumentParser(description="Train D-Predict meta-calibration layer")
    parser.add_argument("--symbols", nargs="+", default=["NIFTY", "BANKNIFTY"])
    parser.add_argument("--horizons", nargs="+", default=["1d", "3d", "5d"])
    parser.add_argument("--test-fraction", type=float, default=0.2)
    args = parser.parse_args()
    for symbol in args.symbols:
        for horizon in args.horizons:
            train(symbol.upper(), horizon, args.test_fraction)


if __name__ == "__main__":
    main()
