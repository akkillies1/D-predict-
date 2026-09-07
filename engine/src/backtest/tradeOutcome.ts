export interface PremiumPoint {
  timestamp: Date;
  ltp: number;
}

export type TradeOutcome = "SL" | "TARGET" | "NEITHER";

export interface OutcomeResult {
  outcome: TradeOutcome;
  exitPremium: number;
  exitTimestamp: Date;
}

/**
 * Walks a chronologically-ordered premium path and returns the first point
 * where the premium crosses stopLoss (<=) or target (>=), whichever comes
 * first in time. If neither is crossed before the path ends, returns
 * NEITHER with the last available premium as a terminal read — the caller
 * decides whether that means "still open" or "score as-is at this horizon".
 *
 * Assumes `path` is sorted ascending by timestamp and non-empty; callers
 * should check for an empty path before calling.
 */
export function determineTradeOutcome(
  path: PremiumPoint[],
  stopLoss: number,
  target: number
): OutcomeResult {
  for (const point of path) {
    if (point.ltp <= stopLoss) {
      return { outcome: "SL", exitPremium: point.ltp, exitTimestamp: point.timestamp };
    }
    if (point.ltp >= target) {
      return { outcome: "TARGET", exitPremium: point.ltp, exitTimestamp: point.timestamp };
    }
  }
  const last = path[path.length - 1];
  return { outcome: "NEITHER", exitPremium: last.ltp, exitTimestamp: last.timestamp };
}
