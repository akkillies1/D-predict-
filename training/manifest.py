"""Reproducible dataset manifests and content fingerprints."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import pandas as pd

from training.dataset import PointInTimeDataset


def canonical_frame_bytes(frame: pd.DataFrame) -> bytes:
    """Return deterministic bytes for a dataset frame."""
    ordered = frame.sort_index().copy()
    ordered.index.name = ordered.index.name or "timestamp"
    return ordered.to_csv(index=True, lineterminator="\n", float_format="%.17g").encode("utf-8")


def fingerprint(frame: pd.DataFrame) -> str:
    """SHA-256 fingerprint of the canonical dataset contents."""
    return hashlib.sha256(canonical_frame_bytes(frame)).hexdigest()


def build_manifest(
    dataset: PointInTimeDataset,
    *,
    source: str,
    output_path: Path,
) -> dict[str, Any]:
    """Build a JSON-serialisable manifest for a point-in-time dataset."""
    frame = dataset.frame
    content_hash = fingerprint(frame)
    manifest: dict[str, Any] = {
        "manifest_version": "1",
        "instrument": dataset.spec.instrument,
        "frequency": dataset.spec.frequency,
        "start": dataset.spec.start.isoformat(),
        "end": dataset.spec.end.isoformat(),
        "feature_set_version": dataset.spec.feature_set_version,
        "label_horizon": dataset.spec.label_horizon,
        "source": source,
        "row_count": int(len(frame)),
        "columns": [str(column) for column in frame.columns],
        "source_cutoff_min": pd.to_datetime(frame["source_cutoff"], utc=True).min().isoformat()
        if "source_cutoff" in frame.columns else None,
        "source_cutoff_max": pd.to_datetime(frame["source_cutoff"], utc=True).max().isoformat()
        if "source_cutoff" in frame.columns else None,
        "content_sha256": content_hash,
        "created_at": pd.Timestamp.now(tz="UTC").isoformat(),
        "output": str(output_path),
    }
    return manifest


def write_manifest(manifest: dict[str, Any], path: Path) -> None:
    """Write a stable, human-readable manifest."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
