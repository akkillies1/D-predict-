import assert from "node:assert/strict";
import { analyzeOptionChain } from "../dist/optionIntelligence.js";

const now = new Date("2026-10-03T10:00:00.000Z");
function leg(strike, optionType, oi, bid, ask, iv = 14) {
  return { expiryDate: "2026-10-30", strike, optionType, timestamp: now.toISOString(), ltp: (bid + ask) / 2, bid, ask, oi, oiChange: 0, iv, volume: 1000 };
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
assert.equal(result.recommendation.action, "BUY_CALL");
assert.equal(result.gates.freshForPaper, true);
assert.ok(result.recommendation.evidence.length >= 3);

const stale = analyzeOptionChain("NIFTY", chain.map(row => ({ ...row, timestamp: "2026-10-03T08:00:00.000Z" })), 25000, now);
assert.notEqual(stale.recommendation.action, "BUY_CALL");
assert.equal(stale.gates.freshForPaper, false);

const missing = analyzeOptionChain("NIFTY", [], null, now);
assert.equal(missing.status, "NO_CHAIN");
assert.equal(missing.recommendation.action, "ABSTAIN");

console.log("option intelligence tests passed");
