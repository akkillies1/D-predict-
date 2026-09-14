"""Independent OOS calibration checks for target and stop probabilities.

The evaluator consumes already-realized executable events. It never constructs
probabilities from the same outcome it is scoring, and it never changes target
levels to improve calibration. It is intentionally a scoring/gating primitive,
not a tuning routine.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

_REQUIRED = {
    "prediction_time",
    "entry_time",
    "direction",
    "target_1_probability",
    "target_1_reached",
    "target_2_probability",
    "target_2_reached",
    "target_3_probability",
    "target_3_reached",
    "stop_probability",
    "stop_hit",
}


def _validate(frame: pd.DataFrame) -> pd.DataFrame:
    missing = _REQUIRED - set(frame.columns)
    if missing:
        raise ValueError(f"calibration ledger missing columns: {sorted(missing)}")
    result = frame.copy()
    for column in ("prediction_time", "entry_time"):
        result[column] = pd.to_datetime(result[column], utc=True)
    if (result["entry_time"] <= result["prediction_time"]).any():
        raise ValueError("entry_time must be strictly after prediction_time")
    for column in (
        "target_1_probability", "target_2_probability", "target_3_probability", "stop_probability",
    ):
        result[column] = pd.to_numeric(result[column], errors="coerce")
        if result[column].isna().any() or ((result[column] < 0) | (result[column] > 1)).any():
            raise ValueError(f"{column} must contain probabilities in [0, 1]")
    for column in ("target_1_reached", "target_2_reached", "target_3_reached", "stop_hit"):
        if result[column].isna().any():
            raise ValueError(f"{column} cannot be null in the independent calibration set")
        result[column] = result[column].astype(bool)
    if result.duplicated(subset=["prediction_time", "entry_time"]).any():
        raise ValueError("calibration events must be unique by prediction and entry time")
    return result.sort_values(["prediction_time", "entry_time"]).reset_index(drop=True)


def _score(probability: pd.Series, reached: pd.Series) -> dict:
    p = probability.to_numpy(dtype=float)
    y = reached.to_numpy(dtype=float)
    if len(p) == 0:
        return {"examples": 0, "mean_predicted_probability": None, "hit_rate": None, "brier": None, "calibration_gap": None}
    return {
        "examples": int(len(p)),
        "mean_predicted_probability": round(float(p.mean()), 6),
        "hit_rate": round(float(y.mean()), 6),
        "brier": round(float(np.mean((p - y) ** 2)), 6),
        "calibration_gap": round(float(abs(p.mean() - y.mean())), 6),
    }


def evaluate(frame: pd.DataFrame) -> dict:
    """Score fixed target/stop probabilities on an untouched realized set."""
    data = _validate(frame)
    targets = {
        "target_1": _score(data["target_1_probability"], data["target_1_reached"]),
        "target_2": _score(data["target_2_probability"], data["target_2_reached"]),
        "target_3": _score(data["target_3_probability"], data["target_3_reached"]),
        "stop": _score(data["stop_probability"], data["stop_hit"]),
    }
    return {
        "examples": int(len(data)),
        "targets": targets,
        "promotion": "NONE",
        "note": "Independent scoring only. No target/stop probability is retuned from these outcomes.",
    }


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Score target/stop probabilities on an independent realized event ledger")
    parser.add_argument("ledger", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = evaluate(pd.read_csv(args.ledger))
    text = json.dumps(report, indent=2)
    if args.output:
        args.output.write_text(text, encoding="utf-8")
    print(text)


if __name__ == "__main__":
    main()
