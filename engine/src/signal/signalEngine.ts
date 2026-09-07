import { pool, getInstrumentId, getSpotPriceAt } from "../db.js";
import { config } from "../config.js";

interface LatestFeatureRow {
  id: number;
  timestamp: Date;
  trend: string;
  momentum: number | null;
  rsi: number | null;
  atr: number | null;
  regime: string;
  pcr: number | null;
  maxPainStrike: number | null;
  macdHistogram: number | null;
  volumeZ: number | null;
}

async function loadLatestFeatures(instrumentId: string): Promise<LatestFeatureRow | null> {
  const res = await pool.query(
    `select id, timestamp, trend, momentum, rsi, atr, regime, pcr, max_pain_strike, raw_features
     from feature_snapshots
     where instrument_id = $1 and feature_set_version = $2
     order by timestamp desc
     limit 1`,
    [instrumentId, config.featureSetVersion]
  );
  if (res.rows.length === 0) return null;
  const r = res.rows[0];
  const raw = r.raw_features ?? {};
  return {
    id: r.id,
    timestamp: new Date(r.timestamp),
    trend: r.trend,
    momentum: r.momentum !== null ? Number(r.momentum) : null,
    rsi: r.rsi !== null ? Number(r.rsi) : null,
    atr: r.atr !== null ? Number(r.atr) : null,
    regime: r.regime,
    pcr: r.pcr !== null ? Number(r.pcr) : null,
    maxPainStrike: r.max_pain_strike !== null ? Number(r.max_pain_strike) : null,
    macdHistogram: raw.macdHistogram ?? null,
    volumeZ: raw.volumeZ ?? null,
  };
}

type Direction = "BULLISH" | "BEARISH" | "NEUTRAL";

interface SignalResult {
  direction: Direction;
  confidence: number; // 0..1
  reasonCodes: string[];
}

/**
 * Deliberately simple, deterministic v1 rule set:
 *   trend + momentum agreement => directional call
 *   RSI extremes reduce confidence (mean-reversion risk against the trend call)
 *   HIGH_VOL regime caps confidence — direction is less trustworthy there
 *   MACD histogram, volume, PCR, and max-pain add independent confirmation/
 *     divergence on top of the base trend call (see inline notes on each —
 *     PCR and max-pain in particular rest on debated market-folklore
 *     assumptions, not proven relationships; they're small, capped nudges,
 *     not primary drivers, on purpose)
 * This is the layer to backtest FIRST, in isolation, before anything downstream
 * is trusted (per the "does the directional engine actually work" rule).
 */
function computeSignal(f: LatestFeatureRow, spot: number | null): SignalResult {
  const reasonCodes: string[] = [];
  let direction: Direction = "NEUTRAL";
  let confidence = 0.5;

  const momentumAgreesUp = f.momentum !== null && f.momentum > 0;
  const momentumAgreesDown = f.momentum !== null && f.momentum < 0;

  if (f.trend === "UP" && momentumAgreesUp) {
    direction = "BULLISH";
    confidence += 0.2;
    reasonCodes.push("TREND_UP", "MOMENTUM_CONFIRMS");
  } else if (f.trend === "DOWN" && momentumAgreesDown) {
    direction = "BEARISH";
    confidence += 0.2;
    reasonCodes.push("TREND_DOWN", "MOMENTUM_CONFIRMS");
  } else if (f.trend === "UP" || f.trend === "DOWN") {
    direction = f.trend === "UP" ? "BULLISH" : "BEARISH";
    reasonCodes.push(`TREND_${f.trend}`, "MOMENTUM_DIVERGES");
    confidence -= 0.1;
  } else {
    reasonCodes.push("TREND_SIDEWAYS");
  }

  if (f.rsi !== null) {
    if (f.rsi > 70 && direction === "BULLISH") {
      confidence -= 0.15;
      reasonCodes.push("RSI_OVERBOUGHT");
    } else if (f.rsi < 30 && direction === "BEARISH") {
      confidence -= 0.15;
      reasonCodes.push("RSI_OVERSOLD");
    }
  }

  if (f.regime === "HIGH_VOL") {
    confidence -= 0.15;
    reasonCodes.push("HIGH_VOL_REGIME_PENALTY");
  } else if (f.regime === "TRENDING") {
    confidence += 0.05;
    reasonCodes.push("TRENDING_REGIME_BONUS");
  }

  // MACD: reacts to price action differently than the EMA-crossover trend
  // call above (different periods, different smoothing), so agreement is a
  // genuinely independent check rather than the same signal counted twice.
  if (direction !== "NEUTRAL" && f.macdHistogram !== null) {
    const macdBullish = f.macdHistogram > 0;
    if ((direction === "BULLISH" && macdBullish) || (direction === "BEARISH" && !macdBullish)) {
      confidence += 0.1;
      reasonCodes.push("MACD_CONFIRMS");
    } else {
      confidence -= 0.1;
      reasonCodes.push("MACD_DIVERGES");
    }
  }

  // Volume: a move on unusually high volume is more trustworthy than the
  // same move on thin volume; unusually low volume is a caution flag, not
  // a directional signal by itself.
  if (direction !== "NEUTRAL" && f.volumeZ !== null) {
    if (f.volumeZ > 1) {
      confidence += 0.05;
      reasonCodes.push("VOLUME_CONFIRMS");
    } else if (f.volumeZ < -1) {
      confidence -= 0.05;
      reasonCodes.push("LOW_VOLUME_CAUTION");
    }
  }

  // Put-Call Ratio: a commonly cited (but genuinely debated) options-sentiment
  // read — elevated PCR (more puts written) is conventionally read as a
  // bullish tilt from option writers, and vice versa. Treated here as a
  // small nudge, not a primary driver, precisely because the relationship
  // isn't settled — the backtest's reason-code breakdown is what should
  // decide whether OI_PCR_* actually earns its keep.
  if (direction !== "NEUTRAL" && f.pcr !== null) {
    if (f.pcr > 1.2) {
      if (direction === "BULLISH") { confidence += 0.1; reasonCodes.push("OI_PCR_CONFIRMS"); }
      else { confidence -= 0.05; reasonCodes.push("OI_PCR_DIVERGES"); }
    } else if (f.pcr < 0.8) {
      if (direction === "BEARISH") { confidence += 0.1; reasonCodes.push("OI_PCR_CONFIRMS"); }
      else { confidence -= 0.05; reasonCodes.push("OI_PCR_DIVERGES"); }
    }
  }

  // Max pain "magnet" theory: the (contested) idea that price drifts toward
  // the max-pain strike as expiry approaches, since that's where option
  // writers collectively owe the least. Also a small nudge, also something
  // the backtest should validate or kill, not an assumption to trust blindly.
  if (direction !== "NEUTRAL" && f.maxPainStrike !== null && spot !== null) {
    const priceIsBelowMaxPain = spot < f.maxPainStrike;
    if ((direction === "BULLISH" && priceIsBelowMaxPain) || (direction === "BEARISH" && !priceIsBelowMaxPain)) {
      confidence += 0.05;
      reasonCodes.push("MAX_PAIN_MAGNET_CONFIRMS");
    } else {
      confidence -= 0.05;
      reasonCodes.push("MAX_PAIN_MAGNET_DIVERGES");
    }
  }

  confidence = Math.max(0, Math.min(1, confidence));
  return { direction, confidence, reasonCodes };
}

async function runForSymbol(symbol: string): Promise<void> {
  const instrumentId = await getInstrumentId(symbol);
  const features = await loadLatestFeatures(instrumentId);
  if (!features) {
    console.warn(`[signal] ${symbol}: no feature snapshot available, skipping`);
    return;
  }

  const spot = await getSpotPriceAt(instrumentId, features.timestamp);
  const result = computeSignal(features, spot);

  await pool.query(
    `insert into signal_decisions (
       instrument_id, timestamp, strategy_version, model_version,
       input_snapshot_id, direction, confidence, regime, reason_codes, parameters
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      instrumentId,
      features.timestamp,
      config.strategyVersion,
      config.modelVersion,
      features.id,
      result.direction,
      result.confidence,
      features.regime,
      result.reasonCodes,
      JSON.stringify({
        rsi: features.rsi,
        momentum: features.momentum,
        atr: features.atr,
        macdHistogram: features.macdHistogram,
        volumeZ: features.volumeZ,
        pcr: features.pcr,
        maxPainStrike: features.maxPainStrike,
        spot,
      }),
    ]
  );

  console.log(
    `[signal] ${symbol} @ ${features.timestamp.toISOString()}: ${result.direction} confidence=${result.confidence.toFixed(2)} [${result.reasonCodes.join(", ")}]`
  );
}

export async function runSignalEngine(): Promise<void> {
  for (const symbol of config.instruments) {
    await runForSymbol(symbol);
  }
}
