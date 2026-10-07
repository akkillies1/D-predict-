import assert from "node:assert/strict";
import { buildDecisionCandidate } from "../dist/decisionEngine.js";

const base = {
  symbol: "NIFTY",
  horizon: "5d",
  spot: 25000,
  direction: "LONG",
  score: 80,
  provenance: "STATISTICAL_BASELINE",
  modelConfidence: null,
  expectedReturn: 0.01,
  volatility: 0.012,
  dataFresh: true,
  observations: 120,
  invalidation: 24500,
  reasons: ["deterministic test input"],
  gates: [
    { name: "DATA_FRESH", passed: true, reason: "fresh" },
    { name: "HISTORY_DEPTH", passed: true, reason: "enough history" },
    { name: "DIRECTION", passed: true, reason: "direction measured" },
    { name: "MOMENTUM_ALIGNMENT", passed: true, reason: "aligned" },
    { name: "ML_ACTION_GATE", passed: true, reason: "allowed" },
  ],
  rewardRisk: { reward: 1000, risk: 700, ratio: 1.43 },
};

function candidate(overrides = {}) {
  return buildDecisionCandidate({ ...base, ...overrides });
}

const eligible = candidate();
assert.equal(eligible.status, "PAPER_CANDIDATE");
assert.equal(eligible.paperSuggestion?.direction, "LONG");
assert.equal(eligible.blockers.length, 0);

assert.equal(candidate({ direction: "ABSTAIN" }).status, "ABSTAIN");
assert.equal(candidate({ score: 59 }).status, "ABSTAIN");
assert.equal(candidate({ rewardRisk: { reward: 1000, risk: 850, ratio: 1.18 } }).status, "ABSTAIN");
assert.equal(candidate({
  gates: base.gates.map((gate, index) => index === 0 ? { ...gate, passed: false, reason: "stale" } : gate),
}).status, "ABSTAIN");

const blocked = candidate({
  gates: [{ name: "DATA_FRESH", passed: false, reason: "stale" }],
});
assert.equal(blocked.blockers.length, 1);
assert.equal(blocked.blockers[0].name, "DATA_FRESH");
assert.equal(blocked.paperSuggestion, null);

console.log("decision engine contract tests passed");
