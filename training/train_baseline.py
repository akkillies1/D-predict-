"""Train and evaluate the first D-Predict market model.

This is a deliberately interpretable baseline. It is a benchmark, not a claim
of profitability. The test window is always later than the training window.
"""
from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import joblib
import pandas as pd
from dotenv import load_dotenv
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.metrics import accuracy_score, balanced_accuracy_score, log_loss, mean_absolute_error, mean_squared_error

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data" / "training"
MODEL_DIR = ROOT / "models"
load_dotenv(ROOT / ".env")

FEATURE_COLUMNS = [
    "return_1", "return_5", "return_20", "sma5_ratio", "sma20_ratio", "sma50_ratio",
    "ema12_ratio", "ema26_ratio", "ema_spread", "rsi14", "atr14_pct", "volatility20",
    "volume_z20", "day_of_week",
]
CLASS_MAP = {"DOWN": 0, "FLAT": 1, "UP": 2}
CLASS_NAMES = ["DOWN", "FLAT", "UP"]


def train_one(symbol: str, horizon: str, test_fraction: float) -> dict:
    path = DATA_DIR / f"{symbol.lower()}_{horizon}.csv"
    if not path.exists():
        raise FileNotFoundError(f"Missing {path}; run build_dataset.py first")
    df = pd.read_csv(path, parse_dates=["timestamp"]).sort_values("timestamp")
    df = df.dropna(subset=FEATURE_COLUMNS + ["target_return", "target_class"]).copy()
    if len(df) < 250:
        raise RuntimeError(f"Only {len(df)} examples for {symbol} {horizon}; need at least 250")

    split = max(1, int(len(df) * (1 - test_fraction)))
    train = df.iloc[:split]
    test = df.iloc[split:]
    X_train = train[FEATURE_COLUMNS]
    X_test = test[FEATURE_COLUMNS]
    y_train = train["target_class"].map(CLASS_MAP)
    y_test = test["target_class"].map(CLASS_MAP)

    clf = HistGradientBoostingClassifier(
        learning_rate=0.05,
        max_iter=250,
        max_leaf_nodes=15,
        l2_regularization=1.0,
        random_state=42,
    )
    clf.fit(X_train, y_train)
    pred = clf.predict(X_test)
    proba = clf.predict_proba(X_test)

    reg = HistGradientBoostingRegressor(
        learning_rate=0.05,
        max_iter=250,
        max_leaf_nodes=15,
        l2_regularization=1.0,
        random_state=42,
        loss="squared_error",
    )
    reg.fit(X_train, train["target_return"])
    reg_pred = reg.predict(X_test)

    metrics = {
        "examples": len(df),
        "train_examples": len(train),
        "test_examples": len(test),
        "train_start": train["timestamp"].iloc[0].isoformat(),
        "train_end": train["timestamp"].iloc[-1].isoformat(),
        "test_start": test["timestamp"].iloc[0].isoformat(),
        "test_end": test["timestamp"].iloc[-1].isoformat(),
        "accuracy": round(float(accuracy_score(y_test, pred)), 6),
        "balanced_accuracy": round(float(balanced_accuracy_score(y_test, pred)), 6),
        "log_loss": round(float(log_loss(y_test, proba, labels=[0, 1, 2])), 6),
        "regression_mae": round(float(mean_absolute_error(test["target_return"], reg_pred)), 8),
        "regression_rmse": round(float(mean_squared_error(test["target_return"], reg_pred) ** 0.5), 8),
        "class_distribution": test["target_class"].value_counts(normalize=True).to_dict(),
        "model": "hist-gradient-boosting",
        "feature_set_version": "market-v1",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    prefix = MODEL_DIR / f"{symbol.lower()}_{horizon}_market_v1"
    joblib.dump({"model": clf, "features": FEATURE_COLUMNS, "classes": CLASS_NAMES}, f"{prefix}_classifier.joblib")
    joblib.dump({"model": reg, "features": FEATURE_COLUMNS}, f"{prefix}_regressor.joblib")
    (prefix.with_suffix(".metrics.json")).write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    print(json.dumps(metrics, indent=2))
    return metrics


def main() -> None:
    parser = argparse.ArgumentParser(description="Train the D-Predict market baseline")
    parser.add_argument("--symbols", nargs="+", default=["NIFTY", "BANKNIFTY"])
    parser.add_argument("--horizons", nargs="+", default=["1d", "3d", "5d"])
    parser.add_argument("--test-fraction", type=float, default=0.2)
    args = parser.parse_args()
    if not 0.1 <= args.test_fraction <= 0.4:
        raise SystemExit("--test-fraction must be between 0.1 and 0.4")
    for symbol in args.symbols:
        for horizon in args.horizons:
            train_one(symbol.upper(), horizon, args.test_fraction)


if __name__ == "__main__":
    main()
