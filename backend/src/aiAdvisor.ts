// Pure, side-effect-free helpers for the optional BYO-key AI assistant.
// Kept separate from the router so the honesty rules below are unit-testable
// without a database or an outbound network call.

export const DEFAULT_AI_BASE_URL = "https://integrate.api.nvidia.com/v1";
/** NVIDIA API keys are issued with this prefix; used only for a shape warning. */
const NVIDIA_KEY_PREFIX = "nvapi-";
/** Characters of serialized evidence handed to the model. Keeps requests small and cheap. */
export const MAX_EVIDENCE_CHARS = 16_000;
/** Conversation turns replayed to the model, newest first, excluding the system prompt. */
const MAX_REPLAYED_TURNS = 8;

export type AiMessage = { role: "user" | "assistant"; content: string };
export type AiEvidence = { label: string; data: unknown; asOf?: string | null };

export function normalizeBaseUrl(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return DEFAULT_AI_BASE_URL;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withProtocol);
  } catch {
    return DEFAULT_AI_BASE_URL;
  }
  // Accept a bare host, a host ending in /v1, or a full chat-completions URL.
  let pathname = url.pathname.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(pathname)) pathname = pathname.slice(0, -"/chat/completions".length);
  if (!pathname || pathname === "") pathname = "/v1";
  return `${url.protocol}//${url.host}${pathname}`;
}

export function maskApiKey(key: string | null): string | null {
  if (!key) return null;
  if (key.length <= 8) return "••••";
  return `${key.slice(0, NVIDIA_KEY_PREFIX.length)}…${key.slice(-4)}`;
}

export function looksLikeNvidiaKey(key: string): boolean {
  return key.trim().toLowerCase().startsWith(NVIDIA_KEY_PREFIX);
}

/** Only user/assistant turns survive, trimmed, capped, and ordered oldest → newest. */
export function sanitizeMessages(input: unknown): AiMessage[] {
  if (!Array.isArray(input)) return [];
  const allowed = input
    .filter((message) => message && (message.role === "user" || message.role === "assistant"))
    .map((message) => ({ role: message.role as "user" | "assistant", content: String(message.content ?? "").slice(0, 4000) }))
    .filter((message) => message.content.trim().length > 0);
  return allowed.slice(-MAX_REPLAYED_TURNS);
}

function formatNumber(value: number): number {
  if (Number.isInteger(value)) return value;
  return Math.round(value * 1e6) / 1e6;
}

function compactJson(value: unknown): string {
  // The replacer must return every non-number unchanged; returning undefined
  // there would silently drop the field from the evidence the model sees.
  return JSON.stringify(value, (_key, raw) => (typeof raw === "number" && Number.isFinite(raw) ? formatNumber(raw) : raw));
}

export function buildEvidenceBlock(evidence: AiEvidence[]): string {
  const sections = evidence
    .filter((item) => item && item.label)
    .map((item) => `${item.label}${item.asOf ? ` (as of ${item.asOf})` : ""}:\n${compactJson(item.data) ?? "null"}`)
    .join("\n\n");
  if (!sections) return "EVIDENCE: none supplied for this request.";
  if (sections.length <= MAX_EVIDENCE_CHARS) return `EVIDENCE:\n${sections}`;
  return `EVIDENCE (truncated to ${MAX_EVIDENCE_CHARS} characters; anything after the cut was NOT sent to you):\n${sections.slice(0, MAX_EVIDENCE_CHARS)}`;
}

export function buildSystemPrompt(evidence: AiEvidence[], marketContext?: string | null): string {
  const block = buildEvidenceBlock(evidence);
  const context = String(marketContext ?? "").trim();
  return [
    "You are the D-Predict assistant, embedded in a local-first decision terminal for Indian equities and NIFTY/BANKNIFTY derivatives.",
    "All prices are ₹ and all timestamps are the ones given in the evidence. The user is a retail trader running this on their own machine.",
    "",
    "HARD RULES — these override everything else:",
    "1. The EVIDENCE block is your only source of facts. Never state a price, percentage, probability, indicator value, volume, date or symbol that is not present in it. Do not estimate, interpolate, recall market data, or invent examples.",
    "2. If the evidence does not contain what the question needs, say precisely what is missing instead of filling the gap. Saying 'not in the data' is a correct answer.",
    "3. Respect the status fields in the evidence. Numbers whose calibration/validation status says unverified, unvalidated or failing must be described as such and must not be presented as a reliable forecast. Rule-based closed-form numbers are exactly that: rules over realized data.",
    "4. You explain what D-Predict already computed; you do not produce a new signal, target price, or probability, and you do not recommend a trade. Frame implications, not instructions.",
    "5. Never reveal, restate, or discuss API keys or configuration.",
    "",
    "Style: plain English, at most ~220 words, short paragraphs, no markdown headings, no emoji, no bullet spam. Finish with the one or two things that would change your read.",
    context ? `Session context: ${context}` : "",
    "",
    block,
  ].filter((line) => line !== "").join("\n");
}

/** Maps an upstream HTTP failure onto a stable code + honest user-facing message. */
export function describeUpstreamError(status: number, bodyText: string): { code: string; message: string } {
  const detail = (() => {
    try {
      const parsed = JSON.parse(bodyText) as Record<string, unknown>;
      const nested = parsed.detail ?? parsed.error ?? parsed.message;
      if (typeof nested === "string") return nested;
      if (nested && typeof nested === "object") {
        const inner = nested as Record<string, unknown>;
        const code = typeof inner.code === "string" ? inner.code : null;
        const msg = typeof inner.message === "string" ? inner.message : null;
        if (code && msg) return `${code}: ${msg}`;
        return String(msg ?? code ?? inner);
      }
      return typeof parsed.message === "string" ? parsed.message : null;
    } catch {
      return bodyText ? bodyText.slice(0, 200) : null;
    }
  })();
  if (status === 401 || status === 403) return { code: "AI_KEY_REJECTED", message: detail ? `NVIDIA rejected this API key. ${detail}` : "NVIDIA rejected this API key (401). Check the key in AI Assistant settings." };
  if (status === 404) return { code: "AI_MODEL_UNAVAILABLE", message: detail ? `NVIDIA has no endpoint for this model. ${detail}` : "This model id is not available for your key. Pick another in AI Assistant settings." };
  if (status === 429) return { code: "AI_RATE_LIMITED", message: detail ? `Rate limit or credit quota reached. ${detail}` : "NVIDIA rate-limited this request (429). Free-tier credits are limited — wait a minute and ask again." };
  if (status === 400 || status === 422) return { code: "AI_REQUEST_REJECTED", message: detail ? `NVIDIA rejected the request. ${detail}` : "NVIDIA rejected the request (bad model id or parameters)." };
  if (status >= 500) return { code: "AI_UPSTREAM_ERROR", message: detail ? `NVIDIA is having trouble. ${detail}` : `NVIDIA returned server error ${status}.` };
  return { code: "AI_UPSTREAM_ERROR", message: detail || `NVIDIA returned HTTP ${status}.` };
}

/** Pulls text deltas out of one parsed OpenAI-compatible SSE chunk. */
export function extractStreamDelta(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object") return "";
  const record = parsed as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const delta = first?.delta as Record<string, unknown> | undefined;
  const content = delta?.content ?? (first?.message as Record<string, unknown> | undefined)?.content ?? first?.text;
  return typeof content === "string" ? content : "";
}
