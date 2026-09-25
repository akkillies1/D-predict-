"""Tests for the automatic training scheduler.

Written as plain assert-based functions (same style as test_promotion_gate.py;
the ml image has no pytest, so run via the runner in this file's __main__ or
`python -c` discovery). The state-classification tests are pure; the coverage
test is a live-DB integration smoke check that self-skips when the database is
unreachable.
"""
from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from auto_train import MIN_HISTORY, _classify, coverage_report, discover_universe  # noqa: E402


def _bundle(training_end: pd.Timestamp | None):
    if training_end is None:
        return None
    return SimpleNamespace(
        training_end=training_end, model_version="market-v2-1d-histgb-test",
        promotion_ready=False, meta_ready=False,
    )


def test_classify_no_data_is_waiting():
    stats = {"daily_bars": 0, "latest_bar": None, "instrument_type": "EQUITY"}
    result = _classify("FOO.NS", "1d", stats, None)
    assert result["model_state"] == "WAITING_FOR_DATA", result
    assert result["reason"] == "NO_DAILY_HISTORY", result


def test_classify_scarce_history_is_insufficient_not_error():
    now = pd.Timestamp.now(tz="UTC")
    stats = {"daily_bars": 4, "latest_bar": now.to_pydatetime(), "instrument_type": "EQUITY"}
    result = _classify("VEEGALAND.NS", "1d", stats, None)
    assert result["model_state"] == "INSUFFICIENT_HISTORY", result
    assert result["reason"] == "INSUFFICIENT_HISTORY", result


def test_classify_enough_history_no_artifact_requires_training():
    now = pd.Timestamp.now(tz="UTC")
    stats = {"daily_bars": MIN_HISTORY + 10, "latest_bar": now.to_pydatetime(), "instrument_type": "EQUITY"}
    result = _classify("NEWCO.NS", "1d", stats, None)
    assert result["model_state"] == "TRAINING_REQUIRED", result
    assert result["reason"] == "NO_ARTIFACT", result


def test_classify_artifact_ahead_of_latest_bar_is_up_to_date():
    latest = pd.Timestamp("2026-09-22 18:30:00", tz="UTC")
    training_end = latest + pd.Timedelta(days=1)  # model trained past the newest bar
    stats = {"daily_bars": MIN_HISTORY + 10, "latest_bar": latest.to_pydatetime(), "instrument_type": "INDEX"}
    result = _classify("NIFTY", "1d", stats, _bundle(training_end))
    assert result["model_state"] == "UP_TO_DATE", result
    assert result["reason"] == "NO_NEW_DATA", result


def test_classify_new_bar_after_training_is_stale():
    latest = pd.Timestamp("2026-09-22 18:30:00", tz="UTC")
    training_end = latest - pd.Timedelta(days=2)  # a newer bar landed after training
    stats = {"daily_bars": MIN_HISTORY + 10, "latest_bar": latest.to_pydatetime(), "instrument_type": "INDEX"}
    result = _classify("NIFTY", "1d", stats, _bundle(training_end))
    assert result["model_state"] == "STALE", result
    assert result["reason"] == "NEW_DATA_AVAILABLE", result


def test_classify_reports_data_freshness_separately():
    fresh = pd.Timestamp.now(tz="UTC")
    stale = pd.Timestamp.now(tz="UTC") - pd.Timedelta(days=30)
    stats_base = {"daily_bars": MIN_HISTORY + 10, "instrument_type": "EQUITY"}
    live = _classify("A.NS", "1d", {**stats_base, "latest_bar": fresh.to_pydatetime()}, None)
    old = _classify("B.NS", "1d", {**stats_base, "latest_bar": stale.to_pydatetime()}, None)
    assert live["data_status"] == "LIVE", live
    assert old["data_status"] == "STALE", old


def test_coverage_report_against_live_db():
    try:
        universe = discover_universe()
    except Exception as error:  # database unreachable -> self-skip
        print(f"  SKIP test_coverage_report_against_live_db: {error}")
        return
    report = coverage_report(["1d"])
    assert report["ok"] is True
    assert report["summary"]["activeInstruments"] == len(universe)
    by_symbol = {item["symbol"]: item for item in report["instruments"]}
    # VEEGALAND has only a handful of daily bars, so it must be an honest skip,
    # never a fake READY and never an error.
    if "VEEGALAND.NS" in by_symbol:
        assert by_symbol["VEEGALAND.NS"]["model_state"] == "INSUFFICIENT_HISTORY", by_symbol["VEEGALAND.NS"]
    # Symbols with a trained artifact must classify as UP_TO_DATE or STALE.
    for symbol, item in by_symbol.items():
        if item["model_version"]:
            assert item["model_state"] in {"UP_TO_DATE", "STALE"}, (symbol, item)


def _run_all() -> int:
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_") and callable(value)]
    failures = 0
    for test in tests:
        try:
            test()
            print(f"PASS {test.__name__}")
        except Exception as error:
            failures += 1
            print(f"FAIL {test.__name__}: {error}")
    print(f"\n{len(tests) - failures}/{len(tests)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(_run_all())
