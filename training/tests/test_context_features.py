import pandas as pd

from training.context_features import ContextSpec, build_context_row


def _series(values):
    return pd.Series(
        values,
        index=pd.date_range("2026-01-01", periods=len(values), freq="D", tz="UTC"),
    )


def test_context_uses_only_observations_at_or_before_timestamp():
    stock = _series([100, 102, 104, 106, 108])
    benchmark = _series([100, 101, 102, 103, 104])
    sector = _series([100, 101, 103, 105, 107])
    timestamp = stock.index[3]

    row = build_context_row(
        timestamp,
        stock,
        benchmark,
        ContextSpec(benchmark="NIFTY", sector="ENERGY"),
        sector,
    )

    # At index 3, the current stock return is 106/104-1, benchmark is 103/102-1.
    assert row.relative_strength_1 is not None
    assert abs(row.relative_strength_1 - ((106 / 104 - 1) - (103 / 102 - 1))) < 1e-12
    assert row.sector_return_1 == 105 / 103 - 1


def test_future_outlier_does_not_change_past_context():
    stock_a = _series([100, 102, 104, 106, 108])
    stock_b = _series([100, 102, 104, 106, 1000])
    benchmark = _series([100, 101, 102, 103, 104])
    timestamp = stock_a.index[3]

    first = build_context_row(timestamp, stock_a, benchmark, ContextSpec("NIFTY"))
    second = build_context_row(timestamp, stock_b, benchmark, ContextSpec("NIFTY"))

    assert first.to_dict() == second.to_dict()


def test_missing_history_is_explicit_not_invented():
    stock = _series([100, 101])
    benchmark = _series([100, 101])
    row = build_context_row(stock.index[-1], stock, benchmark, ContextSpec("NIFTY"))
    assert row.benchmark_return_1 is not None
    assert row.benchmark_return_5 is None
    assert row.relative_strength_20 is None
