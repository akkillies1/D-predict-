import assert from "node:assert/strict";
import { computeCharges } from "../dist/paperRoutes.js";

const round = (value) => Math.round(value * 100) / 100;

// CNC delivery buy: zero brokerage, 0.1% STT, 0.015% stamp.
const cncBuy = computeCharges("BUY", "CNC", 400, 2090.6);
assert.equal(cncBuy.brokerage, 0);
assert.equal(cncBuy.stt, round(836240 * 0.001));
assert.equal(cncBuy.stamp, round(836240 * 0.00015));
assert.equal(cncBuy.exchange, round(836240 * 0.0000297));
assert.equal(cncBuy.gst, round((cncBuy.exchange + 836240 * 0.000001) * 0.18));

// CNC delivery sell: stamp only applies on the buy side.
const cncSell = computeCharges("SELL", "CNC", 400, 2090.6);
assert.equal(cncSell.stamp, 0);
assert.equal(cncSell.brokerage, 0);

// MIS intraday: flat 20 rupee brokerage cap and 0.025% STT.
const misBuy = computeCharges("BUY", "MIS", 1000, 500);
assert.equal(misBuy.brokerage, 20);
assert.equal(misBuy.stt, round(500000 * 0.00025));
assert.equal(misBuy.stamp, round(500000 * 0.00003));

// Small intraday order: brokerage stays under the cap.
const smallMis = computeCharges("BUY", "MIS", 10, 100);
assert.equal(smallMis.brokerage, round(1000 * 0.0003));

console.log("paper charge model test passed");
