"""Ingest real option-chain snapshots with provenance.

This is a live/near-current options collector, not a historical expired-options
source. Expired-contract history must come from an exchange/archive source and
is intentionally not fabricated here.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "derivatives" / "options"

UNDERLYING_MAP = {"NIFTY": "^NSEI", "BANKNIFTY": "^NSEBANK"}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ingest(symbol: str) -> dict:
    symbol = symbol.upper()
    provider = UNDERLYING_MAP.get(symbol, f"{symbol}.NS")
    ticker = yf.Ticker(provider)
    expiries = list(ticker.options)
    if not expiries:
        raise RuntimeError(f"No option expiries returned for {symbol} ({provider})")
    retrieved = datetime.now(timezone.utc)
    written = []
    for expiry in expiries:
        chain = ticker.option_chain(expiry)
        for side, frame in (("CALL", chain.calls), ("PUT", chain.puts)):
            if frame is None or frame.empty:
                continue
            frame = frame.copy()
            frame["symbol"] = symbol
            frame["provider_symbol"] = provider
            frame["expiry"] = expiry
            frame["option_side"] = side
            frame["retrieved_at"] = retrieved.isoformat()
            path = OUT / symbol.lower() / expiry / f"{side.lower()}.csv"
            path.parent.mkdir(parents=True, exist_ok=True)
            frame.to_csv(path, index=False)
            written.append(path)
    manifest = {
        "dataset_id": f"options-snapshot-{symbol.lower()}-{retrieved.strftime('%Y%m%dT%H%M%SZ')}",
        "dataset_type": "OPTION_CHAIN_SNAPSHOT",
        "symbol": symbol,
        "source": "yahoo_finance",
        "source_url": "https://finance.yahoo.com/",
        "provider_symbol": provider,
        "retrieved_at": retrieved.isoformat(),
        "synthetic_data_used": False,
        "historical_expired_contracts": False,
        "files": [
            {"path": str(path.relative_to(ROOT)), "sha256": _sha256(path)} for path in written
        ],
    }
    manifest_path = OUT / symbol.lower() / f"manifest-{retrieved.strftime('%Y%m%dT%H%M%SZ')}.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description="Collect real option-chain snapshots")
    parser.add_argument("--symbols", nargs="+", required=True)
    args = parser.parse_args()
    for symbol in args.symbols:
        print(json.dumps(ingest(symbol), indent=2))


if __name__ == "__main__":
    main()
