"""Leakage-safe probability calibration for OOS class forecasts.

Calibration data must be strictly prior to the prediction being calibrated.
The module fits a lightweight calibrator per chronological fold and scores the
calibrated probabilities on later observations. It never calibrates on the
same rows whose probabilities it reports.
"""
from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import brier_score_loss, log_loss

CLASSES = ("DOWN", "FLAT", "UP")
PROBABILITY_COLUMNS = {
    "DOWN": "market_probability_down",
    "FLAT": "market_probability_flat",
    "UP": "market_probability_up",
}


@dataclass(frozen=True)
class CalibrationConfig:
    min_history: int = 100
    method: str = "isotonic"

    def validate(self) -> None:
        if self.min_history < 10:
            raise ValueError("min_history must be at least 10")
        if self.method != "isotonic":
            raise ValueError("only isotonic calibration is currently supported")


def _validate(frame: pd.DataFrame) -> pd.DataFrame:
    required = {"timestamp", "prediction", "realized_class", "outcome_status", *PROBABILITY_COLUMNS.values()}
    missing = sorted(required - set(frame.columns))
    if missing:
        raise ValueError(f"ledger is missing columns: {', '.join(missing)}")
    frame = frame.copy()
    frame["timestamp"] = pd.to_datetime(frame["timestamp"], utc=True, errors="raise")
    if "symbol" in frame.columns:
        key = ["timestamp", "symbol"]
    else:
        key = ["timestamp"]
    if frame.duplicated(key).any():
        raise ValueError(f"calibration keys must be unique: {key}")
    if not frame["prediction"].isin(CLASSES).all() or not frame["realized_class"].isin(CLASSES).all():
        raise ValueError("invalid prediction or realized class")
    probabilities = frame[list(PROBABILITY_COLUMNS.values())].apply(pd.to_numeric, errors="coerce")
    if probabilities.isna().any().any() or (probabilities < 0).any().any() or (probabilities > 1).any().any():
        raise ValueError("probabilities must be numeric and between 0 and 1")
    if ((probabilities.sum(axis=1) - 1).abs() > 1e-6).any():
        raise ValueError("probabilities must sum to 1")
    scored = frame[frame["outcome_status"].eq("SCORED")].copy()
    if scored.empty:
        raise ValueError("ledger contains no scored outcomes")
    return scored.sort_values("timestamp").reset_index(drop=True)


def _fit_prior(history: pd.DataFrame, config: CalibrationConfig) -> list[IsotonicRegression | None]:
    calibrators: list[IsotonicRegression | None] = []
    for cls in CLASSES:
        raw = history[PROBABILITY_COLUMNS[cls]].to_numpy(float)
        y = (history["realized_class"] == cls).astype(float).to_numpy()
        if len(history) < config.min_history or len(np.unique(raw)) < 2 or len(np.unique(y)) < 2:
            calibrators.append(None)
            continue
        calibrator = IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds="clip")
        calibrator.fit(raw, y)
        calibrators.append(calibrator)
    return calibrators


def calibrate_oos(frame: pd.DataFrame, config: CalibrationConfig = CalibrationConfig()) -> pd.DataFrame:
    config.validate()
    scored = _validate(frame)
    rows: list[dict] = []
    for i, row in scored.iterrows():
        history = scored.iloc[:i]
        calibrators = _fit_prior(history, config)
        raw = np.array([row[PROBABILITY_COLUMNS[c]] for c in CLASSES], dtype=float)
        if any(calibrator is None for calibrator in calibrators):
            calibrated = raw.copy()
            status = "UNCALIBRATED"
        else:
            calibrated = np.array([calibrators[j].predict([raw[j]])[0] for j in range(3)])
            total = calibrated.sum()
            calibrated = calibrated / total if total > 0 else raw
            status = "CALIBRATED"
        output = row.to_dict()
        for cls, value in zip(CLASSES, calibrated):
            output[f"calibrated_probability_{cls.lower()}"] = float(value)
        output["calibration_status"] = status
        output["calibration_history_examples"] = int(len(history))
        rows.append(output)
    return pd.DataFrame(rows)


def score_calibration(calibrated: pd.DataFrame) -> dict:
    scored = calibrated[calibrated["calibration_status"].eq("CALIBRATED")].copy()
    if scored.empty:
        return {"examples": 0, "calibration_status": "INSUFFICIENT_HISTORY"}
    y = scored["realized_class"]
    probs = scored[[f"calibrated_probability_{c.lower()}" for c in CLASSES]].to_numpy(float)
    mapping = {cls: i for i, cls in enumerate(CLASSES)}
    y_idx = y.map(mapping).to_numpy()
    logloss = float(log_loss(y_idx, probs, labels=[0, 1, 2]))
    brier = float(np.mean([brier_score_loss((y == cls).astype(int), probs[:, i]) for i, cls in enumerate(CLASSES)]))
    confidence = probs.max(axis=1)
    correct = (probs.argmax(axis=1) == y_idx).astype(float)
    calibration_gap = float(abs(confidence.mean() - correct.mean()))
    return {
        "examples": int(len(scored)),
        "log_loss": round(logloss, 6),
        "multiclass_brier": round(brier, 6),
        "mean_confidence": round(float(confidence.mean()), 6),
        "empirical_accuracy": round(float(correct.mean()), 6),
        "calibration_gap": round(calibration_gap, 6),
        "calibration_status": "CALIBRATED",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Leakage-safe OOS probability calibration")
    parser.add_argument("ledger", type=Path)
    parser.add_argument("--min-history", type=int, default=100)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    calibrated = calibrate_oos(pd.read_csv(args.ledger), CalibrationConfig(min_history=args.min_history))
    report = score_calibration(calibrated)
    payload = json.dumps(report, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload + "\n", encoding="utf-8")
    print(payload)


if __name__ == "__main__":
    main()
