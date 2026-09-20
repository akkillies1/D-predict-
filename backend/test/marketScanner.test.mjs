import assert from "node:assert/strict";
import { rankMarketCandidates } from "../dist/marketScanner.js";

const bars = Array.from({ length: 80 }, (_, index) => ({
  timestamp: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
  close: 100 * Math.exp(index * 0.003),
}));
const now = new Date("2026-03-30T00:00:00.000Z");
const freshBars = bars.map((bar, index) => ({ ...bar, timestamp: new Date(now.getTime() - (79 - index) * 86400000).toISOString() }));
const result = rankMarketCandidates([
  { symbol: "GOOD", bars: freshBars, prediction: { expectedReturn: 0.04, confidence: 0.78, timestamp: now, horizon: "5d", calibrationStatus: "CALIBRATED", predictionStatus: "PROMOTION_READY", actionStatus: "ACTIONABLE_LONG" } },
  { symbol: "UNCALIBRATED", bars: freshBars, prediction: { expectedReturn: 0.05, confidence: 0.8, timestamp: now, horizon: "5d", calibrationStatus: "UNCALIBRATED", predictionStatus: "PROMOTION_READY", actionStatus: "ACTIONABLE_LONG" } },
  { symbol: "GATED", bars: freshBars, prediction: { expectedReturn: 0.05, confidence: 0.8, timestamp: now, horizon: "5d", calibrationStatus: "CALIBRATED", predictionStatus: "ABSTAIN", actionStatus: "ABSTAIN_MODEL_GATE" } },
  { symbol: "WATCH", bars: freshBars, prediction: { expectedReturn: 0.05, confidence: 0.8, timestamp: now, horizon: "5d", calibrationStatus: "CALIBRATED", predictionStatus: "PROMOTION_READY", actionStatus: "WATCH_LOW_EDGE" } },
  { symbol: "COSTS", bars: freshBars, prediction: { expectedReturn: 0.001, confidence: 0.8, timestamp: now, horizon: "5d", calibrationStatus: "CALIBRATED", predictionStatus: "PROMOTION_READY", actionStatus: "ACTIONABLE_LONG" } },
  { symbol: "SHORT", bars: freshBars.slice(0, 10), prediction: { expectedReturn: 0.05, confidence: 0.8, timestamp: now, horizon: "5d", calibrationStatus: "CALIBRATED", predictionStatus: "PROMOTION_READY", actionStatus: "ACTIONABLE_LONG" } },
], { maxPicks: 5, roundTripCost: 0.002, minHistory: 60 }, now);
assert.equal(result.picks.length, 1);
assert.equal(result.picks[0].symbol, "GOOD");
assert.ok(result.picks[0].netExpectedReturn > 0);
assert.ok(result.excluded.some((item) => item.symbol === "UNCALIBRATED"));
assert.ok(result.excluded.some((item) => item.symbol === "GATED"));
assert.ok(result.excluded.some((item) => item.symbol === "WATCH"));
assert.ok(result.excluded.some((item) => item.symbol === "COSTS"));
assert.ok(result.excluded.some((item) => item.symbol === "SHORT"));
assert.match(result.methodology, /calibrated-oos/);
