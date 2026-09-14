"""V1 non-overlapping portfolio backtest for D-Predict OOS predictions.

The engine is deliberately conservative: a prediction made at timestamp T is
executed at the next available historical close, held for the requested
trading-row horizon, and then exited. Signals cannot overlap. Transaction cost
and slippage are charged on both entry and exit. This is an evaluation tool,
not an order-execution engine.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
PRED_DIR = ROOT / "data" / "predictions"

HORIZON_ROWS = {"1d": 1, "3d": 3, "5d": 5}
VALID_CLASSES = {"DOWN", "FLAT", "UP"}


def load_inputs(prediction_path: Path, history_path: Path) -> tuple[pd.DataFrame, pd.DataFrame]:
    predictions = pd.read_csv(prediction_path, parse_dates=["timestamp"])
    history = pd.read_csv(history_path, parse_dates=["timestamp"])
    required_predictions = {"timestamp", "prediction", "horizon"}
    missing = required_predictions - set(predictions.columns)
    if missing:
        raise ValueError(f"Prediction ledger missing columns: {sorted(missing)}")
    required_history = {"timestamp", "close"}
    missing = required_history - set(history.columns)
    if missing:
        raise ValueError(f"Historical data missing columns: {sorted(missing)}")

    predictions["timestamp"] = pd.to_datetime(predictions["timestamp"], utc=True)
    history["timestamp"] = pd.to_datetime(history["timestamp"], utc=True)
    if predictions["timestamp"].duplicated().any():
        raise ValueError("Prediction timestamps must be unique")
    if history["timestamp"].duplicated().any():
        raise ValueError("Historical timestamps must be unique")
    if (history["close"] <= 0).any():
        raise ValueError("Historical close prices must be positive")
    if not predictions["prediction"].isin(VALID_CLASSES).all():
        raise ValueError("Prediction classes must be DOWN, FLAT or UP")
    if not predictions["horizon"].isin(HORIZON_ROWS).all():
        raise ValueError("Unsupported horizon; use 1d, 3d or 5d")

    return predictions.sort_values("timestamp"), history.sort_values("timestamp")


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
) -> dict:
    if cost_bps < 0 or slippage_bps < 0:
        raise ValueError("cost_bps and slippage_bps cannot be negative")
    if initial_capital <= 0:
        raise ValueError("initial_capital must be positive")

    predictions, history = load_inputs(prediction_path, history_path)
    history = history.set_index("timestamp")
    history_times = history.index
    equity = float(initial_capital)
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

        entry_time = history_times[entry_idx]
        exit_time = history_times[exit_idx]
        entry_price = float(history.iloc[entry_idx]["close"])
        exit_price = float(history.iloc[exit_idx]["close"])
        trade_return = _net_return(row.prediction, entry_price, exit_price, cost_bps, slippage_bps)
        start_equity = equity
        equity *= 1.0 + trade_return
        trades.append({
            "signal_timestamp": signal_time.isoformat(),
            "entry_timestamp": entry_time.isoformat(),
            "exit_timestamp": exit_time.isoformat(),
            "symbol": getattr(row, "symbol", ""),
            "horizon": row.horizon,
            "direction": row.prediction,
            "entry_price": entry_price,
            "exit_price": exit_price,
            "net_return": trade_return,
            "equity_before": start_equity,
            "equity_after": equity,
        })
        next_free_timestamp = exit_time

    if not trades:
        raise RuntimeError("No executable non-FLAT trades were produced")

    trade_frame = pd.DataFrame(trades)
    returns = trade_frame["net_return"]
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
        "prediction_file": str(prediction_path),
        "history_file": str(history_path),
    }
    return {"metrics": metrics, "trades": trades}


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the D-Predict V1 OOS portfolio backtest")
    parser.add_argument("prediction_file", type=Path)
    parser.add_argument("--history", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--cost-bps", type=float, default=10.0, help="Transaction cost in basis points per side")
    parser.add_argument("--slippage-bps", type=float, default=5.0, help="Slippage in basis points per side")
    parser.add_argument("--initial-capital", type=float, default=100_000.0)
    args = parser.parse_args()
    result = backtest(args.prediction_file, args.history, args.cost_bps, args.slippage_bps, args.initial_capital)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result["metrics"], indent=2))


if __name__ == "__main__":
    main()
