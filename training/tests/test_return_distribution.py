import pandas as pd
import pytest

from training.return_distribution import ReturnDistributionConfig, calibrate_return_distributions, construct_trade_thesis


def ledger_frame(targets):
    rows = []
    for index, target in enumerate(targets):
        rows.append({
            "timestamp": f"2026-01-{index + 1:02d}T00:00:00Z",
            "symbol": "RELIANCE",
            "horizon": "3d",
            "prediction": "UP",
            "predicted_return": 0.0,
            "target_return": target,
            "market_probability_down": 0.10,
            "market_probability_flat": 0.10,
            "market_probability_up": 0.80,
        })
    return pd.DataFrame(rows)


def test_distribution_uses_only_prior_oos_residuals():
    frame = ledger_frame([0.01, 0.02, 0.03, 1.00])
    result = calibrate_return_distributions(frame, ReturnDistributionConfig(min_history=3))

    assert result.iloc[0]["distribution_status"] == "UNCALIBRATED"
    assert result.iloc[2]["distribution_status"] == "UNCALIBRATED"
    fourth = result.iloc[3]
    assert fourth["distribution_status"] == "CALIBRATED"
    assert fourth["residual_history"] == 3
    assert fourth["return_p50"] == pytest.approx(0.02)
    assert fourth["return_p95"] < 0.10


def test_current_outcome_is_not_available_to_its_own_distribution():
    frame = ledger_frame([0.01, 0.02, 0.03, 0.50])
    result = calibrate_return_distributions(frame, ReturnDistributionConfig(min_history=3))
    fourth = result.iloc[3]
    assert fourth["return_p50"] == pytest.approx(0.02)
    assert fourth["return_p95"] < 0.10


def test_trade_thesis_derives_targets_and_stop_from_distribution():
    frame = ledger_frame([0.01, 0.02, 0.03, 0.04, 0.05, 0.06])
    calibrated = calibrate_return_distributions(frame, ReturnDistributionConfig(min_history=3))
    thesis = construct_trade_thesis(calibrated.iloc[-1], 1000.0, ReturnDistributionConfig(min_history=3))

    assert thesis["decision"] == "EXECUTABLE"
    assert thesis["direction"] == "LONG"
    assert thesis["signal"] == "STRONG BUY"
    assert len(thesis["targets"]) == 3
    assert [target["probability"] for target in thesis["targets"]] == [0.65, 0.45, 0.25]
    assert thesis["targets"][0]["price"] > 1000.0
    assert thesis["targets"][0]["price"] < thesis["targets"][1]["price"] < thesis["targets"][2]["price"]
    assert thesis["stop"]["price"] < 1000.0
    assert thesis["risk_reward_to_target_1"] > 0
    assert thesis["confidence"] == 80.0


def test_uncalibrated_distribution_is_no_trade():
    frame = ledger_frame([0.01, 0.02, 0.03])
    calibrated = calibrate_return_distributions(frame, ReturnDistributionConfig(min_history=10))
    thesis = construct_trade_thesis(calibrated.iloc[-1], 1000.0, ReturnDistributionConfig(min_history=10))
    assert thesis["decision"] == "NO_TRADE"
    assert thesis["reason"] == "RETURN_DISTRIBUTION_UNCALIBRATED"


def test_flat_prediction_is_no_trade():
    frame = ledger_frame([0.01, 0.02, 0.03, 0.04])
    frame["prediction"] = "FLAT"
    calibrated = calibrate_return_distributions(frame, ReturnDistributionConfig(min_history=3))
    thesis = construct_trade_thesis(calibrated.iloc[-1], 1000.0, ReturnDistributionConfig(min_history=3))
    assert thesis["decision"] == "NO_TRADE"
    assert thesis["signal"] == "HOLD"


def test_invalid_target_probability_configuration_is_rejected():
    with pytest.raises(ValueError):
        ReturnDistributionConfig(target_probabilities=(0.45, 0.65, 0.25)).validate()
