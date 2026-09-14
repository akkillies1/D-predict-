"""Untouched temporal holdout evaluator for final model promotion.

The holdout is deliberately boring: the caller supplies a development OOS
ledger and a later holdout ledger. This module never retrains, retunes, or
moves thresholds. It verifies temporal separation and evaluates the holdout
once, after development gates have already been satisfied.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd
from sklearn.metrics import accuracy_score, balanced_accuracy_score, log_loss

from .train_baseline import CLASS_MAP

PROBABILITY_COLUMNS = [
    "market_probability_down",
    "market_probability_flat",
    "market_probability_up",
]


def _load(path: Path) -> pd.DataFrame:
    frame = pd.read_csv(path)
    required = {"timestamp", "prediction", "realized_class", "outcome_status", *PROBABILITY_COLUMNS}
    missing = sorted(required - set(frame.columns))
    if missing:
        raise ValueError(f"holdout ledger is missing columns: {', '.join(missing)}")
    frame["timestamp"] = pd.to_datetime(frame["timestamp"], utc=True, errors="raise")
    if frame["timestamp"].duplicated().any():
        # Different instruments may share a timestamp; preserve that valid case.
        key = ["timestamp"] + (["symbol"] if "symbol" in frame.columns else [])
        if frame.duplicated(key).any():
            raise ValueError(f"holdout prediction keys must be unique: {key}")
    allowed = set(CLASS_MAP)
    if not frame["prediction"].isin(allowed).all() or not frame["realized_class"].isin(allowed).all():
        raise ValueError("holdout prediction/outcome classes are invalid")
    probabilities = frame[PROBABILITY_COLUMNS].apply(pd.to_numeric, errors="coerce")
    if probabilities.isna().any().any() or (probabilities < 0).any().any() or (probabilities > 1).any().any():
        raise ValueError("holdout probabilities must be numeric and between 0 and 1")
    if ((probabilities.sum(axis=1) - 1).abs() > 1e-6).any():
        raise ValueError("holdout probabilities must sum to 1")
    return frame.sort_values("timestamp").reset_index(drop=True)


def evaluate_holdout(development_path: Path, holdout_path: Path, *, min_examples: int = 100) -> dict:
    development = _load(development_path)
    holdout = _load(holdout_path)
    dev_scored = development[development["outcome_status"].eq("SCORED")]
    test = holdout[holdout["outcome_status"].eq("SCORED")].copy()
    if test.empty:
        raise ValueError("holdout ledger contains no scored outcomes")
    development_end = dev_scored["timestamp"].max() if not dev_scored.empty else development["timestamp"].max()
    holdout_start = test["timestamp"].min()
    if holdout_start <= development_end:
        raise ValueError("holdout must begin strictly after development data")

    y_true = test["realized_class"].map(CLASS_MAP).astype(int)
    y_pred = test["prediction"].map(CLASS_MAP).astype(int)
    proba = test[PROBABILITY_COLUMNS].to_numpy(dtype=float)
    accuracy = float(accuracy_score(y_true, y_pred))
    baseline = float(test["realized_class"].value_counts(normalize=True).max())
    directional = test[test["realized_class"].isin(["UP", "DOWN"])]
    directional_calls = directional[directional["prediction"].isin(["UP", "DOWN"])]
    directional_accuracy = None if directional_calls.empty else float(
        (directional_calls["prediction"] == directional_calls["realized_class"]).mean()
    )
    return {
        "development_file": str(development_path),
        "holdout_file": str(holdout_path),
        "development_end": development_end.isoformat(),
        "holdout_start": holdout_start.isoformat(),
        "examples": int(len(test)),
        "minimum_examples": min_examples,
        "minimum_examples_pass": len(test) >= min_examples,
        "accuracy": round(accuracy, 6),
        "balanced_accuracy": round(float(balanced_accuracy_score(y_true, y_pred)), 6),
        "majority_baseline_accuracy": round(baseline, 6),
        "accuracy_lift_vs_majority": round(accuracy - baseline, 6),
        "log_loss": round(float(log_loss(y_true, proba, labels=[0, 1, 2])), 6),
        "directional_accuracy": None if directional_accuracy is None else round(directional_accuracy, 6),
        "evaluated_once": True,
        "retuning_performed": False,
        "promotion": "HOLDOUT_ONLY" if len(test) >= min_examples else "INSUFFICIENT_HOLDOUT",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate an untouched temporal holdout")
    parser.add_argument("development_ledger", type=Path)
    parser.add_argument("holdout_ledger", type=Path)
    parser.add_argument("--min-examples", type=int, default=100)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = evaluate_holdout(args.development_ledger, args.holdout_ledger, min_examples=args.min_examples)
    payload = json.dumps(result, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload + "\n", encoding="utf-8")
    print(payload)


if __name__ == "__main__":
    main()
