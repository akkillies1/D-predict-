import assert from "node:assert/strict";
import { mapAlertRow } from "../dist/alertFeed.js";

// mapAlertRow is the single shape used by both GET /api/alerts and the WS push;
// these checks pin the camelCase contract the dashboard depends on.
const row = {
  id: "7",
  symbol: "TATASTEEL",
  rule: "sma20_cross_up",
  evidence: { close: 152.4, sma20: 151.1, basis: "stored_bars", bars_evaluated: 60 },
  price: "152.40",
  market_timestamp: new Date(Date.UTC(2026, 8, 25, 9, 45)),
  new_to_radar: false,
  acknowledged: false,
  created_at: new Date(Date.UTC(2026, 8, 25, 10, 0)),
};

const mapped = mapAlertRow(row);
assert.equal(mapped.id, 7);
assert.equal(mapped.symbol, "TATASTEEL");
assert.equal(mapped.rule, "sma20_cross_up");
assert.equal(mapped.evidence.sma20, 151.1);
assert.equal(mapped.price, 152.4);
assert.equal(mapped.marketTimestamp, "2026-09-25T09:45:00.000Z");
assert.equal(mapped.newToRadar, false);
assert.equal(mapped.acknowledged, false);
assert.equal(mapped.createdAt, "2026-09-25T10:00:00.000Z");

// Edge shapes: missing evidence, null price, unknown booleans must not leak undefined.
const bare = mapAlertRow({ id: 1, symbol: "X", rule: "momentum_turn", price: null, market_timestamp: null, created_at: null });
assert.deepEqual(bare.evidence, {});
assert.equal(bare.price, null);
assert.equal(bare.marketTimestamp, null);
assert.equal(bare.newToRadar, false);
assert.equal(bare.acknowledged, false);

console.log("alerts.test.mjs: all assertions passed");
