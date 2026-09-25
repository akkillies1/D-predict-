export type ScannerBar = { timestamp: string | Date; close: number };
export type ScannerPrediction = { expectedReturn: number | null; confidence: number | null; timestamp: string | Date; horizon: string; calibrationStatus?: string | null; predictionStatus?: string | null; actionStatus?: string | null; modelVersion?: string | null };
export type ScannerCandidate = {
  symbol: string;
  name?: string | null;
  spot: number;
  expectedReturn: number;
  netExpectedReturn: number;
  confidence: number;
  horizon: string;
  dailyVolatility: number;
  momentum20d: number;
  momentum60d: number;
  maxDrawdown60d: number;
  dataDays: number;
  dataAsOf: string;
  dataStatus: "CURRENT" | "CLOSED_LAST_SESSION";
  score: number;
  basis: "MODEL" | "EVIDENCE";
  reasons: string[];
  risks: string[];
};

export type ScannerConfig = { maxPicks?: number; roundTripCost?: number; minHistory?: number; maxDataAgeDays?: number; marketOpen?: boolean };

function clamp(value: number, min = 0, max = 1) { return Math.max(min, Math.min(max, value)); }
function asDate(value: string | Date) { const date = value instanceof Date ? value : new Date(value); return Number.isFinite(date.getTime()) ? date : null; }
function returns(closes: number[]) { return closes.slice(1).map((value, index) => Math.log(value / closes[index])).filter(Number.isFinite); }

export function rankMarketCandidates(
  inputs: Array<{ symbol: string; name?: string | null; bars: ScannerBar[]; prediction: ScannerPrediction | null }>,
  config: ScannerConfig = {},
  now = new Date(),
): { picks: ScannerCandidate[]; excluded: Array<{ symbol: string; reason: string }>; asOf: string; methodology: string } {
  const maxPicks = Math.max(1, Math.min(5, Math.floor(config.maxPicks ?? 5)));
  const roundTripCost = Math.max(0, config.roundTripCost ?? 0.002);
  const minHistory = Math.max(20, Math.floor(config.minHistory ?? 60));
  // A closed exchange legitimately has no current bar. Keep the last verified
  // session available for research, but do not let an old dataset masquerade
  // as current data. The route can tighten this during an open session.
  const maxDataAgeDays = Math.max(1, config.maxDataAgeDays ?? 10);
  const marketOpen = config.marketOpen ?? true;
  const excluded: Array<{ symbol: string; reason: string }> = [];
  const candidates: ScannerCandidate[] = [];

  for (const input of inputs) {
    const bars = input.bars.filter((bar) => Number.isFinite(bar.close) && bar.close > 0 && asDate(bar.timestamp)).sort((a, b) => asDate(a.timestamp)!.getTime() - asDate(b.timestamp)!.getTime());
    const prediction = input.prediction;
    if (bars.length < minHistory) { excluded.push({ symbol: input.symbol, reason: `Only ${bars.length} daily observations; requires ${minHistory}.` }); continue; }
    const latest = asDate(bars[bars.length - 1].timestamp)!;
    const ageDays = (now.getTime() - latest.getTime()) / 86400000;
    if (ageDays > maxDataAgeDays) { excluded.push({ symbol: input.symbol, reason: `Daily data is ${ageDays.toFixed(1)} days old; maximum accepted age is ${maxDataAgeDays} days.` }); continue; }
    const closes = bars.map((bar) => bar.close);
    const logReturns = returns(closes.slice(-Math.min(90, closes.length)));
    const mean = logReturns.reduce((sum, value) => sum + value, 0) / Math.max(1, logReturns.length);
    const variance = logReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, logReturns.length - 1);
    const dailyVolatility = Math.sqrt(Math.max(0, variance));
    const spot = closes[closes.length - 1];
    const base20 = closes[Math.max(0, closes.length - 21)];
    const base60 = closes[Math.max(0, closes.length - 61)];
    const momentum20d = spot / base20 - 1;
    const momentum60d = spot / base60 - 1;
    let peak = closes[Math.max(0, closes.length - 60)];
    let maxDrawdown60d = 0;
    for (const close of closes.slice(-60)) { peak = Math.max(peak, close); maxDrawdown60d = Math.min(maxDrawdown60d, close / peak - 1); }
    const riskPenalty = Math.min(0.02, Math.abs(maxDrawdown60d) * 0.15 + dailyVolatility * 0.1);
    const dataStatus: ScannerCandidate["dataStatus"] = !marketOpen && ageDays > 1 / 24 ? "CLOSED_LAST_SESSION" : "CURRENT";

    // Preferred path: a validated model signal that clears every research gate.
    const modelReady = prediction
      && prediction.expectedReturn != null
      && prediction.confidence != null
      && prediction.calibrationStatus === "CALIBRATED"
      && prediction.predictionStatus === "PROMOTION_READY"
      && (prediction.actionStatus === "ACTIONABLE_LONG" || prediction.actionStatus === "ACTIONABLE_SHORT");
    if (modelReady) {
      const expectedReturn = prediction.expectedReturn as number;
      const netExpectedReturn = expectedReturn - roundTripCost;
      if (netExpectedReturn <= 0) { excluded.push({ symbol: input.symbol, reason: `Model expected return ${(expectedReturn * 100).toFixed(2)}% does not cover ${(roundTripCost * 100).toFixed(2)}% round-trip cost.` }); continue; }
      const confidence = prediction.confidence as number;
      const directionAligned = Math.sign(expectedReturn) === Math.sign(momentum20d || expectedReturn);
      const score = netExpectedReturn * 100 + confidence * 20 + (directionAligned ? 2 : -2) - riskPenalty * 100;
      const reasons = [
        `${expectedReturn >= 0 ? "Expected upside" : "Expected downside"} ${(Math.abs(expectedReturn) * 100).toFixed(2)}% from calibrated ${prediction!.horizon} forecast.`,
        `${(confidence * 100).toFixed(0)}% model confidence with prior OOS calibration status.`,
        `20-day momentum ${(momentum20d * 100).toFixed(2)}% and 60-day momentum ${(momentum60d * 100).toFixed(2)}%.`,
      ];
      const risks = [`Round-trip cost assumption ${(roundTripCost * 100).toFixed(2)}% must be verified for the instrument.`, `60-day maximum drawdown ${(Math.abs(maxDrawdown60d) * 100).toFixed(2)}%.`];
      if (!directionAligned) risks.push("Model direction and recent momentum disagree.");
      candidates.push({ symbol: input.symbol, name: input.name, spot, expectedReturn, netExpectedReturn, confidence, horizon: prediction!.horizon, dailyVolatility, momentum20d, momentum60d, maxDrawdown60d, dataDays: bars.length, dataAsOf: latest.toISOString(), dataStatus, score, basis: "MODEL", reasons, risks });
      continue;
    }

    // Honest fallback: rank from realized closes only. This is a technical
    // evidence screen, not a predictive signal, and is labelled as such so the
    // scanner can still surface qualifying instruments when no model has been
    // promoted yet — without inventing a forward return forecast.
    const netMomentum = momentum20d - roundTripCost;
    const modelNote = !prediction || prediction.expectedReturn == null
      ? "no model forecast is available"
      : prediction.calibrationStatus !== "CALIBRATED"
        ? "model probability is uncalibrated"
        : prediction.predictionStatus !== "PROMOTION_READY"
          ? "model failed the OOS promotion gate"
          : "the model action gate did not clear";
    if (momentum20d <= 0 || momentum60d <= 0 || netMomentum <= 0) { excluded.push({ symbol: input.symbol, reason: `Momentum evidence too weak: ${modelNote}, and realized 20/60-session momentum is not positive net of ${(roundTripCost * 100).toFixed(2)}% cost.` }); continue; }
    let strength = 0.35 /* 20d up */ + 0.3 /* 60d up */;
    if (maxDrawdown60d > -0.15) strength += 0.15;
    strength += bars.length >= 120 ? 0.1 : 0.05;
    strength += ageDays <= 1 / 24 ? 0.1 : 0.05;
    const confidence = Math.min(1, strength);
    const expectedReturn = momentum20d;
    const netExpectedReturn = netMomentum;
    const score = netExpectedReturn * 100 + momentum60d * 100 * 0.5 - riskPenalty * 100;
    const reasons = [
      `Realized 20-session momentum ${(momentum20d * 100).toFixed(2)}% and 60-session momentum ${(momentum60d * 100).toFixed(2)}% confirm an established uptrend in persisted closes.`,
      `Ranked from realized daily bars only — a technical-evidence screen, not a validated model forecast (${modelNote}).`,
      `Volatility-adjusted: daily vol ${(dailyVolatility * 100).toFixed(2)}%, 60-day max drawdown ${(Math.abs(maxDrawdown60d) * 100).toFixed(2)}% on ${bars.length} sessions of history.`,
    ];
    const risks = [
      `No forward return is predicted; "${(expectedReturn * 100).toFixed(2)}%" is the realized trailing move. ${modelNote === "no model forecast is available" ? "Retrain/promote a model to upgrade this to a signal-grade pick." : "Promote the model to upgrade this to a signal-grade pick."}`,
      `Round-trip cost assumption ${(roundTripCost * 100).toFixed(2)}% must be verified for the instrument.`,
    ];
    candidates.push({ symbol: input.symbol, name: input.name, spot, expectedReturn, netExpectedReturn, confidence, horizon: "20d", dailyVolatility, momentum20d, momentum60d, maxDrawdown60d, dataDays: bars.length, dataAsOf: latest.toISOString(), dataStatus, score, basis: "EVIDENCE", reasons, risks });
  }
  // Signal-grade picks always outrank evidence-grade ones; within a tier, score.
  candidates.sort((a, b) => (a.basis === b.basis ? b.score - a.score : a.basis === "MODEL" ? -1 : 1));
  const hasEvidence = candidates.some((candidate) => candidate.basis === "EVIDENCE");
  const methodology = `${hasEvidence ? "realized-momentum evidence screen (technical, non-predictive)" : "calibrated-oos-forecast"} + daily-momentum-confirmation - round-trip-cost - drawdown-risk-penalty; closed markets use the latest verified session; abstain when history, freshness, or net edge is unavailable`;
  return { picks: candidates.slice(0, maxPicks), excluded, asOf: now.toISOString(), methodology };
}
