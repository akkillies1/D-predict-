export type MlPrediction = {
  ok: boolean;
  symbol: string;
  timestamp: string;
  horizon: string;
  prediction: "DOWN" | "FLAT" | "UP";
  probabilities: { DOWN: number; FLAT: number; UP: number };
  raw_probabilities: { DOWN: number; FLAT: number; UP: number };
  expected_return: number;
  confidence: number;
  probability_margin: number;
  calibration_status: "CALIBRATED" | "UNCALIBRATED";
  prediction_status: "PROMOTION_READY" | "ABSTAIN";
  action_status: "ACTIONABLE_LONG" | "ACTIONABLE_SHORT" | "WATCH_FLAT" | "WATCH_LOW_EDGE" | "ABSTAIN_MODEL_GATE";
  action_reasons: string[];
  promotion_checks: Record<string, boolean>;
  oos_metrics: {
    accuracy: number;
    majority_baseline: number;
    log_loss: number;
    directional_accuracy: number | null;
  };
  model_version: string;
  feature_set_version: string;
  training_cutoff: string;
  validation_oos_examples: number;
  calibration_examples: number;
  features: Record<string, number>;
};

const baseUrl = (process.env.ML_INFERENCE_URL ?? "http://ml:4300").replace(/\/$/, "");

export async function predictWithValidatedModel(symbol: string, asOf: Date, horizon = "1d"): Promise<MlPrediction> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(process.env.ML_INFERENCE_TIMEOUT_MS ?? 15000)));
  try {
    const response = await fetch(`${baseUrl}/predict`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol, as_of: asOf.toISOString(), horizon }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok !== true) {
      throw new Error(`ML inference failed (${response.status}): ${body?.detail ?? "unknown error"}`);
    }
    return body as MlPrediction;
  } finally {
    clearTimeout(timeout);
  }
}
