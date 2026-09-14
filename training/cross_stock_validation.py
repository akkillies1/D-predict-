"""Cross-stock point-in-time validation for D-Predict.

The harness evaluates existing walk-forward prediction ledgers without changing
the production model. At every prediction timestamp, market state and benchmark
/sector context are computed only from observations available at that timestamp.
Trade metrics use the executable next-bar entry window.
"""
from __future__ import annotations

import argparse
import json
from dataclasses import dataclass, asdict
from pathlib import Path

import numpy as np
import pandas as pd

from .build_dataset import make_features
from .context_features import ContextSpec, build_context_row
from .market_state import classify_market_state

ROOT = Path(__file__).resolve().parents[1]
HIST_DIR = ROOT / "data" / "historical"
PRED_DIR = ROOT / "data" / "predictions"
REPORT_DIR = ROOT / "data" / "reports"

DEFAULT_SYMBOLS = ["SBI", "HDFCBANK", "RELIANCE", "ONGC", "LT", "ADANIPORTS"]
DEFAULT_BENCHMARK = "NIFTY"
SECTORS = {
    "SBI": ("NIFTY", "BANKING"),
    "HDFCBANK": ("NIFTY", "BANKING"),
    "RELIANCE": ("NIFTY", "ENERGY"),
    "ONGC": ("NIFTY", "ENERGY"),
    "LT": ("NIFTY", "INFRASTRUCTURE"),
    "ADANIPORTS": ("NIFTY", "INFRASTRUCTURE"),
}


@dataclass(frozen=True)
class HarnessConfig:
    horizon: str = "1d"
    cost_bps_per_side: float = 10.0
    slippage_bps_per_side: float = 5.0


def _load_history(symbol: str) -> pd.DataFrame:
    path = HIST_DIR / f"{symbol.lower()}.csv"
    if not path.exists():
        raise FileNotFoundError(path)
    df = pd.read_csv(path, parse_dates=["timestamp"])
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
    df = df.sort_values("timestamp").drop_duplicates("timestamp").set_index("timestamp")
    required = {"open", "high", "low", "close"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"{symbol}: missing history columns {sorted(missing)}")
    if (pd.to_numeric(df["close"], errors="coerce") <= 0).any():
        raise ValueError(f"{symbol}: non-positive close")
    return df


def _load_predictions(symbol: str, horizon: str) -> pd.DataFrame:
    path = PRED_DIR / f"{symbol.lower()}_{horizon}_walk_forward.csv"
    if not path.exists():
        raise FileNotFoundError(path)
    df = pd.read_csv(path, parse_dates=["timestamp"])
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
    return df.sort_values("timestamp").drop_duplicates("timestamp")


def _confidence(row: pd.Series) -> float:
    return float(max(row["market_probability_down"], row["market_probability_flat"], row["market_probability_up"]))


def _trade_event(history: pd.DataFrame, timestamp: pd.Timestamp, horizon: str, direction: str, cost_bps: float, slippage_bps: float) -> dict:
    days = {"1d": 1, "3d": 3, "5d": 5}[horizon]
    future = history.loc[history.index > timestamp]
    if direction == "FLAT":
        return {"status": "NO_TRADE"}
    if len(future) <= days:
        return {"status": "PENDING"}
    entry = future.iloc[0]
    exit_row = future.iloc[days]
    entry_px = float(entry["close"])
    exit_px = float(exit_row["close"])
    raw_return = exit_px / entry_px - 1.0
    gross = raw_return if direction == "UP" else -raw_return
    friction = 2.0 * (cost_bps + slippage_bps) / 10000.0
    net = gross - friction
    path = future.loc[(future.index >= entry.name) & (future.index <= exit_row.name)]
    closes = pd.to_numeric(path["close"], errors="coerce")
    if direction == "UP":
        mae = float(closes.min() / entry_px - 1.0)
        mfe = float(closes.max() / entry_px - 1.0)
    else:
        mae = float(-(closes.max() / entry_px - 1.0))
        mfe = float(-(closes.min() / entry_px - 1.0))
    return {
        "status": "SCORED",
        "entry_timestamp": entry.name.isoformat(),
        "entry_price": entry_px,
        "exit_timestamp": exit_row.name.isoformat(),
        "exit_price": exit_px,
        "trade_return": float(net),
        "gross_return": float(gross),
        "transaction_cost_slippage": float(friction),
        "mae": mae,
        "mfe": mfe,
        "direction_correct": bool(gross > 0),
        "profitable_after_friction": bool(net > 0),
    }


def _market_state_row(history: pd.DataFrame, timestamp: pd.Timestamp) -> dict:
    upto = history.loc[history.index <= timestamp]
    features = make_features(upto).iloc[-1].to_dict() if len(upto) else {}
    result = classify_market_state(features)
    values = result.to_dict()
    return {
        "market_state": values["state"],
        "trend_strength": values["trend_strength"],
        "volatility_regime": values["volatility_regime"],
        "regime_confidence": values["regime_confidence"],
        "state_reason_codes": json.dumps(values["reason_codes"]),
    }


def evaluate_symbol(symbol: str, config: HarnessConfig) -> tuple[pd.DataFrame, dict]:
    history = _load_history(symbol)
    predictions = _load_predictions(symbol, config.horizon)
    benchmark_name, sector = SECTORS.get(symbol, (DEFAULT_BENCHMARK, None))
    benchmark = _load_history(benchmark_name)

    # Until native sector-index histories exist, use a clearly labelled peer proxy.
    # It is still causal and never substitutes future stock outcomes into features.
    sector_frame = None
    sector_proxy_symbol = None
    for candidate, (_, candidate_sector) in SECTORS.items():
        if candidate_sector == sector and candidate != symbol:
            candidate_path = HIST_DIR / f"{candidate.lower()}.csv"
            if candidate_path.exists():
                sector_proxy_symbol = candidate
                sector_frame = _load_history(candidate)
                break

    rows = []
    for _, pred in predictions.iterrows():
        ts = pd.Timestamp(pred["timestamp"])
        if ts not in history.index:
            continue
        state = _market_state_row(history, ts)
        context = build_context_row(
            ts,
            history["close"],
            benchmark["close"],
            ContextSpec(benchmark_name, sector),
            sector_frame["close"] if sector_frame is not None else None,
        ).to_dict()
        direction = str(pred["prediction"])
        confidence = _confidence(pred)
        trade = _trade_event(history, ts, config.horizon, direction, config.cost_bps_per_side, config.slippage_bps_per_side)
        rows.append({
            **pred.to_dict(),
            **state,
            **context,
            "sector_proxy_symbol": sector_proxy_symbol,
            "direction": direction,
            "forecast_confidence": confidence,
            "executable_trade_status": trade["status"],
            **trade,
        })

    result = pd.DataFrame(rows)
    scored = result[result["executable_trade_status"] == "SCORED"] if not result.empty else result
    summary = {
        "symbol": symbol,
        "horizon": config.horizon,
        "examples": int(len(result)),
        "scored_trades": int(len(scored)),
        "pending": int((result["executable_trade_status"] == "PENDING").sum()) if not result.empty else 0,
        "sector_context": sector,
        "sector_proxy_symbol": sector_proxy_symbol,
    }
    if not scored.empty:
        summary.update({
            "directional_accuracy": float(scored["direction_correct"].mean()),
            "executable_trade_accuracy": float(scored["profitable_after_friction"].mean()),
            "mean_trade_return": float(scored["trade_return"].mean()),
            "median_trade_return": float(scored["trade_return"].median()),
            "mae_mean": float(scored["mae"].mean()),
            "mfe_mean": float(scored["mfe"].mean()),
        })
    else:
        summary.update({"directional_accuracy": None, "executable_trade_accuracy": None, "mean_trade_return": None, "median_trade_return": None, "mae_mean": None, "mfe_mean": None})
    return result, summary


def run(symbols: list[str], config: HarnessConfig) -> dict:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    all_rows: list[pd.DataFrame] = []
    summaries = []
    failures = []
    for symbol in symbols:
        try:
            frame, summary = evaluate_symbol(symbol.upper(), config)
            all_rows.append(frame)
            summaries.append(summary)
        except (FileNotFoundError, ValueError, RuntimeError) as exc:
            failures.append({"symbol": symbol.upper(), "error": str(exc)})

    details = pd.concat(all_rows, ignore_index=True) if all_rows else pd.DataFrame()
    detail_path = REPORT_DIR / f"cross_stock_{config.horizon}_details.csv"
    details.to_csv(detail_path, index=False)
    report = {
        "config": asdict(config),
        "symbols": symbols,
        "summaries": summaries,
        "failures": failures,
        "detail_file": str(detail_path),
        "data_policy": "local point-in-time history only; no external outcomes or news",
        "sector_policy": "sector field is a causal peer proxy until native sector-index history is available",
    }
    report_path = REPORT_DIR / f"cross_stock_{config.horizon}_report.json"
    report_path.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
    print(json.dumps(report, indent=2, default=str))
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="Run D-Predict cross-stock point-in-time validation")
    parser.add_argument("--symbols", nargs="+", default=DEFAULT_SYMBOLS)
    parser.add_argument("--horizon", choices=["1d", "3d", "5d"], default="1d")
    parser.add_argument("--cost-bps-per-side", type=float, default=10.0)
    parser.add_argument("--slippage-bps-per-side", type=float, default=5.0)
    args = parser.parse_args()
    if args.cost_bps_per_side < 0 or args.slippage_bps_per_side < 0:
        raise SystemExit("friction cannot be negative")
    run([s.upper() for s in args.symbols], HarnessConfig(args.horizon, args.cost_bps_per_side, args.slippage_bps_per_side))


if __name__ == "__main__":
    main()
