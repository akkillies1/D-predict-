from __future__ import annotations

import pandas as pd

from training.validate_history import validate


def frame() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "timestamp": pd.date_range("2026-01-01", periods=3, freq="D", tz="UTC"),
            "open": [100, 101, 102],
            "high": [102, 103, 104],
            "low": [99, 100, 101],
            "close": [101, 102, 103],
            "volume": [1000, 1100, 1200],
        }
    )


def test_valid_history_has_no_issues() -> None:
    assert validate(frame()) == []


def test_duplicate_timestamp_is_rejected() -> None:
    data = frame()
    data.loc[1, "timestamp"] = data.loc[0, "timestamp"]
    assert any(issue.code == "DUPLICATE_TIMESTAMP" for issue in validate(data))


def test_bad_ohlc_range_is_rejected() -> None:
    data = frame()
    data.loc[1, "high"] = 99
    assert any(issue.code == "INVALID_OHLC_RANGE" for issue in validate(data))


def test_negative_volume_is_rejected() -> None:
    data = frame()
    data.loc[2, "volume"] = -1
    assert any(issue.code == "NEGATIVE_VOLUME" for issue in validate(data))
