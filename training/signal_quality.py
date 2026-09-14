"""Deterministic signal-quality / NO_TRADE layer.

Signal quality is intentionally separate from model probability. It combines
causal state/context agreement and data freshness. It does not optimize itself
against historical returns.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from enum import Enum


class TradeDecision(str, Enum):
    LONG = "LONG"
    SHORT = "SHORT"
    NO_TRADE = "NO_TRADE"


@dataclass(frozen=True)
class SignalQualityResult:
    decision: TradeDecision
    quality: str
    score: float
    reason_codes: tuple[str, ...]

    def to_dict(self) -> dict:
        value = asdict(self)
        value["decision"] = self.decision.value
        value["reason_codes"] = list(self.reason_codes)
        return value


def assess_signal_quality(
    prediction: str,
    forecast_confidence: float,
    regime_confidence: float,
    trend_strength: float,
    relative_strength: float | None = None,
    sector_alignment: float | None = None,
    data_status: str = "LIVE",
    min_confidence: float = 0.55,
) -> SignalQualityResult:
    """Return a deterministic decision without looking at future outcomes."""
    if prediction not in {"UP", "DOWN", "FLAT"}:
        raise ValueError("prediction must be UP, DOWN, or FLAT")
    for name, value in {
        "forecast_confidence": forecast_confidence,
        "regime_confidence": regime_confidence,
        "trend_strength": trend_strength,
        "min_confidence": min_confidence,
    }.items():
        if not 0 <= float(value) <= 1:
            raise ValueError(f"{name} must be between 0 and 1")

    reasons: list[str] = []
    if data_status in {"STALE", "OFFLINE"}:
        return SignalQualityResult(TradeDecision.NO_TRADE, "LOW", 0.0, ("DATA_NOT_FRESH",))
    if prediction == "FLAT":
        return SignalQualityResult(TradeDecision.NO_TRADE, "LOW", 0.0, ("FLAT_PREDICTION",))
    if forecast_confidence < min_confidence:
        return SignalQualityResult(TradeDecision.NO_TRADE, "LOW", forecast_confidence, ("LOW_FORECAST_CONFIDENCE",))

    components = [float(regime_confidence), float(trend_strength), float(forecast_confidence)]
    if relative_strength is not None:
        components.append(max(0.0, min(1.0, 0.5 + relative_strength * 5.0)))
        reasons.append("RELATIVE_STRENGTH_AVAILABLE")
    if sector_alignment is not None:
        components.append(max(0.0, min(1.0, 0.5 + sector_alignment * 5.0)))
        reasons.append("SECTOR_CONTEXT_AVAILABLE")

    score = sum(components) / len(components)
    if score < 0.50:
        return SignalQualityResult(TradeDecision.NO_TRADE, "LOW", score, tuple(reasons + ["SIGNAL_CONFLICT"]))
    if score < 0.68:
        quality = "MEDIUM"
    else:
        quality = "HIGH"
    reasons.append("CAUSAL_CONTEXT_ALIGNED")
    decision = TradeDecision.LONG if prediction == "UP" else TradeDecision.SHORT
    return SignalQualityResult(decision, quality, score, tuple(reasons))
