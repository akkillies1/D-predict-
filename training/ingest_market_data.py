"""Bootstrap real historical market data with provenance and deterministic manifests.

The default free source is Yahoo Finance through the repository's existing
`yfinance` dependency. NSE-specific collectors can be added behind the same
canonical contract later. No synthetic rows are ever created.
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
RAW_DIR = ROOT / "data" / "historical"
MANIFEST_DIR = ROOT / "data" / "manifests"
SCHEMA_VERSION = "market-history-v1"
SYMBOL_MAP = {"NIFTY": "^NSEI", "BANKNIFTY": "^NSEBANK"}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _normalise(symbol: str, frame: pd.DataFrame) -> pd.DataFrame:
    if frame.empty:
        raise ValueError(f"no historical rows returned for {symbol}")
    if isinstance(frame.columns, pd.MultiIndex):
        frame.columns = [column[0] for column in frame.columns]
    frame = frame.rename(columns={str(c).lower(): str(c).lower() for c in frame.columns})
    required = {"open", "high", "low", "close", "volume"}
    missing = sorted(required - set(frame.columns.str.lower()))
    if missing:
        raise ValueError(f"historical source missing columns for {symbol}: {missing}")
    frame = frame.rename(columns={c: c.lower() for c in frame.columns})
    frame = frame.reset_index()
    timestamp_column = "date" if "date" in frame.columns else "datetime"
    if timestamp_column not in frame.columns:
        raise ValueError("historical source has no date/datetime column")
    frame = frame.rename(columns={timestamp_column: "timestamp"})
    frame["timestamp"] = pd.to_datetime(frame["timestamp"], utc=True, errors="raise")
    for column in ["open", "high", "low", "close", "volume"]:
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    frame = frame[["timestamp", "open", "high", "low", "close", "volume"]].dropna()
    frame = frame.sort_values("timestamp").drop_duplicates("timestamp", keep="last")
    if frame.empty or (frame["close"] <= 0).any():
        raise ValueError(f"invalid historical prices for {symbol}")
    frame["symbol"] = symbol.upper()
    frame["source"] = "yahoo_finance"
    frame["source_provider_symbol"] = SYMBOL_MAP.get(symbol.upper(), f"{symbol.upper()}.NS")
    return frame[["timestamp", "symbol", "open", "high", "low", "close", "volume", "source", "source_provider_symbol"]]


def ingest(symbol: str, start: str, end: str | None = None, force: bool = False) -> Path:
    symbol = symbol.upper()
    provider_symbol = SYMBOL_MAP.get(symbol, f"{symbol}.NS")
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST_DIR.mkdir(parents=True, exist_ok=True)
    output = RAW_DIR / f"{symbol.lower()}.csv"
    if output.exists() and not force:
        return output
    frame = yf.download(provider_symbol, start=start, end=end, interval="1d", auto_adjust=False, progress=False)
    normalized = _normalise(symbol, frame)
    normalized.to_csv(output, index=False)
    manifest = {
        "dataset_id": f"equity-daily-{symbol.lower()}",
        "dataset_type": "EQUITY_DAILY",
        "symbol": symbol,
        "source": "yahoo_finance",
        "source_url": "https://finance.yahoo.com/",
        "provider_symbol": provider_symbol,
        "coverage_start": normalized["timestamp"].min().isoformat(),
        "coverage_end": normalized["timestamp"].max().isoformat(),
        "frequency": "1d",
        "row_count": int(len(normalized)),
        "content_sha256": _sha256(output),
        "schema_version": SCHEMA_VERSION,
        "downloaded_at": datetime.now(timezone.utc).isoformat(),
        "synthetic_data_used": False,
    }
    (MANIFEST_DIR / f"{symbol.lower()}_daily.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description="Download real daily market history")
    parser.add_argument("--symbols", nargs="+", required=True)
    parser.add_argument("--start", default="2010-01-01")
    parser.add_argument("--end")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    for symbol in args.symbols:
        path = ingest(symbol, args.start, args.end, args.force)
        print(f"INGESTED {symbol.upper()} -> {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
