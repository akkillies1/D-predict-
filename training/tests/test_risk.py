import pandas as pd
import pytest

from training.risk import RiskConfig, construct_risk_budget


def predictions(*rows):
    return pd.DataFrame(rows)


def history(rows):
    return pd.DataFrame(rows)


def p_row(timestamp="2026-01-20"):
    return {"timestamp": timestamp, "symbol": "NIFTY", "horizon": "1d", "prediction": "UP", "market_probability_down": 0.05, "market_probability_flat": 0.10, "market_probability_up": 0.85}


def h_rows(n=20, start="2026-01-01"):
    dates = pd.date_range(start, periods=n, freq="D", tz="UTC")
    return [{"timestamp": d, "open": 100.0, "high": 101.0 + i * 0.01, "low": 99.0, "close": 100.0 + i * 0.05} for i, d in enumerate(dates)]


def test_risk_budget_is_volatility_aware_and_capped():
    result = construct_risk_budget(
        predictions(p_row()),
        history(h_rows()),
        RiskConfig(risk_per_trade=0.005, stop_atr_multiplier=1.5, max_position_weight=0.25),
    )
    row = result.iloc[0]
    assert row["decision"] == "LONG"
    assert row["atr_pct"] > 0
    assert row["stop_distance_bps"] >= 50
    assert row["position_weight"] <= 0.25
    assert row["position_weight"] <= row["risk_limited_weight"]
    assert row["volatility_timestamp"] <= row["timestamp"]


def test_risk_never_uses_future_history():
    result = construct_risk_budget(
        predictions(p_row("2026-01-10")),
        history(h_rows(30)),
        RiskConfig(),
    )
    assert result.iloc[0]["volatility_timestamp"] == "2026-01-10T00:00:00+00:00"


def test_missing_volatility_is_explicit_no_trade():
    result = construct_risk_budget(
        predictions(p_row("2026-01-10")),
        history(h_rows(10)),
        RiskConfig(atr_period=14),
    )
    assert result.iloc[0]["position_weight"] == 0
    assert result.iloc[0]["decision"] == "NO_TRADE"
    assert result.iloc[0]["risk_status"] == "RISK_DATA_UNAVAILABLE"


def test_gross_exposure_remains_capped():
    rows = [p_row(f"2026-01-{20 + i:02d}") for i in range(4)]
    result = construct_risk_budget(
        predictions(*rows),
        history(h_rows(40)),
        RiskConfig(max_position_weight=0.25, max_gross_exposure=0.30),
    )
    assert result["position_weight"].sum() == pytest.approx(0.30)
    assert (result["position_weight"] <= 0.25).all()


def test_invalid_history_is_rejected():
    bad = h_rows()
    bad[10]["close"] = -1
    with pytest.raises(ValueError, match="positive"):
        construct_risk_budget(predictions(p_row()), history(bad))


def test_invalid_config_is_rejected():
    with pytest.raises(ValueError):
        RiskConfig(risk_per_trade=0).validate()
