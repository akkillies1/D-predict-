import assert from "node:assert/strict";
import { analyzeOptionChain } from "../dist/optionIntelligence.js";

const now = new Date("2026-10-03T10:00:00.000Z");
function leg(strike, optionType, oi, bid, ask, iv = 14) {
  return { expiryDate: "2026-10-30", strike, optionType, timestamp: now.toISOString(), ltp: (bid + ask) / 2, bid, ask, oi, oiChange: 0, iv, volume: 1000, lotSize: 75 };
}
const chain = [
  leg(24800, "CE", 1000, 220, 221), leg(25000, "CE", 2000, 150, 151), leg(25200, "CE", 500, 95, 96),
  leg(24800, "PE", 3000, 80, 81, 16), leg(25000, "PE", 3500, 110, 111, 16), leg(25200, "PE", 1000, 155, 156, 16),
];
const result = analyzeOptionChain("NIFTY", chain, 25000, now);
assert.equal(result.ok, true);
assert.equal(result.expiry, "2026-10-30");
assert.equal(result.metrics.atmStrike, 25000);
assert.equal(result.recommendation.direction, "BULLISH");
assert.equal(result.recommendation.action, "CALL_VERTICAL");
assert.equal(result.gates.freshForPaper, true);
assert.ok(result.recommendation.evidence.length >= 3);

// Bearish put vertical: the long higher-strike PE must determine the debit.
// The old calculation reversed the legs, produced zero debit, and hid the vertical.
const bearishChain = [
  leg(24800, "CE", 3000, 220, 221), leg(25000, "CE", 4000, 150, 151), leg(25200, "CE", 3000, 95, 96),
  leg(24800, "PE", 100, 80, 81), leg(25000, "PE", 100, 110, 111), leg(25200, "PE", 100, 155, 156),
];
const bearish = analyzeOptionChain("NIFTY", bearishChain, 25000, now);
assert.equal(bearish.recommendation.direction, "BEARISH");
assert.equal(bearish.recommendation.action, "PUT_VERTICAL");
assert.equal(bearish.recommendation.tradePlan?.entry, 31);
assert.equal(bearish.recommendation.tradePlan?.legs[0]?.side, "BUY");
assert.equal(bearish.recommendation.tradePlan?.legs[0]?.strike, 25000);

const stale = analyzeOptionChain("NIFTY", chain.map(row => ({ ...row, timestamp: "2026-10-03T08:00:00.000Z" })), 25000, now);
assert.equal(stale.recommendation.action, "WAIT");
assert.equal(stale.status, "RESEARCH_ONLY");
assert.equal(stale.gates.freshForPaper, false);
assert.equal(stale.recommendation.tradePlan, null);

// A future-dated provider snapshot must not be clamped to age zero or treated as fresh.
const future = analyzeOptionChain(
  "NIFTY",
  chain.map(row => ({ ...row, timestamp: new Date(now.getTime() + 60_000).toISOString() })),
  25000,
  now,
);
assert.equal(future.gates.freshForPaper, false);
assert.ok(future.metrics.freshnessSeconds < 0);
assert.equal(future.status, "RESEARCH_ONLY");
assert.equal(future.recommendation.action, "WAIT");
assert.equal(future.recommendation.tradePlan, null);

const missing = analyzeOptionChain("NIFTY", [], null, now);
assert.equal(missing.status, "NO_CHAIN");
assert.equal(missing.recommendation.action, "ABSTAIN");

console.log("option intelligence tests passed");
