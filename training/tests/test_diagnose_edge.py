import numpy as np
import pandas as pd

from training.diagnose_edge import _flat_share_at_band, _rank_ic, _redundant_pairs
from training.build_dataset import FEATURE_COLUMNS


def _frame():
    rng = np.random.default_rng(7)
    n = 400
    signal = rng.normal(0, 1, n)
    target = 0.3 * signal + rng.normal(0, 1, n)
    data = {name: rng.normal(0, 1, n) for name in FEATURE_COLUMNS}
    data["return_1"] = signal
    data["sma20_ratio"] = data["return_1"] * 10 + 5  # exact linear twin
    frame = pd.DataFrame(data)
    frame["target_return"] = target
    frame.index = pd.date_range("2020-01-01", periods=n, freq="D")
    return frame


def test_rank_ic_finds_the_informative_feature():
    rows = _rank_ic(_frame())
    by_name = {row["feature"]: row for row in rows}
    assert by_name["return_1"]["ic_full"] > 0.2
    ranked = sorted(rows, key=lambda row: -abs(row["ic_full"]))
    assert {ranked[0]["feature"], ranked[1]["feature"]} == {"return_1", "sma20_ratio"}


def test_redundant_pairs_flags_linear_twin():
    pairs = _redundant_pairs(_frame())
    assert {"return_1", "sma20_ratio"} in ({p["a"], p["b"]} for p in pairs)


def test_flat_share_shrinks_as_band_widens():
    returns = np.array([-0.02, -0.005, 0.0, 0.004, 0.03, 0.0005] * 20)
    tight = _flat_share_at_band(returns, 0.001)
    wide = _flat_share_at_band(returns, 0.01)
    assert wide > tight
