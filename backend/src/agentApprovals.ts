// The approval gate: the only thing that lets an agent tool change app state.
// A write tool call parks here until the user clicks Apply or Refuse in the
// dashboard. Nothing in this module performs an action — it hands back a
// decision, and an absent or expired decision is always a refusal.
export type ApprovalSource = "user" | "timeout" | "abandoned" | "unavailable";
export type ApprovalDecision = { approved: boolean; source: ApprovalSource };

type Waiting = { resolve: (decision: ApprovalDecision) => void; timer: NodeJS.Timeout; runId: string };

const waiting = new Map<string, Waiting>();

export const APPROVAL_TIMEOUT_MS = Math.max(15_000, Number(process.env.AGENT_APPROVAL_TIMEOUT_MS ?? 300_000));

const keyOf = (runId: string, callId: string) => `${runId}::${callId}`;

/** Parks one write call until the user decides, the timer expires or the run dies. */
export function waitForApproval(runId: string, callId: string, timeoutMs = APPROVAL_TIMEOUT_MS): Promise<ApprovalDecision> {
  const key = keyOf(runId, callId);
  settle(runId, callId, { approved: false, source: "abandoned" });
  return new Promise((resolve) => {
    const finish = (decision: ApprovalDecision) => {
      clearTimeout(timer);
      waiting.delete(key);
      resolve(decision);
    };
    const timer = setTimeout(() => finish({ approved: false, source: "timeout" }), timeoutMs);
    waiting.set(key, { resolve: finish, timer, runId });
  });
}

/** Resolves a parked call. False means it was never waiting or already expired. */
export function settle(runId: string, callId: string, decision: ApprovalDecision): boolean {
  const entry = waiting.get(keyOf(runId, callId));
  if (!entry) return false;
  entry.resolve(decision);
  return true;
}

/** Refuses everything still parked for a run — used when the client disconnects. */
export function abandonRun(runId: string): number {
  let count = 0;
  for (const [key, entry] of [...waiting]) {
    if (entry.runId !== runId) continue;
    waiting.delete(key);
    entry.resolve({ approved: false, source: "abandoned" });
    count += 1;
  }
  return count;
}

export function pendingCount(): number {
  return waiting.size;
}
