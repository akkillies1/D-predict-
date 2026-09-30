// Ledger-wide realised performance, shared by the HTTP route and the AI agent's
// prediction_performance tool so both report the same numbers from the same SQL.
import type { Pool } from "pg";

export type PredictionPerformance = {
  ok: true;
  periodDays: number;
  generatedAt: string;
  metrics: Record<string, number | null>;
  byHorizon: Array<Record<string, unknown>>;
};

const CLASSES = ["DOWN", "FLAT", "UP"] as const;

export async function computePredictionPerformance(pool: Pool, days: number): Promise<PredictionPerformance> {
  const result = await pool.query(`
    select symbol, horizon, timestamp, evaluated_at, expected_return, outcome_return, outcome_class, evidence
    from prediction_ledger
    where timestamp >= now() - ($1::int * interval '1 day')
    order by timestamp desc
  `, [days]);
  const pending = result.rows.filter((row) => row.evaluated_at == null);
  const scored = result.rows.filter((row) => row.evaluated_at != null && ["DOWN", "FLAT", "UP"].includes(String(row.outcome_class)));
  const safeNumber = (value: unknown) => { const number = Number(value); return Number.isFinite(number) ? number : null; };
  const predictionOf = (row: any) => String(row.evidence?.prediction ?? "");
  const probabilityOf = (row: any, label: string) => safeNumber(row.evidence?.probabilities?.[label]);
  const actual = scored.map((row) => String(row.outcome_class));
  const predicted = scored.map(predictionOf);
  const correct = scored.map((_, index) => predicted[index] === actual[index]);
  const accuracy = correct.length ? correct.filter(Boolean).length / correct.length : null;
  const recalls = CLASSES.map((label) => {
    const indexes = actual.map((value, index) => value === label ? index : -1).filter((index) => index >= 0);
    return indexes.length ? indexes.filter((index) => predicted[index] === label).length / indexes.length : null;
  }).filter((value): value is number => value != null);
  const balancedAccuracy = recalls.length ? recalls.reduce((sum, value) => sum + value, 0) / recalls.length : null;
  const directionalIndexes = actual.map((value, index) => ["UP", "DOWN"].includes(value) && ["UP", "DOWN"].includes(predicted[index]) ? index : -1).filter((index) => index >= 0);
  const directionalAccuracy = directionalIndexes.length ? directionalIndexes.filter((index) => predicted[index] === actual[index]).length / directionalIndexes.length : null;
  const probabilityRows: Array<{ row: any; probabilities: number[] }> = scored.flatMap((row) => {
    const probabilities = CLASSES.map((label) => probabilityOf(row, label));
    return probabilities.every((value): value is number => value != null) ? [{ row, probabilities }] : [];
  });
  const logLoss = probabilityRows.length ? -probabilityRows.reduce((sum, item) => sum + Math.log(Math.max(1e-9, item.probabilities[CLASSES.indexOf(String(item.row.outcome_class) as (typeof CLASSES)[number])])), 0) / probabilityRows.length : null;
  const brier = probabilityRows.length ? probabilityRows.reduce((sum, item) => sum + item.probabilities.reduce((rowSum, probability, index) => rowSum + (probability - (CLASSES[index] === String(item.row.outcome_class) ? 1 : 0)) ** 2, 0), 0) / probabilityRows.length : null;
  const expectedReturns = scored.map((row) => safeNumber(row.expected_return)).filter((value): value is number => value != null);
  const realizedReturns = scored.map((row) => safeNumber(row.outcome_return)).filter((value): value is number => value != null);
  const pairedReturns = scored.map((row) => [safeNumber(row.expected_return), safeNumber(row.outcome_return)] as const).filter((pair): pair is readonly [number, number] => pair[0] != null && pair[1] != null);
  const confidenceError = scored.map((row, index) => { const confidence = safeNumber(row.evidence?.confidence ?? row.confidence); return confidence == null ? null : Math.abs(confidence - (correct[index] ? 1 : 0)); }).filter((value): value is number => value != null);
  const metrics = {
    scoredPredictions: scored.length,
    pendingPredictions: pending.length,
    accuracy,
    balancedAccuracy,
    directionalAccuracy,
    logLoss,
    brier,
    calibrationError: confidenceError.length ? confidenceError.reduce((sum, value) => sum + value, 0) / confidenceError.length : null,
    meanExpectedReturn: expectedReturns.length ? expectedReturns.reduce((sum, value) => sum + value, 0) / expectedReturns.length : null,
    meanRealizedReturn: realizedReturns.length ? realizedReturns.reduce((sum, value) => sum + value, 0) / realizedReturns.length : null,
    returnMae: pairedReturns.length ? pairedReturns.reduce((sum, pair) => sum + Math.abs(pair[0] - pair[1]), 0) / pairedReturns.length : null,
  };
  const byHorizon = [...new Set(result.rows.map((row) => String(row.horizon)))].map((horizon) => {
    const rows = scored.filter((row) => String(row.horizon) === horizon);
    const wins = rows.filter((row) => predictionOf(row) === String(row.outcome_class)).length;
    const directionalRows = rows.filter((row) => ["UP", "DOWN"].includes(predictionOf(row)) && ["UP", "DOWN"].includes(String(row.outcome_class)));
    const horizonProbabilityRows: Array<{ row: any; probabilities: number[] }> = rows.flatMap((row) => {
      const probabilities = CLASSES.map((label) => probabilityOf(row, label));
      return probabilities.every((value): value is number => value != null) ? [{ row, probabilities }] : [];
    });
    const horizonLogLoss = horizonProbabilityRows.length
      ? -horizonProbabilityRows.reduce((sum, item) => sum + Math.log(Math.max(1e-9, item.probabilities[CLASSES.indexOf(String(item.row.outcome_class) as (typeof CLASSES)[number])])), 0) / horizonProbabilityRows.length
      : null;
    return {
      horizon,
      scoredPredictions: rows.length,
      accuracy: rows.length ? wins / rows.length : null,
      directionalAccuracy: directionalRows.length ? directionalRows.filter((row) => predictionOf(row) === String(row.outcome_class)).length / directionalRows.length : null,
      logLoss: horizonLogLoss,
      pendingPredictions: pending.filter((row) => String(row.horizon) === horizon).length,
    };
  });
  return { ok: true, periodDays: days, generatedAt: new Date().toISOString(), metrics, byHorizon };
}
