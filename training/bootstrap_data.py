"""Bootstrap the local D-Predict research data lake.

Market history is real OHLCV. Option collection is explicitly a current chain
snapshot; it does not pretend to be expired-contract history. Textual research
is ingested separately through training.research_memory.
"""
from __future__ import annotations

import argparse

from training.ingest_market_data import ingest as ingest_market
from training.ingest_options import ingest as ingest_options


def main() -> None:
    parser = argparse.ArgumentParser(description="Bootstrap D-Predict real research data")
    parser.add_argument("--symbols", nargs="+", required=True)
    parser.add_argument("--start", default="2010-01-01")
    parser.add_argument("--end")
    parser.add_argument("--options", action="store_true", help="also collect current option-chain snapshots")
    args = parser.parse_args()

    for symbol in args.symbols:
        path = ingest_market(symbol, args.start, args.end)
        print(f"MARKET {symbol.upper()}: {path}")
        if args.options:
            try:
                manifest = ingest_options(symbol)
                print(f"OPTIONS {symbol.upper()}: {manifest['dataset_id']}")
            except Exception as exc:
                print(f"OPTIONS {symbol.upper()}: unavailable ({exc})")


if __name__ == "__main__":
    main()
