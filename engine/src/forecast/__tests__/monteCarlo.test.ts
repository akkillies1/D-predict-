import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mulberry32,
  simulateProbabilityCone,
  probabilityInRange,
  probabilityAbove,
  probabilityBelow,
} from "../monteCarlo.js";

test("throws on invalid inputs rather than silently producing nonsense", () => {
  assert.throws(() => simulateProbabilityCone(-100, 0.01, 5, 100, 0, mulberry32(1)));
  assert.throws(() => simulateProbabilityCone(100, -0.01, 5, 100, 0, mulberry32(1)));
  assert.throws(() => simulateProbabilityCone(100, 0.01, 0, 100, 0, mulberry32(1)));
});

test("returns one band per simulated day", () => {
  const result = simulateProbabilityCone(100, 0.01, 7, 500, 0, mulberry32(42));
  assert.equal(result.bands.length, 7);
  assert.deepEqual(result.bands.map((b) => b.day), [1, 2, 3, 4, 5, 6, 7]);
});

test("each band's percentiles are monotonically ordered (p10 <= p25 <= median <= p75 <= p90)", () => {
  const result = simulateProbabilityCone(24800, 0.012, 10, 2000, 0, mulberry32(7));
  for (const band of result.bands) {
    assert.ok(band.p10 <= band.p25, `day ${band.day}: p10 > p25`);
    assert.ok(band.p25 <= band.median, `day ${band.day}: p25 > median`);
    assert.ok(band.median <= band.p75, `day ${band.day}: median > p75`);
    assert.ok(band.p75 <= band.p90, `day ${band.day}: p75 > p90`);
  }
});

test("the cone widens over time — later days have a wider p10-p90 spread than earlier days", () => {
  const result = simulateProbabilityCone(24800, 0.015, 15, 3000, 0, mulberry32(99));
  const earlySpread = result.bands[1].p90 - result.bands[1].p10; // day 2
  const lateSpread = result.bands[13].p90 - result.bands[13].p10; // day 14
  assert.ok(lateSpread > earlySpread, `expected day-14 spread (${lateSpread}) > day-2 spread (${earlySpread})`);
});

test("with zero drift, the median stays close to spot (no directional bias baked in)", () => {
  const spot = 25000;
  const result = simulateProbabilityCone(spot, 0.01, 5, 5000, 0, mulberry32(123));
  const finalMedian = result.bands[result.bands.length - 1].median;
  const pctDeviation = Math.abs(finalMedian - spot) / spot;
  assert.ok(pctDeviation < 0.03, `expected median within 3% of spot with zero drift, got ${pctDeviation * 100}% off`);
});

test("higher volatility produces a wider cone than lower volatility, all else equal", () => {
  const lowVol = simulateProbabilityCone(25000, 0.005, 10, 2000, 0, mulberry32(5));
  const highVol = simulateProbabilityCone(25000, 0.03, 10, 2000, 0, mulberry32(5));
  const lowSpread = lowVol.bands[9].p90 - lowVol.bands[9].p10;
  const highSpread = highVol.bands[9].p90 - highVol.bands[9].p10;
  assert.ok(highSpread > lowSpread, `expected high-vol spread (${highSpread}) > low-vol spread (${lowSpread})`);
});

test("all simulated prices remain positive (GBM property — price can't go negative)", () => {
  const result = simulateProbabilityCone(100, 0.05, 20, 1000, 0, mulberry32(1));
  assert.ok(result.terminalPrices.every((p) => p > 0));
});

test("probabilityInRange covering the full range returns 1, an empty range returns 0", () => {
  const prices = [10, 20, 30, 40, 50];
  assert.equal(probabilityInRange(prices, 0, 1000), 1);
  assert.equal(probabilityInRange(prices, 1000, 2000), 0);
});

test("probabilityAbove and probabilityBelow are complementary for a threshold with no exact ties", () => {
  const prices = [10, 21, 32, 43, 54];
  const above = probabilityAbove(prices, 30);
  const below = probabilityBelow(prices, 30);
  assert.equal(above + below, 1);
});

test("probabilityAbove is roughly 0.5 for a threshold at the zero-drift median", () => {
  const spot = 25000;
  const result = simulateProbabilityCone(spot, 0.01, 5, 5000, 0, mulberry32(77));
  const p = probabilityAbove(result.terminalPrices, spot);
  assert.ok(p > 0.4 && p < 0.6, `expected roughly 50/50 split around spot with zero drift, got ${p}`);
});
