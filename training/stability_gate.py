"""Apply conservative stability requirements to an OOS stability report."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

DEFAULT_MAX_CALIBRATION_GAP = 0.10
DEFAULT_MAX_FOLD_ACCURACY_STD = 0.10
DEFAULT_MIN_WORST_FOLD_LIFT = -0.05
DEFAULT_MIN_INTERPRETABLE_REGIMES = 2
DEFAULT_MIN_REGIME_LIFT = -0.05


def evaluate(path: Path, max_calibration_gap: float = DEFAULT_MAX_CALIBRATION_GAP,
             max_fold_accuracy_std: float = DEFAULT_MAX_FOLD_ACCURACY_STD,
             min_worst_fold_lift: float = DEFAULT_MIN_WORST_FOLD_LIFT,
             min_interpretable_regimes: int = DEFAULT_MIN_INTERPRETABLE_REGIMES,
             min_regime_lift: float = DEFAULT_MIN_REGIME_LIFT) -> dict:
    report = json.loads(path.read_text(encoding="utf-8"))
    required = {"overall", "confidence_buckets", "calibration", "fold_stability", "regime_stability"}
    missing = sorted(required - set(report))
    if missing:
        raise ValueError(f"stability report is missing sections: {', '.join(missing)}")

    calibration_rows = [r for r in report["calibration"] if r.get("examples", 0) >= 10 and r.get("absolute_calibration_gap") is not None]
    max_gap = max((r["absolute_calibration_gap"] for r in calibration_rows), default=None)
    fold_stability = report["fold_stability"]
    fold_rows = fold_stability.get("folds", [])
    worst_fold_lift = min((r.get("accuracy_lift_vs_majority", 0.0) for r in fold_rows), default=None)
    fold_std = fold_stability.get("accuracy_std")
    regime_rows = [r for r in report["regime_stability"].get("regimes", []) if r.get("interpretable") is True]
    regime_lifts = [r.get("accuracy_lift_vs_majority") for r in regime_rows if r.get("accuracy_lift_vs_majority") is not None]
    worst_regime_lift = min(regime_lifts) if regime_lifts else None

    checks = {
        "calibration_quality": max_gap is not None and max_gap <= max_calibration_gap,
        "fold_accuracy_stability": fold_std is not None and fold_std <= max_fold_accuracy_std,
        "worst_fold_not_materially_below_baseline": worst_fold_lift is not None and worst_fold_lift >= min_worst_fold_lift,
        "minimum_interpretable_regimes": len(regime_rows) >= min_interpretable_regimes,
        "regime_stability": worst_regime_lift is not None and worst_regime_lift >= min_regime_lift,
    }
    return {
        "stability_file": str(path),
        "checks": checks,
        "promotion_stability_ready": all(checks.values()),
        "observed": {
            "max_interpretable_calibration_gap": max_gap,
            "fold_accuracy_std": fold_std,
            "worst_fold_accuracy_lift": worst_fold_lift,
            "interpretable_regime_count": len(regime_rows),
            "worst_regime_accuracy_lift": worst_regime_lift,
        },
        "thresholds": {
            "max_calibration_gap": max_calibration_gap,
            "max_fold_accuracy_std": max_fold_accuracy_std,
            "min_worst_fold_lift": min_worst_fold_lift,
            "min_interpretable_regimes": min_interpretable_regimes,
            "min_regime_lift": min_regime_lift,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate D-predict prediction stability gates")
    parser.add_argument("stability_report", type=Path)
    parser.add_argument("--max-calibration-gap", type=float, default=DEFAULT_MAX_CALIBRATION_GAP)
    parser.add_argument("--max-fold-accuracy-std", type=float, default=DEFAULT_MAX_FOLD_ACCURACY_STD)
    parser.add_argument("--min-worst-fold-lift", type=float, default=DEFAULT_MIN_WORST_FOLD_LIFT)
    parser.add_argument("--min-interpretable-regimes", type=int, default=DEFAULT_MIN_INTERPRETABLE_REGIMES)
    parser.add_argument("--min-regime-lift", type=float, default=DEFAULT_MIN_REGIME_LIFT)
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()
    result = evaluate(args.stability_report, args.max_calibration_gap, args.max_fold_accuracy_std, args.min_worst_fold_lift, args.min_interpretable_regimes, args.min_regime_lift)
    payload = json.dumps(result, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload + "\n", encoding="utf-8")
    print(payload)


if __name__ == "__main__":
    main()
