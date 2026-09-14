"""Point-in-time cross-instrument exposure attribution and correlation limits.

This module is a deterministic portfolio-risk layer. It attributes proposed
position weights by symbol/direction and prevents a new position from adding
too much exposure to instruments whose historical returns are highly
correlated with already accepted exposure. Correlations use only bars at or
before the candidate prediction timestamp.
"""
from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from pathlib import Path

import pandas as pd


@dataclass(frozen=True)
class ExposureConfig:
    max_symbol_weight: float = 0.50
    max_correlated_exposure: float = 0.50
    correlation_threshold: float = 0.70
    correlation_lookback: int = 60

    def validate(self) -> None:
        if not 0 < self.max_symbol_weight <= 1:
            raise ValueError("max_symbol_weight must be in (0, 1]")
        if not 0 < self.max_correlated_exposure <= 1:
            raise ValueError("max_correlated_exposure must be in (0, 1]")
        if not 0 <= self.correlation_threshold <= 1:
            raise ValueError("correlation_threshold must be in [0, 1]")
        if self.correlation_lookback < 2:
            raise ValueError("correlation_lookback must be at least 2")


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


def _point_in_time_returns(history: pd.DataFrame, timestamp: pd.Timestamp, lookback: int) -> pd.Series:
    eligible = history.loc[history["timestamp"] <= timestamp, ["timestamp", "close"]].copy()
    returns = eligible.set_index("timestamp")["close"].pct_change().dropna()
    return returns.tail(lookback)


def _correlation(candidate_history: pd.DataFrame, existing_history: pd.DataFrame, timestamp: pd.Timestamp, lookback: int) -> float | None:
    candidate = _point_in_time_returns(candidate_history, timestamp, lookback)
    existing = _point_in_time_returns(existing_history, timestamp, lookback)
    joined = pd.concat([candidate.rename("candidate"), existing.rename("existing")], axis=1).dropna()
    if len(joined) < 2:
        return None
    value = float(joined["candidate"].corr(joined["existing"]))
    return value if pd.notna(value) else None


def attribute_and_limit_exposure(
    risk_budget: pd.DataFrame,
    histories: dict[str, pd.DataFrame],
    config: ExposureConfig | None = None,
) -> pd.DataFrame:
    config = config or ExposureConfig()
    config.validate()
    required = {"timestamp", "symbol", "prediction", "position_weight"}
    missing = required - set(risk_budget.columns)
    if missing:
        raise ValueError(f"Risk budget missing columns: {sorted(missing)}")
    if risk_budget.empty:
        return pd.DataFrame()

    normalised = {str(symbol): _normalise_history(frame) for symbol, frame in histories.items()}
    frame = risk_budget.copy()
    frame["timestamp"] = pd.to_datetime(frame["timestamp"], utc=True)
    if frame[["timestamp", "symbol"]].duplicated().any():
        raise ValueError("Risk-budget timestamp/symbol pairs must be unique")
    frame["position_weight"] = pd.to_numeric(frame["position_weight"], errors="coerce")
    if frame["position_weight"].isna().any() or (frame["position_weight"] < 0).any():
        raise ValueError("position_weight must be non-negative numeric")

    accepted: dict[str, float] = {}
    rows: list[dict] = []

    for row in frame.sort_values(["timestamp", "symbol"]).itertuples(index=False):
        symbol = str(row.symbol)
        timestamp = pd.Timestamp(row.timestamp)
        base_weight = float(row.position_weight)
        proposed = min(base_weight, config.max_symbol_weight)
        correlations: dict[str, float] = {}
        correlated_exposure = 0.0
        status = "OK"

        if symbol not in normalised:
            proposed = 0.0
            status = "EXPOSURE_DATA_UNAVAILABLE"
        elif proposed > 0:
            for existing_symbol, existing_weight in accepted.items():
                if existing_symbol == symbol or existing_weight <= 0:
                    continue
                corr = _correlation(normalised[symbol], normalised[existing_symbol], timestamp, config.correlation_lookback)
                if corr is None:
                    continue
                correlations[existing_symbol] = corr
                if abs(corr) >= config.correlation_threshold:
                    correlated_exposure += existing_weight

            remaining_correlated = max(0.0, config.max_correlated_exposure - correlated_exposure)
            proposed = min(proposed, remaining_correlated)
            if proposed <= 0:
                status = "CORRELATED_EXPOSURE_LIMIT"

        accepted[symbol] = accepted.get(symbol, 0.0) + proposed
        total_gross = sum(accepted.values())
        rows.append({
            "timestamp": timestamp.isoformat(),
            "symbol": symbol,
            "prediction": str(row.prediction),
            "base_position_weight": base_weight,
            "position_weight": proposed,
            "gross_exposure_after": total_gross,
            "symbol_exposure_after": accepted[symbol],
            "correlated_exposure_before": correlated_exposure,
            "correlation_threshold": config.correlation_threshold,
            "correlations": correlations,
            "risk_status": status,
            "exposure_rule": "min(base_weight, symbol_cap, remaining_high_correlation_exposure)",
            "point_in_time_rule": "history_timestamp <= prediction_timestamp",
        })

    return pd.DataFrame(rows)


def _parse_history_args(values: list[str]) -> dict[str, pd.DataFrame]:
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
    parser = argparse.ArgumentParser(description="Attribute and limit cross-instrument portfolio exposure")
    parser.add_argument("risk_file", type=Path, help="CSV containing risk-budget rows")
    parser.add_argument("--history", action="append", required=True, help="SYMBOL=PATH; repeat for each instrument")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--max-symbol-weight", type=float, default=0.50)
    parser.add_argument("--max-correlated-exposure", type=float, default=0.50)
    parser.add_argument("--correlation-threshold", type=float, default=0.70)
    parser.add_argument("--correlation-lookback", type=int, default=60)
    args = parser.parse_args()
    config = ExposureConfig(
        max_symbol_weight=args.max_symbol_weight,
        max_correlated_exposure=args.max_correlated_exposure,
        correlation_threshold=args.correlation_threshold,
        correlation_lookback=args.correlation_lookback,
    )
    result = attribute_and_limit_exposure(pd.read_csv(args.risk_file), _parse_history_args(args.history), config)
    payload = {
        "config": asdict(config),
        "rows": result.to_dict(orient="records"),
        "total_gross_exposure": float(result["position_weight"].sum()) if not result.empty else 0.0,
        "correlated_limit_blocks": int((result["risk_status"] == "CORRELATED_EXPOSURE_LIMIT").sum()) if not result.empty else 0,
        "data_unavailable_blocks": int((result["risk_status"] == "EXPOSURE_DATA_UNAVAILABLE").sum()) if not result.empty else 0,
    }
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
