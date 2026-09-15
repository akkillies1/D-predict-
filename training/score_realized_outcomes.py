"""Score prediction ledgers against independently loaded historical prices.

A prediction at T is evaluated on the same economic window used by execution:
entry at the next available bar, then hold for the requested trading-row
horizon. This prevents the validation layer from calling a signal correct on a
price move that the simulated trade could not actually capture.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd
from sklearn.metrics import accuracy_score, balanced_accuracy_score, log_loss

from .train_baseline import CLASS_MAP

ROOT = Path(__file__).resolve().parents[1]
HIST_DIR = ROOT / "data" / "historical"
PROBABILITY_COLUMNS = [
    "market_probability_down",
    "market_probability_flat",
    "market_probability_up",
]
HORIZON_ROWS = {"1d": 1, "3d": 3, "5d": 5}


def load_history(path: Path) -> pd.DataFrame:
    frame = pd.read_csv(path, parse_dates=["timestamp"])
    required = {"timestamp", "close"}
    missing = sorted(required - set(frame.columns))
    if missing:
        raise ValueError(f"historical data is missing columns: {', '.join(missing)}")
    frame["timestamp"] = pd.to_datetime(frame["timestamp"], utc=True)
    frame["close"] = pd.to_numeric(frame["close"], errors="coerce")
    frame = frame.dropna(subset=["timestamp", "close"]).sort_values("timestamp")
    if frame["timestamp"].duplicated().any():
        raise ValueError("historical data contains duplicate timestamps")
    if (frame["close"] <= 0).any():
        raise ValueError("historical close prices must be positive")
    return frame.reset_index(drop=True)


def _classify(return_value: float) -> str:
    if return_value > 0.001:
        return "UP"
    if return_value < -0.001:
        return "DOWN"
    return "FLAT"


def _validate_ledger(frame: pd.DataFrame) -> None:
    required = {"timestamp", "symbol", "horizon", "prediction", *PROBABILITY_COLUMNS}
    missing = sorted(required - set(frame.columns))
    if missing:
        raise ValueError(f"prediction ledger is missing columns: {', '.join(missing)}")
    if frame.empty:
        raise ValueError("prediction ledger is empty")
    horizons = frame["horizon"].astype(str).str.lower()
    if not horizons.isin(HORIZON_ROWS).all():
        bad = sorted(set(horizons) - set(HORIZON_ROWS))
        raise ValueError(f"unsupported prediction horizons: {bad}")
    allowed = set(CLASS_MAP)
    values = set(frame["prediction"].dropna().astype(str))
    unknown = sorted(values - allowed)
    if unknown:
        raise ValueError(f"unknown prediction values: {unknown}")
    probabilities = frame[PROBABILITY_COLUMNS].apply(pd.to_numeric, errors="coerce")
    if probabilities.isna().any().any():
        raise ValueError("prediction probabilities contain missing/non-numeric values")
    if (probabilities < 0).any().any() or (probabilities > 1).any().any():
        raise ValueError("prediction probabilities must be between 0 and 1")
    if ((probabilities.sum(axis=1) - 1).abs() > 1e-6).any():
        raise ValueError("prediction probabilities must sum to 1")


def score_file(ledger_path: Path, history_path: Path, output_path: Path | None = None) -> dict:
    ledger = pd.read_csv(ledger_path, parse_dates=["timestamp"])
    ledger["timestamp"] = pd.to_datetime(ledger["timestamp"], utc=True)
    _validate_ledger(ledger)
    history = load_history(history_path)
    timestamps = pd.DatetimeIndex(history["timestamp"])

    rows: list[dict] = []
    for record in ledger.to_dict("records"):
        prediction_time = pd.Timestamp(record["timestamp"])
        positions = timestamps.get_indexer([prediction_time])
        position = int(positions[0])
        if position < 0:
            raise ValueError(
                f"prediction timestamp {prediction_time.isoformat()} is absent from historical source {history_path}"
            )

        horizon = str(record["horizon"]).lower()
        entry_position = position + 1
        exit_position = entry_position + HORIZON_ROWS[horizon]
        scored = dict(record)
        if exit_position >= len(history):
            scored.update({
                "outcome_status": "PENDING",
                "entry_timestamp": None,
                "entry_close": None,
                "exit_timestamp": None,
                "realized_close": None,
                "realized_return": None,
                "realized_class": None,
            })
        else:
            entry_close = float(history.iloc[entry_position]["close"])
            exit_close = float(history.iloc[exit_position]["close"])
            realized_return = exit_close / entry_close - 1.0
            scored.update({
                "outcome_status": "SCORED",
                "entry_timestamp": history.iloc[entry_position]["timestamp"].isoformat(),
                "entry_close": entry_close,
                "exit_timestamp": history.iloc[exit_position]["timestamp"].isoformat(),
                "realized_close": exit_close,
                "realized_return": realized_return,
                "realized_class": _classify(realized_return),
            })
        rows.append(scored)

    result = pd.DataFrame(rows)
    scored = result[result["outcome_status"] == "SCORED"].copy()
    if scored.empty:
        summary = {
            "prediction_file": str(ledger_path),
            "history_file": str(history_path),
            "examples": 0,
            "pending": int((result["outcome_status"] == "PENDING").sum()),
            "economic_window": "next_bar_entry_plus_horizon_rows",
        }
    else:
        y_true = scored["realized_class"].map(CLASS_MAP)
        y_pred = scored["prediction"].map(CLASS_MAP)
        proba = scored[PROBABILITY_COLUMNS].to_numpy(dtype=float)
        summary = {
            "prediction_file": str(ledger_path),
            "history_file": str(history_path),
            "symbol": str(scored["symbol"].iloc[0]).upper(),
            "horizon": str(scored["horizon"].iloc[0]).lower(),
            "examples": int(len(scored)),
            "pending": int((result["outcome_status"] == "PENDING").sum()),
            "accuracy": round(float(accuracy_score(y_true, y_pred)), 6),
            "balanced_accuracy": round(float(balanced_accuracy_score(y_true, y_pred)), 6),
            "log_loss": round(float(log_loss(y_true, proba, labels=[0, 1, 2])), 6),
            "realized_mean_return": round(float(scored["realized_return"].mean()), 8),
            "economic_window": "next_bar_entry_plus_horizon_rows",
        }

    if output_path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        result.to_csv(output_path, index=False)
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="Score D-Predict predictions on the executable economic window")
    parser.add_argument("ledger", type=Path)
    parser.add_argument("--history", type=Path, default=None)
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()

    ledger = pd.read_csv(args.ledger, nrows=1)
    symbol = str(ledger["symbol"].iloc[0]).lower() if "symbol" in ledger.columns else ""
    history_path = args.history or (HIST_DIR / f"{symbol}.csv")
    summary = score_file(args.ledger, history_path, args.output)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
