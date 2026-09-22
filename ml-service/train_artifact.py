"""Standalone training job for persisted D-Predict inference artifacts."""
from __future__ import annotations

import argparse
import json

from app import DEFAULT_HORIZON, FEATURE_SET_VERSION, SUPPORTED_HORIZONS, _fit_bundle, _load_daily, _save_bundle, _training_frame


def train_one(symbol: str, horizon: str) -> dict:
    symbol = symbol.strip().upper()
    if horizon not in SUPPORTED_HORIZONS:
        raise ValueError(f"Unsupported horizon {horizon}; choose one of {sorted(SUPPORTED_HORIZONS)}")
    raw = _load_daily(symbol)
    frame = _training_frame(raw, horizon)
    bundle = _fit_bundle(symbol, frame, horizon)
    artifact = _save_bundle(symbol, bundle)
    report = {
        "symbol": symbol,
        "horizon": horizon,
        "artifact": str(artifact),
        "model_version": bundle.model_version,
        "feature_set_version": FEATURE_SET_VERSION,
        "training_cutoff": bundle.training_end.isoformat(),
        "validation_oos_examples": bundle.validation_examples,
        "calibration_examples": bundle.calibration_examples,
        "promotion_ready": bundle.promotion_ready,
        "oos_accuracy": bundle.oos_accuracy,
        "oos_majority_baseline": bundle.oos_majority_baseline,
        "oos_log_loss": bundle.oos_log_loss,
        "oos_directional_accuracy": bundle.oos_directional_accuracy,
    }
    print(json.dumps(report, indent=2))
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="Train and persist validated D-Predict inference artifacts")
    parser.add_argument("--symbols", nargs="+", required=True)
    parser.add_argument("--horizons", nargs="+", default=[DEFAULT_HORIZON], choices=sorted(SUPPORTED_HORIZONS))
    args = parser.parse_args()
    for symbol in args.symbols:
        for horizon in args.horizons:
            train_one(symbol, horizon)


if __name__ == "__main__":
    main()

__all__ = ["train_one"]
