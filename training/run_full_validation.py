"""Bootstrap and persist D-Predict's real-data validation pipeline.

This is the first-run orchestrator for a from-scratch installation. It may
acquire real historical daily data when local history is missing, then runs
raw-data validation, point-in-time dataset construction, expanding walk-forward
prediction, independent executable-window outcome scoring, accuracy comparison,
and a causal backtest. Nothing is synthesized and nothing is promoted.

Expensive work is persisted under data/validation/. A deterministic fingerprint
of the exact historical inputs, dataset manifests, configuration, and pipeline
contract allows later invocations to reuse an unchanged validation bundle.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from training.backtest import backtest
from training.score_realized_outcomes import score_file as score_realized
from training.score_prediction_ledger import score_file as score_ledger

ROOT = Path(__file__).resolve().parents[1]
HIST_DIR = ROOT / "data" / "historical"
DATASET_DIR = ROOT / "data" / "training"
PRED_DIR = ROOT / "data" / "predictions"
VALIDATION_DIR = ROOT / "data" / "validation"
REGISTRY_PATH = VALIDATION_DIR / "registry.json"
LATEST_PATH = VALIDATION_DIR / "latest.json"
CONTRACT_VERSION = "full-validation-v1"

DEFAULT_SYMBOLS = ["RELIANCE", "HDFCBANK", "ICICIBANK", "INFY", "TCS", "SBIN"]
DEFAULT_HORIZONS = ["1d", "3d", "5d"]


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _fingerprint(files: list[Path], config: dict) -> str:
    payload = {"contract": CONTRACT_VERSION, "config": config, "files": []}
    for path in sorted(files):
        payload["files"].append({"path": str(path.relative_to(ROOT)), "sha256": _sha256(path)})
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()


def _run(module: str, *args: str) -> None:
    command = [sys.executable, "-m", module, *args]
    print("$", " ".join(command))
    subprocess.run(command, cwd=ROOT, check=True)


def _load_registry() -> dict:
    if not REGISTRY_PATH.exists():
        return {"schema_version": "validation-registry-v1", "bundles": []}
    try:
        value = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"schema_version": "validation-registry-v1", "bundles": []}
    if not isinstance(value, dict) or not isinstance(value.get("bundles"), list):
        return {"schema_version": "validation-registry-v1", "bundles": []}
    return value


def _write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def _find_reusable(fingerprint: str) -> dict | None:
    registry = _load_registry()
    for bundle in reversed(registry["bundles"]):
        if bundle.get("fingerprint") != fingerprint:
            continue
        paths = [ROOT / item for item in bundle.get("artifacts", [])]
        if all(path.exists() for path in paths):
            return bundle
    return None


def _download_missing(symbols: list[str], start: str, end: str | None, refresh: bool) -> None:
    missing = []
    for symbol in symbols:
        path = HIST_DIR / f"{symbol.lower()}.csv"
        if refresh or not path.exists():
            missing.append(symbol)
    if not missing:
        print("Historical data: local files already present; no download required")
        return
    args = ["--symbols", *missing, "--start", start]
    if end:
        args += ["--end", end]
    _run("training.download_historical", *args)


def _validate_raw(symbols: list[str]) -> None:
    for symbol in symbols:
        path = HIST_DIR / f"{symbol.lower()}.csv"
        _run("training.validate_history", str(path), "--frequency", "1d")


def _build_datasets(symbols: list[str], min_rows: int) -> None:
    _run("training.build_dataset", "--symbols", *symbols, "--min-rows", str(min_rows))


def _bundle_config(symbols: list[str], horizons: list[str], folds: int, min_rows: int, start: str, end: str | None) -> dict:
    return {
        "symbols": [s.upper() for s in symbols],
        "horizons": horizons,
        "folds": folds,
        "min_rows": min_rows,
        "history_start": start,
        "history_end": end,
        "contract_version": CONTRACT_VERSION,
    }


def run(
    symbols: list[str],
    horizons: list[str],
    folds: int = 5,
    min_rows: int = 500,
    start: str = "2010-01-01",
    end: str | None = None,
    refresh_data: bool = False,
    force: bool = False,
) -> dict:
    symbols = [symbol.upper() for symbol in symbols]
    horizons = [h.lower() for h in horizons]
    invalid = sorted(set(horizons) - {"1d", "3d", "5d"})
    if invalid:
        raise ValueError(f"unsupported horizons: {invalid}")
    if len(symbols) == 0:
        raise ValueError("at least one symbol is required")
    if folds < 2:
        raise ValueError("folds must be >= 2")
    if min_rows < 300:
        raise ValueError("min_rows must be >= 300 for walk-forward validation")

    HIST_DIR.mkdir(parents=True, exist_ok=True)
    DATASET_DIR.mkdir(parents=True, exist_ok=True)
    PRED_DIR.mkdir(parents=True, exist_ok=True)
    VALIDATION_DIR.mkdir(parents=True, exist_ok=True)

    _download_missing(symbols, start, end, refresh_data)
    history_files = [HIST_DIR / f"{symbol.lower()}.csv" for symbol in symbols]
    missing = [path for path in history_files if not path.exists()]
    if missing:
        raise FileNotFoundError(f"real historical artifacts missing: {missing}")

    config = _bundle_config(symbols, horizons, folds, min_rows, start, end)
    input_files = list(history_files)
    fingerprint = _fingerprint(input_files, config)
    reusable = None if force else _find_reusable(fingerprint)
    if reusable:
        print(f"REUSED validation bundle {reusable['bundle_id']} ({reusable['created_at']})")
        return reusable

    _validate_raw(symbols)
    _build_datasets(symbols, min_rows)

    records = []
    artifacts: list[Path] = []
    for symbol in symbols:
        for horizon in horizons:
            dataset_manifest = DATASET_DIR / f"{symbol.lower()}_{horizon}.manifest.json"
            if not dataset_manifest.exists():
                raise FileNotFoundError(f"dataset manifest missing after build: {dataset_manifest}")
            input_files.append(dataset_manifest)
            _run("training.walk_forward", "--symbols", symbol, "--horizons", horizon, "--folds", str(folds))
            ledger = PRED_DIR / f"{symbol.lower()}_{horizon}_walk_forward.csv"
            realized = PRED_DIR / f"{symbol.lower()}_{horizon}_realized.csv"
            raw_score = PRED_DIR / f"{symbol.lower()}_{horizon}_ledger_score.json"
            realized_summary = score_realized(ledger, HIST_DIR / f"{symbol.lower()}.csv", realized)
            ledger_summary = score_ledger(ledger)
            raw_score.write_text(json.dumps(ledger_summary, indent=2) + "\n", encoding="utf-8")

            if realized_summary.get("examples", 0) == 0:
                raise RuntimeError(f"No scored OOS outcomes for {symbol} {horizon}")

            bt = backtest(ledger, HIST_DIR / f"{symbol.lower()}.csv")
            backtest_path = VALIDATION_DIR / f"{symbol.lower()}_{horizon}_backtest.json"
            backtest_path.write_text(json.dumps(bt, indent=2, default=str) + "\n", encoding="utf-8")

            record = {
                "symbol": symbol,
                "horizon": horizon,
                "ledger": str(ledger.relative_to(ROOT)),
                "realized_ledger": str(realized.relative_to(ROOT)),
                "ledger_score": ledger_summary,
                "realized_score": realized_summary,
                "backtest": bt,
            }
            records.append(record)
            artifacts.extend([ledger, realized, raw_score, backtest_path])

    # The final fingerprint includes the dataset manifests actually used to
    # construct the OOS predictions. This is deliberately computed only after
    # the first successful build, so a changed feature/data contract invalidates
    # subsequent reuse.
    final_fingerprint = _fingerprint(input_files, config)
    bundle_id = f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{final_fingerprint[:12]}"
    bundle_dir = VALIDATION_DIR / "bundles" / bundle_id
    bundle_dir.mkdir(parents=True, exist_ok=True)

    report = {
        "schema_version": "validation-bundle-v1",
        "bundle_id": bundle_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "fingerprint": final_fingerprint,
        "config": config,
        "synthetic_data_used": False,
        "promotion": "NONE",
        "status": "VALIDATED",
        "records": records,
        "notes": [
            "First-run bootstrap uses real historical market data only.",
            "Independent outcome scoring uses next-bar entry plus requested trading-row horizon.",
            "This bundle is evaluation evidence, not model promotion.",
            "Future invocations reuse the bundle when its fingerprint is unchanged.",
        ],
    }
    report_path = bundle_dir / "report.json"
    _write_json(report_path, report)
    artifacts.append(report_path)

    # Store an immutable compact copy of the report in the bundle and maintain a
    # small registry/pointer for cheap startup lookups. Large CSV artifacts stay
    # in data/predictions rather than being duplicated into the bundle.
    registry = _load_registry()
    registry["bundles"].append({
        "bundle_id": bundle_id,
        "created_at": report["created_at"],
        "fingerprint": final_fingerprint,
        "status": "VALIDATED",
        "artifacts": [str(path.relative_to(ROOT)) for path in artifacts],
        "report": str(report_path.relative_to(ROOT)),
    })
    _write_json(REGISTRY_PATH, registry)
    _write_json(LATEST_PATH, {"bundle_id": bundle_id, "report": str(report_path.relative_to(ROOT)), "fingerprint": final_fingerprint})

    print(json.dumps(report, indent=2, default=str))
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="Bootstrap and persist D-Predict real-data validation")
    parser.add_argument("--symbols", nargs="+", default=DEFAULT_SYMBOLS)
    parser.add_argument("--horizons", nargs="+", default=DEFAULT_HORIZONS)
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--min-rows", type=int, default=500)
    parser.add_argument("--start", default="2010-01-01")
    parser.add_argument("--end", default=None)
    parser.add_argument("--refresh-data", action="store_true", help="redownload the selected real historical files")
    parser.add_argument("--force", action="store_true", help="ignore a reusable validation bundle")
    args = parser.parse_args()
    run(
        symbols=args.symbols,
        horizons=args.horizons,
        folds=args.folds,
        min_rows=args.min_rows,
        start=args.start,
        end=args.end,
        refresh_data=args.refresh_data,
        force=args.force,
    )


if __name__ == "__main__":
    main()
