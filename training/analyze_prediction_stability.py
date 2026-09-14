"""Analyze OOS prediction confidence, calibration, fold stability, and regimes.

This module consumes the independently realized prediction ledger. Regime labels
are evaluation-only proxies derived from historical closes; they are never fed
back into model training or prediction.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import accuracy_score, balanced_accuracy_score, log_loss

from .train_baseline import CLASS_MAP

PROBABILITY_COLUMNS = [
    "market_probability_down",
    "market_probability_flat",
    "market_probability_up",
]
CONFIDENCE_BINS = [0.0, 0.40, 0.50, 0.60, 0.70, 1.000001]
CONFIDENCE_LABELS = ["<0.40", "0.40-0.50", "0.50-0.60", "0.60-0.70", ">=0.70"]
MIN_BUCKET_EXAMPLES = 10


def _validate(frame: pd.DataFrame) -> None:
    required = {
        "timestamp", "prediction", "realized_class", "realized_return",
        "outcome_status", "fold", *PROBABILITY_COLUMNS,
    }
    missing = sorted(required - set(frame.columns))
    if missing:
        raise ValueError(f"realized ledger is missing columns: {', '.join(missing)}")
    allowed = set(CLASS_MAP)
    bad = set(frame["prediction"].dropna().astype(str)) - allowed
    bad |= set(frame["realized_class"].dropna().astype(str)) - allowed
    if bad:
        raise ValueError(f"unknown prediction/outcome classes: {sorted(bad)}")
    probabilities = frame[PROBABILITY_COLUMNS].apply(pd.to_numeric, errors="coerce")
    if probabilities.isna().any().any():
        raise ValueError("prediction probabilities contain missing/non-numeric values")
    if (probabilities < 0).any().any() or (probabilities > 1).any().any():
        raise ValueError("prediction probabilities must be between 0 and 1")
    if ((probabilities.sum(axis=1) - 1).abs() > 1e-6).any():
        raise ValueError("prediction probabilities must sum to 1")


def _baseline_accuracy(actual: pd.Series) -> float:
    return float(actual.value_counts(normalize=True).max())


def _metrics(frame: pd.DataFrame) -> dict:
    y_true = frame["realized_class"].map(CLASS_MAP).astype(int)
    y_pred = frame["prediction"].map(CLASS_MAP).astype(int)
    proba = frame[PROBABILITY_COLUMNS].to_numpy(dtype=float)
    accuracy = float(accuracy_score(y_true, y_pred))
    baseline = _baseline_accuracy(frame["realized_class"])
    directional = frame[frame["realized_class"].isin(["UP", "DOWN"])]
    directional = directional[directional["prediction"].isin(["UP", "DOWN"])]
    directional_accuracy = None if directional.empty else float(
        (directional["prediction"] == directional["realized_class"]).mean()
    )
    return {
        "examples": int(len(frame)),
        "accuracy": round(accuracy, 6),
        "balanced_accuracy": round(float(balanced_accuracy_score(y_true, y_pred)), 6),
        "majority_baseline_accuracy": round(baseline, 6),
        "accuracy_lift_vs_majority": round(accuracy - baseline, 6),
        "log_loss": round(float(log_loss(y_true, proba, labels=[0, 1, 2])), 6),
        "directional_accuracy": None if directional_accuracy is None else round(directional_accuracy, 6),
        "mean_realized_return": round(float(frame["realized_return"].mean()), 8),
    }


def _confidence_analysis(frame: pd.DataFrame) -> list[dict]:
    data = frame.copy()
    data["confidence"] = data[PROBABILITY_COLUMNS].max(axis=1)
    data["confidence_bucket"] = pd.cut(
        data["confidence"], bins=CONFIDENCE_BINS, labels=CONFIDENCE_LABELS,
        right=False, include_lowest=True,
    )
    output = []
    for label in CONFIDENCE_LABELS:
        bucket = data[data["confidence_bucket"] == label]
        item = {"bucket": label, "examples": int(len(bucket)), "minimum_examples_for_interpretation": MIN_BUCKET_EXAMPLES}
        if len(bucket) >= MIN_BUCKET_EXAMPLES:
            item.update(_metrics(bucket))
            item["interpretable"] = True
            item["mean_confidence"] = round(float(bucket["confidence"].mean()), 6)
        else:
            item["interpretable"] = False
            item["mean_confidence"] = None if bucket.empty else round(float(bucket["confidence"].mean()), 6)
        output.append(item)
    return output


def _calibration(frame: pd.DataFrame) -> list[dict]:
    data = frame.copy()
    data["confidence"] = data[PROBABILITY_COLUMNS].max(axis=1)
    data["correct"] = (data["prediction"] == data["realized_class"]).astype(float)
    bins = pd.cut(data["confidence"], bins=CONFIDENCE_BINS, labels=CONFIDENCE_LABELS, right=False, include_lowest=True)
    output = []
    for label in CONFIDENCE_LABELS:
        bucket = data[bins == label]
        output.append({
            "bucket": label,
            "examples": int(len(bucket)),
            "mean_predicted_confidence": None if bucket.empty else round(float(bucket["confidence"].mean()), 6),
            "empirical_accuracy": None if bucket.empty else round(float(bucket["correct"].mean()), 6),
            "absolute_calibration_gap": None if bucket.empty else round(abs(float(bucket["confidence"].mean()) - float(bucket["correct"].mean())), 6),
        })
    return output


def _fold_stability(frame: pd.DataFrame) -> dict:
    rows = []
    for fold, group in frame.groupby("fold", sort=True):
        metrics = _metrics(group)
        metrics["fold"] = int(fold)
        rows.append(metrics)
    accuracies = [row["accuracy"] for row in rows]
    return {
        "folds": rows,
        "accuracy_mean": None if not accuracies else round(float(np.mean(accuracies)), 6),
        "accuracy_std": None if len(accuracies) < 2 else round(float(np.std(accuracies, ddof=1)), 6),
        "worst_fold_accuracy": None if not accuracies else round(float(min(accuracies)), 6),
        "best_fold_accuracy": None if not accuracies else round(float(max(accuracies)), 6),
    }


def _add_regime_proxy(history_path: Path) -> pd.DataFrame:
    history = pd.read_csv(history_path, parse_dates=["timestamp"])
    required = {"timestamp", "close"}
    missing = sorted(required - set(history.columns))
    if missing:
        raise ValueError(f"historical data is missing columns: {', '.join(missing)}")
    history["timestamp"] = pd.to_datetime(history["timestamp"], utc=True)
    history["close"] = pd.to_numeric(history["close"], errors="coerce")
    history = history.dropna(subset=["timestamp", "close"]).sort_values("timestamp")
    if history["timestamp"].duplicated().any():
        raise ValueError("historical data contains duplicate timestamps")
    if (history["close"] <= 0).any():
        raise ValueError("historical close prices must be positive")
    history["trend_20d"] = history["close"].pct_change(20)
    history["vol_20d"] = history["close"].pct_change().rolling(20).std()
    trend_high = history["trend_20d"].quantile(0.67)
    trend_low = history["trend_20d"].quantile(0.33)
    vol_high = history["vol_20d"].quantile(0.67)
    def label(row: pd.Series) -> str:
        if pd.isna(row["trend_20d"]) or pd.isna(row["vol_20d"]):
            return "UNKNOWN"
        if row["vol_20d"] >= vol_high:
            return "HIGH_VOL"
        if row["trend_20d"] >= trend_high:
            return "BULL_TREND"
        if row["trend_20d"] <= trend_low:
            return "BEAR_TREND"
        return "NORMAL"
    history["evaluation_regime"] = history.apply(label, axis=1)
    return history[["timestamp", "evaluation_regime"]]


def _regime_stability(frame: pd.DataFrame, history_path: Path) -> dict:
    regimes = _add_regime_proxy(history_path)
    data = frame.merge(regimes, on="timestamp", how="left")
    data = data[data["evaluation_regime"] != "UNKNOWN"].copy()
    rows = []
    for regime, group in data.groupby("evaluation_regime", sort=True):
        item = {"regime": regime}
        item.update(_metrics(group))
        item["interpretable"] = len(group) >= MIN_BUCKET_EXAMPLES
        item["minimum_examples_for_interpretation"] = MIN_BUCKET_EXAMPLES
        rows.append(item)
    return {
        "method": "evaluation-only proxy: 20-trading-row trend and volatility quantiles; never used as a model feature",
        "regimes": rows,
    }


def analyze(ledger_path: Path, history_path: Path) -> dict:
    frame = pd.read_csv(ledger_path, parse_dates=["timestamp"])
    frame["timestamp"] = pd.to_datetime(frame["timestamp"], utc=True)
    _validate(frame)
    scored = frame[frame["outcome_status"].eq("SCORED")].copy()
    if scored.empty:
        raise ValueError("realized ledger contains no scored outcomes")
    return {
        "prediction_file": str(ledger_path),
        "history_file": str(history_path),
        "overall": _metrics(scored),
        "confidence_buckets": _confidence_analysis(scored),
        "calibration": _calibration(scored),
        "fold_stability": _fold_stability(scored),
        "regime_stability": _regime_stability(scored, history_path),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Analyze D-predict OOS prediction stability")
    parser.add_argument("ledger", type=Path)
    parser.add_argument("--history", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = analyze(args.ledger, args.history)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
