import assert from "node:assert/strict";
import { rankMarketCandidates } from "../dist/marketScanner.js";

const now = new Date("2026-03-30T00:00:00.000Z");
const upBars = Array.from({ length: 80 }, (_, index) => ({
  timestamp: new Date(now.getTime() - (79 - index) * 86400000).toISOString(),
  close: 100 * Math.exp(index * 0.003), // established uptrend
}));
const downBars = Array.from({ length: 80 }, (_, index) => ({
  timestamp: new Date(now.getTime() - (79 - index) * 86400000).toISOString(),
  close: 100 * Math.exp(-index * 0.003), // established downtrend
}));

const result = rankMarketCandidates([
  { symbol: "GOOD", bars: upBars, prediction: { expectedReturn: 0.04, confidence: 0.78, timestamp: now, horizon: "5d", calibrationStatus: "CALIBRATED", predictionStatus: "PROMOTION_READY", actionStatus: "ACTIONABLE_LONG" } },
  { symbol: "UNCALIBRATED", bars: upBars, prediction: { expectedReturn: 0.05, confidence: 0.8, timestamp: now, horizon: "5d", calibrationStatus: "UNCALIBRATED", predictionStatus: "PROMOTION_READY", actionStatus: "ACTIONABLE_LONG" } },
  { symbol: "GATED", bars: upBars, prediction: { expectedReturn: 0.05, confidence: 0.8, timestamp: now, horizon: "5d", calibrationStatus: "CALIBRATED", predictionStatus: "ABSTAIN", actionStatus: "ABSTAIN_MODEL_GATE" } },
  { symbol: "NODATA", bars: upBars, prediction: null },
  { symbol: "DOWN", bars: downBars, prediction: null },
  { symbol: "SHORT", bars: upBars.slice(0, 10), prediction: null },
], { maxPicks: 5, roundTripCost: 0.002, minHistory: 60 }, now);

// Only the validated model signal is graded MODEL; the rest surface as honest
// realized-momentum evidence rather than abstaining on every instrument.
assert.equal(result.picks[0].symbol, "GOOD");
assert.equal(result.picks[0].basis, "MODEL");
assert.ok(result.picks.every((pick) => (pick.basis === "MODEL" ? pick.symbol === "GOOD" : pick.basis === "EVIDENCE")));
assert.deepEqual(result.picks.map((pick) => pick.symbol).sort(), ["GOOD", "NODATA", "UNCALIBRATED", "GATED"].sort());
// Every evidence pick must carry realized (not forecast) framing in its reasons.
const evidence = result.picks.find((pick) => pick.basis === "EVIDENCE");
assert.ok(/realized/i.test(evidence.reasons.join(" ")));
// A genuine downtrend still abstains honestly even without a model, and too
// little history is excluded regardless.
const excludedSymbols = result.excluded.map((item) => item.symbol);
assert.ok(excludedSymbols.includes("DOWN"));
assert.ok(excludedSymbols.includes("SHORT"));
