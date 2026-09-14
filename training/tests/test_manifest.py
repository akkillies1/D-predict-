from __future__ import annotations

from pathlib import Path

import pandas as pd

from training.dataset import DatasetSpec, PointInTimeDataset, make_segments
from training.manifest import build_manifest, fingerprint, write_manifest


def dataset() -> PointInTimeDataset:
    index = pd.date_range("2026-01-01", periods=12, freq="D", tz="UTC")
    frame = pd.DataFrame(
        {
            "symbol": "NIFTY",
            "horizon": "1d",
            "feature_set_version": "market-v1",
            "return_1": range(12),
            "target_return": [x / 100 for x in range(12)],
            "source_cutoff": index,
        },
        index=index,
    )
    spec = DatasetSpec(
        instrument="NIFTY",
        frequency="1d",
        start=index[0],
        end=index[-1] + pd.Timedelta(days=1),
        feature_set_version="market-v1",
        label_horizon="1d",
    )
    result = PointInTimeDataset(spec=spec, frame=frame, segments=make_segments(index, purge_rows=1))
    result.validate()
    return result


def test_fingerprint_is_deterministic() -> None:
    first = dataset().frame
    second = first.iloc[::-1].sort_index()
    assert fingerprint(first) == fingerprint(second)


def test_fingerprint_changes_when_data_changes() -> None:
    first = dataset().frame
    changed = first.copy()
    changed.loc[changed.index[0], "return_1"] = 999
    assert fingerprint(first) != fingerprint(changed)


def test_manifest_contains_provenance_and_hash(tmp_path: Path) -> None:
    item = dataset()
    output = tmp_path / "nifty_1d.csv"
    manifest = build_manifest(item, source="postgres", output_path=output)
    assert manifest["instrument"] == "NIFTY"
    assert manifest["row_count"] == 12
    assert manifest["source"] == "postgres"
    assert len(manifest["content_sha256"]) == 64

    path = tmp_path / "nifty_1d.manifest.json"
    write_manifest(manifest, path)
    assert path.exists()
    assert '"content_sha256"' in path.read_text(encoding="utf-8")
