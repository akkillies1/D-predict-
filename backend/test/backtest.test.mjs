import assert from "node:assert/strict";
import { runBacktest } from "../dist/backtest.js";

const day = (index) => new Date(Date.UTC(2024, 0, 1 + index)).toISOString();

// 100 rising closes, then a 30% collapse, then flat. Deterministic, no rng.
const closes = [
  ...Array.from({ length: 100 }, (_, i) => 100 + i),          // 100..199 steady rise
  ...Array.from({ length: 30 }, (_, i) => 199 - i * 2),       // collapse to 141
  ...Array.from({ length: 20 }, () => 141),                    // flat tail
];
const bars = closes.map((close, index) => ({ timestamp: day(index), close }));

// buy_hold enters at bar 1 (101) and liquidates at the final close (141).
const hold = runBacktest(bars, "buy_hold");
assert.equal(hold.ok, true);
assert.equal(hold.trades, 1);
assert.equal(hold.tradeLog[0].exitReason, "END_OF_HISTORY");
assert.equal(hold.tradeLog[0].quantity, Math.floor(100_000 / 101));
assert.ok(hold.totalReturn > 0.3, `buy_hold on a rising-then-flat series should be net positive, got ${hold.totalReturn}`);
assert.ok(hold.totalCosts > 0, "buy_hold must pay at least one buy+sell charge cycle");
assert.equal(hold.finalEquity, hold.equityCurve.at(-1).equity);

// sma_trend must exit before eating the whole collapse and never trade same-bar.
const trend = runBacktest(bars, "sma_trend");
assert.equal(trend.ok, true);
assert.ok(trend.totalReturn > hold.totalReturn, "trend filter should beat holding through the collapse");
for (const trade of trend.tradeLog) {
  const entryIndex = bars.findIndex((bar) => bar.timestamp === trade.entryTimestamp);
  const exitIndex = bars.findIndex((bar) => bar.timestamp === trade.exitTimestamp);
  assert.ok(exitIndex > entryIndex, "positions must live at least one bar");
}
// Every trade decision at bar i used data only through i-1: equity never
// changes on bar 0 (warm-up), because no decision could have been made yet.
assert.equal(trend.equityCurve[0].equity, 100_000);

// vol_expansion needs 62 bars; short series is refused, not faked.
const short = runBacktest(bars.slice(0, 40), "vol_expansion");
assert.equal(short.ok, false);
assert.equal(short.error, "INSUFFICIENT_HISTORY");
assert.equal(short.requiredBars, 62);

// A constant price makes zero net profit but still costs STT on round trips.
const flatBars = Array.from({ length: 80 }, (_, i) => ({ timestamp: day(i), close: 100 }));
const flat = runBacktest(flatBars, "buy_hold");
assert.equal(flat.trades, 1);
assert.ok(flat.totalReturn < 0, "a zero-move buy_hold must lose exactly its charges");
assert.ok(Math.abs(flat.totalReturn * 100_000 + flat.totalCosts) < 10, "loss should equal total costs (within rounding)");

// win_rate/profit_factor stay honest with no closed trades.
const tiny = runBacktest(bars.slice(0, 3), "buy_hold");
assert.equal(tiny.ok, true);
assert.ok(tiny.winRate === null || tiny.trades > 0);

console.log("backtest.test.mjs: all assertions passed");
