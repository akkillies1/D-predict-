"""Paper/shadow trading simulator for historical replay and model training.

This module never sends orders. It replays an OOS prediction ledger against
historical closes, resolves outcomes only when the required future bar exists,
and maintains virtual capital plus an accuracy/training score.

The same engine can later consume a live prediction stream: unresolved
predictions remain PENDING until the future observation becomes available.
"""
from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from pathlib import Path

import pandas as pd

HORIZON_ROWS = {"1d": 1, "3d": 3, "5d": 5}
VALID_CLASSES = {"DOWN", "FLAT", "UP"}
PROBABILITY_COLUMNS = (
    "market_probability_down",
    "market_probability_flat",
    "market_probability_up",
)


@dataclass(frozen=True)
class ShadowConfig:
    initial_capital: float = 100_000.0
    max_position_weight: float = 0.25
    cost_bps_per_side: float = 10.0
    slippage_bps_per_side: float = 5.0

    def validate(self) -> None:
        if self.initial_capital <= 0:
            raise ValueError("initial_capital must be positive")
        if not 0 < self.max_position_weight <= 1:
            raise ValueError("max_position_weight must be in (0, 1]")
        if self.cost_bps_per_side < 0 or self.slippage_bps_per_side < 0:
            raise ValueError("friction cannot be negative")


def _normalise_history(history: pd.DataFrame) -> pd.DataFrame:
    required = {"timestamp", "close"}
    missing = required - set(history.columns)
    if missing:
        raise ValueError(f"Historical data missing columns: {sorted(missing)}")
    frame = history.copy()
    frame["timestamp"] = pd.to_datetime(frame["timestamp"], utc=True)
    frame["close"] = pd.to_numeric(frame["close"], errors="coerce")
    if frame["timestamp"].duplicated().any():
        raise ValueError("Historical timestamps must be unique")
    if frame["close"].isna().any() or (frame["close"] <= 0).any():
        raise ValueError("Historical close prices must be positive and numeric")
    return frame.sort_values("timestamp").reset_index(drop=True)


def _validate_ledger(ledger: pd.DataFrame) -> None:
    required = {"timestamp", "symbol", "horizon", "prediction", *PROBABILITY_COLUMNS}
    missing = required - set(ledger.columns)
    if missing:
        raise ValueError(f"Prediction ledger missing columns: {sorted(missing)}")
    if ledger.empty:
        raise ValueError("Prediction ledger is empty")
    if not ledger["prediction"].isin(VALID_CLASSES).all():
        raise ValueError("Prediction classes must be DOWN, FLAT or UP")
    horizons = ledger["horizon"].astype(str).str.lower()
    if not horizons.isin(HORIZON_ROWS).all():
        raise ValueError("Unsupported horizon; use 1d, 3d or 5d")
    probabilities = ledger[list(PROBABILITY_COLUMNS)].apply(pd.to_numeric, errors="coerce")
    if probabilities.isna().any().any():
        raise ValueError("Prediction probabilities contain missing/non-numeric values")
    if (probabilities < 0).any().any() or (probabilities > 1).any().any():
        raise ValueError("Prediction probabilities must be between 0 and 1")
    if ((probabilities.sum(axis=1) - 1).abs() > 1e-6).any():
        raise ValueError("Prediction probabilities must sum to 1")


def _classify(return_value: float) -> str:
    if return_value > 0.001:
        return "UP"
    if return_value < -0.001:
        return "DOWN"
    return "FLAT"


def _confidence(row: pd.Series) -> float:
    probabilities = {
        "DOWN": float(row["market_probability_down"]),
        "FLAT": float(row["market_probability_flat"]),
        "UP": float(row["market_probability_up"]),
    }
    return probabilities[str(row["prediction"])]


def _net_return(direction: str, entry: float, exit_price: float, config: ShadowConfig) -> float:
    friction = 2.0 * (config.cost_bps_per_side + config.slippage_bps_per_side) / 10_000.0
    if direction == "UP":
        gross = exit_price / entry - 1.0
    elif direction == "DOWN":
        gross = entry / exit_price - 1.0
    else:
        return 0.0
    return gross - friction


def replay(
    ledger: pd.DataFrame,
    histories: dict[str, pd.DataFrame],
    config: ShadowConfig | None = None,
) -> dict:
    """Replay predictions chronologically with virtual capital and accuracy scoring."""
    config = config or ShadowConfig()
    config.validate()
    _validate_ledger(ledger)
    normalised = {str(symbol): _normalise_history(frame) for symbol, frame in histories.items()}

    frame = ledger.copy()
    frame["timestamp"] = pd.to_datetime(frame["timestamp"], utc=True)
    if frame[["timestamp", "symbol"]].duplicated().any():
        raise ValueError("Prediction timestamps must be unique per symbol")
    frame = frame.sort_values(["timestamp", "symbol"]).reset_index(drop=True)

    equity = float(config.initial_capital)
    peak = equity
    correct = 0
    resolved = 0
    directional_correct = 0
    directional_calls = 0
    score_points = 0.0
    pending = 0
    rows: list[dict] = []

    for source in frame.to_dict("records"):
        row = pd.Series(source)
        symbol = str(row["symbol"])
        history = normalised.get(symbol)
        base = dict(source)
        base["prediction_confidence"] = _confidence(row)
        base["position_weight"] = 0.0
        base["entry_timestamp"] = None
        base["exit_timestamp"] = None
        base["realized_class"] = None
        base["realized_return"] = None
        base["outcome_status"] = "PENDING"
        base["game_score"] = None
        base["accuracy_after"] = None
        base["directional_accuracy_after"] = None
        base["equity_before"] = equity
        base["equity_after"] = equity
        base["drawdown_after"] = equity / peak - 1.0

        if history is None:
            base["outcome_status"] = "DATA_UNAVAILABLE"
            rows.append(base)
            continue

        timestamps = pd.DatetimeIndex(history["timestamp"])
        position = int(timestamps.searchsorted(pd.Timestamp(row["timestamp"]), side="left"))
        if position >= len(timestamps) or timestamps[position] != pd.Timestamp(row["timestamp"]):
            base["outcome_status"] = "DATA_UNAVAILABLE"
            rows.append(base)
            continue

        horizon = HORIZON_ROWS[str(row["horizon"]).lower()]
        future_position = position + horizon
        if future_position >= len(history):
            pending += 1
            rows.append(base)
            continue

        entry_position = position + 1
        if entry_position >= len(history) or entry_position + horizon >= len(history):
            pending += 1
            rows.append(base)
            continue

        current_close = float(history.iloc[position]["close"])
        future_close = float(history.iloc[future_position]["close"])
        realized_return = future_close / current_close - 1.0
        realized_class = _classify(realized_return)
        prediction = str(row["prediction"])
        confidence = float(base["prediction_confidence"])
        correct_now = prediction == realized_class
        resolved += 1
        correct += int(correct_now)
        if prediction in {"UP", "DOWN"}:
            directional_calls += 1
            directional_correct += int(prediction == realized_class)
        point_delta = confidence if correct_now else -confidence
        score_points += point_delta

        position_weight = 0.0
        portfolio_return = 0.0
        entry_price = float(history.iloc[entry_position]["close"])
        exit_position = entry_position + horizon
        if prediction != "FLAT" and confidence > 1 / 3:
            edge = (confidence - 1 / 3) / (2 / 3)
            position_weight = min(config.max_position_weight, config.max_position_weight * edge)
            exit_price = float(history.iloc[exit_position]["close"])
            trade_return = _net_return(prediction, entry_price, exit_price, config)
            portfolio_return = position_weight * trade_return
            equity *= 1.0 + portfolio_return
            peak = max(peak, equity)

        drawdown = equity / peak - 1.0
        base.update({
            "outcome_status": "SCORED",
            "entry_timestamp": timestamps[entry_position].isoformat(),
            "exit_timestamp": timestamps[exit_position].isoformat(),
            "realized_close": future_close,
            "realized_class": realized_class,
            "realized_return": realized_return,
            "position_weight": position_weight,
            "portfolio_return": portfolio_return,
            "game_score": point_delta,
            "accuracy_after": correct / resolved,
            "directional_accuracy_after": directional_correct / directional_calls if directional_calls else None,
            "equity_before": base["equity_before"],
            "equity_after": equity,
            "drawdown_after": drawdown,
        })
        rows.append(base)

    result = pd.DataFrame(rows)
    if resolved == 0:
        raise RuntimeError("No predictions could be resolved against the supplied history")

    total_return = equity / config.initial_capital - 1.0
    max_drawdown = float(result["drawdown_after"].min())
    summary = {
        "mode": "HISTORICAL_REPLAY",
        "resolved_predictions": resolved,
        "pending_predictions": pending,
        "accuracy": correct / resolved,
        "directional_accuracy": directional_correct / directional_calls if directional_calls else None,
        "directional_calls": directional_calls,
        "game_score": score_points,
        "game_score_per_prediction": score_points / resolved,
        "initial_capital": config.initial_capital,
        "final_virtual_equity": equity,
        "virtual_return": total_return,
        "max_drawdown": max_drawdown,
        "config": asdict(config),
        "live_orders_sent": 0,
    }
    return {"summary": summary, "predictions": rows}


def _parse_histories(values: list[str]) -> dict[str, pd.DataFrame]:
    histories: dict[str, pd.DataFrame] = {}
    for value in values:
        if "=" not in value:
            raise ValueError("--history must use SYMBOL=PATH")
        symbol, path = value.split("=", 1)
        if not symbol or not path:
            raise ValueError("--history must use SYMBOL=PATH")
        histories[symbol] = pd.read_csv(Path(path))
    return histories


def main() -> None:
    parser = argparse.ArgumentParser(description="Run D-Predict paper/shadow historical replay")
    parser.add_argument("ledger", type=Path)
    parser.add_argument("--history", action="append", required=True, help="SYMBOL=PATH; repeat for each instrument")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--initial-capital", type=float, default=100_000.0)
    parser.add_argument("--max-position-weight", type=float, default=0.25)
    parser.add_argument("--cost-bps", type=float, default=10.0)
    parser.add_argument("--slippage-bps", type=float, default=5.0)
    args = parser.parse_args()
    ledger = pd.read_csv(args.ledger)
    result = replay(
        ledger,
        _parse_histories(args.history),
        ShadowConfig(args.initial_capital, args.max_position_weight, args.cost_bps, args.slippage_bps),
    )
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result["summary"], indent=2))


if __name__ == "__main__":
    main()
