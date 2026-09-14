import pytest

from training.signal_quality import TradeDecision, assess_signal_quality


def test_stale_data_forces_no_trade():
    result = assess_signal_quality("UP", 0.9, 0.9, 0.9, data_status="STALE")
    assert result.decision == TradeDecision.NO_TRADE
    assert result.quality == "LOW"


def test_flat_prediction_is_no_trade():
    result = assess_signal_quality("FLAT", 0.9, 0.9, 0.9)
    assert result.decision == TradeDecision.NO_TRADE


def test_low_confidence_is_no_trade():
    result = assess_signal_quality("UP", 0.51, 0.9, 0.9)
    assert result.decision == TradeDecision.NO_TRADE


def test_aligned_context_produces_long_signal_without_future_data():
    result = assess_signal_quality("UP", 0.8, 0.8, 0.8, 0.04, 0.03)
    assert result.decision == TradeDecision.LONG
    assert result.quality in {"MEDIUM", "HIGH"}


def test_invalid_probability_inputs_are_rejected():
    with pytest.raises(ValueError):
        assess_signal_quality("UP", 1.2, 0.8, 0.8)
