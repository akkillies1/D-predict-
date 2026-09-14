"""Evaluate whether an OOS prediction ledger is promotion-ready."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd
from sklearn.metrics import accuracy_score, balanced_accuracy_score, log_loss

from .train_baseline import CLASS_MAP

PROBABILITY_COLUMNS = ["market_probability_down", "market_probability_flat", "market_probability_up"]
DEFAULT_MIN_EXAMPLES = 100
DEFAULT_MIN_ACCURACY_LIFT = 0.02
DEFAULT_MAX_LOG_LOSS = 1.05
DEFAULT_MIN_DIRECTIONAL_ACCURACY = 0.52


def _validate(frame: pd.DataFrame) -> None:
    required = {"prediction", "realized_class", "outcome_status", *PROBABILITY_COLUMNS}
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


def evaluate(path: Path, min_examples: int = DEFAULT_MIN_EXAMPLES,
             min_accuracy_lift: float = DEFAULT_MIN_ACCURACY_LIFT,
             max_log_loss: float = DEFAULT_MAX_LOG_LOSS,
             min_directional_accuracy: float = DEFAULT_MIN_DIRECTIONAL_ACCURACY,
             stability_result: dict | None = None) -> dict:
    frame = pd.read_csv(path)
    _validate(frame)
    scored = frame[frame["outcome_status"].eq("SCORED")].copy()
    if scored.empty:
        raise ValueError("realized ledger contains no scored outcomes")
    y_true = scored["realized_class"].map(CLASS_MAP).astype(int)
    y_pred = scored["prediction"].map(CLASS_MAP).astype(int)
    proba = scored[PROBABILITY_COLUMNS].to_numpy(dtype=float)
    accuracy = float(accuracy_score(y_true, y_pred))
    baseline = float(scored["realized_class"].value_counts(normalize=True).max())
    lift = accuracy - baseline
    loss = float(log_loss(y_true, proba, labels=[0, 1, 2]))
    directional = scored[scored["realized_class"].isin(["UP", "DOWN"])]
    directional_calls = directional[directional["prediction"].isin(["UP", "DOWN"])]
    directional_accuracy = None if directional_calls.empty else float((directional_calls["prediction"] == directional_calls["realized_class"]).mean())
    checks = {
        "minimum_examples": len(scored) >= min_examples,
        "beats_majority_baseline": lift >= min_accuracy_lift,
        "probability_quality": loss <= max_log_loss,
        "directional_accuracy": directional_accuracy is not None and directional_accuracy >= min_directional_accuracy,
        "stability": stability_result is not None and stability_result.get("promotion_stability_ready") is True,
    }
    return {
        "prediction_file": str(path),
        "examples": int(len(scored)),
        "accuracy": round(accuracy, 6),
        "balanced_accuracy": round(float(balanced_accuracy_score(y_true, y_pred)), 6),
        "majority_baseline_accuracy": round(baseline, 6),
        "accuracy_lift_vs_majority": round(lift, 6),
        "log_loss": round(loss, 6),
        "directional_accuracy": None if directional_accuracy is None else round(directional_accuracy, 6),
        "thresholds": {"min_examples": min_examples, "min_accuracy_lift": min_accuracy_lift, "max_log_loss": max_log_loss, "min_directional_accuracy": min_directional_accuracy},
        "checks": checks,
        "stability_gate": stability_result,
        "promotion_ready": all(checks.values()),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate D-predict model promotion gates")
    parser.add_argument("ledger", type=Path)
    parser.add_argument("--stability-report", type=Path, required=True)
    parser.add_argument("--min-examples", type=int, default=DEFAULT_MIN_EXAMPLES)
    parser.add_argument("--min-accuracy-lift", type=float, default=DEFAULT_MIN_ACCURACY_LIFT)
    parser.add_argument("--max-log-loss", type=float, default=DEFAULT_MAX_LOG_LOSS)
    parser.add_argument("--min-directional-accuracy", type=float, default=DEFAULT_MIN_DIRECTIONAL_ACCURACY)
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()
    from .stability_gate import evaluate as evaluate_stability
    stability = evaluate_stability(args.stability_report)
    result = evaluate(args.ledger, args.min_examples, args.min_accuracy_lift, args.max_log_loss, args.min_directional_accuracy, stability)
    payload = json.dumps(result, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload + "\n", encoding="utf-8")
    print(payload)


if __name__ == "__main__":
    main()
