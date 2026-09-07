import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sma, ema, rsi, atr, classifyTrend, classifyRegime, expectedMove, macd, volumeZScore,
  historicalVolatility, Bar,
} from "../indicators.js";

test("sma returns null when not enough values", () => {
  assert.equal(sma([1, 2], 3), null);
});

test("sma computes simple average of last N values", () => {
  assert.equal(sma([1, 2, 3, 4, 5], 3), 4); // (3+4+5)/3
});

test("ema converges toward recent values more than sma", () => {
  const values = [...Array(15).fill(1), 10]; // 15 leading values ensures ema's recurrence actually runs past period=10
  const smaVal = sma(values, 10)!;
  const emaVal = ema(values, 10)!;
  assert.ok(emaVal > smaVal, `ema (${emaVal}) should weight the recent spike more than sma (${smaVal})`);
});

test("rsi is null with insufficient data", () => {
  assert.equal(rsi([1, 2, 3], 14), null);
});

test("rsi is 100 when there are no losses in the window", () => {
  const risingCloses = Array.from({ length: 20 }, (_, i) => 100 + i);
  assert.equal(rsi(risingCloses, 14), 100);
});

test("rsi is between 0 and 100 for mixed data", () => {
  const closes = [100, 102, 101, 103, 105, 104, 106, 108, 107, 109, 110, 108, 111, 112, 113];
  const value = rsi(closes, 14);
  assert.ok(value !== null && value >= 0 && value <= 100);
});

function makeBars(closes: number[]): Bar[] {
  return closes.map((c, i) => ({
    timestamp: new Date(2026, 0, i + 1),
    open: c,
    high: c + 1,
    low: c - 1,
    close: c,
  }));
}

test("atr is null with insufficient bars", () => {
  assert.equal(atr(makeBars([1, 2]), 14), null);
});

test("atr is positive for bars with nonzero range", () => {
  const bars = makeBars(Array.from({ length: 20 }, (_, i) => 100 + Math.sin(i)));
  const value = atr(bars, 14);
  assert.ok(value !== null && value > 0);
});

test("classifyTrend returns UP for a clearly rising series", () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 + i * 2);
  assert.equal(classifyTrend(closes), "UP");
});

test("classifyTrend returns DOWN for a clearly falling series", () => {
  const closes = Array.from({ length: 30 }, (_, i) => 200 - i * 2);
  assert.equal(classifyTrend(closes), "DOWN");
});

test("classifyTrend returns SIDEWAYS for flat data", () => {
  const closes = Array.from({ length: 30 }, () => 100);
  assert.equal(classifyTrend(closes), "SIDEWAYS");
});

test("classifyRegime flags HIGH_VOL when atr spikes without a trend", () => {
  assert.equal(classifyRegime("SIDEWAYS", 10, 5), "HIGH_VOL");
});

test("classifyRegime returns TRENDING for a trend even with elevated atr", () => {
  assert.equal(classifyRegime("UP", 10, 5), "TRENDING");
});

test("classifyRegime returns RANGE for sideways with normal atr", () => {
  assert.equal(classifyRegime("SIDEWAYS", 5, 5), "RANGE");
});

test("expectedMove falls back to IV-implied move when ATR is null", () => {
  assert.equal(expectedMove(null, 1, 42), 42);
});

test("expectedMove takes the max of ATR-derived and IV-implied moves", () => {
  const atrMove = 10 * Math.sqrt(2); // atr=10, horizon=2
  assert.equal(expectedMove(10, 2, 5), atrMove); // ATR move (~14.1) beats IV move (5)
  assert.equal(expectedMove(10, 2, 100), 100); // IV move beats ATR move
});

test("macd returns null with insufficient data", () => {
  assert.equal(macd(Array.from({ length: 20 }, (_, i) => 100 + i)), null);
});

test("macd histogram is near zero for a steady linear trend (no acceleration)", () => {
  // A perfectly linear trend has constant momentum — MACD line converges to a
  // constant, so its EMA (the signal line) converges to the same constant.
  // Histogram measures *change* in momentum, not the trend's mere existence.
  const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 1.5);
  const result = macd(closes);
  assert.ok(result !== null);
  assert.ok(Math.abs(result!.histogram) < 0.5, `expected near-zero histogram for steady trend, got ${result!.histogram}`);
});

test("macd histogram is positive when upward momentum is accelerating", () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + 0.02 * i * i); // quadratic growth
  const result = macd(closes);
  assert.ok(result !== null);
  assert.ok(result!.histogram > 0, `expected positive histogram for accelerating rise, got ${result!.histogram}`);
});

test("macd histogram is negative when a rally sharply reverses into a decline", () => {
  const closes = Array.from({ length: 60 }, (_, i) => (i < 40 ? 100 + i * 2 : 100 + 40 * 2 - (i - 40) * 3));
  const result = macd(closes);
  assert.ok(result !== null);
  assert.ok(result!.histogram < 0, `expected negative histogram after a sharp reversal down, got ${result!.histogram}`);
});

test("macd histogram is near zero for flat data", () => {
  const closes = Array.from({ length: 60 }, () => 100);
  const result = macd(closes);
  assert.ok(result !== null);
  assert.ok(Math.abs(result!.histogram) < 0.01);
});

test("volumeZScore is null with insufficient data", () => {
  assert.equal(volumeZScore([1, 2, 3], 20), null);
});

test("volumeZScore is null when the window has zero variance", () => {
  const volumes = Array(25).fill(1000);
  assert.equal(volumeZScore(volumes, 20), null);
});

test("volumeZScore is strongly positive for an unusually high latest reading", () => {
  // slight variance in history (900-1100) so stdDev isn't zero, then a clear spike
  const history = Array.from({ length: 20 }, (_, i) => 900 + (i % 5) * 50);
  const volumes = [...history, 5000];
  const z = volumeZScore(volumes, 20);
  assert.ok(z !== null && z > 2, `expected z > 2, got ${z}`);
});

test("volumeZScore is strongly negative for an unusually low latest reading", () => {
  const history = Array.from({ length: 20 }, (_, i) => 900 + (i % 5) * 50);
  const volumes = [...history, 10];
  const z = volumeZScore(volumes, 20);
  assert.ok(z !== null && z < -2, `expected z < -2, got ${z}`);
});

test("historicalVolatility is null with insufficient data", () => {
  assert.equal(historicalVolatility([100, 101, 102], 20), null);
});

test("historicalVolatility is higher for a choppier series than a smooth one", () => {
  const smooth = Array.from({ length: 25 }, (_, i) => 100 + i * 0.1);
  const choppy = Array.from({ length: 25 }, (_, i) => 100 + (i % 2 === 0 ? 5 : -5));
  const smoothVol = historicalVolatility(smooth, 20)!;
  const choppyVol = historicalVolatility(choppy, 20)!;
  assert.ok(choppyVol > smoothVol, `expected choppy (${choppyVol}) > smooth (${smoothVol})`);
});

test("historicalVolatility is zero for a perfectly flat series", () => {
  const flat = Array(25).fill(100);
  assert.equal(historicalVolatility(flat, 20), 0);
});
