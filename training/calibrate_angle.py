"""Calibrate p(theta): realized continuation frequency per trend-angle bin.

The proposal on the table was a closed-form angle->probability map, e.g.
p = theta / (pi/2) or variants of (1 + cos theta) / 2. Those are assumptions,
not measurements. This script keeps the geometry but replaces the assumed
probability with the realized one:

- trend angle theta per rolling window, made scale-free by normalizing the
  OLS slope of log-prices by the window's own daily return volatility:
  tan(theta) = slope / sigma. (An angle drawn on a chart depends on the
  chart's aspect ratio; this definition does not.)
- every window is then scored against what the market ACTUALLY did over the
  next `horizon` sessions, pooled across symbols and binned into 15-degree
  buckets, reporting measured P(up) with n per bin, side by side with the
  assumed linear maps.

It is a diagnostic, not an alert rule: if the pooled information coefficient
of theta against the forward return is indistinguishable from zero, the angle
carries no usable probability and nothing downstream may claim it does.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

from .build_dataset import normalize, read_postgres

ROOT = Path(__file__).resolve().parents[1]
REPORT_DIR = ROOT / "data" / "reports"
BIN_DEGREES = 15
MIN_WINDOW = 20


def window_theta(log_closes: np.ndarray, daily_returns: np.ndarray) -> float:
    """Scale-free trend angle in degrees for one window. tan(theta) is the
    OLS slope of log-price per bar divided by the window's return std."""
    n = len(log_closes)
    if n < 3:
        return 0.0
    x = np.arange(n, dtype=float)
    slope = float(np.polyfit(x, log_closes, 1)[0])
    sigma = float(np.std(daily_returns, ddof=1)) if len(daily_returns) >= 2 else 0.0
    if sigma <= 0 or not math.isfinite(sigma):
        return 0.0
    return math.degrees(math.atan(slope / sigma))


def rolling_signals(closes: np.ndarray, window: int, horizon: int) -> tuple[np.ndarray, np.ndarray]:
    """(theta_deg, forward_return) aligned per window end, for every bar that
    has a full window behind it and a full horizon ahead (no peeking)."""
    log_closes = np.log(closes.astype(float))
    returns = np.diff(log_closes)
    thetas, fwd = [], []
    for end in range(window - 1, len(closes) - horizon):
        window_log = log_closes[end - window + 1 : end + 1]
        window_returns = returns[end - window + 1 : end]
        thetas.append(window_theta(window_log, window_returns))
        fwd.append(float(closes[end + horizon] / closes[end] - 1.0))
    return np.asarray(thetas), np.asarray(fwd)


def assumed_linear_maps(theta_deg: float) -> dict[str, float]:
    """The two closed-form proposals, evaluated honestly: the shifted-linear
    reading of p = d_theta/(pi/2) (0.5 at flat, 1 at +90 deg) and the raw
    literal theta/90, which is only a probability for theta in [0, 90]."""
    return {
        "linear_shift": max(0.0, min(1.0, 0.5 + theta_deg / 180.0)),
        "raw_theta_over_90": theta_deg / 90.0,
    }


def continuation_bins(thetas: np.ndarray, fwd: np.ndarray, bin_degrees: int = BIN_DEGREES) -> list[dict]:
    rows = []
    for lo in range(-90, 90, bin_degrees):
        hi = lo + bin_degrees
        mask = (thetas >= lo) & (thetas < hi) if lo < 90 - 1e-9 else (thetas >= lo) & (thetas <= hi)
        subset = fwd[mask]
        n = int(len(subset))
        midpoint = lo + bin_degrees / 2
        assumed = assumed_linear_maps(midpoint)
        rows.append({
            "bin_deg": f"{lo} to {hi}",
            "midpoint_deg": midpoint,
            "n": n,
            "measured_p_up": round(float(np.mean(subset > 0)), 4) if n else None,
            "mean_fwd_return": round(float(np.mean(subset)), 5) if n else None,
            "assumed_linear_shift": round(assumed["linear_shift"], 4),
            "assumed_raw_theta_over_90": round(assumed["raw_theta_over_90"], 4),
        })
    return rows


def rank_ic(thetas: np.ndarray, fwd: np.ndarray) -> float:
    if len(thetas) < 3 or np.std(thetas) == 0 or np.std(fwd) == 0:
        return 0.0
    rho = spearmanr(thetas, fwd).statistic
    return 0.0 if not math.isfinite(rho) else float(rho)


def calibrate_symbol(symbol: str, window: int, horizon: int) -> dict:
    frame = read_postgres(symbol)
    if frame is None:
        raise FileNotFoundError(f"no stored daily bars for {symbol}")
    frame = normalize(frame)
    closes = frame["close"].to_numpy(dtype=float)
    if len(closes) < window + horizon + 20:
        raise FileNotFoundError(f"{symbol}: {len(closes)} bars, need at least {window + horizon + 20}")
    thetas, fwd = rolling_signals(closes, window, horizon)
    return {
        "symbol": symbol,
        "bars": len(closes),
        "windows": len(thetas),
        "rank_ic": round(rank_ic(thetas, fwd), 4),
        "bins": continuation_bins(thetas, fwd),
        "_thetas": thetas,
        "_fwd": fwd,
    }


def _pooled_pooled_bins(reports: list[dict]) -> list[dict]:
    thetas = np.concatenate([r["_thetas"] for r in reports])
    fwd = np.concatenate([r["_fwd"] for r in reports])
    return continuation_bins(thetas, fwd)


def _verdict(reports: list[dict], horizon: int) -> dict:
    thetas = np.concatenate([r["_thetas"] for r in reports])
    fwd = np.concatenate([r["_fwd"] for r in reports])
    pooled_ic = rank_ic(thetas, fwd)
    per_symbol_ics = [r["rank_ic"] for r in reports]
    sign_agreement = (
        max(
            sum(1 for ic in per_symbol_ics if ic > 0),
            sum(1 for ic in per_symbol_ics if ic < 0),
        )
        / len(per_symbol_ics)
        if per_symbol_ics
        else 0.0
    )
    bins = _pooled_pooled_bins(reports)
    covered = [b for b in bins if b["n"] >= 30]
    calibration_gap = (
        float(np.mean([abs(b["measured_p_up"] - b["assumed_linear_shift"]) for b in covered]))
        if covered
        else None
    )
    return {
        "pooled_rank_ic": round(pooled_ic, 4),
        "per_symbol_ic_range": [min(per_symbol_ics), max(per_symbol_ics)] if per_symbol_ics else None,
        "ic_sign_agreement": round(sign_agreement, 3),
        "mean_abs_gap_measured_vs_linear_shift": round(calibration_gap, 4) if calibration_gap is not None else None,
        "usable_as_alert_rule": abs(pooled_ic) >= 0.02 and sign_agreement >= 0.75,
        "note": (
            "verdict is from REAL realized bars only; if usable_as_alert_rule is false the angle "
            "carries no validated probability and no formula may be presented as one"
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Measure realized continuation frequency per trend-angle bin")
    parser.add_argument("--symbols", nargs="+", default=None, help="default: all active instruments")
    parser.add_argument("--window", type=int, default=MIN_WINDOW)
    parser.add_argument("--horizon", type=int, default=5)
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()

    symbols = args.symbols
    if not symbols:
        import os

        import psycopg2

        url = os.getenv("DATABASE_URL")
        with psycopg2.connect(url) as conn, conn.cursor() as cur:
            cur.execute("select symbol from instruments where is_active = true order by symbol")
            symbols = [row[0] for row in cur.fetchall()]

    reports, skipped = [], []
    for symbol in symbols:
        try:
            reports.append(calibrate_symbol(symbol.upper(), args.window, args.horizon))
        except (FileNotFoundError, RuntimeError) as exc:
            skipped.append({"symbol": symbol.upper(), "reason": str(exc)})

    if not reports:
        print(json.dumps({"ok": False, "skipped": skipped}))
        return

    result = {
        "ok": True,
        "method": f"theta=atan(OLS_slope(log close)/sigma_daily) over {args.window}-bar windows; realized sign over next {args.horizon} sessions",
        "window": args.window,
        "horizon": args.horizon,
        "symbols": [r["symbol"] for r in reports],
        "skipped": skipped,
        "pooled_bins": _pooled_pooled_bins(reports),
        "per_symbol": [{k: v for k, v in r.items() if not k.startswith("_")} for r in reports],
        "verdict": _verdict(reports, args.horizon),
    }
    output = args.output or REPORT_DIR / "angle_calibration.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"verdict": result["verdict"], "pooled_bins": result["pooled_bins"], "report_file": str(output)}, indent=2))


if __name__ == "__main__":
    main()
