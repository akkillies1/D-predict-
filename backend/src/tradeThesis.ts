import type { Pool } from "pg";

type SignalRow = {
  symbol: string;
  timestamp: Date | string;
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
  confidence: number;
};

type Timing = {
  status: "CALIBRATED" | "INSUFFICIENT_HISTORY";
  expectedSeconds?: number;
  p25Seconds?: number;
  p50Seconds?: number;
  p75Seconds?: number;
  samples: number;
  resolution: "1m";
  method: "empirical_first_passage_time";
  warning?: string;
};

const TARGET_PROBABILITIES = [0.65, 0.45, 0.25] as const;
const MIN_RESIDUAL_HISTORY = 60;
const MIN_TIMING_EVENTS = 20;
const MAX_LOOKAHEAD_BARS = 390;

function quantile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) throw new Error("empty quantile input");
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

async function firstPassageTiming(
  pool: Pool,
  symbol: string,
  targetReturn: number,
  direction: "LONG" | "SHORT",
  cutoff: Date | string,
): Promise<Timing> {
  const cutoffDate = new Date(cutoff);
  if (!Number.isFinite(cutoffDate.getTime())) {
    return {
      status: "INSUFFICIENT_HISTORY",
      samples: 0,
      resolution: "1m",
      method: "empirical_first_passage_time",
      warning: "Invalid signal timestamp; minute-level ETA is withheld.",
    };
  }

  // Calibration is intentionally point-in-time: each historical entry is
  // before the signal cutoff, while bars after that entry provide its future
  // first-passage outcome. Never include bars at or after the live signal
  // timestamp, because those observations would leak the current outcome.
  const result = await pool.query(
    `select pb.market_timestamp, pb.close
       from price_bars pb
       join instruments i on i.instrument_id=pb.instrument_id
      where i.symbol=$1
        and pb.timeframe='1m'
        and pb.market_timestamp < $2
      order by pb.market_timestamp desc limit 5000`,
    [symbol, cutoffDate],
  );
  const bars = result.rows.reverse().map(row => ({
    timestamp: new Date(row.market_timestamp).getTime(),
    close: Number(row.close),
  })).filter(row => Number.isFinite(row.timestamp) && Number.isFinite(row.close) && row.close > 0);

  const durations: number[] = [];
  for (let i = 0; i < bars.length - 1 && durations.length < 100; i += 1) {
    const entry = bars[i];
    const targetPrice = entry.close * (1 + targetReturn);
    const end = Math.min(bars.length, i + 1 + MAX_LOOKAHEAD_BARS);
    for (let j = i + 1; j < end; j += 1) {
      const reached = direction === "LONG" ? bars[j].close >= targetPrice : bars[j].close <= targetPrice;
      if (reached) {
        durations.push((bars[j].timestamp - entry.timestamp) / 1000);
        break;
      }
    }
  }

  if (durations.length < MIN_TIMING_EVENTS) {
    return {
      status: "INSUFFICIENT_HISTORY",
      samples: durations.length,
      resolution: "1m",
      method: "empirical_first_passage_time",
      warning: `Need at least ${MIN_TIMING_EVENTS} historical first-passage events; minute-level ETA is withheld otherwise.`,
    };
  }
  return {
    status: "CALIBRATED",
    expectedSeconds: quantile(durations, 0.5),
    p25Seconds: quantile(durations, 0.25),
    p50Seconds: quantile(durations, 0.5),
    p75Seconds: quantile(durations, 0.75),
    samples: durations.length,
    resolution: "1m",
    method: "empirical_first_passage_time",
    warning: "Target arrival time is probabilistic, not an exact timestamp.",
  };
}

export async function buildCausalTradeThesis(pool: Pool, signal: SignalRow, entryPrice: number) {
  const prediction = await pool.query(
    `select timestamp, horizon, expected_return, outcome_return
       from prediction_ledger
      where symbol=$1 and timestamp <= $2 and expected_return is not null
      order by timestamp desc limit 1`,
    [signal.symbol, signal.timestamp],
  );
  if (!prediction.rows.length) {
    return { decision: "NO_TRADE", signal: "NO_TRADE", reason: "NO_POINT_IN_TIME_RETURN_FORECAST" };
  }

  const forecast = prediction.rows[0];
  const horizon = String(forecast.horizon);
  const history = await pool.query(
    `select outcome_return, expected_return
       from prediction_ledger
      where symbol=$1 and horizon=$2 and timestamp < $3
        and outcome_return is not null and expected_return is not null
      order by timestamp desc limit 1000`,
    [signal.symbol, horizon, signal.timestamp],
  );
  const residuals = history.rows
    .map(row => Number(row.outcome_return) - Number(row.expected_return))
    .filter(Number.isFinite);

  if (residuals.length < MIN_RESIDUAL_HISTORY) {
    return {
      symbol: signal.symbol,
      timestamp: new Date(signal.timestamp).toISOString(),
      direction: signal.direction === "BULLISH" ? "LONG" : signal.direction === "BEARISH" ? "SHORT" : "FLAT",
      signal: signal.direction === "NEUTRAL" ? "HOLD" : "NO_TRADE",
      decision: "NO_TRADE",
      reason: "RETURN_DISTRIBUTION_UNCALIBRATED",
      distributionStatus: "UNCALIBRATED",
      residualHistory: residuals.length,
      requiredResidualHistory: MIN_RESIDUAL_HISTORY,
      expectedReturn: Number(forecast.expected_return),
      horizon,
    };
  }

  const direction = signal.direction === "BULLISH" ? "LONG" : signal.direction === "BEARISH" ? "SHORT" : "FLAT";
  if (direction === "FLAT") return { symbol: signal.symbol, timestamp: new Date(signal.timestamp).toISOString(), direction, signal: "HOLD", decision: "NO_TRADE", reason: "NEUTRAL_SIGNAL" };

  const predictedReturn = Number(forecast.expected_return);
  const targets = TARGET_PROBABILITIES.map(probability => {
    const residualQuantile = quantile(residuals, direction === "LONG" ? 1 - probability : probability);
    const targetReturn = predictedReturn + residualQuantile;
    return {
      return: targetReturn,
      price: entryPrice * (1 + targetReturn),
      probability,
    };
  }).filter(target => direction === "LONG" ? target.return > 0 : target.return < 0);

  const stopProbability = 0.15;
  const stopResidual = quantile(residuals, direction === "LONG" ? stopProbability : 1 - stopProbability);
  const stopReturn = predictedReturn + stopResidual;
  const stopValid = direction === "LONG" ? stopReturn < 0 : stopReturn > 0;
  if (!targets.length || !stopValid) {
      return { symbol: signal.symbol, timestamp: new Date(signal.timestamp).toISOString(), direction, signal: "NO_TRADE", decision: "NO_TRADE", reason: "INSUFFICIENT_ECONOMIC_EDGE", distributionStatus: "CALIBRATED", residualHistory: residuals.length, expectedReturn: predictedReturn, horizon };
  }

  const stopPrice = entryPrice * (1 + stopReturn);
  const risk = Math.abs(entryPrice - stopPrice);
  const reward = Math.abs(targets[0].price - entryPrice);
  const thesisTargets = [];
  for (const target of targets) {
    const timing = await firstPassageTiming(pool, signal.symbol, target.return, direction, signal.timestamp);
    thesisTargets.push({ ...target, timing });
  }

  return {
    symbol: signal.symbol,
    timestamp: new Date(signal.timestamp).toISOString(),
    signal: direction === "LONG" ? signal.confidence >= 0.7 ? "STRONG BUY" : "BUY" : signal.confidence >= 0.7 ? "STRONG SELL" : "SELL",
    decision: "EXECUTABLE",
    direction,
    entryPrice,
    expectedReturn: predictedReturn,
    horizon,
    targets: thesisTargets,
    stop: { price: stopPrice, probability: stopProbability, return: stopReturn },
    riskRewardToTarget1: risk > 0 ? reward / risk : null,
    probability: signal.confidence,
    confidence: signal.confidence,
    distributionStatus: "CALIBRATED",
    residualHistory: residuals.length,
    tradeThesisVersion: "return-distribution-v1-live",
  };
}
