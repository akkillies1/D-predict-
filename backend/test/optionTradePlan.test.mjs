import assert from "node:assert/strict";
import { analyzeOptionChain } from "../dist/optionIntelligence.js";

const now = new Date("2026-10-03T10:00:00.000Z");
function leg(strike, optionType, oi, bid, ask, iv = 14) {
  return { lotSize: 75, expiryDate: "2026-10-30", strike, optionType, timestamp: now.toISOString(), ltp: (bid + ask) / 2, bid, ask, oi, oiChange: 0, iv, volume: 1000 };
}
const chain = [
  leg(24800, "CE", 1000, 220, 221), leg(25000, "CE", 2000, 150, 151), leg(25200, "CE", 500, 95, 96),
  leg(24800, "PE", 3000, 80, 81, 16), leg(25000, "PE", 3500, 110, 111, 16), leg(25200, "PE", 1000, 155, 156, 16),
];
const result = analyzeOptionChain("NIFTY", chain, 25000, now);
assert.equal(result.recommendation.action, "CALL_VERTICAL");
assert.ok(result.recommendation.tradePlan);
assert.equal(result.recommendation.tradePlan.legs.length, 2);
assert.equal(result.recommendation.tradePlan.legs[0].optionType, "CE");
assert.equal(result.recommendation.tradePlan.legs[1].side, "SELL");
assert.equal(result.recommendation.tradePlan.legs[1].optionType, "CE");
assert.equal(result.recommendation.tradePlan.maxLoss, 56);
assert.equal(result.recommendation.tradePlan.lotSize, 75);
assert.equal(result.recommendation.tradePlan.entryValue, 4200);
assert.equal(result.recommendation.tradePlan.maxLossValue, 4200);
assert.equal(result.recommendation.tradePlan.maxProfitValue, 10800);

const stale = analyzeOptionChain("NIFTY", chain.map(row => ({ ...row, timestamp: "2026-10-03T08:00:00.000Z" })), 25000, now);
assert.equal(stale.gates.freshForPaper, false);
assert.equal(stale.recommendation.tradePlan, null);

console.log("option trade plan contract tests passed");

const mismatchedLots = chain.map((row, index) => index === 2 ? { ...row, lotSize: 50 } : row);
const mismatched = analyzeOptionChain("NIFTY", mismatchedLots, 25000, now);
assert.equal(mismatched.gates.lotSizeAvailable, false);
assert.equal(mismatched.recommendation.tradePlan, null);
