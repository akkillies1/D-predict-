import pandas as pd

from training.cross_stock_validation import _market_state_row, _trade_event
from training.context_features import ContextSpec, build_context_row


def _history(closes):
    idx = pd.date_range("2026-01-01", periods=len(closes), freq="D", tz="UTC")
    return pd.DataFrame({
        "open": closes,
        "high": [x + 1 for x in closes],
        "low": [x - 1 for x in closes],
        "close": closes,
        "volume": [1000] * len(closes),
    }, index=idx)


def test_executable_trade_window_is_used_for_direction_and_pnl():
    history = _history([100, 102, 98, 99])
    ts = history.index[0]
    event = _trade_event(history, ts, "1d", "UP", 0, 0)
    assert event["status"] == "SCORED"
    assert event["entry_price"] == 102
    assert event["exit_price"] == 98
    assert event["direction_correct"] is False
    assert event["profitable_after_friction"] is False
    assert event["trade_return"] < 0


def test_market_state_is_causal_at_timestamp():
    closes = list(range(100, 150))
    history = _history(closes)
    ts = history.index[-1]
    before = _market_state_row(history, ts)
    altered = history.copy()
    altered.loc[altered.index > ts, "close"] = 1_000_000
    after = _market_state_row(altered, ts)
    assert before == after


def test_context_uses_only_observations_at_or_before_timestamp():
    stock = _history([100, 101, 102, 103, 104, 105])
    benchmark = _history([200, 202, 204, 206, 208, 210])
    ts = stock.index[4]
    row1 = build_context_row(ts, stock["close"], benchmark["close"], ContextSpec("NIFTY", "TEST"))
    benchmark.loc[benchmark.index > ts, "close"] = 1_000_000
    row2 = build_context_row(ts, stock["close"], benchmark["close"], ContextSpec("NIFTY", "TEST"))
    assert row1 == row2


def test_flat_prediction_is_no_trade():
    history = _history([100, 101, 102, 103])
    event = _trade_event(history, history.index[0], "1d", "FLAT", 10, 5)
    assert event["status"] == "NO_TRADE"
