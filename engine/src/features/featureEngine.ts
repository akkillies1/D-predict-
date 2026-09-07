import { pool, getInstrumentId } from "../db.js";
import { config } from "../config.js";
import {
  Bar,
  atr,
  classifyRegime,
  classifyTrend,
  expectedMove,
  macd,
  rsi,
  sma,
  volumeZScore,
} from "./indicators.js";

const LOOKBACK_BARS = 100; // enough for slow EMA(21) + ATR(14) + a volatility baseline

interface BarWithVolume extends Bar {
  volume: number | null;
}

async function loadRecentBars(instrumentId: string, timeframe: string): Promise<BarWithVolume[]> {
  const res = await pool.query(
    `select market_timestamp, open, high, low, close, volume
     from price_bars
     where instrument_id = $1 and timeframe = $2
     order by market_timestamp desc
     limit $3`,
    [instrumentId, timeframe, LOOKBACK_BARS]
  );
  return res.rows
    .map((r) => ({
      timestamp: new Date(r.market_timestamp),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: r.volume !== null ? Number(r.volume) : null,
    }))
    .reverse(); // oldest -> newest
}

interface OptionAggRow {
  strike: number;
  optionType: "CE" | "PE";
  oi: number;
}

/** Latest OI per (strike, CE/PE) for the nearest unexpired expiry. Uses each
 * contract's most recent snapshot rather than an exact timestamp match,
 * since option snapshots and price bars aren't polled in lockstep. */
async function loadNearestExpiryOi(instrumentId: string): Promise<OptionAggRow[]> {
  const res = await pool.query(
    `with nearest_expiry as (
       select expiry_date from option_contracts
       where instrument_id = $1 and expiry_date >= current_date
       order by expiry_date asc limit 1
     ),
     latest_snapshot as (
       select distinct on (os.contract_id)
         os.contract_id, os.oi
       from option_snapshots os
       join option_contracts oc on oc.contract_id = os.contract_id
       where oc.instrument_id = $1
         and oc.expiry_date = (select expiry_date from nearest_expiry)
       order by os.contract_id, os.market_timestamp desc
     )
     select oc.strike, oc.option_type as "optionType", coalesce(ls.oi, 0) as oi
     from option_contracts oc
     join latest_snapshot ls on ls.contract_id = oc.contract_id
     where oc.instrument_id = $1
       and oc.expiry_date = (select expiry_date from nearest_expiry)`,
    [instrumentId]
  );
  return res.rows.map((r) => ({ strike: Number(r.strike), optionType: r.optionType, oi: Number(r.oi) }));
}

function computePcr(rows: OptionAggRow[]): number | null {
  const callOi = rows.filter((r) => r.optionType === "CE").reduce((a, r) => a + r.oi, 0);
  const putOi = rows.filter((r) => r.optionType === "PE").reduce((a, r) => a + r.oi, 0);
  if (callOi === 0) return null;
  return putOi / callOi;
}

/** Max pain: the strike at which option writers collectively owe the least
 * at expiry, computed by summing (in-the-money payout * OI) across all
 * contracts for each candidate settlement strike and taking the minimum. */
function computeMaxPain(rows: OptionAggRow[]): number | null {
  const strikes = [...new Set(rows.map((r) => r.strike))].sort((a, b) => a - b);
  if (strikes.length === 0) return null;

  let minPain = Infinity;
  let maxPainStrike = strikes[0];

  for (const settle of strikes) {
    let totalPayout = 0;
    for (const row of rows) {
      if (row.optionType === "CE" && settle > row.strike) {
        totalPayout += (settle - row.strike) * row.oi;
      } else if (row.optionType === "PE" && settle < row.strike) {
        totalPayout += (row.strike - settle) * row.oi;
      }
    }
    if (totalPayout < minPain) {
      minPain = totalPayout;
      maxPainStrike = settle;
    }
  }
  return maxPainStrike;
}

async function computeAndPersistFeatures(symbol: string, timeframe = "1m"): Promise<void> {
  const instrumentId = await getInstrumentId(symbol);
  const bars = await loadRecentBars(instrumentId, timeframe);

  if (bars.length < 25) {
    console.warn(`[features] ${symbol}: only ${bars.length} bars available, skipping (need >=25)`);
    return;
  }

  const closes = bars.map((b) => b.close);
  const trend = classifyTrend(closes);
  const rsiValue = rsi(closes);
  const atrValue = atr(bars);

  // Rolling ATR average as a volatility baseline for regime classification.
  const atrSeries: number[] = [];
  for (let i = 20; i <= bars.length; i++) {
    const a = atr(bars.slice(0, i));
    if (a !== null) atrSeries.push(a);
  }
  const avgAtr = sma(atrSeries, Math.min(20, atrSeries.length));
  const regime = classifyRegime(trend, atrValue, avgAtr);

  const momentum =
    closes.length >= 10 ? ((closes[closes.length - 1] - closes[closes.length - 10]) / closes[closes.length - 10]) * 100 : null;

  const move = expectedMove(atrValue, 1, null); // ivImpliedMove wired up once ATM IV history is deep enough

  // Independent confirmation signals — react differently to price action than
  // the EMA-crossover trend call, so agreement between them is more
  // informative than repeating the same signal twice.
  const macdResult = macd(closes);
  const volumes = bars.map((b) => b.volume).filter((v): v is number => v !== null);
  const volZ = volumeZScore(volumes);

  // Options-chain features. Computed from whatever OI data has been collected
  // so far — safe to be sparse/null early on, gets more reliable as the
  // collector accumulates snapshots (per the "collect from day one" decision).
  let pcr: number | null = null;
  let maxPainStrike: number | null = null;
  try {
    const oiRows = await loadNearestExpiryOi(instrumentId);
    if (oiRows.length > 0) {
      pcr = computePcr(oiRows);
      maxPainStrike = computeMaxPain(oiRows);
    }
  } catch (err) {
    console.warn(`[features] ${symbol}: options-chain features unavailable (${(err as Error).message})`);
  }

  const latestTimestamp = bars[bars.length - 1].timestamp;

  await pool.query(
    `insert into feature_snapshots (
       instrument_id, timestamp, feature_set_version,
       trend, momentum, rsi, atr, expected_move, regime, pcr, max_pain_strike, raw_features
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict (instrument_id, timestamp, feature_set_version) do update
       set trend = excluded.trend, momentum = excluded.momentum, rsi = excluded.rsi,
           atr = excluded.atr, expected_move = excluded.expected_move,
           regime = excluded.regime, pcr = excluded.pcr, max_pain_strike = excluded.max_pain_strike,
           raw_features = excluded.raw_features`,
    [
      instrumentId,
      latestTimestamp,
      config.featureSetVersion,
      trend,
      momentum,
      rsiValue,
      atrValue,
      move,
      regime,
      pcr,
      maxPainStrike,
      JSON.stringify({ barsUsed: bars.length, avgAtr, macdHistogram: macdResult?.histogram ?? null, volumeZ: volZ }),
    ]
  );

  console.log(
    `[features] ${symbol} @ ${latestTimestamp.toISOString()}: trend=${trend} rsi=${rsiValue?.toFixed(1)} atr=${atrValue?.toFixed(2)} regime=${regime} pcr=${pcr?.toFixed(2) ?? "n/a"} maxPain=${maxPainStrike ?? "n/a"} macdHist=${macdResult?.histogram.toFixed(2) ?? "n/a"} volZ=${volZ?.toFixed(2) ?? "n/a"}`
  );
}

export async function runFeatureEngine(): Promise<void> {
  for (const symbol of config.instruments) {
    await computeAndPersistFeatures(symbol);
  }
}
