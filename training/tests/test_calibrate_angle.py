import numpy as np

from training.calibrate_angle import (
    assumed_linear_maps,
    continuation_bins,
    rank_ic,
    rolling_signals,
    window_theta,
)


def test_window_theta_strong_uptrend_is_positive_and_large():
    closes = np.exp(np.linspace(0, 1.2, 60))  # relentless climb
    log_closes = np.log(closes)
    thetas = [
        window_theta(log_closes[i - 20 : i + 1], np.diff(log_closes)[i - 20 : i])
        for i in range(20, 60 - 5)
    ]
    assert np.mean(thetas) > 60, np.mean(thetas)


def test_window_theta_noise_is_small():
    rng = np.random.default_rng(11)
    log_closes = np.cumsum(rng.normal(0, 0.02, 200))
    thetas = [
        window_theta(log_closes[i - 20 : i + 1], np.diff(log_closes)[i - 20 : i])
        for i in range(20, 200 - 5)
    ]
    assert np.mean(np.abs(thetas)) < 45  # wanders, never locks in a steep angle


def test_rolling_signals_no_peeking_alignment():
    closes = np.linspace(100, 200, 100)
    thetas, fwd = rolling_signals(closes, window=20, horizon=5)
    assert len(thetas) == len(fwd) == 100 - 20 + 1 - 5
    assert np.all(thetas > 80)  # perfectly linear in price -> steep in logs too
    assert np.all(fwd > 0)


def test_continuation_bins_measure_not_assume():
    # a synthetic universe where the true P(up) is 0.9 at high angles and 0.1 at low
    rng = np.random.default_rng(3)
    thetas, fwd = [], []
    for theta, edge_bin in ((-68, "-75 to -60"), (52, "45 to 60")):
        p_up = 0.9 if theta > 0 else 0.1
        draws = rng.random(500) < p_up
        thetas.append(theta + rng.normal(0, 0.5, 500))
        fwd.append(np.where(draws, 0.01, -0.01))
    thetas = np.concatenate(thetas)
    fwd = np.concatenate(fwd)
    bins = continuation_bins(thetas, fwd)
    high = next(b for b in bins if b["bin_deg"] == "45 to 60")
    low = next(b for b in bins if b["bin_deg"] == "-75 to -60")
    assert high["n"] >= 400 and high["measured_p_up"] > 0.8
    assert low["n"] >= 400 and low["measured_p_up"] < 0.2


def test_assumed_maps_values():
    assert assumed_linear_maps(90)["linear_shift"] == 1.0
    assert assumed_linear_maps(0)["linear_shift"] == 0.5
    assert assumed_linear_maps(45)["raw_theta_over_90"] == 0.5
    # the raw literal map is not even a probability for theta < 0
    assert assumed_linear_maps(-30)["raw_theta_over_90"] < 0


def test_rank_ic_detects_signal_and_noise():
    rng = np.random.default_rng(5)
    thetas = rng.normal(0, 30, 800)
    informative = 0.0004 * thetas + rng.normal(0, 0.01, 800)
    assert rank_ic(thetas, informative) > 0.15
    assert abs(rank_ic(thetas, rng.normal(0, 0.02, 800))) < 0.07


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"{name} passed")
