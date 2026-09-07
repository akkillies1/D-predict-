/**
 * Monte Carlo price-path simulation under Geometric Brownian Motion (GBM) —
 * the same random-walk assumption Black-Scholes itself is built on. This is
 * the "probability cone": instead of one predicted price, simulate many
 * random forward paths and read off the distribution of outcomes at each
 * future day.
 *
 * Deliberately zero-drift by default (a pure statistical baseline, not a
 * forecast tilted by the signal engine's directional view) — see forecastEngine.ts
 * for why that separation matters.
 *
 * Known limitations, stated plainly rather than buried:
 *   - GBM assumes returns are normally distributed. Real markets have fatter
 *     tails (crashes, gap opens on news/events) than this model captures.
 *   - Volatility is treated as constant over the horizon, when real
 *     volatility clusters and regime-shifts (the very thing the feature
 *     engine's regime classifier tracks, which this simulation ignores).
 *   - This model is a baseline for "how much could price plausibly move",
 *     not a claim about what it will do.
 */

export interface ConeBand {
  day: number;
  p10: number;
  p25: number;
  median: number;
  p75: number;
  p90: number;
}

export interface ForecastResult {
  bands: ConeBand[];
  terminalPrices: number[]; // final day's simulated prices, for probability queries
}

/** Deterministic seeded PRNG (mulberry32) — used so tests get reproducible
 * results. Production callers should pass Math.random instead. */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal sample via Box-Muller transform, driven by a uniform [0,1) RNG. */
function gaussianRandom(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function percentile(sortedAscending: number[], pct: number): number {
  const idx = (pct / 100) * (sortedAscending.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAscending[lo];
  const frac = idx - lo;
  return sortedAscending[lo] + (sortedAscending[hi] - sortedAscending[lo]) * frac;
}

/**
 * Simulates `numPaths` independent GBM price paths over `horizonDays` daily
 * steps, returning the percentile bands at each day (the cone) plus the raw
 * terminal-day prices for probability queries.
 *
 * @param spot current price
 * @param dailyVol per-day volatility (e.g. from historicalVolatility() on daily closes)
 * @param horizonDays number of daily steps to simulate forward
 * @param numPaths number of independent simulated paths — more paths = smoother
 *   percentile estimates but more compute; 2000-5000 is plenty for a personal tool
 * @param drift per-day expected log-return; 0 = pure random walk (default and
 *   recommended baseline — see forecastEngine.ts for why signal bias isn't
 *   blended in here by default)
 * @param rng uniform [0,1) random source; defaults to Math.random for
 *   production use, pass a seeded generator (mulberry32) for reproducible tests
 */
export function simulateProbabilityCone(
  spot: number,
  dailyVol: number,
  horizonDays: number,
  numPaths = 2000,
  drift = 0,
  rng: () => number = Math.random
): ForecastResult {
  if (spot <= 0) throw new Error("spot must be positive");
  if (dailyVol < 0) throw new Error("dailyVol cannot be negative");
  if (horizonDays < 1) throw new Error("horizonDays must be at least 1");

  let prices = new Array(numPaths).fill(spot);
  const bands: ConeBand[] = [];

  for (let day = 1; day <= horizonDays; day++) {
    const nextPrices = new Array(numPaths);
    for (let p = 0; p < numPaths; p++) {
      const z = gaussianRandom(rng);
      nextPrices[p] = prices[p] * Math.exp(drift - 0.5 * dailyVol * dailyVol + dailyVol * z);
    }
    prices = nextPrices;

    const sorted = [...prices].sort((a, b) => a - b);
    bands.push({
      day,
      p10: percentile(sorted, 10),
      p25: percentile(sorted, 25),
      median: percentile(sorted, 50),
      p75: percentile(sorted, 75),
      p90: percentile(sorted, 90),
    });
  }

  return { bands, terminalPrices: prices };
}

/** Fraction of simulated terminal paths landing within [lower, upper] —
 * e.g. "probability Nifty is between 24,800 and 25,200 at the horizon". */
export function probabilityInRange(terminalPrices: number[], lower: number, upper: number): number {
  const count = terminalPrices.filter((p) => p >= lower && p <= upper).length;
  return count / terminalPrices.length;
}

/** Fraction of simulated terminal paths above a threshold — e.g. probability
 * of finishing above a given strike (relevant for "will this option finish ITM"). */
export function probabilityAbove(terminalPrices: number[], threshold: number): number {
  return terminalPrices.filter((p) => p > threshold).length / terminalPrices.length;
}

export function probabilityBelow(terminalPrices: number[], threshold: number): number {
  return terminalPrices.filter((p) => p < threshold).length / terminalPrices.length;
}
