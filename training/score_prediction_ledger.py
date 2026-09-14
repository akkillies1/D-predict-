"""Score strictly out-of-sample prediction ledgers.

The scorer deliberately separates raw accuracy from useful predictive quality:
- multiclass accuracy and balanced accuracy;
- directional accuracy for UP/DOWN calls, excluding FLAT;
- log loss and multiclass Brier score for probability quality;
- majority-class baseline and accuracy lift;
- per-fold and per-horizon summaries.

Input is expected to be produced by ``walk_forward.py``. It must contain
out-of-sample predictions and the realized target for each prediction.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd
from sklearn.metrics import (
    accuracy_score,
    balanced_accuracy_score,
    brier_score_loss,
    log_loss,
    precision_recall_fscore_support,
)

from .train_baseline import CLASS_MAP

ROOT = Path(__file__).resolve().parents[1]
PRED_DIR = ROOT / "data" / "predictions"
PROBABILITY_COLUMNS = [
    "market_probability_down",
    "market_probability_flat",
    "market_probability_up",
]


def _validate(frame: pd.DataFrame) -> None:
    required = {
        "symbol", "horizon", "fold", "prediction", "actual",
        *PROBABILITY_COLUMNS,
    }
    missing = sorted(required - set(frame.columns))
    if missing:
        raise ValueError(f"prediction ledger is missing columns: {', '.join(missing)}")
    if frame.empty:
        raise ValueError("prediction ledger is empty")
    allowed = set(CLASS_MAP)
    for column in ("prediction", "actual"):
        values = set(frame[column].dropna().astype(str))
        unknown = sorted(values - allowed)
        if unknown:
            raise ValueError(f"unknown {column} values: {unknown}")
    probabilities = frame[PROBABILITY_COLUMNS].apply(pd.to_numeric, errors="coerce")
    if probabilities.isna().any().any():
        raise ValueError("prediction probabilities contain missing/non-numeric values")
    if (probabilities < 0).any().any() or (probabilities > 1).any().any():
        raise ValueError("prediction probabilities must be between 0 and 1")
    if ((probabilities.sum(axis=1) - 1).abs() > 1e-6).any():
        raise ValueError("prediction probabilities must sum to 1")


def _score(frame: pd.DataFrame) -> dict:
    _validate(frame)
    y_true = frame["actual"].map(CLASS_MAP).astype(int)
    y_pred = frame["prediction"].map(CLASS_MAP).astype(int)
    proba = frame[PROBABILITY_COLUMNS].to_numpy(dtype=float)

    majority_accuracy = float(frame["actual"].value_counts(normalize=True).max())
    accuracy = float(accuracy_score(y_true, y_pred))

    directional = frame[frame["actual"].isin(["UP", "DOWN"])]
    directional_calls = directional[directional["prediction"].isin(["UP", "DOWN"])]
    if directional_calls.empty:
        directional_accuracy = None
        directional_coverage = 0.0
    else:
        directional_accuracy = float(
            (directional_calls["prediction"] == directional_calls["actual"]).mean()
        )
        directional_coverage = float(len(directional_calls) / len(directional)) if len(directional) else 0.0

    precision, recall, f1, _ = precision_recall_fscore_support(
        y_true, y_pred, labels=[0, 1, 2], zero_division=0
    )
    # Multiclass Brier score: mean squared error over the three one-hot class probabilities.
    one_hot = pd.get_dummies(y_true).reindex(columns=[0, 1, 2], fill_value=0).to_numpy(dtype=float)
    brier = float(((proba - one_hot) ** 2).sum(axis=1).mean())

    result = {
        "symbol": str(frame["symbol"].iloc[0]).upper(),
        "horizon": str(frame["horizon"].iloc[0]).lower(),
        "examples": int(len(frame)),
        "folds": int(frame["fold"].nunique()),
        "accuracy": round(accuracy, 6),
        "balanced_accuracy": round(float(balanced_accuracy_score(y_true, y_pred)), 6),
        "majority_baseline_accuracy": round(majority_accuracy, 6),
        "accuracy_lift_vs_majority": round(accuracy - majority_accuracy, 6),
        "directional_accuracy": None if directional_accuracy is None else round(directional_accuracy, 6),
        "directional_coverage": round(directional_coverage, 6),
        "log_loss": round(float(log_loss(y_true, proba, labels=[0, 1, 2])), 6),
        "brier_score": round(brier, 6),
        "precision_down": round(float(precision[0]), 6),
        "precision_flat": round(float(precision[1]), 6),
        "precision_up": round(float(precision[2]), 6),
        "recall_down": round(float(recall[0]), 6),
        "recall_flat": round(float(recall[1]), 6),
        "recall_up": round(float(recall[2]), 6),
        "f1_down": round(float(f1[0]), 6),
        "f1_flat": round(float(f1[1]), 6),
        "f1_up": round(float(f1[2]), 6),
    }
    return result


def score_file(path: Path) -> dict:
    frame = pd.read_csv(path)
    result = _score(frame)
    result["prediction_file"] = str(path)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Score an out-of-sample D-Predict prediction ledger")
    parser.add_argument("paths", nargs="+", type=Path)
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()

    results = [score_file(path) for path in args.paths]
    output = {"results": results}
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
