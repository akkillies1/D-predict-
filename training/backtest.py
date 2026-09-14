"""Causal V1 portfolio backtest with risk budgeting and drawdown throttling.

A prediction at T is executed at the next available historical close. Position
weight is derived only from historical OHLC available at T, then throttled by
the portfolio drawdown observed before the trade. Trades do not overlap.
This is an evaluation tool, not an order-execution engine.
"""
from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path

import pandas as pd

from training.risk import RiskConfig, construct_risk_budget

ROOT = Path(__file__).resolve().parents[1]
PRED_DIR = ROOT / "data" / "predictions"

HORIZON_ROWS = {"1d": 1, "3d": 3, "5d": 5}
VALID_CLASSES = {"DOWN", "FLAT", "UP"}


@dataclass(frozen=True)
class DrawdownConfig:
    soft_drawdown: float = 0.05
    hard_drawdown: float = 0.10

    def validate(self) -> None:
        if not 0 <= self.soft_drawdown < self.hard_drawdown < 1:
            raise ValueError("drawdown thresholds must satisfy 0 <= soft < hard < 1")


def drawdown_multiplier(drawdown: float, config: DrawdownConfig | None = None) -> float:
    config = config or DrawdownConfig()
    config.validate()
    drawdown = max(0.0, drawdown)
    if drawdown <= config.soft_drawdown:
        return 1.0
    if drawdown >= config.hard_drawdown:
        return 0.0
    return (config.hard_drawdown - drawdown) / (config.hard_drawdown - config.soft_drawdown)


def load_inputs(prediction_path: Path, history_path: Path) -> tuple[pd.DataFrame, pd.DataFrame]:
    predictions = pd.read_csv(prediction_path, parse_dates=["timestamp"])
    history = pd.read_csv(history_path, parse_dates=["timestamp"])
    required_predictions = {
        "timestamp", "prediction", "horizon", "market_probability_down",
        "market_probability_flat", "market_probability_up",
    }
    missing = required_predictions - set(predictions.columns)
    if missing:
        raise ValueError(f"Prediction ledger missing columns: {sorted(missing)}")
    required_history = {"timestamp", "high", "low", "close"}
    missing = required_history - set(history.columns)
    if missing:
        raise ValueError(f"Historical data missing columns: {sorted(missing)}")

    predictions["timestamp"] = pd.to_datetime(predictions["timestamp"], utc=True)
    history["timestamp"] = pd.to_datetime(history["timestamp"], utc=True)
    prediction_key = ["timestamp"]
    if "symbol" in predictions.columns:
        prediction_key.append("symbol")
    if "horizon" in predictions.columns:
        prediction_key.append("horizon")
    if predictions.duplicated(subset=prediction_key).any():
        raise ValueError(f"Prediction keys must be unique: {prediction_key}")
    if history["timestamp"].duplicated().any():
        raise ValueError("Historical timestamps must be unique")
    for column in ("high", "low", "close"):
        history[column] = pd.to_numeric(history[column], errors="coerce")
    if history[["high", "low", "close"]].isna().any().any():
        raise ValueError("Historical OHLC values must be numeric and non-null")
    if (history[["high", "low", "close"]] <= 0).any().any():
        raise ValueError("Historical OHLC values must be positive")
    if (history["high"] < history["low"]).any():
        raise ValueError("Historical high must be >= low")
    if not predictions["prediction"].isin(VALID_CLASSES).all():
        raise ValueError("Prediction classes must be DOWN, FLAT or UP")
    if not predictions["horizon"].isin(HORIZON_ROWS).all():
        raise ValueError("Unsupported horizon; use 1d, 3d or 5d")

    return predictions.sort_values(["timestamp"] + (["symbol"] if "symbol" in predictions.columns else [])), history.sort_values("timestamp")


def _net_return(direction: str, entry: float, exit_price: float, cost_bps: float, slippage_bps: float) -> float:
    friction = 2.0 * (cost_bps + slippage_bps) / 10_000.0
    if direction == "UP":
        gross = exit_price / entry - 1.0
    elif direction == "DOWN":
        gross = entry / exit_price - 1.0
    else:
        raise ValueError(f"Cannot backtest direction {direction}")
    return gross - friction


def backtest(
    prediction_path: Path,
    history_path: Path,
    cost_bps: float = 10.0,
    slippage_bps: float = 5.0,
    initial_capital: float = 100_000.0,
    risk_config: RiskConfig | None = None,
    drawdown_config: DrawdownConfig | None = None,
) -> dict:
    if cost_bps < 0 or slippage_bps < 0:
        raise ValueError("cost_bps and slippage_bps cannot be negative")
    if initial_capital <= 0:
        raise ValueError("initial_capital must be positive")
    risk_config = risk_config or RiskConfig()
    risk_config.validate()
    drawdown_config = drawdown_config or DrawdownConfig()
    drawdown_config.validate()

    predictions, history = load_inputs(prediction_path, history_path)
    history_times = history["timestamp"].reset_index(drop=True)
    equity = float(initial_capital)
    equity_peak = equity
    trades: list[dict] = []
    next_free_timestamp = None

    for row in predictions.itertuples(index=False):
        if row.prediction == "FLAT":
            continue
        signal_time = row.timestamp
        if next_free_timestamp is not None and signal_time < next_free_timestamp:
            continue

        entry_positions = history_times.searchsorted(signal_time, side="right")
        if entry_positions >= len(history_times):
            continue
        entry_idx = int(entry_positions)
        horizon_rows = HORIZON_ROWS[row.horizon]
        exit_idx = entry_idx + horizon_rows
        if exit_idx >= len(history_times):
            continue

        entry_time = history_times.iloc[entry_idx]
        exit_time = history_times.iloc[exit_idx]
        entry_price = float(history.iloc[entry_idx]["close"])
        exit_price = float(history.iloc[exit_idx]["close"])

        risk_row = construct_risk_budget(pd.DataFrame([row._asdict()]), history, risk_config).iloc[0]
        base_weight = float(risk_row["position_weight"])
        current_drawdown = equity / equity_peak - 1.0
        throttle = drawdown_multiplier(-current_drawdown, drawdown_config)
        position_weight = base_weight * throttle

        if position_weight <= 0:
            trades.append({
                "signal_timestamp": signal_time.isoformat(),
                "entry_timestamp": entry_time.isoformat(),
                "exit_timestamp": exit_time.isoformat(),
                "symbol": str(getattr(row, "symbol", "")),
                "horizon": row.horizon,
                "direction": row.prediction,
                "entry_price": entry_price,
                "exit_price": exit_price,
                "base_position_weight": base_weight,
                "drawdown": current_drawdown,
                "drawdown_multiplier": throttle,
                "position_weight": 0.0,
                "risk_status": "DRAWDOWN_THROTTLED" if throttle == 0 else str(risk_row["risk_status"]),
                "net_return": 0.0,
                "portfolio_return": 0.0,
                "equity_before": equity,
                "equity_after": equity,
            })
            continue

        trade_return = _net_return(row.prediction, entry_price, exit_price, cost_bps, slippage_bps)
        portfolio_return = position_weight * trade_return
        start_equity = equity
        equity *= 1.0 + portfolio_return
        equity_peak = max(equity_peak, equity)
        trades.append({
            "signal_timestamp": signal_time.isoformat(),
            "entry_timestamp": entry_time.isoformat(),
            "exit_timestamp": exit_time.isoformat(),
            "symbol": str(getattr(row, "symbol", "")),
            "horizon": row.horizon,
            "direction": row.prediction,
            "entry_price": entry_price,
            "exit_price": exit_price,
            "base_position_weight": base_weight,
            "drawdown": current_drawdown,
            "drawdown_multiplier": throttle,
            "position_weight": position_weight,
            "risk_status": str(risk_row["risk_status"]),
            "net_return": trade_return,
            "portfolio_return": portfolio_return,
            "equity_before": start_equity,
            "equity_after": equity,
        })
        next_free_timestamp = exit_time

    executed = [trade for trade in trades if trade["position_weight"] > 0]
    if not executed:
        raise RuntimeError("No executable non-FLAT trades were produced")

    trade_frame = pd.DataFrame(executed)
    returns = trade_frame["portfolio_return"]
    wins = int((returns > 0).sum())
    losses = int((returns < 0).sum())
    gross_profit = float(returns[returns > 0].sum())
    gross_loss = float(-returns[returns < 0].sum())
    equity_curve = trade_frame["equity_after"]
    running_max = equity_curve.cummax()
    drawdown = equity_curve / running_max - 1.0

    start = pd.Timestamp(trade_frame["entry_timestamp"].iloc[0])
    end = pd.Timestamp(trade_frame["exit_timestamp"].iloc[-1])
    days = max((end - start).total_seconds() / 86_400.0, 1.0)
    total_return = equity / initial_capital - 1.0
    cagr = (equity / initial_capital) ** (365.25 / days) - 1.0
    std = float(returns.std(ddof=1)) if len(returns) > 1 else 0.0
    sharpe = float(returns.mean() / std * (252.0 ** 0.5)) if std > 0 else 0.0

    metrics = {
        "initial_capital": initial_capital,
        "final_equity": round(equity, 2),
        "total_return": round(total_return, 6),
        "cagr": round(float(cagr), 6),
        "max_drawdown": round(float(drawdown.min()), 6),
        "sharpe_per_trade_annualized": round(sharpe, 6),
        "trades": len(trade_frame),
        "wins": wins,
        "losses": losses,
        "win_rate": round(wins / len(trade_frame), 6),
        "profit_factor": round(gross_profit / gross_loss, 6) if gross_loss > 0 else None,
        "cost_bps_per_side": cost_bps,
        "slippage_bps_per_side": slippage_bps,
        "risk_config": risk_config.__dict__,
        "drawdown_config": drawdown_config.__dict__,
        "prediction_file": str(prediction_path),
        "history_file": str(history_path),
    }
    return {"metrics": metrics, "trades": trades}


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the D-Predict causal risk-weighted OOS portfolio backtest")
    parser.add_argument("prediction_file", type=Path)
    parser.add_argument("--history", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--cost-bps", type=float, default=10.0)
    parser.add_argument("--slippage-bps", type=float, default=5.0)
    parser.add_argument("--initial-capital", type=float, default=100_000.0)
    parser.add_argument("--risk-per-trade", type=float, default=0.005)
    parser.add_argument("--atr-period", type=int, default=14)
    parser.add_argument("--stop-atr-multiplier", type=float, default=1.5)
    parser.add_argument("--min-stop-distance-bps", type=float, default=50.0)
    parser.add_argument("--max-position-weight", type=float, default=0.25)
    parser.add_argument("--max-gross-exposure", type=float, default=1.0)
    parser.add_argument("--soft-drawdown", type=float, default=0.05)
    parser.add_argument("--hard-drawdown", type=float, default=0.10)
    args = parser.parse_args()
    result = backtest(
        args.prediction_file,
        args.history,
        args.cost_bps,
        args.slippage_bps,
        args.initial_capital,
        RiskConfig(
            risk_per_trade=args.risk_per_trade,
            atr_period=args.atr_period,
            stop_atr_multiplier=args.stop_atr_multiplier,
            min_stop_distance_bps=args.min_stop_distance_bps,
            max_position_weight=args.max_position_weight,
            max_gross_exposure=args.max_gross_exposure,
        ),
        DrawdownConfig(args.soft_drawdown, args.hard_drawdown),
    )
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result["metrics"], indent=2))


if __name__ == "__main__":
    main()
