from pathlib import Path

import pytest

from training.live_shadow import (
    LiveShadowConfig,
    load_session,
    observe_bar,
    record_prediction,
    save_session,
    summary,
)


def bar(day, close):
    return {"timestamp": f"2026-01-{day:02d}T00:00:00Z", "symbol": "NIFTY", "close": close}


def prediction(day, value="UP"):
    return {
        "timestamp": f"2026-01-{day:02d}T00:00:00Z",
        "symbol": "NIFTY",
        "horizon": "1d",
        "prediction": value,
        "market_probability_down": 0.1 if value == "UP" else 0.8,
        "market_probability_flat": 0.1,
        "market_probability_up": 0.8 if value == "UP" else 0.1,
    }


def test_prediction_resolves_only_after_executable_future_window():
    state = load_session(Path("unused.json"), session_id="test")
    observe_bar(state, bar(1, 100))
    record_prediction(state, prediction(1))
    observe_bar(state, bar(2, 101))
    assert state["predictions"][0]["outcome_status"] == "PENDING"
    observe_bar(state, bar(3, 102))
    assert state["predictions"][0]["outcome_status"] == "SCORED"
    assert state["predictions"][0]["entry_price"] == pytest.approx(101.0)
    assert state["predictions"][0]["exit_price"] == pytest.approx(102.0)
    assert state["predictions"][0]["realized_return"] == pytest.approx(102 / 101 - 1)
    assert state["predictions"][0]["realized_class"] == "UP"
    assert summary(state)["accuracy"] == pytest.approx(1.0)
    assert summary(state)["live_orders_sent"] == 0


def test_prediction_score_and_trade_pnl_share_same_window():
    state = load_session(Path("unused.json"), session_id="adversarial")
    observe_bar(state, bar(1, 100))
    record_prediction(state, prediction(1, "UP"))
    observe_bar(state, bar(2, 102))
    assert state["predictions"][0]["outcome_status"] == "PENDING"
    observe_bar(state, bar(3, 98))

    scored = state["predictions"][0]
    assert scored["entry_price"] == pytest.approx(102.0)
    assert scored["exit_price"] == pytest.approx(98.0)
    assert scored["realized_class"] == "DOWN"
    assert scored["accuracy_after"] == pytest.approx(0.0)
    assert scored["portfolio_return"] < 0
    assert summary(state)["accuracy"] == pytest.approx(0.0)


def test_session_is_restart_safe(tmp_path):
    path = tmp_path / "session.json"
    state = load_session(path, session_id="restart-test")
    observe_bar(state, bar(1, 100))
    record_prediction(state, prediction(1))
    save_session(path, state)

    restored = load_session(path)
    observe_bar(restored, bar(2, 99))
    observe_bar(restored, bar(3, 98))
    save_session(path, restored)

    final = load_session(path)
    assert final["session_id"] == "restart-test"
    assert final["predictions"][0]["outcome_status"] == "SCORED"
    assert summary(final)["accuracy"] == pytest.approx(0.0)
    assert final["live_orders_sent"] == 0


def test_duplicate_prediction_and_conflicting_bar_are_rejected():
    state = load_session(Path("unused.json"))
    observe_bar(state, bar(1, 100))
    record_prediction(state, prediction(1))
    with pytest.raises(ValueError, match="unique per symbol"):
        record_prediction(state, prediction(1))
    with pytest.raises(ValueError, match="immutable"):
        observe_bar(state, bar(1, 101))


def test_config_rejects_invalid_rolling_window():
    with pytest.raises(ValueError):
        LiveShadowConfig(rolling_window=0).validate()
