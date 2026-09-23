import { pool, getActiveSymbols, getInstrumentId } from "../db.js";
import { config } from "../config.js";
import { predictWithValidatedModel } from "../mlClient.js";

type Direction = "BULLISH" | "BEARISH" | "NEUTRAL";

/** Point-in-time feature context for a decision: the most recent feature
 * snapshot at or before the prediction's own timestamp. Using "<= timestamp"
 * (not the latest row overall) keeps the linkage free of lookahead, so the
 * snapshot referenced is exactly the context that was available when the model
 * call was made. Returns nulls when no snapshot precedes the prediction yet,
 * which leaves the FK empty rather than pointing at future data. */
async function featureContextAt(
  instrumentId: string,
  asOf: string
): Promise<{ snapshotId: number | null; regime: string | null }> {
  const res = await pool.query(
    `select id, regime
     from feature_snapshots
     where instrument_id = $1 and timestamp <= $2
     order by timestamp desc
     limit 1`,
    [instrumentId, asOf]
  );
  if (res.rows.length === 0) return { snapshotId: null, regime: null };
  return { snapshotId: Number(res.rows[0].id), regime: res.rows[0].regime ?? null };
}

function toDirection(prediction: "DOWN" | "FLAT" | "UP"): Direction {
  if (prediction === "UP") return "BULLISH";
  if (prediction === "DOWN") return "BEARISH";
  return "NEUTRAL";
}

function reasonCodes(prediction: "DOWN" | "FLAT" | "UP", calibration: string, status: string, actionStatus: string): string[] {
  return [
    `ML_${prediction}`,
    calibration === "CALIBRATED" ? "PROBABILITY_CALIBRATED" : "PROBABILITY_UNCALIBRATED",
    status === "PROMOTION_READY" ? "OOS_PROMOTION_READY" : "OOS_GATE_ABSTAIN",
    `ACTION_${actionStatus}`,
    "PYTHON_RESEARCH_MODEL",
  ];
}

async function runForSymbol(symbol: string): Promise<void> {
  const instrumentId = await getInstrumentId(symbol);
  const prediction = await predictWithValidatedModel(symbol, new Date());
  const context = await featureContextAt(instrumentId, prediction.timestamp);
  const actionable = prediction.action_status === "ACTIONABLE_LONG" || prediction.action_status === "ACTIONABLE_SHORT";
  const direction = actionable ? toDirection(prediction.prediction) : "NEUTRAL";
  const reasons = reasonCodes(prediction.prediction, prediction.calibration_status, prediction.prediction_status, prediction.action_status);
  // Probability the market model assigns to the class it actually called.
  // Falls back to confidence (max class probability) if the map is missing.
  const marketProbability = prediction.probabilities?.[prediction.prediction] ?? prediction.confidence;

  const signal = await pool.query(
    `insert into signal_decisions (
       instrument_id, timestamp, strategy_version, model_version,
       input_snapshot_id, direction, confidence, regime, reason_codes, parameters
     )
     select i.instrument_id, $2, $3, $4, $9, $5, $6, $10, $7, $8::jsonb
     from instruments i
     where upper(i.symbol) = upper($1)
       and not exists (
         select 1 from signal_decisions s
         where s.instrument_id = i.instrument_id
           and s.timestamp = $2
           and s.model_version = $4
       )
     returning id`,
    [
      symbol,
      prediction.timestamp,
      config.strategyVersion,
      prediction.model_version,
      direction,
      prediction.confidence,
      reasons,
      JSON.stringify({
        probabilities: prediction.probabilities,
        rawProbabilities: prediction.raw_probabilities,
        expectedReturn: prediction.expected_return,
        probabilityMargin: prediction.probability_margin,
        returnInterval: prediction.return_interval,
        probabilityNetPositive: prediction.probability_net_positive,
        calibrationStatus: prediction.calibration_status,
        actionStatus: prediction.action_status,
        actionReasons: prediction.action_reasons,
        predictionStatus: prediction.prediction_status,
        promotionChecks: prediction.promotion_checks,
        oosMetrics: prediction.oos_metrics,
        featureSetVersion: prediction.feature_set_version,
        trainingCutoff: prediction.training_cutoff,
        validationOosExamples: prediction.validation_oos_examples,
        calibrationExamples: prediction.calibration_examples,
        features: prediction.features,
      }),
      context.snapshotId,
      context.regime,
    ]
  );

  await pool.query(
    `insert into prediction_ledger (
       symbol, timestamp, horizon, model_version,
       market_probability, expected_return, confidence, regime, evidence, input_snapshot
     )
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)
     on conflict do nothing`,
    [
      symbol,
      prediction.timestamp,
      prediction.horizon,
      prediction.model_version,
      marketProbability,
      prediction.expected_return,
      prediction.confidence,
      context.regime,
      JSON.stringify({
        probabilities: prediction.probabilities,
        rawProbabilities: prediction.raw_probabilities,
        prediction: prediction.prediction,
        probabilityMargin: prediction.probability_margin,
        returnInterval: prediction.return_interval,
        probabilityNetPositive: prediction.probability_net_positive,
        calibrationStatus: prediction.calibration_status,
        actionStatus: prediction.action_status,
        actionReasons: prediction.action_reasons,
        predictionStatus: prediction.prediction_status,
        promotionChecks: prediction.promotion_checks,
        oosMetrics: prediction.oos_metrics,
        featureSetVersion: prediction.feature_set_version,
        trainingCutoff: prediction.training_cutoff,
      }),
      JSON.stringify(prediction.features),
    ]
  );

  if ((signal.rowCount ?? 0) > 0) {
    console.log(
      `[signal] ${symbol} @ ${prediction.timestamp}: ${direction} confidence=${prediction.confidence.toFixed(3)} model=${prediction.model_version} calibration=${prediction.calibration_status}`
    );
  } else {
    console.log(`[signal] ${symbol} @ ${prediction.timestamp}: model output already recorded`);
  }
}

export async function runSignalEngine(): Promise<void> {
  for (const symbol of await getActiveSymbols()) {
    try {
      await runForSymbol(symbol);
    } catch (error) {
      console.error(`[signal] ${symbol}: validated ML inference unavailable`, error);
    }
  }
}
