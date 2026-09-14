"""Leakage-free conditional return distributions and trade-thesis construction."""
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
        # Small fixtures may use 3; production defaults to a conservative 60.
        if self.min_history < 3:
            raise ValueError("min_history must be at least 3")
        if len(self.target_probabilities) != 3:
            raise ValueError("exactly three target probabilities are required")
        if any(not 0 < p < 1 for p in self.target_probabilities):
            raise ValueError("target probabilities must be between 0 and 1")
        if not all(a > b for a, b in zip(self.target_probabilities, self.target_probabilities[1:])):
            raise ValueError("target probabilities must be strictly descending")
        if not 0 < self.stop_probability < 0.5:
            raise ValueError("stop_probability must be between 0 and 0.5")


_REQUIRED = {
    "timestamp", "symbol", "horizon", "prediction", "predicted_return", "target_return",
    "market_probability_down", "market_probability_flat", "market_probability_up",
}


def _validate_frame(frame: pd.DataFrame) -> pd.DataFrame:
    missing = _REQUIRED - set(frame.columns)
    if missing:
        raise ValueError(f"return forecast ledger missing columns: {sorted(missing)}")
    result = frame.copy()
    result["timestamp"] = pd.to_datetime(result["timestamp"], utc=True)
    if result.duplicated(subset=["symbol", "horizon", "timestamp"]).any():
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


def calibrate_return_distributions(ledger: pd.DataFrame, config: ReturnDistributionConfig | None = None) -> pd.DataFrame:
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
                quantiles = {f"return_p{p:02d}": _quantile(residuals, p / 100.0) for p in (5, 10, 15, 25, 35, 45, 50, 55, 65, 75, 85, 90, 95)}
                for key, residual_quantile in quantiles.items():
                    item[key] = float(row.predicted_return + residual_quantile)
                item["distribution_status"] = "CALIBRATED"
            output.append(item)
            # Current outcome enters history only after its own distribution.
            residuals.append(float(row.target_return - row.predicted_return))
    return pd.DataFrame(output)


def _distribution_quantile(row: pd.Series, probability: float) -> float:
    key = f"return_p{int(round(probability * 100)):02d}"
    if key not in row or pd.isna(row[key]):
        raise ValueError(f"missing calibrated return quantile {key}")
    return float(row[key])


def construct_trade_thesis(row: pd.Series, entry_price: float, config: ReturnDistributionConfig | None = None) -> dict:
    """Construct a deterministic thesis from one calibrated distribution."""
    config = config or ReturnDistributionConfig()
    config.validate()
    if entry_price <= 0:
        raise ValueError("entry_price must be positive")
    if row.get("distribution_status") != "CALIBRATED":
        return {"symbol": str(row.get("symbol", "")), "timestamp": pd.Timestamp(row["timestamp"]).isoformat(), "decision": "NO_TRADE", "signal": "NO_TRADE", "reason": "RETURN_DISTRIBUTION_UNCALIBRATED"}
    prediction = str(row["prediction"])
    if prediction == "FLAT":
        return {"symbol": str(row["symbol"]), "timestamp": pd.Timestamp(row["timestamp"]).isoformat(), "direction": "FLAT", "signal": "HOLD", "decision": "NO_TRADE", "reason": "FLAT_PREDICTION"}
    direction = "LONG" if prediction == "UP" else "SHORT"
    target_returns: list[float] = []
    for hit_probability in config.target_probabilities:
        quantile_probability = 1.0 - hit_probability if direction == "LONG" else hit_probability
        target_return = _distribution_quantile(row, quantile_probability)
        if (direction == "LONG" and target_return <= 0) or (direction == "SHORT" and target_return >= 0):
            break
        target_returns.append(target_return)
    stop_quantile_probability = config.stop_probability if direction == "LONG" else 1.0 - config.stop_probability
    stop_return = _distribution_quantile(row, stop_quantile_probability)
    stop_is_valid = (direction == "LONG" and stop_return < 0) or (direction == "SHORT" and stop_return > 0)
    if not stop_is_valid or not target_returns:
        return {"symbol": str(row["symbol"]), "timestamp": pd.Timestamp(row["timestamp"]).isoformat(), "direction": direction, "signal": "NO_TRADE", "decision": "NO_TRADE", "reason": "INSUFFICIENT_ECONOMIC_EDGE", "expected_return": float(row["predicted_return"]), "distribution_status": "CALIBRATED"}
    targets = [{"return": float(r), "price": float(entry_price * (1.0 + r)), "probability": float(p)} for r, p in zip(target_returns, config.target_probabilities)]
    stop_price = float(entry_price * (1.0 + stop_return))
    risk = abs(entry_price - stop_price)
    reward = abs(targets[0]["price"] - entry_price)
    risk_reward = reward / risk if risk > 0 else None
    confidence = max(float(row["market_probability_down"]), float(row["market_probability_flat"]), float(row["market_probability_up"]))
    signal = "STRONG BUY" if direction == "LONG" and confidence >= 0.70 else "BUY" if direction == "LONG" else "STRONG SELL" if confidence >= 0.70 else "SELL"
    return {
        "symbol": str(row["symbol"]), "timestamp": pd.Timestamp(row["timestamp"]).isoformat(), "direction": direction,
        "signal": signal, "decision": "EXECUTABLE", "entry_price": float(entry_price), "expected_return": float(row["predicted_return"]),
        "horizon": str(row["horizon"]), "targets": targets,
        "stop": {"price": stop_price, "probability": float(config.stop_probability), "return": float(stop_return)},
        "risk_reward_to_target_1": float(risk_reward) if risk_reward is not None else None,
        "probability": confidence, "confidence": round(confidence * 100.0, 2), "distribution_status": "CALIBRATED",
        "distribution_min_history": int(config.min_history), "trade_thesis_version": "return-distribution-v1",
    }
