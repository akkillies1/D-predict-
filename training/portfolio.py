"""Deterministic portfolio construction and exposure limits for OOS research.

This module converts model probabilities into auditable portfolio weights. It is
an evaluation/risk layer only: it never places orders and never invents prices.
"""
from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from pathlib import Path

import pandas as pd

VALID_CLASSES = {"DOWN", "FLAT", "UP"}
REQUIRED_COLUMNS = {
    "timestamp", "symbol", "horizon", "prediction",
    "market_probability_down", "market_probability_flat", "market_probability_up",
}


@dataclass(frozen=True)
class PortfolioConfig:
    min_confidence: float = 0.55
    max_position_weight: float = 0.25
    max_gross_exposure: float = 1.0

    def validate(self) -> None:
        if not 1 / 3 <= self.min_confidence <= 1:
            raise ValueError("min_confidence must be between 1/3 and 1")
        if not 0 < self.max_position_weight <= 1:
            raise ValueError("max_position_weight must be in (0, 1]")
        if not 0 < self.max_gross_exposure <= 1:
            raise ValueError("max_gross_exposure must be in (0, 1]")
        if self.max_position_weight > self.max_gross_exposure:
            raise ValueError("max_position_weight cannot exceed max_gross_exposure")


def _validate_probabilities(row: pd.Series) -> tuple[float, float, float]:
    values = tuple(float(row[name]) for name in (
        "market_probability_down", "market_probability_flat", "market_probability_up"
    ))
    if any(value < 0 or value > 1 for value in values):
        raise ValueError("Prediction probabilities must be between 0 and 1")
    if abs(sum(values) - 1.0) > 1e-6:
        raise ValueError("Prediction probabilities must sum to 1")
    return values


def construct_portfolio(predictions: pd.DataFrame, config: PortfolioConfig | None = None) -> pd.DataFrame:
    config = config or PortfolioConfig()
    config.validate()
    missing = REQUIRED_COLUMNS - set(predictions.columns)
    if missing:
        raise ValueError(f"Prediction ledger missing columns: {sorted(missing)}")
    if predictions.empty:
        return pd.DataFrame(columns=["timestamp", "symbol", "horizon", "prediction", "confidence", "position_weight", "decision"])

    frame = predictions.copy()
    frame["timestamp"] = pd.to_datetime(frame["timestamp"], utc=True)
    if frame["timestamp"].duplicated().any():
        raise ValueError("Prediction timestamps must be unique for portfolio construction")
    if not frame["prediction"].isin(VALID_CLASSES).all():
        raise ValueError("Prediction classes must be DOWN, FLAT or UP")

    decisions: list[dict] = []
    gross_used = 0.0
    for row in frame.sort_values("timestamp").itertuples(index=False):
        row_series = pd.Series(row._asdict())
        down, flat, up = _validate_probabilities(row_series)
        probabilities = {"DOWN": down, "FLAT": flat, "UP": up}
        direction = row.prediction
        confidence = probabilities[direction]

        weight = 0.0
        decision = "NO_TRADE"
        if direction != "FLAT" and confidence >= config.min_confidence:
            # Scale only the probability edge above the neutral 1/3 class prior.
            # The configured position cap is always the hard ceiling.
            edge = max(0.0, (confidence - 1 / 3) / (2 / 3))
            requested = config.max_position_weight * edge
            remaining = max(0.0, config.max_gross_exposure - gross_used)
            weight = min(requested, remaining)
            if weight > 0:
                decision = "LONG" if direction == "UP" else "SHORT"
                gross_used += weight

        decisions.append({
            "timestamp": row.timestamp.isoformat(),
            "symbol": str(row.symbol),
            "horizon": str(row.horizon),
            "prediction": direction,
            "confidence": confidence,
            "position_weight": weight,
            "gross_exposure_after": gross_used,
            "decision": decision,
            "sizing_rule": "probability_edge_capped",
            "min_confidence": config.min_confidence,
            "max_position_weight": config.max_position_weight,
            "max_gross_exposure": config.max_gross_exposure,
        })
    return pd.DataFrame(decisions)


def main() -> None:
    parser = argparse.ArgumentParser(description="Construct deterministic D-Predict portfolio weights")
    parser.add_argument("prediction_file", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--min-confidence", type=float, default=0.55)
    parser.add_argument("--max-position-weight", type=float, default=0.25)
    parser.add_argument("--max-gross-exposure", type=float, default=1.0)
    args = parser.parse_args()

    predictions = pd.read_csv(args.prediction_file)
    config = PortfolioConfig(args.min_confidence, args.max_position_weight, args.max_gross_exposure)
    result = construct_portfolio(predictions, config)
    payload = {
        "config": asdict(config),
        "rows": result.to_dict(orient="records"),
        "gross_exposure": float(result["position_weight"].sum()) if not result.empty else 0.0,
        "decisions": len(result),
        "traded_decisions": int((result["position_weight"] > 0).sum()) if not result.empty else 0,
    }
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
