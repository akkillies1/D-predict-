export type CandidateDirection = "LONG" | "SHORT" | "ABSTAIN";
export type CandidateProvenance = "ML_CONFIRMED" | "STATISTICAL_BASELINE" | "OPTION_INTELLIGENCE";
export type CandidateGate = { name: string; passed: boolean; reason: string };
export type CandidateEvidence = { name: string; value: number | string | boolean | null; weight: number; contribution: number };

export type DecisionCandidateInput = {
  symbol: string;
  horizon: string;
  spot: number;
  direction: CandidateDirection;
  score: number;
  provenance: CandidateProvenance;
  modelConfidence: number | null;
  expectedReturn: number | null;
  volatility: number | null;
  dataFresh: boolean;
  observations: number;
  invalidation: number | null;
  reasons: string[];
  gates: CandidateGate[];
  evidence?: CandidateEvidence[];
  rewardRisk?: { reward: number; risk: number; ratio: number } | null;
  option?: {
    expiry: string;
    optionType: "CE" | "PE";
    strike: number;
    ask: number;
    bid: number | null;
    lotSize: number;
    liquidityScore: number | null;
    spreadPct: number | null;
  } | null;
};

export function buildDecisionCandidate(input: DecisionCandidateInput) {
  const passed = input.gates.filter(g => g.passed).length;
  const failed = input.gates.length - passed;
  const normalizedScore = Math.round(Math.max(0, Math.min(100, input.score)));
  const rr = input.rewardRisk?.ratio ?? null;
  const blockers = input.gates.filter(g => !g.passed).map(g => ({ name: g.name, reason: g.reason }));

  const status =
    input.direction === "ABSTAIN" ||
    failed > 0 ||
    normalizedScore < 60 ||
    (rr != null && rr < 1.25)
      ? "ABSTAIN"
      : "PAPER_CANDIDATE";

  return {
    status,
    symbol: input.symbol,
    horizon: input.horizon,
    direction: input.direction,
    score: normalizedScore,
    provenance: input.provenance,
    modelConfidence: input.modelConfidence,
    expectedReturn: input.expectedReturn,
    spot: input.spot,
    invalidation: input.invalidation,
    rewardRisk: input.rewardRisk ?? null,
    evidence: input.evidence ?? [],
    gates: input.gates,
    blockers,
    reasons: input.reasons,
    option: input.option ?? null,
    paperSuggestion: status === "PAPER_CANDIDATE"
      ? {
          direction: input.direction,
          entryReference: input.spot,
          invalidation: input.invalidation,
          option: input.option ?? null,
          note: "Research/paper candidate only. No broker order is sent.",
        }
      : null,
    dataQuality: {
      observations: input.observations,
      fresh: input.dataFresh,
    },
    gateSummary: passed + " passed / " + input.gates.length + " total; " + failed + " failed",
  };
}

export function rankDecisionCandidates(candidates: ReturnType<typeof buildDecisionCandidate>[]) {
  return [...candidates].sort((a, b) => {
    if (a.status !== b.status) return a.status === "PAPER_CANDIDATE" ? -1 : 1;
    if (a.score !== b.score) return b.score - a.score;
    return (b.rewardRisk?.ratio ?? 0) - (a.rewardRisk?.ratio ?? 0);
  });
}
