"""Leakage-free conditional return distributions and trade-thesis construction.

The distribution is deliberately built from prior out-of-sample residuals:

    actual_return - predicted_return

for the same symbol and horizon. No current or future realized return is used
when constructing a prediction's distribution. Targets and stops are then
quantiles of that conditional distribution rather than fixed percentage rules.

This module is a research primitive. It does not place orders and it does not
claim that the chosen target probabilities are calibrated until they are
validated independently out of sample.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

import numpy as np
import pandas as pd

VALID_CLASSES = {"DOWN", "FLAT", "UP"}


@dataclass(frozen=True)
class ReturnDistributionConfig:
    min_history: int = 60
    target_probabilities: tuple[float, float, float] = (0.65, 0.45, 0.25)
    stop_probability: float = 0.15

    def validate(self) -> None:
        if self.min_history < 10:
            raise ValueError("min_history must be at least 10")
        if len(self.target_probabilities) != 3:
            raise ValueError("exactly three target probabilities are required")
        if any(not 0 < p < 1 for p in self.target_probabilities):
            raise ValueError("target probabilities must be between 0 and 1")
        if not all(a > b for a, b in zip(self.target_probabilities, self.target_probabilities[1:])):
            raise ValueError("target probabilities must be strictly descending")
        if not 0 < self.stop_probability < 0.5:
            raise ValueError("stop_probability must be between 0 and 0.5")


_REQUIRED = {
    "timestamp", "symbol", "horizon", "prediction",
    "predicted_return", "target_return",
    "market_probability_down", "market_probability_flat", "market_probability_up",
}


def _validate_frame(frame: pd.DataFrame) -> pd.DataFrame:
    missing = _REQUIRED - set(frame.columns)
    if missing:
        raise ValueError(f"return forecast ledger missing columns: {sorted(missing)}")
    result = frame.copy()
    result["timestamp"] = pd.to_datetime(result["timestamp"], utc=True)
    if result["timestamp"].duplicated(subset=["symbol", "horizon"]).any():
        raise ValueError("timestamps must be unique per symbol and horizon")
    if not result["prediction"].isin(VALID_CLASSES).all():
        raise ValueError("prediction classes must be DOWN, FLAT or UP")
    for column in ("predicted_return", "target_return", "market_probability_down", "market_probability_flat", "market_probability_up"):
        result[column] = pd.to_numeric(result[column], errors="coerce")
    if result[["predicted_return", "target_return"]].isna().any().any():
        raise ValueError("predicted_return and target_return must be numeric")
    probabilities = result[["market_probability_down", "market_probability_flat", "market_probability_up"]]
    if probabilities.isna().any().any() or ((probabilities < 0) | (probabilities > 1)).any().any():
        raise ValueError("probabilities must be between 0 and 1")
    if not np.allclose(probabilities.sum(axis=1), 1.0, atol=1e-8):
        raise ValueError("market probabilities must sum to 1")
    return result.sort_values(["symbol", "horizon", "timestamp"]).reset_index(drop=True)


def _quantile(values: Iterable[float], probability: float) -> float:
    return float(np.quantile(np.asarray(list(values), dtype=float), probability, method="linear"))


def calibrate_return_distributions(
    ledger: pd.DataFrame,
    config: ReturnDistributionConfig | None = None,
) -> pd.DataFrame:
    """Add expanding, prior-OOS residual distributions to a prediction ledger."""
    config = config or ReturnDistributionConfig()
    config.validate()
    frame = _validate_frame(ledger)
    output: list[dict] = []

    for (symbol, horizon), group in frame.groupby(["symbol", "horizon"], sort=False):
        residuals: list[float] = []
        for row in group.itertuples(index=False):
            item = row._asdict()
            item["distribution_status"] = "UNCALIBRATED"
            item["residual_history"] = len(residuals)
            if len(residuals) >= config.min_history:
                quantiles = {
                    "return_p05": _quantile(residuals, 0.05),
                    "return_p10": _quantile(residuals, 0.10),
                    "return_p15": _quantile(residuals, 0.15),
                    "return_p25": _quantile(residuals, 0.25),
                    "return_p35": _quantile(residuals, 0.35),
                    "return_p45": _quantile(residuals, 0.45),
                    "return_p50": _quantile(residuals, 0.50),
                    "return_p55": _quantile(residuals, 0.55),
                    "return_p65": _quantile(residuals, 0.65),
                    "return_p75": _quantile(residuals, 0.75),
                    "return_p85": _quantile(residuals, 0.85),
                    "return_p90": _quantile(residuals, 0.90),
                    "return_p95": _quantile(residuals, 0.95),
                }
                for key, residual_quantile in quantiles.items():
                    item[key] = float(row.predicted_return + residual_quantile)
                item["distribution_status"] = "CALIBRATED"
            output.append(item)
            # Current outcome is added only after its own distribution has been
            # constructed, preventing same-row leakage.
            residuals.append(float(row.target_return - row.predicted_return))

    return pd.DataFrame(output)


def _distribution_quantile(row: pd.Series, probability: float) -> float:
    key = f"return_p{int(round(probability * 100)):02d}"
    if key not in row or pd.isna(row[key]):
        raise ValueError(f"missing calibrated return quantile {key}")
    return float(row[key])


def construct_trade_thesis(
    row: pd.Series,
    entry_price: float,
    config: ReturnDistributionConfig | None = None,
) -> dict:
    """Construct a deterministic thesis from one calibrated distribution."""
    config = config or ReturnDistributionConfig()
    config.validate()
    if entry_price <= 0:
        raise ValueError("entry_price must be positive")
    if row.get("distribution_status") != "CALIBRATED":
        return {
            "symbol": str(row.get("symbol", "")),
            "timestamp": pd.Timestamp(row["timestamp"]).isoformat(),
            "decision": "NO_TRADE",
            "signal": "NO_TRADE",
            "reason": "RETURN_DISTRIBUTION_UNCALIBRATED",
        }

    prediction = str(row["prediction"])
    if prediction == "FLAT":
        return {
            "symbol": str(row["symbol"]),
            "timestamp": pd.Timestamp(row["timestamp"]).isoformat(),
            "direction": "FLAT",
            "signal": "HOLD",
            "decision": "NO_TRADE",
            "reason": "FLAT_PREDICTION",
        }

    direction = "LONG" if prediction == "UP" else "SHORT"
    target_returns: list[float] = []
    target_probabilities = list(config.target_probabilities)
    for hit_probability in target_probabilities:
        quantile_probability = 1.0 - hit_probability if direction == "LONG" else hit_probability
        target_return = _distribution_quantile(row, quantile_probability)
        if (direction == "LONG" and target_return <= 0) or (direction == "SHORT" and target_return >= 0):
            break
        target_returns.append(target_return)

    stop_quantile_probability = config.stop_probability if direction == "LONG" else 1.0 - config.stop_probability
    stop_return = _distribution_quantile(row, stop_quantile_probability)
    stop_is_valid = (direction == "LONG" and stop_return < 0) or (direction == "SHORT" and stop_return > 0)
    if not stop_is_valid or not target_returns:
        return {
            "symbol": str(row["symbol"]),
            "timestamp": pd.Timestamp(row["timestamp"]).isoformat(),
            "direction": direction,
            "signal": "NO_TRADE",
            "decision": "NO_TRADE",
            "reason": "INSUFFICIENT_ECONOMIC_EDGE",
            "expected_return": float(row["predicted_return"]),
            "distribution_status": "CALIBRATED",
        }

    targets = []
    for target_return, probability in zip(target_returns, target_probabilities):
        targets.append({
            "return": float(target_return),
            "price": float(entry_price * (1.0 + target_return)),
            "probability": float(probability),
        })

    stop_price = float(entry_price * (1.0 + stop_return))
    first_target = targets[0]["price"]
    risk = abs(entry_price - stop_price)
    reward = abs(first_target - entry_price)
    risk_reward = reward / risk if risk > 0 else None

    confidence = max(
        float(row["market_probability_down"]),
        float(row["market_probability_flat"]),
        float(row["market_probability_up"]),
    )
    signal = "STRONG BUY" if direction == "LONG" and confidence >= 0.70 else "BUY" if direction == "LONG" else "STRONG SELL" if confidence >= 0.70 else "SELL"
    horizon = str(row["horizon"])

    return {
        "symbol": str(row["symbol"]),
        "timestamp": pd.Timestamp(row["timestamp"]).isoformat(),
        "direction": direction,
        "signal": signal,
        "decision": "EXECUTABLE",
        "entry_price": float(entry_price),
        "expected_return": float(row["predicted_return"]),
        "horizon": horizon,
        "targets": targets,
        "stop": {"price": stop_price, "probability": float(config.stop_probability), "return": float(stop_return)},
        "risk_reward_to_target_1": float(risk_reward) if risk_reward is not None else None,
        "probability": confidence,
        "confidence": round(confidence * 100.0, 2),
        "distribution_status": "CALIBRATED",
        "distribution_min_history": int(config.min_history),
        "trade_thesis_version": "return-distribution-v1",
    }
