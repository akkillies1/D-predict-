"""Download daily history for symbols that are missing or incomplete locally.

This script is intentionally conservative: it writes raw CSV files and never
makes trading decisions. The dataset builder can later merge these bars with
PostgreSQL price_bars.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "historical"

DEFAULT_TICKERS = {
    "NIFTY": "^NSEI",
    "BANKNIFTY": "^NSEBANK",
}


def download_one(name: str, ticker: str, start: str, end: str | None) -> Path:
    OUT.mkdir(parents=True, exist_ok=True)
    kwargs = {"start": start, "auto_adjust": False, "progress": False}
    if end:
        kwargs["end"] = end
    frame = yf.download(ticker, **kwargs)
    if frame is None or frame.empty:
        raise RuntimeError(f"No Yahoo history returned for {name} ({ticker})")
    if isinstance(frame.columns, pd.MultiIndex):
        frame.columns = [str(col[0]).lower() for col in frame.columns]
    else:
        frame.columns = [str(col).lower() for col in frame.columns]
    required = ["open", "high", "low", "close", "volume"]
    missing = [col for col in required if col not in frame.columns]
    if missing:
        raise RuntimeError(f"Missing columns for {name}: {missing}")
    result = frame[required].copy()
    result.index = pd.to_datetime(result.index, utc=True)
    result.index.name = "timestamp"
    path = OUT / f"{name.lower()}.csv"
    result.to_csv(path)
    print(f"wrote {len(result):,} rows -> {path}")
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description="Download daily historical market data")
    parser.add_argument("--symbols", nargs="+", default=list(DEFAULT_TICKERS))
    parser.add_argument("--start", default="2010-01-01")
    parser.add_argument("--end", default=None)
    args = parser.parse_args()

    for symbol in args.symbols:
        key = symbol.upper()
        ticker = DEFAULT_TICKERS.get(key, key)
        download_one(key, ticker, args.start, args.end)


if __name__ == "__main__":
    main()
