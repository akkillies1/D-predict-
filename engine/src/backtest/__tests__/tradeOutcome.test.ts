import { test } from "node:test";
import assert from "node:assert/strict";
import { determineTradeOutcome, PremiumPoint } from "../tradeOutcome.js";

function pt(hour: number, ltp: number): PremiumPoint {
  return { timestamp: new Date(2026, 0, 1, hour), ltp };
}

test("returns SL at the first point that drops to or below stopLoss", () => {
  const path = [pt(9, 100), pt(10, 90), pt(11, 68), pt(12, 150)]; // crosses SL at 11 before ever reaching target
  const result = determineTradeOutcome(path, 70, 160);
  assert.equal(result.outcome, "SL");
  assert.equal(result.exitPremium, 68);
  assert.equal(result.exitTimestamp.getHours(), 11);
});

test("returns TARGET at the first point that reaches or exceeds target", () => {
  const path = [pt(9, 100), pt(10, 120), pt(11, 165), pt(12, 50)]; // hits target at 11 before later dropping
  const result = determineTradeOutcome(path, 70, 160);
  assert.equal(result.outcome, "TARGET");
  assert.equal(result.exitPremium, 165);
  assert.equal(result.exitTimestamp.getHours(), 11);
});

test("prefers whichever crossing happens first in time, not whichever is bigger", () => {
  // SL crossed at hour 10, target only reached at hour 12 — SL must win since it happened first
  const path = [pt(9, 100), pt(10, 65), pt(11, 90), pt(12, 170)];
  const result = determineTradeOutcome(path, 70, 160);
  assert.equal(result.outcome, "SL");
});

test("returns NEITHER with the last premium when no crossing occurs", () => {
  const path = [pt(9, 100), pt(10, 110), pt(11, 105)];
  const result = determineTradeOutcome(path, 70, 160);
  assert.equal(result.outcome, "NEITHER");
  assert.equal(result.exitPremium, 105);
});

test("a single-point path with no crossing returns NEITHER at that point", () => {
  const path = [pt(9, 100)];
  const result = determineTradeOutcome(path, 70, 160);
  assert.equal(result.outcome, "NEITHER");
  assert.equal(result.exitPremium, 100);
});

test("a premium exactly at the boundary counts as a crossing (inclusive)", () => {
  assert.equal(determineTradeOutcome([pt(9, 70)], 70, 160).outcome, "SL");
  assert.equal(determineTradeOutcome([pt(9, 160)], 70, 160).outcome, "TARGET");
});
