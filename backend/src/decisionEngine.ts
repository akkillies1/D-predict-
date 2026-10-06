export type CandidateDirection = "LONG" | "SHORT" | "ABSTAIN";

export type DecisionCandidateInput = {
  symbol: string;
  horizon: string;
  spot: number;
  direction: CandidateDirection;
  score: number;
  provenance: "ML_CONFIRMED" | "STATISTICAL_BASELINE";
  modelConfidence: number | null;
  expectedReturn: number | null;
  volatility: number | null;
  dataFresh: boolean;
  observations: number;
  invalidation: number | null;
  reasons: string[];
  gates: Array<{ name: string; passed: boolean; reason: string }>;
};

export function buildDecisionCandidate(input: DecisionCandidateInput) {
  const passed = input.gates.filter(g => g.passed).length;
  const failed = input.gates.length - passed;
  const status = input.direction === "ABSTAIN" || failed > 0 || input.score < 60 ? "ABSTAIN" : "PAPER_CANDIDATE";
  return {
    status,
    symbol: input.symbol,
    horizon: input.horizon,
    direction: input.direction,
    score: Math.round(Math.max(0, Math.min(100, input.score))),
    provenance: input.provenance,
    modelConfidence: input.modelConfidence,
    expectedReturn: input.expectedReturn,
    spot: input.spot,
    invalidation: input.invalidation,
    dataQuality: {
      observations: input.observations,
      fresh: input.dataFresh,
    },
    gates: input.gates,
    reasons: input.reasons,
    paperSuggestion: status === "PAPER_CANDIDATE" ? {
      direction: input.direction,
      entryReference: input.spot,
      invalidation: input.invalidation,
      note: "Research/paper candidate only. No broker order is sent.",
    } : null,
    gateSummary: `${passed} passed / ${input.gates.length} total; ${failed} failed`,
  };
}
