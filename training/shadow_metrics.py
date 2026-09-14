"""Rolling evaluation metrics for live shadow sessions.

This module consumes persisted live-shadow predictions only. It never changes
prediction outcomes and never uses future observations to score an unresolved
prediction.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import pandas as pd


BUCKETS = ((0.0, 0.4), (0.4, 0.5), (0.5, 0.6), (0.6, 0.7), (0.7, 1.000001))


def _bucket(confidence: float) -> str:
    for low, high in BUCKETS:
        if low <= confidence < high:
            return f"{low:.2f}-{min(high, 1.0):.2f}"
    return "unknown"


def _metrics(rows: list[dict[str, Any]]) -> dict[str, Any]:
    scored = [row for row in rows if row.get("outcome_status") == "SCORED"]
    if not scored:
        return {
            "examples": 0,
            "accuracy": None,
            "directional_accuracy": None,
            "directional_calls": 0,
            "mean_confidence": None,
            "brier_score": None,
            "calibration_gap": None,
        }

    correct = sum(row["prediction"] == row["realized_class"] for row in scored)
    directional = [row for row in scored if row["prediction"] in {"UP", "DOWN"}]
    directional_correct = sum(row["prediction"] == row["realized_class"] for row in directional)
    brier = sum(
        sum((float(row[column]) - (1.0 if label == row["realized_class"] else 0.0)) ** 2 for column, label in (
            ("market_probability_down", "DOWN"),
            ("market_probability_flat", "FLAT"),
            ("market_probability_up", "UP"),
        ))
        for row in scored
    ) / len(scored)
    mean_confidence = sum(float(row["prediction_confidence"]) for row in scored) / len(scored)
    calibration_gap = abs(correct / len(scored) - mean_confidence)
    return {
        "examples": len(scored),
        "accuracy": correct / len(scored),
        "directional_accuracy": directional_correct / len(directional) if directional else None,
        "directional_calls": len(directional),
        "mean_confidence": mean_confidence,
        "brier_score": brier,
        "calibration_gap": calibration_gap,
    }


def analyze(state: dict[str, Any], window: int = 100) -> dict[str, Any]:
    if window < 1:
        raise ValueError("window must be positive")
    predictions = sorted(state.get("predictions", []), key=lambda row: row["timestamp"])
    scored = [row for row in predictions if row.get("outcome_status") == "SCORED"]
    recent = scored[-window:]
    overall = _metrics(scored)
    rolling = _metrics(recent)

    calibration_buckets: list[dict[str, Any]] = []
    for low, high in BUCKETS:
        bucket_rows = [
            row for row in recent
            if low <= float(row["prediction_confidence"]) < high
        ]
        if bucket_rows:
            accuracy = sum(row["prediction"] == row["realized_class"] for row in bucket_rows) / len(bucket_rows)
            confidence = sum(float(row["prediction_confidence"]) for row in bucket_rows) / len(bucket_rows)
            calibration_buckets.append({
                "bucket": f"{low:.2f}-{min(high, 1.0):.2f}",
                "examples": len(bucket_rows),
                "confidence": confidence,
                "accuracy": accuracy,
                "gap": abs(accuracy - confidence),
            })
        else:
            calibration_buckets.append({
                "bucket": f"{low:.2f}-{min(high, 1.0):.2f}",
                "examples": 0,
                "confidence": None,
                "accuracy": None,
                "gap": None,
            })

    return {
        "mode": "LIVE_SHADOW_METRICS",
        "session_id": state.get("session_id"),
        "overall": overall,
        "rolling": rolling,
        "rolling_window": window,
        "calibration": calibration_buckets,
        "pending_predictions": sum(row.get("outcome_status") == "PENDING" for row in predictions),
        "virtual_equity": state.get("virtual_equity"),
        "virtual_return": state.get("virtual_equity", 0) / state.get("initial_capital", 1) - 1,
        "max_drawdown": state.get("max_drawdown"),
        "live_orders_sent": 0,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Analyze a persisted D-Predict live-shadow session")
    parser.add_argument("state", type=Path)
    parser.add_argument("--window", type=int, default=100)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    state = json.loads(args.state.read_text(encoding="utf-8"))
    result = analyze(state, args.window)
    payload = json.dumps(result, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload + "\n", encoding="utf-8")
    print(payload)


if __name__ == "__main__":
    main()
