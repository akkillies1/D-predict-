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
  return_interval: { p10: number; p50: number; p90: number };
  probability_net_positive: number;
  calibration_status: "CALIBRATED" | "UNCALIBRATED" | "CALIBRATION_UNVERIFIED";
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
  meta_probability: number | null;
  meta: {
    version: string;
    ready: boolean;
    probability: number | null;
    min_confidence: number;
    examples: number;
    oos_auc: number | null;
    oos_auc_ci_low: number | null;
    oos_accuracy: number | null;
    oos_log_loss: number | null;
    selected_coverage: number | null;
    accuracy_lift_ci_low: number | null;
    coverage_accuracy: Record<string, number>;
    features: Record<string, number>;
  };
  model_version: string;
  feature_set_version: string;
  training_cutoff: string;
  validation_oos_examples: number;
  calibration_examples: number;
  features: Record<string, number>;
};

const baseUrl = (process.env.ML_INFERENCE_URL ?? "http://ml:4300").replace(/\/$/, "");

/** Map of symbol -> model_state from the ML coverage view. An instrument is
 * predictable only when it already has a usable artifact (UP_TO_DATE or STALE);
 * everything else (TRAINING_REQUIRED, INSUFFICIENT_HISTORY, WAITING_FOR_DATA)
 * has no artifact and would make /predict fail with a 503. Returns an empty map
 * when coverage is unavailable, so callers can fall back to try-and-isolate. */
export async function fetchModelStates(horizon = "1d"): Promise<Map<string, string>> {
  const states = new Map<string, string>();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(process.env.ML_INFERENCE_TIMEOUT_MS ?? 15000)));
  try {
    const response = await fetch(`${baseUrl}/training/coverage?horizons=${encodeURIComponent(horizon)}`, { signal: controller.signal });
    if (!response.ok) return states;
    const body = (await response.json().catch(() => ({}))) as { instruments?: Array<{ symbol?: string; model_state?: string }> };
    for (const item of body.instruments ?? []) {
      if (item?.symbol) states.set(String(item.symbol).toUpperCase(), String(item.model_state ?? ""));
    }
    return states;
  } catch {
    return states;
  } finally {
    clearTimeout(timeout);
  }
}

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
