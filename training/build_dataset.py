"""Build point-in-time training examples from local PostgreSQL or CSV history.

The feature side only uses data available at timestamp T. Targets are created
from future prices and are never exposed to the model as features.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path

import numpy as np
import pandas as pd
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data" / "training"
HIST_DIR = ROOT / "data" / "historical"
load_dotenv(ROOT / ".env")

HORIZONS = {"1d": 1, "3d": 3, "5d": 5}
FEATURE_SET_VERSION = "market-v1"


def _rsi(close: pd.Series, period: int = 14) -> pd.Series:
    delta = close.diff()
    up = delta.clip(lower=0).rolling(period).mean()
    down = (-delta.clip(upper=0)).rolling(period).mean()
    rs = up / down.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def make_features(frame: pd.DataFrame) -> pd.DataFrame:
    df = frame.copy().sort_index()
    close = pd.to_numeric(df["close"], errors="coerce")
    high = pd.to_numeric(df["high"], errors="coerce")
    low = pd.to_numeric(df["low"], errors="coerce")
    volume = pd.to_numeric(df.get("volume", pd.Series(index=df.index, dtype=float)), errors="coerce")

    out = pd.DataFrame(index=df.index)
    out["return_1"] = close.pct_change(1)
    out["return_5"] = close.pct_change(5)
    out["return_20"] = close.pct_change(20)
    out["sma5_ratio"] = close / close.rolling(5).mean() - 1
    out["sma20_ratio"] = close / close.rolling(20).mean() - 1
    out["sma50_ratio"] = close / close.rolling(50).mean() - 1
    out["ema12_ratio"] = close / close.ewm(span=12, adjust=False).mean() - 1
    out["ema26_ratio"] = close / close.ewm(span=26, adjust=False).mean() - 1
    out["ema_spread"] = close.ewm(span=12, adjust=False).mean() / close.ewm(span=26, adjust=False).mean() - 1
    out["rsi14"] = _rsi(close)
    tr = pd.concat([(high - low), (high - close.shift()).abs(), (low - close.shift()).abs()], axis=1).max(axis=1)
    out["atr14_pct"] = tr.rolling(14).mean() / close
    out["volatility20"] = out["return_1"].rolling(20).std() * np.sqrt(252)
    vol_mean = volume.rolling(20).mean()
    vol_std = volume.rolling(20).std().replace(0, np.nan)
    out["volume_z20"] = (volume - vol_mean) / vol_std
    out["day_of_week"] = pd.Series(df.index.dayofweek, index=df.index)
    return out.replace([np.inf, -np.inf], np.nan)


def read_csv(symbol: str) -> pd.DataFrame | None:
    path = HIST_DIR / f"{symbol.lower()}.csv"
    if not path.exists():
        return None
    df = pd.read_csv(path, parse_dates=["timestamp"], index_col="timestamp")
    return df


def read_postgres(symbol: str) -> pd.DataFrame | None:
    url = os.getenv("DATABASE_URL")
    if not url:
        return None
    try:
        import psycopg2
    except ImportError:
        return None
    query = """
        select pb.market_timestamp as timestamp, pb.open, pb.high, pb.low, pb.close, pb.volume
        from price_bars pb
        join instruments i on i.instrument_id = pb.instrument_id
        where upper(i.symbol) = upper(%s) and pb.timeframe = '1d'
        order by pb.market_timestamp
    """
    try:
        with psycopg2.connect(url) as conn:
            df = pd.read_sql_query(query, conn, params=(symbol,), parse_dates=["timestamp"])
        if df.empty:
            return None
        return df.set_index("timestamp")
    except Exception as exc:
        print(f"database history unavailable for {symbol}: {exc}")
        return None


def normalize(frame: pd.DataFrame) -> pd.DataFrame:
    df = frame.copy()
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = [str(c[0]).lower() for c in df.columns]
    else:
        df.columns = [str(c).lower() for c in df.columns]
    if "timestamp" in df.columns:
        df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
        df = df.set_index("timestamp")
    elif not isinstance(df.index, pd.DatetimeIndex):
        df.index = pd.to_datetime(df.index, utc=True)
    return df[[c for c in ["open", "high", "low", "close", "volume"] if c in df.columns]].sort_index()


def build(symbol: str, min_rows: int = 500) -> None:
    raw = read_postgres(symbol)
    if raw is None or len(raw) < min_rows:
        csv = read_csv(symbol)
        if csv is not None and (raw is None or len(csv) > len(raw)):
            raw = csv
    if raw is None or len(raw) < min_rows:
        raise RuntimeError(
            f"Not enough history for {symbol}. Run: python training/download_historical.py --symbols {symbol}"
        )

    raw = normalize(raw)
    features = make_features(raw)
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    for horizon, days in HORIZONS.items():
        target = raw["close"].shift(-days) / raw["close"] - 1
        data = features.copy()
        data["target_return"] = target
        data["target_class"] = np.select(
            [target > 0.001, target < -0.001], ["UP", "DOWN"], default="FLAT"
        )
        data["symbol"] = symbol.upper()
        data["horizon"] = horizon
        data["feature_set_version"] = FEATURE_SET_VERSION
        data["source_cutoff"] = data.index
        data = data.dropna(subset=list(features.columns) + ["target_return"]).copy()
        path = DATA_DIR / f"{symbol.lower()}_{horizon}.csv"
        data.reset_index(names="timestamp").to_csv(path, index=False)
        print(f"{symbol} {horizon}: {len(data):,} point-in-time examples -> {path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build D-Predict historical training data")
    parser.add_argument("--symbols", nargs="+", default=["NIFTY", "BANKNIFTY"])
    parser.add_argument("--min-rows", type=int, default=500)
    args = parser.parse_args()
    for symbol in args.symbols:
        build(symbol.upper(), args.min_rows)


if __name__ == "__main__":
    main()
