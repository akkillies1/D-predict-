import { pool, getInstrumentId, getDailyClosesFromIntraday } from "../db.js";
import { config } from "../config.js";

interface PriceBarRow {
  timestamp: Date;
  close: number;
}

interface SignalRow {
  timestamp: Date;
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
  confidence: number;
  reasonCodes: string[];
}

interface BacktestResult {
  totalSignals: number;
  evaluable: number; // signals with enough future bars to score
  winRate: number;
  avgReturnPct: number;
  avgWinPct: number;
  avgLossPct: number;
  expectancyPct: number; // winRate*avgWin - lossRate*avgLoss
  byDirection: Record<string, { count: number; winRate: number; avgReturnPct: number }>;
  byReasonCode: Record<string, { count: number; winRate: number; avgReturnPct: number }>;
}

async function loadSignals(instrumentId: string): Promise<SignalRow[]> {
  const res = await pool.query(
    `select timestamp, direction, confidence, reason_codes
     from signal_decisions
     where instrument_id = $1 and strategy_version = $2
     order by timestamp asc`,
    [instrumentId, config.strategyVersion]
  );
  return res.rows.map((r) => ({
    timestamp: new Date(r.timestamp),
    direction: r.direction,
    confidence: Number(r.confidence),
    reasonCodes: r.reason_codes ?? [],
  }));
}

async function loadPriceBars(instrumentId: string, timeframe: string): Promise<PriceBarRow[]> {
  const res = await pool.query(
    `select market_timestamp as timestamp, close
     from price_bars
     where instrument_id = $1 and timeframe = $2
     order by market_timestamp asc`,
    [instrumentId, timeframe]
  );
  return res.rows.map((r) => ({ timestamp: new Date(r.timestamp), close: Number(r.close) }));
}

/** Finds the index of the first bar at or after a given timestamp (binary search
 * would be faster; linear is fine at personal-project data volumes). */
function findBarIndexAtOrAfter(bars: PriceBarRow[], ts: Date): number {
  return bars.findIndex((b) => b.timestamp.getTime() >= ts.getTime());
}

export async function backtestSignalEngine(
  symbol: string,
  opts: { timeframe?: string; horizonBars?: number; aggregateDailyFrom1m?: boolean } = {}
): Promise<BacktestResult> {
  // Default: aggregate the collector's '1m' bars into daily bars, since the
  // collector doesn't store a native '1d' timeframe. Pass
  // aggregateDailyFrom1m: false once/if a native daily timeframe exists.
  const aggregateDailyFrom1m = opts.aggregateDailyFrom1m ?? true;
  const timeframe = opts.timeframe ?? "1m";
  const horizonBars = opts.horizonBars ?? 1; // in the resulting bar unit (days, if aggregated)

  const instrumentId = await getInstrumentId(symbol);
  const signals = await loadSignals(instrumentId);
  const bars = aggregateDailyFrom1m
    ? await getDailyClosesFromIntraday(instrumentId, timeframe)
    : await loadPriceBars(instrumentId, timeframe);

  const returns: { direction: string; returnPct: number; reasonCodes: string[] }[] = [];

  for (const signal of signals) {
    if (signal.direction === "NEUTRAL") continue; // no directional call to score
    const entryIdx = findBarIndexAtOrAfter(bars, signal.timestamp);
    const exitIdx = entryIdx + horizonBars;
    if (entryIdx === -1 || exitIdx >= bars.length) continue; // not enough future data yet

    const entryPrice = bars[entryIdx].close;
    const exitPrice = bars[exitIdx].close;
    const rawReturnPct = ((exitPrice - entryPrice) / entryPrice) * 100;
    const signedReturnPct = signal.direction === "BULLISH" ? rawReturnPct : -rawReturnPct;

    returns.push({ direction: signal.direction, returnPct: signedReturnPct, reasonCodes: signal.reasonCodes });
  }

  const evaluable = returns.length;
  const wins = returns.filter((r) => r.returnPct > 0);
  const losses = returns.filter((r) => r.returnPct <= 0);

  const avgReturnPct = evaluable > 0 ? returns.reduce((a, r) => a + r.returnPct, 0) / evaluable : 0;
  const avgWinPct = wins.length > 0 ? wins.reduce((a, r) => a + r.returnPct, 0) / wins.length : 0;
  const avgLossPct = losses.length > 0 ? losses.reduce((a, r) => a + r.returnPct, 0) / losses.length : 0;
  const winRate = evaluable > 0 ? wins.length / evaluable : 0;
  const expectancyPct = winRate * avgWinPct + (1 - winRate) * avgLossPct;

  const byDirection: BacktestResult["byDirection"] = {};
  for (const dir of ["BULLISH", "BEARISH"]) {
    const subset = returns.filter((r) => r.direction === dir);
    const subsetWins = subset.filter((r) => r.returnPct > 0);
    byDirection[dir] = {
      count: subset.length,
      winRate: subset.length > 0 ? subsetWins.length / subset.length : 0,
      avgReturnPct: subset.length > 0 ? subset.reduce((a, r) => a + r.returnPct, 0) / subset.length : 0,
    };
  }

  // Which individual rule component correlates with better/worse outcomes —
  // e.g. does RSI_OVERBOUGHT actually predict worse returns, or is the
  // confidence penalty for it unjustified? A signal usually carries several
  // reason codes at once, so counts here overlap by design.
  const byReasonCode: BacktestResult["byReasonCode"] = {};
  const allCodes = new Set(returns.flatMap((r) => r.reasonCodes));
  for (const code of allCodes) {
    const subset = returns.filter((r) => r.reasonCodes.includes(code));
    const subsetWins = subset.filter((r) => r.returnPct > 0);
    byReasonCode[code] = {
      count: subset.length,
      winRate: subset.length > 0 ? subsetWins.length / subset.length : 0,
      avgReturnPct: subset.length > 0 ? subset.reduce((a, r) => a + r.returnPct, 0) / subset.length : 0,
    };
  }

  return {
    totalSignals: signals.length,
    evaluable,
    winRate,
    avgReturnPct,
    avgWinPct,
    avgLossPct,
    expectancyPct,
    byDirection,
    byReasonCode,
  };
}

export async function runBacktest(): Promise<void> {
  for (const symbol of config.instruments) {
    const result = await backtestSignalEngine(symbol);
    console.log(`\n[backtest] ${symbol} — signal engine only, no strike/sizing/hedging`);
    console.log(`  signals: ${result.totalSignals} total, ${result.evaluable} evaluable`);
    console.log(`  win rate: ${(result.winRate * 100).toFixed(1)}%`);
    console.log(`  avg return: ${result.avgReturnPct.toFixed(3)}%  (avg win ${result.avgWinPct.toFixed(3)}%, avg loss ${result.avgLossPct.toFixed(3)}%)`);
    console.log(`  expectancy: ${result.expectancyPct.toFixed(3)}% per signal`);
    console.log(`  by direction:`);
    for (const [dir, stats] of Object.entries(result.byDirection)) {
      console.log(`    ${dir}: n=${stats.count} winRate=${(stats.winRate * 100).toFixed(1)}% avgReturn=${stats.avgReturnPct.toFixed(3)}%`);
    }
    console.log(`  by reason code (which rule components help/hurt):`);
    for (const [code, stats] of Object.entries(result.byReasonCode)) {
      console.log(`    ${code}: n=${stats.count} winRate=${(stats.winRate * 100).toFixed(1)}% avgReturn=${stats.avgReturnPct.toFixed(3)}%`);
    }
  }
}
