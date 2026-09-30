// One HTTP client for the local ML service, shared by the REST routes and the
// AI agent's tools so a forecast can never be fetched differently depending on
// who asked.
export type MlResult = { status: number; body: any };

export async function mlFetch(path: string, init: RequestInit = {}, timeoutMs = 15000): Promise<MlResult> {
  const base = (process.env.ML_INFERENCE_URL ?? "http://ml:4300").replace(/\/$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    const response = await fetch(`${base}${path}`, { ...init, signal: controller.signal });
    const body = await response.json().catch(() => ({ ok: false, error: "ML_INVALID_RESPONSE" }));
    return { status: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
}
