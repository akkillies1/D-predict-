"""Option-evidence radar: closed-form rules over real NSE chain snapshots.

Same honesty contract as the price radar (collector/radar.py): every rule is
a pure formula over stored option_snapshots (PCR on OI, ATM implied vol,
ATM-band OI buildup), and the exact numbers that fired it travel with the
alert. No ML participates. A cross needs two chain observations at least
MIN_GAP_MINUTES apart within the same session — that is what distinguishes
movement from noise, not a model opinion.
"""
from __future__ import annotations

from datetime import date

PCR_BAND = (0.70, 1.30)      # OI-weighted put-call ratio band treated as "neutral"
IV_SPIKE_POINTS = 1.5        # ATM implied-vol jump, in vol points, vs earlier snapshot
OI_BUILDUP_GROWTH = 0.15     # ATM-band total OI growth fraction vs earlier snapshot
OI_BUILDUP_MIN_BASE = 1000   # ignore buildup on dust-thin bases
MIN_GAP_MINUTES = 25         # two observations closer than this are one moment, not a trend
BAND_PCT = 0.05              # "ATM band" = strikes within +/-5% of spot


def chain_metrics(legs: list[dict], spot: float) -> dict | None:
    """PCR, ATM IV and ATM-band OI for the nearest expiry around spot."""
    if not legs or spot <= 0:
        return None
    expiries = [leg["expiry_date"] for leg in legs if leg.get("expiry_date")]
    if not expiries:
        return None
    nearest_expiry = min(expiries)
    exp_legs = [leg for leg in legs if leg.get("expiry_date") == nearest_expiry]
    band = [
        leg for leg in exp_legs
        if leg.get("strike") and abs(leg["strike"] - spot) / spot <= BAND_PCT
    ]
    if not band:
        return None
    ce_oi = sum(leg["oi"] or 0 for leg in band if leg["option_type"] == "CE")
    pe_oi = sum(leg["oi"] or 0 for leg in band if leg["option_type"] == "PE")
    atm_strike = min((leg["strike"] for leg in band), key=lambda s: abs(s - spot))
    atm_ivs = [
        leg["iv"] for leg in band
        if leg["strike"] == atm_strike and leg.get("iv")
    ]
    return {
        "expiry": nearest_expiry,
        "atm_strike": atm_strike,
        "pcr": (pe_oi / ce_oi) if ce_oi > 0 else None,
        "atm_iv": (sum(atm_ivs) / len(atm_ivs)) if atm_ivs else None,
        "band_oi": ce_oi + pe_oi,
        "ce_oi": ce_oi,
        "pe_oi": pe_oi,
    }


def evaluate_option_rules(
    now_legs: list[dict],
    then_legs: list[dict],
    spot: float,
    gap_minutes: float,
) -> list[tuple[str, dict]]:
    """Compare the latest chain snapshot to one at least MIN_GAP_MINUTES
    older; fire only on crossings/trends between the two observations."""
    fired: list[tuple[str, dict]] = []
    if gap_minutes < MIN_GAP_MINUTES:
        return fired
    now = chain_metrics(now_legs, spot)
    then = chain_metrics(then_legs, spot)
    if not now or not then:
        return fired

    if now["pcr"] is not None and then["pcr"] is not None:
        was_inside = PCR_BAND[0] <= then["pcr"] <= PCR_BAND[1]
        now_side = "below" if now["pcr"] < PCR_BAND[0] else ("above" if now["pcr"] > PCR_BAND[1] else None)
        if was_inside and now_side:
            fired.append(("pcr_band_cross", {
                "pcr_now": round(now["pcr"], 3),
                "pcr_then": round(then["pcr"], 3),
                "band_low": PCR_BAND[0],
                "band_high": PCR_BAND[1],
                "crossed_to": now_side,
                "expiry": str(now["expiry"]),
            }))

    if now["atm_iv"] is not None and then["atm_iv"] is not None:
        jump = now["atm_iv"] - then["atm_iv"]
        if jump >= IV_SPIKE_POINTS:
            fired.append(("atm_iv_spike", {
                "iv_now": round(now["atm_iv"], 2),
                "iv_then": round(then["atm_iv"], 2),
                "jump_points": round(jump, 2),
                "atm_strike": now["atm_strike"],
                "gap_minutes": round(gap_minutes, 0),
            }))

    if then["band_oi"] >= OI_BUILDUP_MIN_BASE:
        growth = now["band_oi"] / then["band_oi"] - 1
        if growth >= OI_BUILDUP_GROWTH:
            fired.append(("atm_oi_buildup", {
                "band_oi_now": int(now["band_oi"]),
                "band_oi_then": int(then["band_oi"]),
                "growth_pct": round(growth * 100, 1),
                "ce_oi": int(now["ce_oi"]),
                "pe_oi": int(now["pe_oi"]),
                "atm_strike": now["atm_strike"],
                "gap_minutes": round(gap_minutes, 0),
            }))
    return fired
