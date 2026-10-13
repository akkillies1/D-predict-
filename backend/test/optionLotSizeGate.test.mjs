import assert from "node:assert/strict";
import { analyzeOptionChain } from "../dist/optionIntelligence.js";
import { isOptionQuoteFresh } from "../dist/shadowRoutes.js";

const now = new Date("2026-10-03T10:00:00.000Z");
const leg = (strike, optionType, oi, bid, ask) => ({
  lotSize: null, expiryDate: "2026-10-30", strike, optionType,
  timestamp: now.toISOString(), ltp: (bid + ask) / 2, bid, ask,
  oi, oiChange: 0, iv: 14, volume: 1000,
});
const chain = [
  leg(25000, "CE", 2000, 150, 151),
  leg(25200, "CE", 500, 95, 96),
  leg(25000, "PE", 3500, 110, 111),
  leg(24800, "PE", 3000, 80, 81),
];

const result = analyzeOptionChain("NIFTY", chain, 25000, now);
assert.equal(result.gates.lotSizeAvailable, false);
assert.equal(result.status, "RESEARCH_ONLY");
assert.equal(result.recommendation.tradePlan, null);

console.log("option lot-size gate contract passed");

// The order/close route must enforce quote age even outside market hours.
const freshnessNow = new Date("2026-10-03T10:00:00.000Z");
assert.equal(isOptionQuoteFresh(new Date(freshnessNow.getTime() - 30_000), freshnessNow, 120_000), true);
assert.equal(isOptionQuoteFresh(new Date(freshnessNow.getTime() - 180_000), freshnessNow, 120_000), false);
assert.equal(isOptionQuoteFresh(new Date(freshnessNow.getTime() + 1_000), freshnessNow, 120_000), false);
assert.equal(isOptionQuoteFresh(new Date("invalid"), freshnessNow, 120_000), false);
