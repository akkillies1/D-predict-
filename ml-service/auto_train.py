"""Automatic, instrument-agnostic training scheduler for D-Predict.

This module is the operational layer the spec asks for: it discovers the active
universe from the canonical instruments table, gates each instrument on data
sufficiency and artifact freshness, and retrains *only when required* — reusing
the exact production training path (``_training_frame`` / ``_fit_bundle`` /
``_save_bundle``) so no algorithm is duplicated.

Design contracts enforced here:
  * No hardcoded symbol list — the universe is ``instruments where is_active``.
  * Per-instrument failure isolation — one bad instrument never fails the batch.
  * Incremental — an instrument whose latest bar is not newer than its artifact
    training cutoff is reported UP_TO_DATE and skipped, never retrained.
  * Insufficient data is a SKIP with a reason, never a 503 or a fake artifact.
  * Every trained version is appended to ``model_registry``; nothing overwrites
    an existing model. Because no promotion pipeline is wired yet, a model that
    passes the gate lands as CANDIDATE and one that fails lands as DORMANT —
    never PRODUCTION — so the registry cannot overstate what the system trusts.

It imports the live training helpers from ``app``. ``app`` imports this module
lazily (inside its endpoints / scheduler) to avoid a circular import.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from types import SimpleNamespace

import pandas as pd
from fastapi import HTTPException

from app import (
    DEFAULT_HORIZON,
    FEATURE_SET_VERSION,
    MIN_HISTORY,
    SUPPORTED_HORIZONS,
    _db,
    _fit_bundle,
    _load_daily,
    _save_bundle,
    _training_frame,
)

DATA_STALE_DAYS = 3  # daily bars older than this are reported as DATA_STALE.


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, pd.Timestamp):
        return value.tz_convert("UTC").isoformat() if value.tzinfo else value.tz_localize("UTC").isoformat()
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat()
    return str(value)


def discover_universe() -> list[dict]:
    """Return the active instrument universe: symbol + canonical type."""
    sql = """
        select i.symbol, i.instrument_type
        from instruments i
        where i.is_active = true
        order by i.symbol
    """
    with _db() as conn:
        cursor = conn.cursor()
        cursor.execute(sql)
        rows = cursor.fetchall()
    return [{"symbol": row[0], "instrument_type": row[1]} for row in rows]


def _daily_bar_stats() -> dict[str, dict]:
    """Latest daily bar, the newest *labelable* bar, and usable-bar count for
    every active instrument, in one query. The newest daily bar has no next-day
    outcome yet, so a model trained through the previous bar is genuinely up to
    date — staleness must be judged against the labelable bar, not the raw last
    bar, or every instrument would look stale forever and retrain each tick."""
    sql = """
        select i.symbol,
               count(pb.id) as daily_bars,
               max(pb.market_timestamp) as latest_bar,
               (select pb2.market_timestamp
                  from price_bars pb2
                 where pb2.instrument_id = i.instrument_id and pb2.timeframe = '1d'
                 order by pb2.market_timestamp desc
                 limit 1 offset 1) as labelable_bar
        from instruments i
        left join price_bars pb on pb.instrument_id = i.instrument_id and pb.timeframe = '1d'
        where i.is_active = true
        group by i.symbol, i.instrument_id
    """
    with _db() as conn:
        cursor = conn.cursor()
        cursor.execute(sql)
        rows = cursor.fetchall()
    return {row[0]: {"daily_bars": int(row[1] or 0), "latest_bar": row[2], "labelable_bar": row[3]} for row in rows}


def _registry_views(horizons: list[str]) -> dict[tuple[str, str], object]:
    """Latest registry row per (symbol, horizon) as a lightweight stand-in for a
    loaded bundle. Coverage and the freshness gate read model_version /
    training_end / promotion_ready / meta_ready straight from SQL instead of
    deserializing every joblib artifact, which made the endpoint take ~19s."""
    with _db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            select distinct on (symbol, horizon)
                   symbol, horizon, training_end, model_version, promotion_ready, meta_ready
            from model_registry
            where horizon = any(%s)
            order by symbol, horizon, created_at desc
            """,
            (list(horizons),),
        )
        rows = cursor.fetchall()
    return {
        (row[0], row[1]): SimpleNamespace(
            training_end=row[2], model_version=row[3], promotion_ready=row[4], meta_ready=row[5]
        )
        for row in rows
    }


def _classify(symbol: str, horizon: str, stats: dict, bundle) -> dict:
    """Pure classification of one instrument's current training state — shared
    by the coverage view and the run loop so they can never disagree."""
    daily_bars = int(stats.get("daily_bars", 0))
    latest_bar = stats.get("latest_bar")
    labelable_bar = stats.get("labelable_bar") or latest_bar
    training_end = bundle.training_end if bundle is not None else None
    data_age_days = None
    if latest_bar is not None:
        data_age_days = (_utcnow() - latest_bar.astimezone(timezone.utc)).total_seconds() / 86400.0

    if daily_bars == 0:
        model_state, reason = "WAITING_FOR_DATA", "NO_DAILY_HISTORY"
    elif bundle is None:
        model_state, reason = ("TRAINING_REQUIRED", "NO_ARTIFACT") if daily_bars >= MIN_HISTORY else ("INSUFFICIENT_HISTORY", "INSUFFICIENT_HISTORY")
    else:
        if labelable_bar is not None and training_end is not None and pd.Timestamp(labelable_bar).tz_convert("UTC") > pd.Timestamp(training_end):
            model_state, reason = "STALE", "NEW_DATA_AVAILABLE"
        else:
            model_state, reason = "UP_TO_DATE", "NO_NEW_DATA"

    return {
        "symbol": symbol,
        "horizon": horizon,
        "instrument_type": stats.get("instrument_type"),
        "daily_bars": daily_bars,
        "bars_required": MIN_HISTORY,
        "latest_bar": _iso(latest_bar),
        "training_end": _iso(training_end),
        "model_state": model_state,
        "reason": reason,
        "data_status": "LIVE" if data_age_days is not None and data_age_days <= DATA_STALE_DAYS else ("STALE" if data_age_days is not None else "ABSENT"),
        "model_version": bundle.model_version if bundle is not None else None,
        "promotion_ready": bool(bundle.promotion_ready) if bundle is not None else None,
        "meta_ready": bool(bundle.meta_ready) if bundle is not None else None,
    }


def coverage_report(horizons: list[str] | None = None) -> dict:
    """Dynamic model-coverage snapshot for the whole active universe."""
    horizons = horizons or [DEFAULT_HORIZON]
    for horizon in horizons:
        if horizon not in SUPPORTED_HORIZONS:
            raise HTTPException(status_code=400, detail=f"Unsupported horizon {horizon}")
    stats = _daily_bar_stats()
    views = _registry_views(horizons)
    universe = {item["symbol"]: item["instrument_type"] for item in discover_universe()}
    instruments: list[dict] = []
    for symbol in universe:
        merged = dict(stats.get(symbol, {"daily_bars": 0, "latest_bar": None, "labelable_bar": None}))
        merged["instrument_type"] = universe[symbol]
        for horizon in horizons:
            instruments.append(_classify(symbol, horizon, merged, views.get((symbol, horizon))))

    def bucket(state: str) -> int:
        return sum(1 for item in instruments if item["model_state"] == state)

    summary = {
        "activeInstruments": len(universe),
        "horizons": horizons,
        "productionModels": sum(1 for item in instruments if item.get("promotion_ready")),
        "upToDate": bucket("UP_TO_DATE"),
        "trainingRequired": bucket("STALE") + bucket("TRAINING_REQUIRED"),
        "insufficientHistory": bucket("INSUFFICIENT_HISTORY"),
        "waitingForData": bucket("WAITING_FOR_DATA"),
        "generatedAt": _iso(_utcnow()),
    }
    return {"ok": True, "summary": summary, "instruments": instruments}


def _record_instrument(cursor, run_id: str, row: dict) -> None:
    cursor.execute(
        """
        insert into training_run_instruments (
            training_run_id, symbol, horizon, instrument_type, status, reason,
            bars_available, bars_required, latest_bar, training_end, model_version,
            promotion_ready, meta_ready, oos_accuracy, accuracy_lift_ci_low,
            duration_ms, error, started_at, completed_at
        ) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        """,
        (
            run_id, row["symbol"], row["horizon"], row.get("instrument_type"), row["status"], row.get("reason"),
            row.get("bars_available"), row.get("bars_required"), row.get("latest_bar"), row.get("training_end"),
            row.get("model_version"), row.get("promotion_ready"), row.get("meta_ready"), row.get("oos_accuracy"),
            row.get("accuracy_lift_ci_low"), row.get("duration_ms"), row.get("error"), row.get("started_at"), row.get("completed_at"),
        ),
    )


def _record_model(cursor, row: dict) -> None:
    cursor.execute(
        """
        insert into model_registry (
            symbol, horizon, instrument_type, model_version, feature_set_version, dataset_version,
            training_run_id, artifact_path, bars, training_end, oos_accuracy, oos_majority_baseline,
            oos_log_loss, oos_directional_accuracy, accuracy_lift_ci_low, calibration_verified,
            calibration_gap, meta_ready, meta_oos_auc, meta_auc_ci_low, meta_selected_coverage,
            meta_accuracy_lift_ci_low, promotion_ready, status, metrics
        ) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)
        on conflict (symbol, horizon, model_version) do nothing
        """,
        (
            row["symbol"], row["horizon"], row.get("instrument_type"), row["model_version"], FEATURE_SET_VERSION,
            FEATURE_SET_VERSION, row.get("training_run_id"), row.get("artifact_path"), row.get("bars"),
            row.get("training_end"), row.get("oos_accuracy"), row.get("oos_majority_baseline"), row.get("oos_log_loss"),
            row.get("oos_directional_accuracy"), row.get("accuracy_lift_ci_low"), row.get("calibration_verified"),
            row.get("calibration_gap"), row.get("meta_ready"), row.get("meta_oos_auc"), row.get("meta_auc_ci_low"),
            row.get("meta_selected_coverage"), row.get("meta_accuracy_lift_ci_low"), row.get("promotion_ready"),
            row.get("status_model") or "DORMANT", _json_metrics(row),
        ),
    )


def _json_metrics(row: dict) -> str:
    keys = ("oos_accuracy", "oos_majority_baseline", "oos_log_loss", "oos_directional_accuracy",
            "accuracy_lift_ci_low", "calibration_verified", "calibration_gap", "meta_ready",
            "meta_oos_auc", "meta_auc_ci_low", "meta_selected_coverage", "meta_accuracy_lift_ci_low", "meta_coverage_accuracy")
    return json.dumps({key: row.get(key) for key in keys}, default=str)


def _train_one(conn, run_id: str, symbol: str, horizon: str, instrument_type: str, force: bool, stats: dict, existing) -> dict:
    """Train (or skip) a single instrument, recording its outcome. `stats` and
    `existing` come from the run's precomputed universe scan (so the loop never
    re-queries or reloads per instrument). Returns the per-instrument report row.
    Never raises for expected conditions — those are recorded as SKIP / UP_TO_DATE
    states — so one instrument cannot abort a run."""
    started = _utcnow()
    cursor = conn.cursor()
    stats = {**stats, "instrument_type": instrument_type}
    daily_bars = int(stats.get("daily_bars", 0))
    latest_bar = stats.get("latest_bar")
    base = {
        "symbol": symbol, "horizon": horizon, "instrument_type": instrument_type,
        "bars_available": daily_bars, "bars_required": MIN_HISTORY,
        "latest_bar": latest_bar, "started_at": started,
    }

    # 1-2. Gate through the SAME classifier the coverage view uses (data
    # sufficiency + artifact freshness), so a run and the dashboard can never
    # disagree. Manual force always trains. A skip is recorded, never raised.
    state = _classify(symbol, horizon, stats, existing)["model_state"]
    if state == "WAITING_FOR_DATA":
        return _finish(conn, cursor, run_id, {**base, "status": "WAITING_FOR_DATA", "reason": "NO_DAILY_HISTORY", "completed_at": _utcnow()})
    if state == "INSUFFICIENT_HISTORY":
        return _finish(conn, cursor, run_id, {**base, "status": "SKIPPED", "reason": "INSUFFICIENT_HISTORY", "completed_at": _utcnow()})
    if state == "UP_TO_DATE" and not force:
        return _finish(conn, cursor, run_id, {
            **base, "status": "UP_TO_DATE", "reason": "NO_NEW_DATA",
            "training_end": existing.training_end, "model_version": existing.model_version,
            "promotion_ready": bool(existing.promotion_ready), "meta_ready": bool(existing.meta_ready),
            "completed_at": _utcnow(),
        })

    # 3. Build the training frame; re-check sufficiency on usable rows.
    try:
        raw = _load_daily(symbol)
        frame = _training_frame(raw, horizon)
    except HTTPException as error:
        status = "SKIPPED" if error.status_code == 503 else "FAILED"
        reason = "INSUFFICIENT_HISTORY" if error.status_code == 503 else "DATA_LOAD_FAILED"
        message = error.detail if isinstance(error.detail, str) else str(error.detail)
        return _finish(conn, cursor, run_id, {**base, "status": status, "reason": reason, "error": message, "completed_at": _utcnow()})

    # 4. Train + persist through the canonical path; append to the registry.
    bundle = _fit_bundle(symbol, frame, horizon)
    artifact = _save_bundle(symbol, bundle)
    row = {
        **base,
        "status": "TRAINED",
        "reason": "STALE_RETRAIN" if existing is not None else "NO_ARTIFACT",
        "training_end": bundle.training_end,
        "model_version": bundle.model_version,
        "promotion_ready": bool(bundle.promotion_ready),
        "meta_ready": bool(bundle.meta_ready),
        "oos_accuracy": bundle.oos_accuracy,
        "accuracy_lift_ci_low": bundle.accuracy_lift_ci_low if bundle.accuracy_lift_ci_low == bundle.accuracy_lift_ci_low else None,
        "completed_at": _utcnow(),
        "artifact_path": str(artifact),
        "bars": int(len(frame)),
        "oos_majority_baseline": bundle.oos_majority_baseline,
        "oos_log_loss": bundle.oos_log_loss,
        "oos_directional_accuracy": bundle.oos_directional_accuracy,
        "calibration_verified": bundle.calibration_verified,
        "calibration_gap": bundle.calibration_gap,
        "meta_oos_auc": bundle.meta_oos_auc,
        "meta_auc_ci_low": bundle.meta_auc_ci_low,
        "meta_selected_coverage": bundle.meta_selected_coverage,
        "meta_accuracy_lift_ci_low": bundle.meta_accuracy_lift_ci_low,
        "meta_coverage_accuracy": bundle.meta_coverage_accuracy,
        "training_run_id": run_id,
        # Honest lifecycle: passes the gate -> CANDIDATE, otherwise DORMANT.
        # PRODUCTION is reserved for an explicit promotion step that is not yet wired.
        "status_model": "CANDIDATE" if bundle.promotion_ready else "DORMANT",
    }
    return _finish(conn, cursor, run_id, row, record_model=True)


def _finish(conn, cursor, run_id: str, row: dict, record_model: bool = False) -> dict:
    duration = row["completed_at"] - row["started_at"]
    row["duration_ms"] = int(duration.total_seconds() * 1000)
    _record_instrument(cursor, run_id, row)
    if record_model:
        _record_model(cursor, row)
    conn.commit()
    return {key: value for key, value in row.items() if key not in {"started_at", "completed_at", "latest_bar", "training_end"}} | {
        "latest_bar": _iso(row.get("latest_bar")), "training_end": _iso(row.get("training_end"))
    }


def run_auto_training(trigger: str = "AUTO_NEW_DATA", horizons: list[str] | None = None, force_symbols: list[str] | None = None) -> dict:
    """Run the full discover -> gate -> train-if-required loop over the active
    universe. Each instrument is isolated; the batch always returns a report."""
    horizons = horizons or [DEFAULT_HORIZON]
    for horizon in horizons:
        if horizon not in SUPPORTED_HORIZONS:
            raise HTTPException(status_code=400, detail=f"Unsupported horizon {horizon}")
    force_symbols = {symbol.strip().upper() for symbol in (force_symbols or [])}
    started_at = _utcnow()
    universe = discover_universe()
    stats_map = _daily_bar_stats()
    views = _registry_views(horizons)
    conn = _db()
    conn.autocommit = False
    cursor = conn.cursor()
    try:
        cursor.execute("select count(*) from training_runs where date_trunc('day', started_at) = date_trunc('day', %s::timestamptz)", (started_at,))
        run_id = _build_run_id(cursor, started_at)
        cursor.execute(
            "insert into training_runs (training_run_id, trigger, status, started_at, horizons) values (%s,%s,'RUNNING',%s,%s)",
            (run_id, trigger, started_at, horizons),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        conn.close()
        raise

    results: list[dict] = []
    for horizon in horizons:
        for instrument in universe:
            symbol = instrument["symbol"]
            force = symbol.upper() in force_symbols
            existing = views.get((symbol, horizon))
            try:
                results.append(_train_one(conn, run_id, symbol, horizon, instrument["instrument_type"], force, stats_map.get(symbol, {}), existing))
            except Exception as error:  # ultimate isolation: a train crash cannot stop the batch.
                conn.rollback()
                now = _utcnow()
                _record_instrument(cursor, run_id, {
                    "symbol": symbol, "horizon": horizon, "instrument_type": instrument["instrument_type"],
                    "status": "FAILED", "reason": "TRAINING_EXCEPTION", "error": str(error),
                    "started_at": now, "completed_at": now, "duration_ms": 0, "bars_available": None,
                })
                conn.commit()
                results.append({"symbol": symbol, "horizon": horizon, "status": "FAILED", "reason": "TRAINING_EXCEPTION", "error": str(error)})

    trained = sum(1 for r in results if r["status"] == "TRAINED")
    up_to_date = sum(1 for r in results if r["status"] == "UP_TO_DATE")
    skipped = sum(1 for r in results if r["status"] in {"SKIPPED", "WAITING_FOR_DATA", "INSUFFICIENT_HISTORY", "DORMANT"})
    failed = sum(1 for r in results if r["status"] == "FAILED")
    if failed and failed == len(results):
        status = "FAILED"
    elif failed:
        status = "PARTIAL"
    else:
        status = "COMPLETED"
    completed_at = _utcnow()
    cursor.execute(
        """
        update training_runs
        set status=%s, completed_at=%s, instruments_total=%s, instruments_trained=%s,
            instruments_up_to_date=%s, instruments_skipped=%s, instruments_failed=%s, summary=%s::jsonb
        where training_run_id=%s
        """,
        (status, completed_at, len(results), trained, up_to_date, skipped, failed,
         json.dumps({"trained": trained, "upToDate": up_to_date, "skipped": skipped, "failed": failed}), run_id),
    )
    conn.commit()
    conn.close()
    return {
        "ok": status != "FAILED",
        "training_run_id": run_id,
        "trigger": trigger,
        "status": status,
        "started_at": _iso(started_at),
        "completed_at": _iso(completed_at),
        "summary": {"total": len(results), "trained": trained, "upToDate": up_to_date, "skipped": skipped, "failed": failed},
        "instruments": results,
    }


def _build_run_id(cursor, started_at: datetime) -> str:
    cursor.execute("select count(*) from training_runs where date_trunc('day', started_at) = date_trunc('day', %s::timestamptz)", (started_at,))
    seq = int(cursor.fetchone()[0] or 0) + 1
    return f"tr_{started_at.strftime('%Y%m%d')}_{seq:03d}"


def train_single_symbol(symbol: str, horizon: str = DEFAULT_HORIZON, trigger: str = "MANUAL") -> dict:
    """Manual retrain override for one instrument — always retrains (force)."""
    symbol = symbol.strip().upper()
    if horizon not in SUPPORTED_HORIZONS:
        raise HTTPException(status_code=400, detail=f"Unsupported horizon {horizon}")
    with _db() as conn:
        cursor = conn.cursor()
        cursor.execute("select symbol, instrument_type from instruments where upper(symbol)=%s and is_active=true", (symbol,))
        found = cursor.fetchone()
    if not found:
        raise HTTPException(status_code=404, detail=f"{symbol} is not an active instrument")
    started_at = _utcnow()
    conn = _db()
    conn.autocommit = False
    cursor = conn.cursor()
    run_id = _build_run_id(cursor, started_at)
    cursor.execute(
        "insert into training_runs (training_run_id, trigger, status, started_at, horizons, instruments_total) values (%s,%s,'RUNNING',%s,%s,1)",
        (run_id, trigger, started_at, [horizon]),
    )
    conn.commit()
    stats = _daily_bar_stats().get(symbol, {})
    existing = _registry_views([horizon]).get((symbol, horizon))
    result = _train_one(conn, run_id, symbol, horizon, found[1], force=True, stats=stats, existing=existing)
    status = "COMPLETED" if result["status"] not in {"FAILED"} else "FAILED"
    cursor.execute(
        "update training_runs set status=%s, completed_at=%s, instruments_total=1, instruments_trained=%s where training_run_id=%s",
        (status, _utcnow(), 1 if result["status"] == "TRAINED" else 0, run_id),
    )
    conn.commit()
    conn.close()
    return {"ok": status == "COMPLETED", "training_run_id": run_id, "trigger": trigger, "status": status, "instrument": result}


def retrain_all_stale(horizons: list[str] | None = None) -> dict:
    """Retrain only instruments that currently have new data or no artifact."""
    horizons = horizons or [DEFAULT_HORIZON]
    report = coverage_report(horizons)
    stale = sorted({item["symbol"] for item in report["instruments"] if item["model_state"] in {"STALE", "TRAINING_REQUIRED"}})
    if not stale:
        return {"ok": True, "status": "COMPLETED", "summary": {"total": 0, "trained": 0, "upToDate": 0, "skipped": 0, "failed": 0}, "instruments": [], "message": "No stale instruments"}
    return run_auto_training(trigger="AUTO_NEW_DATA", horizons=horizons, force_symbols=stale)


__all__ = [
    "discover_universe",
    "coverage_report",
    "run_auto_training",
    "train_single_symbol",
    "retrain_all_stale",
]
