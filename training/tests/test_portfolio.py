import pandas as pd
import pytest

from training.portfolio import PortfolioConfig, construct_portfolio


def frame(*rows):
    return pd.DataFrame(rows)


def test_flat_and_low_confidence_are_no_trade():
    result = construct_portfolio(frame(
        {"timestamp": "2026-01-01", "symbol": "NIFTY", "horizon": "1d", "prediction": "FLAT", "market_probability_down": 0.1, "market_probability_flat": 0.8, "market_probability_up": 0.1},
        {"timestamp": "2026-01-02", "symbol": "BANKNIFTY", "horizon": "1d", "prediction": "UP", "market_probability_down": 0.2, "market_probability_flat": 0.25, "market_probability_up": 0.55},
    ))
    assert result["position_weight"].tolist() == [0.0, 0.0]
    assert result["decision"].tolist() == ["NO_TRADE", "NO_TRADE"]


def test_confidence_scales_weight_and_respects_cap():
    result = construct_portfolio(frame(
        {"timestamp": "2026-01-01", "symbol": "NIFTY", "horizon": "1d", "prediction": "UP", "market_probability_down": 0.05, "market_probability_flat": 0.05, "market_probability_up": 0.90},
    ), PortfolioConfig(min_confidence=0.55, max_position_weight=0.25, max_gross_exposure=1.0))
    assert result.iloc[0]["decision"] == "LONG"
    assert result.iloc[0]["position_weight"] == pytest.approx(0.2125)
    assert result.iloc[0]["position_weight"] <= 0.25


def test_gross_exposure_is_capped():
    rows = [
        {"timestamp": f"2026-01-0{i}", "symbol": f"S{i}", "horizon": "1d", "prediction": "UP", "market_probability_down": 0.05, "market_probability_flat": 0.05, "market_probability_up": 0.90}
        for i in range(1, 6)
    ]
    result = construct_portfolio(frame(*rows), PortfolioConfig(max_position_weight=0.25, max_gross_exposure=0.40))
    assert result["position_weight"].sum() == pytest.approx(0.40)
    assert (result["position_weight"] <= 0.25).all()


def test_probability_validation_is_strict():
    with pytest.raises(ValueError, match="sum to 1"):
        construct_portfolio(frame(
            {"timestamp": "2026-01-01", "symbol": "NIFTY", "horizon": "1d", "prediction": "UP", "market_probability_down": 0.2, "market_probability_flat": 0.2, "market_probability_up": 0.2},
        ))


def test_config_rejects_invalid_limits():
    with pytest.raises(ValueError):
        PortfolioConfig(max_position_weight=0.5, max_gross_exposure=0.25).validate()
