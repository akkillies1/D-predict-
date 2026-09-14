"""Deterministic, point-in-time market-state classification.

Market state is deliberately separate from BUY/SELL prediction.  It describes
observable structure at timestamp T and never consumes future returns.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from enum import Enum
from typing import Mapping


class MarketState(str, Enum):
    TREND_UP = "TREND_UP"
    TREND_DOWN = "TREND_DOWN"
    RANGE = "RANGE"
    RECOVERY = "RECOVERY"
    BREAKDOWN = "BREAKDOWN"
    HIGH_VOLATILITY = "HIGH_VOLATILITY"
    LOW_VOLATILITY = "LOW_VOLATILITY"
    OVERSOLD_TREND = "OVERSOLD_TREND"
    OVERBOUGHT_TREND = "OVERBOUGHT_TREND"
    REVERSAL_ATTEMPT = "REVERSAL_ATTEMPT"
    INSUFFICIENT_DATA = "INSUFFICIENT_DATA"


@dataclass(frozen=True)
class MarketStateResult:
    state: MarketState
    trend_strength: float
    volatility_regime: str
    regime_confidence: float
    reason_codes: tuple[str, ...]

    def to_dict(self) -> dict:
        value = asdict(self)
        value["state"] = self.state.value
        value["reason_codes"] = list(self.reason_codes)
        return value


def _clip(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def classify_market_state(features: Mapping[str, float]) -> MarketStateResult:
    """Classify only from features available at the observation timestamp.

    Expected causal features are the existing D-Predict technical features plus
    optional relative-strength/sector/volatility context. Missing values produce
    an explicit insufficient-data state rather than an invented classification.
    """
    required = ("sma20_ratio", "sma50_ratio", "ema_spread", "rsi14", "atr14_pct", "volatility20")
    if any(features.get(key) is None for key in required):
        return MarketStateResult(
            MarketState.INSUFFICIENT_DATA, 0.0, "UNKNOWN", 0.0, ("MISSING_REQUIRED_FEATURE",)
        )

    sma20 = float(features["sma20_ratio"])
    sma50 = float(features["sma50_ratio"])
    ema_spread = float(features["ema_spread"])
    rsi = float(features["rsi14"])
    atr = float(features["atr14_pct"])
    vol = float(features["volatility20"])

    trend_score = abs(sma20) + abs(sma50) + abs(ema_spread)
    trend_strength = _clip(trend_score / 0.06)
    up_votes = sum(x > 0 for x in (sma20, sma50, ema_spread))
    down_votes = sum(x < 0 for x in (sma20, sma50, ema_spread))
    reasons: list[str] = []

    # Volatility thresholds are intentionally broad regime markers, not trading thresholds.
    if vol >= 0.45 or atr >= 0.035:
        volatility_regime = "HIGH"
        reasons.append("ELEVATED_VOLATILITY")
    elif vol <= 0.12 and atr <= 0.015:
        volatility_regime = "LOW"
        reasons.append("LOW_VOLATILITY")
    else:
        volatility_regime = "NORMAL"

    if up_votes >= 2 and trend_strength >= 0.45:
        state = MarketState.TREND_UP
        reasons.append("UP_TREND_ALIGNMENT")
    elif down_votes >= 2 and trend_strength >= 0.45:
        state = MarketState.TREND_DOWN
        reasons.append("DOWN_TREND_ALIGNMENT")
    else:
        state = MarketState.RANGE
        reasons.append("MIXED_TREND_STRUCTURE")

    # Oversold/overbought are modifiers of state, never standalone reversal signals.
    if state == MarketState.TREND_DOWN and rsi < 35:
        state = MarketState.OVERSOLD_TREND
        reasons.append("OVERSOLD_WITH_DOWN_TREND")
    elif state == MarketState.TREND_UP and rsi > 65:
        state = MarketState.OVERBOUGHT_TREND
        reasons.append("OVERBOUGHT_WITH_UP_TREND")

    # A recovery/reversal attempt requires improving short-term structure while
    # the medium structure remains opposite. It is descriptive, not predictive.
    ret1 = features.get("return_1")
    ret5 = features.get("return_5")
    if ret1 is not None and ret5 is not None:
        ret1 = float(ret1)
        ret5 = float(ret5)
        if down_votes >= 2 and ret1 > 0 and ret5 > 0:
            state = MarketState.REVERSAL_ATTEMPT
            reasons.append("SHORT_TERM_IMPROVEMENT_AGAINST_DOWN_TREND")
        elif up_votes >= 2 and ret1 < 0 and ret5 < 0:
            state = MarketState.REVERSAL_ATTEMPT
            reasons.append("SHORT_TERM_WEAKNESS_AGAINST_UP_TREND")

    confidence = _clip(0.5 * trend_strength + 0.5 * (max(up_votes, down_votes) / 3.0))
    return MarketStateResult(state, trend_strength, volatility_regime, confidence, tuple(reasons))
