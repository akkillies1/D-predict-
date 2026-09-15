"""Compatibility entry point for the real-data bootstrap validator.

The canonical implementation lives in ingest_market_data.py. It writes
normalized OHLCV plus a deterministic provenance manifest and never creates
synthetic rows.
"""
from __future__ import annotations

import argparse

from training.ingest_market_data import ingest


def main() -> None:
    parser = argparse.ArgumentParser(description="Download real daily market history")
    parser.add_argument("--symbols", nargs="+", required=True)
    parser.add_argument("--start", default="2010-01-01")
    parser.add_argument("--end")
    args = parser.parse_args()
    for symbol in args.symbols:
        path = ingest(symbol, args.start, args.end, force=True)
        print(f"DOWNLOADED {symbol.upper()} -> {path}")


if __name__ == "__main__":
    main()
