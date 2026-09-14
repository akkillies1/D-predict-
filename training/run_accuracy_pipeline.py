"""Run the end-to-end accuracy comparison on real OOS artifacts.

This is intentionally an artifact runner, not a synthetic benchmark. It scans
explicit prediction ledgers supplied by the user, scores raw probabilities,
optionally applies leakage-safe calibration, and emits one comparable report.
It never invents missing market data or silently substitutes a different symbol.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

from training.probability_calibration import CalibrationConfig, calibrate_oos, score_calibration
from training.score_prediction_ledger import score_ledger


def _raw_score(frame: pd.DataFrame) -> dict:
    # score_ledger is the canonical raw probability evaluator; keep this runner
    # as orchestration so there is one definition of accuracy metrics.
    return score_ledger(frame)


def run(ledgers: list[Path], min_calibration_history: int = 100) -> dict:
    if not ledgers:
        raise ValueError("at least one --ledger is required")
    results = []
    for path in ledgers:
        frame = pd.read_csv(path)
        raw = _raw_score(frame)
        calibrated_frame = calibrate_oos(frame, CalibrationConfig(min_history=min_calibration_history))
        calibration = score_calibration(calibrated_frame)
        results.append({
            "ledger": str(path),
            "symbol": str(frame["symbol"].iloc[0]) if "symbol" in frame.columns and not frame.empty else None,
            "horizons": sorted(frame["horizon"].dropna().astype(str).unique().tolist()) if "horizon" in frame.columns else [],
            "raw": raw,
            "calibrated": calibration,
            "calibrated_examples": int((calibrated_frame["calibration_status"] == "CALIBRATED").sum()),
        })
    return {
        "pipeline": "accuracy-comparison-v1",
        "ledgers": results,
        "calibration_min_history": min_calibration_history,
        "synthetic_data_used": False,
        "promotion": "NONE",
        "note": "This report compares research artifacts; it does not retune models or promote a strategy.",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Compare raw and leakage-safe calibrated OOS probabilities")
    parser.add_argument("--ledger", type=Path, action="append", required=True, help="OOS prediction ledger; repeat for multiple symbols/horizons")
    parser.add_argument("--min-calibration-history", type=int, default=100)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = run(args.ledger, args.min_calibration_history)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
