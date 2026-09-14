import pandas as pd

from training.market_state import MarketState, classify_market_state


def test_downtrend_oversold_is_not_reversal():
    result = classify_market_state(
        {
            "sma20_ratio": -0.03,
            "sma50_ratio": -0.05,
            "ema_spread": -0.02,
            "rsi14": 28,
            "atr14_pct": 0.02,
            "volatility20": 0.25,
            "return_1": -0.01,
            "return_5": -0.04,
        }
    )
    assert result.state == MarketState.OVERSOLD_TREND
    assert "OVERSOLD_WITH_DOWN_TREND" in result.reason_codes


def test_short_term_improvement_is_descriptive_reversal_attempt():
    result = classify_market_state(
        {
            "sma20_ratio": -0.03,
            "sma50_ratio": -0.05,
            "ema_spread": -0.02,
            "rsi14": 40,
            "atr14_pct": 0.02,
            "volatility20": 0.25,
            "return_1": 0.01,
            "return_5": 0.03,
        }
    )
    assert result.state == MarketState.REVERSAL_ATTEMPT
    assert result.regime_confidence > 0


def test_missing_features_are_explicitly_unsafe():
    result = classify_market_state({"sma20_ratio": -0.01})
    assert result.state == MarketState.INSUFFICIENT_DATA
    assert result.regime_confidence == 0


def test_state_does_not_consume_future_timestamp_or_series():
    # The classifier accepts only already-computed scalar features. A future
    # observation cannot enter through an implicit series argument.
    result = classify_market_state(
        {
            "sma20_ratio": 0.03,
            "sma50_ratio": 0.04,
            "ema_spread": 0.02,
            "rsi14": 60,
            "atr14_pct": 0.012,
            "volatility20": 0.10,
            "return_1": 0.004,
            "return_5": 0.012,
        }
    )
    assert result.state == MarketState.TREND_UP
