import assert from "node:assert/strict";
import test from "node:test";
import { classifyRealizedReturn, horizonDays } from "../predictionResolutionLogic.js";

test("parses supported trading-day horizons and rejects malformed values", () => {
  assert.equal(horizonDays("1d"), 1);
  assert.equal(horizonDays("5D"), 5);
  assert.equal(horizonDays("0d"), null);
  assert.equal(horizonDays("31d"), null);
  assert.equal(horizonDays("5 days"), null);
});

test("classifies realized return using the same threshold as training labels", () => {
  assert.equal(classifyRealizedReturn(0.004), "UP");
  assert.equal(classifyRealizedReturn(-0.004), "DOWN");
  assert.equal(classifyRealizedReturn(0.001), "FLAT");
  assert.equal(classifyRealizedReturn(-0.001), "FLAT");
});

test("rejects non-finite realized returns", () => {
  assert.throws(() => classifyRealizedReturn(Number.NaN), /finite/);
});
