"""Synthetic-chain tests for the option-evidence rules (pure functions, no tz)."""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from datetime import date
from collector.options_radar import (
    PCR_BAND, chain_metrics, evaluate_option_rules,
)

EX = date(2026, 10, 1)
SPOT = 25000.0


def legs(pcr_ce, pcr_pe, iv_ce=12.0, iv_pe=12.2, strikes=(24000, 24500, 25000, 25500, 26000)):
    out = []
    for s in strikes:
        out.append({"expiry_date": EX, "strike": s, "option_type": "CE", "oi": pcr_ce, "iv": iv_ce})
        out.append({"expiry_date": EX, "strike": s, "option_type": "PE", "oi": pcr_pe, "iv": iv_pe})
    return out


def run() -> None:
    # gap veto: two observations <25 min apart are one moment
    fired = evaluate_option_rules(legs(1000, 2000, iv_ce=20), legs(1000, 1000), SPOT, 24.9)
    assert fired == [], f"gap veto failed: {fired}"

    # chain with no usable expiries -> no metrics
    assert chain_metrics([{"strike": 1, "option_type": "CE", "oi": 1}], SPOT) is None
    assert chain_metrics([], SPOT) is None

    # metrics sanity: band is +/-5% of spot -> strikes 24000..26000 all inside (23750..26250)
    m = chain_metrics(legs(1000, 1300), SPOT)
    assert m["expiry"] == EX and m["atm_strike"] == 25000
    assert abs(m["pcr"] - 1.3) < 1e-9, m["pcr"]
    assert m["band_oi"] == 1000 * 5 + 1300 * 5

    # pcr_band_cross: inside -> below (CE OI builds)
    fired = evaluate_option_rules(legs(2100, 1300), legs(1000, 1300), SPOT, 30)
    names = [r for r, _ in fired]
    assert "pcr_band_cross" in names, fired
    ev = dict(fired)["pcr_band_cross"]
    assert ev["crossed_to"] == "below" and ev["band_low"] == PCR_BAND[0]

    # pcr_band_cross: inside -> above (PE OI builds)
    fired = evaluate_option_rules(legs(1000, 1400), legs(1000, 1300), SPOT, 30)
    ev = dict(fired)["pcr_band_cross"]
    assert ev["crossed_to"] == "above"

    # no re-fire when already outside at 'then'
    fired = evaluate_option_rules(legs(3000, 1300), legs(2100, 1300), SPOT, 30)
    assert "pcr_band_cross" not in [r for r, _ in fired], fired

    # atm_iv_spike: >=1.5 vol points fires, 1.4 does not
    fired = evaluate_option_rules(legs(1000, 1000, iv_ce=14.0, iv_pe=14.0), legs(1000, 1000, iv_ce=12.0, iv_pe=12.0), SPOT, 30)
    assert "atm_iv_spike" in [r for r, _ in fired]
    fired = evaluate_option_rules(legs(1000, 1000, iv_ce=13.4, iv_pe=13.4), legs(1000, 1000, iv_ce=12.0, iv_pe=12.0), SPOT, 30)
    assert "atm_iv_spike" not in [r for r, _ in fired]

    # atm_oi_buildup: >=15% growth with base >=1000 fires; dust base does not
    fired = evaluate_option_rules(legs(700, 700), legs(600, 600), SPOT, 30)
    assert "atm_oi_buildup" in [r for r, _ in fired], fired  # band_oi 6000 -> 7000
    fired = evaluate_option_rules(legs(20, 20), legs(10, 10), SPOT, 30)
    assert "atm_oi_buildup" not in [r for r, _ in fired], fired  # base 100 < 1000

    # missing IV on both sides -> iv rule silently unavailable, others still work
    no_iv = [dict(leg, iv=None) for leg in legs(1000, 2000)]
    then_no_iv = [dict(leg, iv=None) for leg in legs(1000, 1000)]
    fired = evaluate_option_rules(no_iv, then_no_iv, SPOT, 30)
    names = [r for r, _ in fired]
    assert "atm_iv_spike" not in names and "pcr_band_cross" in names, fired

    print("options_radar tests passed")


if __name__ == "__main__":
    run()
