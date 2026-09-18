export type ScannerBar = { timestamp: string | Date; close: number };
export type ScannerPrediction = { expectedReturn: number | null; confidence: number | null; timestamp: string | Date; horizon: string; calibrationStatus?: string | null; modelVersion?: string | null };
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
  score: number;
  reasons: string[];
  risks: string[];
};

export type ScannerConfig = { maxPicks?: number; roundTripCost?: number; minHistory?: number; maxDataAgeDays?: number };

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
  const maxDataAgeDays = Math.max(1, config.maxDataAgeDays ?? 3);
  const excluded: Array<{ symbol: string; reason: string }> = [];
  const candidates: ScannerCandidate[] = [];

  for (const input of inputs) {
    const bars = input.bars.filter((bar) => Number.isFinite(bar.close) && bar.close > 0 && asDate(bar.timestamp)).sort((a, b) => asDate(a.timestamp)!.getTime() - asDate(b.timestamp)!.getTime());
    const prediction = input.prediction;
    if (bars.length < minHistory) { excluded.push({ symbol: input.symbol, reason: `Only ${bars.length} daily observations; requires ${minHistory}.` }); continue; }
    if (!prediction || prediction.expectedReturn == null || prediction.confidence == null) { excluded.push({ symbol: input.symbol, reason: "No model return forecast available." }); continue; }
    if (prediction.calibrationStatus !== "CALIBRATED") { excluded.push({ symbol: input.symbol, reason: "Prediction probability is not calibrated from prior OOS examples." }); continue; }
    const latest = asDate(bars[bars.length - 1].timestamp)!;
    const ageDays = (now.getTime() - latest.getTime()) / 86400000;
    if (ageDays > maxDataAgeDays) { excluded.push({ symbol: input.symbol, reason: `Daily data is ${ageDays.toFixed(1)} days old.` }); continue; }
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
    const expectedReturn = prediction.expectedReturn;
    const netExpectedReturn = expectedReturn - roundTripCost;
    if (netExpectedReturn <= 0) { excluded.push({ symbol: input.symbol, reason: `Expected return ${(expectedReturn * 100).toFixed(2)}% does not cover ${(roundTripCost * 100).toFixed(2)}% round-trip cost.` }); continue; }
    const directionAligned = Math.sign(expectedReturn) === Math.sign(momentum20d || expectedReturn);
    const riskPenalty = Math.min(0.02, Math.abs(maxDrawdown60d) * 0.15 + dailyVolatility * 0.1);
    const score = netExpectedReturn * 100 + prediction.confidence * 20 + (directionAligned ? 2 : -2) - riskPenalty * 100;
    const reasons = [
      `${expectedReturn >= 0 ? "Expected upside" : "Expected downside"} ${(Math.abs(expectedReturn) * 100).toFixed(2)}% from calibrated ${prediction.horizon} forecast.`,
      `${(prediction.confidence * 100).toFixed(0)}% model confidence with prior OOS calibration status.`,
      `20-day momentum ${(momentum20d * 100).toFixed(2)}% and 60-day momentum ${(momentum60d * 100).toFixed(2)}%.`,
    ];
    const risks = [`Round-trip cost assumption ${(roundTripCost * 100).toFixed(2)}% must be verified for the instrument.`, `60-day maximum drawdown ${(Math.abs(maxDrawdown60d) * 100).toFixed(2)}%.`];
    if (!directionAligned) risks.push("Model direction and recent momentum disagree.");
    candidates.push({ symbol: input.symbol, name: input.name, spot, expectedReturn, netExpectedReturn, confidence: prediction.confidence, horizon: prediction.horizon, dailyVolatility, momentum20d, momentum60d, maxDrawdown60d, dataDays: bars.length, dataAsOf: latest.toISOString(), score, reasons, risks });
  }
  candidates.sort((a, b) => b.score - a.score);
  return { picks: candidates.slice(0, maxPicks), excluded, asOf: now.toISOString(), methodology: "calibrated-oos-forecast + daily-momentum-confirmation - round-trip-cost - drawdown-risk-penalty; abstain when data, calibration, or net edge is unavailable" };
}
