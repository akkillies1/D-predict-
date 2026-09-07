export interface Bar {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
}

export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let emaVal = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    emaVal = values[i] * k + emaVal * (1 - k);
  }
  return emaVal;
}

/** Wilder's RSI. Returns null until enough bars exist. */
export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Average True Range — feeds both volatility regime and expected-move calc. */
export function atr(bars: Bar[], period = 14): number | null {
  if (bars.length < period + 1) return null;
  const trueRanges: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i];
    const prevClose = bars[i - 1].close;
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prevClose),
      Math.abs(cur.low - prevClose)
    );
    trueRanges.push(tr);
  }
  return sma(trueRanges, period);
}

export type Trend = "UP" | "DOWN" | "SIDEWAYS";

/** Simple trend classification: fast EMA vs slow EMA, with a flat-band deadzone. */
export function classifyTrend(closes: number[], fastPeriod = 9, slowPeriod = 21): Trend {
  const fast = ema(closes, fastPeriod);
  const slow = ema(closes, slowPeriod);
  if (fast === null || slow === null) return "SIDEWAYS";
  const spreadPct = ((fast - slow) / slow) * 100;
  if (spreadPct > 0.15) return "UP";
  if (spreadPct < -0.15) return "DOWN";
  return "SIDEWAYS";
}

export type Regime = "TRENDING" | "RANGE" | "HIGH_VOL";

/** Regime is trend strength qualified by volatility — a strong trend in high ATR
 * is still 'TRENDING', but choppy price with high ATR gets flagged HIGH_VOL
 * since direction there is less trustworthy. */
export function classifyRegime(trend: Trend, atrValue: number | null, avgAtr: number | null): Regime {
  if (atrValue !== null && avgAtr !== null && avgAtr > 0 && atrValue / avgAtr > 1.5) {
    return trend === "SIDEWAYS" ? "HIGH_VOL" : "TRENDING";
  }
  return trend === "SIDEWAYS" ? "RANGE" : "TRENDING";
}

/** Full EMA series (not just the final value) — needed to compute MACD's
 * signal line, which is itself an EMA of the MACD line. Entries before
 * `period` data points exist are null. */
function emaSeries(values: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return result;
  const k = 2 / (period + 1);
  let emaVal = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period - 1] = emaVal;
  for (let i = period; i < values.length; i++) {
    emaVal = values[i] * k + emaVal * (1 - k);
    result[i] = emaVal;
  }
  return result;
}

export interface MacdResult {
  macdLine: number;
  signalLine: number;
  histogram: number;
}

/** Standard MACD(12,26,9). Histogram sign/direction is what the signal engine
 * uses as an independent confirmation of the EMA-crossover trend call —
 * MACD reacts differently to price action than the fast/slow EMA spread
 * alone, so agreement between the two is more informative than either one
 * repeated twice. Returns null until enough closes exist for the signal line. */
export function macd(
  closes: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9
): MacdResult | null {
  const fastSeries = emaSeries(closes, fastPeriod);
  const slowSeries = emaSeries(closes, slowPeriod);

  const macdLineSeries: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    const f = fastSeries[i];
    const s = slowSeries[i];
    if (f !== null && s !== null) macdLineSeries.push(f - s);
  }

  if (macdLineSeries.length < signalPeriod) return null;

  const signalSeries = emaSeries(macdLineSeries, signalPeriod);
  const signalLine = signalSeries[signalSeries.length - 1];
  if (signalLine === null) return null;

  const macdLine = macdLineSeries[macdLineSeries.length - 1];
  return { macdLine, signalLine, histogram: macdLine - signalLine };
}

/** Expected move over a horizon, in price points — max of ATR-derived move
 * and IV-implied move (IV-implied requires an options layer; pass null until
 * that's wired up and this falls back to ATR alone). */
export function expectedMove(
  atrValue: number | null,
  horizonDays: number,
  ivImpliedMove: number | null
): number | null {
  if (atrValue === null) return ivImpliedMove;
  const atrMove = atrValue * Math.sqrt(horizonDays);
  if (ivImpliedMove === null) return atrMove;
  return Math.max(atrMove, ivImpliedMove);
}

/** Sample standard deviation of log returns over the trailing `period` bars —
 * the volatility input the Monte Carlo forecast calibrates against. Returns
 * per-bar volatility matching whatever timeframe `closes` is in (daily
 * closes in -> daily vol out); the caller is responsible for using it at a
 * consistent timeframe. Returns null until enough closes exist. */
export function historicalVolatility(closes: number[], period = 20): number | null {
  if (closes.length < period + 1) return null;
  const window = closes.slice(-period - 1);
  const logReturns: number[] = [];
  for (let i = 1; i < window.length; i++) {
    logReturns.push(Math.log(window[i] / window[i - 1]));
  }
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (logReturns.length - 1);
  return Math.sqrt(variance);
}

/** How unusual the most recent volume reading is versus its own recent
 * history, in standard deviations. Used as a confirmation signal — a move
 * on unusually high volume is more trustworthy than the same move on thin
 * volume. Returns null with fewer than `period + 1` readings, or when the
 * window has zero variance (avoids a divide-by-zero, not a meaningful 0). */
export function volumeZScore(volumes: number[], period = 20): number | null {
  if (volumes.length < period + 1) return null;
  const window = volumes.slice(-period - 1, -1); // history, excluding the latest reading
  const latest = volumes[volumes.length - 1];
  const mean = window.reduce((a, b) => a + b, 0) / window.length;
  const variance2 = window.reduce((a, b) => a + (b - mean) ** 2, 0) / window.length;
  const stdDev = Math.sqrt(variance2);
  if (stdDev === 0) return null;
  return (latest - mean) / stdDev;
}
