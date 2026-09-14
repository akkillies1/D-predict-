"""Point-in-time volatility-aware portfolio risk budgeting.

Risk is computed only from historical bars at or before each prediction timestamp.
Missing or invalid risk data never gets replaced with a guessed volatility value.
This module is a research/evaluation layer and never places orders.
"""
from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from pathlib import Path

import pandas as pd

from training.portfolio import REQUIRED_COLUMNS, VALID_CLASSES, _validate_probabilities


@dataclass(frozen=True)
class RiskConfig:
    min_confidence: float = 0.55
    risk_per_trade: float = 0.005
    atr_period: int = 14
    stop_atr_multiplier: float = 1.5
    min_stop_distance_bps: float = 50.0
    max_position_weight: float = 0.25
    max_gross_exposure: float = 1.0

    def validate(self) -> None:
        if not 1 / 3 <= self.min_confidence <= 1:
            raise ValueError("min_confidence must be between 1/3 and 1")
        if not 0 < self.risk_per_trade <= 1:
            raise ValueError("risk_per_trade must be in (0, 1]")
        if self.atr_period < 2:
            raise ValueError("atr_period must be at least 2")
        if self.stop_atr_multiplier <= 0:
            raise ValueError("stop_atr_multiplier must be positive")
        if self.min_stop_distance_bps <= 0:
            raise ValueError("min_stop_distance_bps must be positive")
        if not 0 < self.max_position_weight <= 1:
            raise ValueError("max_position_weight must be in (0, 1]")
        if not 0 < self.max_gross_exposure <= 1:
            raise ValueError("max_gross_exposure must be in (0, 1]")
        if self.max_position_weight > self.max_gross_exposure:
            raise ValueError("max_position_weight cannot exceed max_gross_exposure")


def _normalise_history(history: pd.DataFrame) -> pd.DataFrame:
    required = {"timestamp", "high", "low", "close"}
    missing = required - set(history.columns)
    if missing:
        raise ValueError(f"Historical risk data missing columns: {sorted(missing)}")
    frame = history.copy()
    frame["timestamp"] = pd.to_datetime(frame["timestamp"], utc=True)
    for column in ("high", "low", "close"):
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    if frame["timestamp"].duplicated().any():
        raise ValueError("Historical risk timestamps must be unique")
    if not frame["timestamp"].is_monotonic_increasing:
        frame = frame.sort_values("timestamp")
    if frame[["high", "low", "close"]].isna().any().any():
        raise ValueError("Historical risk OHLC values must be numeric and non-null")
    if (frame[["high", "low", "close"]] <= 0).any().any():
        raise ValueError("Historical risk OHLC values must be positive")
    if (frame["high"] < frame["low"]).any():
        raise ValueError("Historical risk high must be >= low")
    return frame.reset_index(drop=True)


def _atr_pct_at(history: pd.DataFrame, timestamp: pd.Timestamp, period: int) -> tuple[float | None, pd.Timestamp | None]:
    eligible = history.loc[history["timestamp"] <= timestamp].copy()
    if len(eligible) < period:
        return None, None
    previous_close = eligible["close"].shift(1)
    true_range = pd.concat(
        [eligible["high"] - eligible["low"],
         (eligible["high"] - previous_close).abs(),
         (eligible["low"] - previous_close).abs()], axis=1,
    ).max(axis=1)
    atr = true_range.rolling(period, min_periods=period).mean().iloc[-1]
    close = float(eligible["close"].iloc[-1])
    if not pd.notna(atr) or not pd.notna(close) or close <= 0:
        return None, None
    value = float(atr) / close
    if not 0 < value < 10:
        return None, None
    return value, pd.Timestamp(eligible["timestamp"].iloc[-1])


def construct_risk_budget(
    predictions: pd.DataFrame,
    history: pd.DataFrame,
    config: RiskConfig | None = None,
) -> pd.DataFrame:
    config = config or RiskConfig()
    config.validate()
    missing = REQUIRED_COLUMNS - set(predictions.columns)
    if missing:
        raise ValueError(f"Prediction ledger missing columns: {sorted(missing)}")
    if predictions.empty:
        return pd.DataFrame()

    frame = predictions.copy()
    frame["timestamp"] = pd.to_datetime(frame["timestamp"], utc=True)
    if frame["timestamp"].duplicated().any():
        raise ValueError("Prediction timestamps must be unique for risk budgeting")
    if not frame["prediction"].isin(VALID_CLASSES).all():
        raise ValueError("Prediction classes must be DOWN, FLAT or UP")
    hist = _normalise_history(history)

    rows: list[dict] = []
    gross_used = 0.0
    min_stop_fraction = config.min_stop_distance_bps / 10_000.0
    for row in frame.sort_values("timestamp").itertuples(index=False):
        series = pd.Series(row._asdict())
        down, flat, up = _validate_probabilities(series)
        confidence = {"DOWN": down, "FLAT": flat, "UP": up}[row.prediction]
        atr_pct, volatility_timestamp = _atr_pct_at(hist, row.timestamp, config.atr_period)

        weight = 0.0
        decision = "NO_TRADE"
        risk_status = "OK"
        stop_distance = None
        risk_limited_weight = None
        confidence_limited_weight = None

        if row.prediction == "FLAT" or confidence < config.min_confidence:
            risk_status = "SIGNAL_BELOW_THRESHOLD"
        elif atr_pct is None:
            risk_status = "RISK_DATA_UNAVAILABLE"
        else:
            stop_distance = max(min_stop_fraction, atr_pct * config.stop_atr_multiplier)
            risk_limited_weight = config.risk_per_trade / stop_distance
            edge = max(0.0, (confidence - 1 / 3) / (2 / 3))
            confidence_limited_weight = config.max_position_weight * edge
            remaining = max(0.0, config.max_gross_exposure - gross_used)
            weight = min(confidence_limited_weight, risk_limited_weight, config.max_position_weight, remaining)
            if weight > 0:
                decision = "LONG" if row.prediction == "UP" else "SHORT"
                gross_used += weight
            else:
                risk_status = "GROSS_EXPOSURE_LIMIT"

        rows.append({
            "timestamp": row.timestamp.isoformat(),
            "symbol": str(row.symbol),
            "horizon": str(row.horizon),
            "prediction": row.prediction,
            "confidence": confidence,
            "atr_period": config.atr_period,
            "atr_pct": atr_pct,
            "volatility_timestamp": volatility_timestamp.isoformat() if volatility_timestamp is not None else None,
            "stop_distance_fraction": stop_distance,
            "stop_distance_bps": stop_distance * 10_000 if stop_distance is not None else None,
            "risk_per_trade": config.risk_per_trade,
            "risk_limited_weight": risk_limited_weight,
            "confidence_limited_weight": confidence_limited_weight,
            "position_weight": weight,
            "gross_exposure_after": gross_used,
            "decision": decision,
            "risk_status": risk_status,
            "sizing_rule": "min(confidence_edge_weight, risk_budget_weight, position_cap, remaining_gross)",
            "risk_source": "historical_OHLC_ATR",
            "point_in_time_rule": "history_timestamp <= prediction_timestamp",
        })
    return pd.DataFrame(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description="Construct point-in-time volatility-aware D-Predict risk budgets")
    parser.add_argument("prediction_file", type=Path)
    parser.add_argument("--history", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--min-confidence", type=float, default=0.55)
    parser.add_argument("--risk-per-trade", type=float, default=0.005)
    parser.add_argument("--atr-period", type=int, default=14)
    parser.add_argument("--stop-atr-multiplier", type=float, default=1.5)
    parser.add_argument("--min-stop-distance-bps", type=float, default=50.0)
    parser.add_argument("--max-position-weight", type=float, default=0.25)
    parser.add_argument("--max-gross-exposure", type=float, default=1.0)
    args = parser.parse_args()

    predictions = pd.read_csv(args.prediction_file)
    history = pd.read_csv(args.history)
    config = RiskConfig(
        min_confidence=args.min_confidence,
        risk_per_trade=args.risk_per_trade,
        atr_period=args.atr_period,
        stop_atr_multiplier=args.stop_atr_multiplier,
        min_stop_distance_bps=args.min_stop_distance_bps,
        max_position_weight=args.max_position_weight,
        max_gross_exposure=args.max_gross_exposure,
    )
    result = construct_risk_budget(predictions, history, config)
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
