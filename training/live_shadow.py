"""Restart-safe live shadow session for market observation and delayed scoring.

This module is simulation-only. It accepts real observations and predictions from
an upstream market/model process, persists state atomically, and resolves a
prediction only when the executable entry/exit window has actually arrived. It
never places broker orders.
"""
from __future__ import annotations

import argparse
import json
import os
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import pandas as pd

HORIZON_ROWS = {"1d": 1, "3d": 3, "5d": 5}
VALID_CLASSES = {"DOWN", "FLAT", "UP"}
PROBABILITY_COLUMNS = (
    "market_probability_down",
    "market_probability_flat",
    "market_probability_up",
)


@dataclass(frozen=True)
class LiveShadowConfig:
    initial_capital: float = 100_000.0
    max_position_weight: float = 0.25
    cost_bps_per_side: float = 10.0
    slippage_bps_per_side: float = 5.0
    rolling_window: int = 100

    def validate(self) -> None:
        if self.initial_capital <= 0:
            raise ValueError("initial_capital must be positive")
        if not 0 < self.max_position_weight <= 1:
            raise ValueError("max_position_weight must be in (0, 1]")
        if self.cost_bps_per_side < 0 or self.slippage_bps_per_side < 0:
            raise ValueError("friction cannot be negative")
        if self.rolling_window < 1:
            raise ValueError("rolling_window must be positive")


def _utc(value: Any) -> pd.Timestamp:
    timestamp = pd.Timestamp(value)
    if timestamp.tzinfo is None:
        timestamp = timestamp.tz_localize("UTC")
    else:
        timestamp = timestamp.tz_convert("UTC")
    return timestamp


def _classify(return_value: float) -> str:
    if return_value > 0.001:
        return "UP"
    if return_value < -0.001:
        return "DOWN"
    return "FLAT"


def _confidence(prediction: dict) -> float:
    probabilities = {
        "DOWN": float(prediction["market_probability_down"]),
        "FLAT": float(prediction["market_probability_flat"]),
        "UP": float(prediction["market_probability_up"]),
    }
    return probabilities[prediction["prediction"]]


def _validate_prediction(prediction: dict) -> dict:
    required = {"timestamp", "symbol", "horizon", "prediction", *PROBABILITY_COLUMNS}
    missing = required - prediction.keys()
    if missing:
        raise ValueError(f"Prediction missing fields: {sorted(missing)}")
    prediction = dict(prediction)
    prediction["timestamp"] = _utc(prediction["timestamp"]).isoformat()
    prediction["symbol"] = str(prediction["symbol"]).strip().upper()
    prediction["horizon"] = str(prediction["horizon"]).lower()
    prediction["prediction"] = str(prediction["prediction"]).upper()
    if prediction["horizon"] not in HORIZON_ROWS:
        raise ValueError("Unsupported horizon; use 1d, 3d or 5d")
    if prediction["prediction"] not in VALID_CLASSES:
        raise ValueError("Prediction must be DOWN, FLAT or UP")
    probabilities = []
    for column in PROBABILITY_COLUMNS:
        value = float(prediction[column])
        if not 0 <= value <= 1:
            raise ValueError("Prediction probabilities must be between 0 and 1")
        prediction[column] = value
        probabilities.append(value)
    if abs(sum(probabilities) - 1.0) > 1e-6:
        raise ValueError("Prediction probabilities must sum to 1")
    return prediction


def _validate_bar(bar: dict) -> dict:
    required = {"timestamp", "symbol", "close"}
    missing = required - bar.keys()
    if missing:
        raise ValueError(f"Market bar missing fields: {sorted(missing)}")
    value = float(bar["close"])
    if value <= 0:
        raise ValueError("Market close must be positive")
    result = dict(bar)
    result["timestamp"] = _utc(bar["timestamp"]).isoformat()
    result["symbol"] = str(bar["symbol"]).strip().upper()
    result["close"] = value
    return result


def _net_return(direction: str, entry: float, exit_price: float, config: LiveShadowConfig) -> float:
    friction = 2 * (config.cost_bps_per_side + config.slippage_bps_per_side) / 10_000
    if direction == "UP":
        gross = exit_price / entry - 1
    elif direction == "DOWN":
        gross = entry / exit_price - 1
    else:
        return 0.0
    return gross - friction


def _new_state(config: LiveShadowConfig, session_id: str) -> dict:
    return {
        "schema_version": 2,
        "session_id": session_id,
        "mode": "LIVE_SHADOW",
        "created_at": pd.Timestamp.now(tz="UTC").isoformat(),
        "updated_at": pd.Timestamp.now(tz="UTC").isoformat(),
        "config": asdict(config),
        "initial_capital": config.initial_capital,
        "virtual_equity": config.initial_capital,
        "virtual_peak": config.initial_capital,
        "max_drawdown": 0.0,
        "bars": [],
        "predictions": [],
        "resolved_predictions": 0,
        "pending_predictions": 0,
        "correct_predictions": 0,
        "directional_calls": 0,
        "directional_correct": 0,
        "game_score": 0.0,
        "live_orders_sent": 0,
    }


def load_session(path: Path, config: LiveShadowConfig | None = None, session_id: str = "default") -> dict:
    config = config or LiveShadowConfig()
    config.validate()
    if not path.exists():
        return _new_state(config, session_id)
    state = json.loads(path.read_text(encoding="utf-8"))
    if state.get("mode") != "LIVE_SHADOW":
        raise ValueError("State file is not a live-shadow session")
    saved_config = LiveShadowConfig(**state["config"])
    saved_config.validate()
    return state


def save_session(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    state["updated_at"] = pd.Timestamp.now(tz="UTC").isoformat()
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(state, handle, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def _bar_frame(state: dict, symbol: str) -> pd.DataFrame:
    rows = [bar for bar in state["bars"] if bar["symbol"] == symbol]
    if not rows:
        return pd.DataFrame(columns=["timestamp", "close"])
    frame = pd.DataFrame(rows)
    frame["timestamp"] = pd.to_datetime(frame["timestamp"], utc=True)
    frame = frame.sort_values("timestamp").drop_duplicates("timestamp", keep="last")
    return frame.reset_index(drop=True)


def _refresh_pending(state: dict) -> None:
    config = LiveShadowConfig(**state["config"])
    for prediction in state["predictions"]:
        if prediction["outcome_status"] != "PENDING":
            continue
        frame = _bar_frame(state, prediction["symbol"])
        timestamps = list(frame["timestamp"])
        if not timestamps:
            continue
        prediction_time = _utc(prediction["timestamp"])
        matching = [index for index, value in enumerate(timestamps) if value == prediction_time]
        if not matching:
            continue
        position = matching[0]
        horizon = HORIZON_ROWS[prediction["horizon"]]
        entry_position = position + 1
        exit_position = entry_position + horizon
        if exit_position >= len(frame):
            continue

        entry_price = float(frame.iloc[entry_position]["close"])
        exit_price = float(frame.iloc[exit_position]["close"])
        realized_return = exit_price / entry_price - 1
        realized_class = _classify(realized_return)
        confidence = float(prediction["prediction_confidence"])
        correct = prediction["prediction"] == realized_class
        point_delta = confidence if correct else -confidence
        position_weight = 0.0
        portfolio_return = 0.0
        if prediction["prediction"] != "FLAT" and confidence > 1 / 3:
            edge = (confidence - 1 / 3) / (2 / 3)
            position_weight = min(config.max_position_weight, config.max_position_weight * edge)
            portfolio_return = position_weight * _net_return(prediction["prediction"], entry_price, exit_price, config)
            state["virtual_equity"] *= 1 + portfolio_return
            state["virtual_peak"] = max(state["virtual_peak"], state["virtual_equity"])

        state["resolved_predictions"] += 1
        state["correct_predictions"] += int(correct)
        if prediction["prediction"] in {"UP", "DOWN"}:
            state["directional_calls"] += 1
            state["directional_correct"] += int(prediction["prediction"] == realized_class)
        state["game_score"] += point_delta
        drawdown = state["virtual_equity"] / state["virtual_peak"] - 1
        state["max_drawdown"] = min(state["max_drawdown"], drawdown)
        prediction.update({
            "outcome_status": "SCORED",
            "entry_price": entry_price,
            "exit_price": exit_price,
            "realized_close": exit_price,
            "realized_return": realized_return,
            "realized_class": realized_class,
            "entry_timestamp": timestamps[entry_position].isoformat(),
            "exit_timestamp": timestamps[exit_position].isoformat(),
            "position_weight": position_weight,
            "portfolio_return": portfolio_return,
            "game_score": point_delta,
            "accuracy_after": state["correct_predictions"] / state["resolved_predictions"],
            "directional_accuracy_after": (
                state["directional_correct"] / state["directional_calls"]
                if state["directional_calls"] else None
            ),
            "equity_after": state["virtual_equity"],
            "drawdown_after": drawdown,
        })


def observe_bar(state: dict, bar: dict) -> dict:
    normalized = _validate_bar(bar)
    duplicate = next((existing for existing in state["bars"] if existing["symbol"] == normalized["symbol"] and existing["timestamp"] == normalized["timestamp"]), None)
    if duplicate is not None:
        if duplicate["close"] != normalized["close"]:
            raise ValueError("Market bar is immutable: existing timestamp has a different close")
        return state
    state["bars"].append(normalized)
    state["bars"].sort(key=lambda item: (item["timestamp"], item["symbol"]))
    _refresh_pending(state)
    return state


def record_prediction(state: dict, prediction: dict) -> dict:
    normalized = _validate_prediction(prediction)
    key = (normalized["symbol"], normalized["timestamp"])
    if any((row["symbol"], row["timestamp"]) == key for row in state["predictions"]):
        raise ValueError("Prediction timestamp must be unique per symbol")
    normalized.update({
        "prediction_confidence": _confidence(normalized),
        "outcome_status": "PENDING",
        "realized_close": None,
        "realized_return": None,
        "realized_class": None,
        "entry_timestamp": None,
        "exit_timestamp": None,
        "entry_price": None,
        "exit_price": None,
        "position_weight": 0.0,
        "portfolio_return": 0.0,
        "game_score": None,
        "accuracy_after": None,
        "directional_accuracy_after": None,
        "equity_after": state["virtual_equity"],
        "drawdown_after": state["virtual_equity"] / state["virtual_peak"] - 1,
    })
    state["predictions"].append(normalized)
    _refresh_pending(state)
    return state


def summary(state: dict) -> dict:
    resolved = int(state["resolved_predictions"])
    directional_calls = int(state["directional_calls"])
    return {
        "mode": "LIVE_SHADOW",
        "session_id": state["session_id"],
        "resolved_predictions": resolved,
        "pending_predictions": len([p for p in state["predictions"] if p["outcome_status"] == "PENDING"]),
        "accuracy": state["correct_predictions"] / resolved if resolved else None,
        "directional_accuracy": state["directional_correct"] / directional_calls if directional_calls else None,
        "directional_calls": directional_calls,
        "game_score": state["game_score"],
        "game_score_per_prediction": state["game_score"] / resolved if resolved else None,
        "initial_capital": state["initial_capital"],
        "final_virtual_equity": state["virtual_equity"],
        "virtual_return": state["virtual_equity"] / state["initial_capital"] - 1,
        "max_drawdown": state["max_drawdown"],
        "bars_observed": len(state["bars"]),
        "predictions_recorded": len(state["predictions"]),
        "live_orders_sent": 0,
        "config": state["config"],
    }


def run_events(path: Path, state_path: Path, config: LiveShadowConfig | None = None, session_id: str = "default") -> dict:
    state = load_session(state_path, config=config, session_id=session_id)
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        event = json.loads(line)
        event_type = event.pop("type", None)
        if event_type == "bar":
            observe_bar(state, event)
        elif event_type == "prediction":
            record_prediction(state, event)
        else:
            raise ValueError("Each event must have type=bar or type=prediction")
        save_session(state_path, state)
    save_session(state_path, state)
    return summary(state)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run a restart-safe D-Predict live shadow session")
    parser.add_argument("events", type=Path, help="JSONL stream containing bar/prediction events")
    parser.add_argument("--state", type=Path, required=True, help="Persistent shadow session JSON")
    parser.add_argument("--session-id", default="default")
    parser.add_argument("--initial-capital", type=float, default=100_000.0)
    parser.add_argument("--max-position-weight", type=float, default=0.25)
    parser.add_argument("--cost-bps", type=float, default=10.0)
    parser.add_argument("--slippage-bps", type=float, default=5.0)
    parser.add_argument("--rolling-window", type=int, default=100)
    args = parser.parse_args()
    config = LiveShadowConfig(args.initial_capital, args.max_position_weight, args.cost_bps, args.slippage_bps, args.rolling_window)
    print(json.dumps(run_events(args.events, args.state, config, args.session_id), indent=2))


if __name__ == "__main__":
    main()
