import { pool, getActiveSymbols } from "../db.js";
import { config } from "../config.js";
import { predictWithValidatedModel } from "../mlClient.js";

type Direction = "BULLISH" | "BEARISH" | "NEUTRAL";

function toDirection(prediction: "DOWN" | "FLAT" | "UP"): Direction {
  if (prediction === "UP") return "BULLISH";
  if (prediction === "DOWN") return "BEARISH";
  return "NEUTRAL";
}

function reasonCodes(prediction: "DOWN" | "FLAT" | "UP", calibration: string): string[] {
  return [
    `ML_${prediction}`,
    calibration === "CALIBRATED" ? "PROBABILITY_CALIBRATED" : "PROBABILITY_UNCALIBRATED",
    "PYTHON_RESEARCH_MODEL",
  ];
}

async function runForSymbol(symbol: string): Promise<void> {
  const prediction = await predictWithValidatedModel(symbol, new Date());
  const direction = toDirection(prediction.prediction);
  const reasons = reasonCodes(prediction.prediction, prediction.calibration_status);

  const signal = await pool.query(
    `insert into signal_decisions (
       instrument_id, timestamp, strategy_version, model_version,
       input_snapshot_id, direction, confidence, regime, reason_codes, parameters
     )
     select i.instrument_id, $2, $3, $4, null, $5, $6, null, $7, $8::jsonb
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
        calibrationStatus: prediction.calibration_status,
        featureSetVersion: prediction.feature_set_version,
        trainingCutoff: prediction.training_cutoff,
        validationOosExamples: prediction.validation_oos_examples,
        calibrationExamples: prediction.calibration_examples,
        features: prediction.features,
      }),
    ]
  );

  await pool.query(
    `insert into prediction_ledger (
       symbol, timestamp, horizon, model_version,
       market_probability, expected_return, confidence, evidence, input_snapshot
     )
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)
     on conflict do nothing`,
    [
      symbol,
      prediction.timestamp,
      prediction.horizon,
      prediction.model_version,
      prediction.confidence,
      prediction.expected_return,
      prediction.confidence,
      JSON.stringify({
        probabilities: prediction.probabilities,
        rawProbabilities: prediction.raw_probabilities,
        prediction: prediction.prediction,
        calibrationStatus: prediction.calibration_status,
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
