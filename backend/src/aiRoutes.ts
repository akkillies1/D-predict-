import { Router } from "express";
import type { Pool } from "pg";
import { Readable } from "node:stream";
import {
  DEFAULT_AI_BASE_URL,
  buildSystemPrompt,
  describeUpstreamError,
  looksLikeNvidiaKey,
  maskApiKey,
  normalizeBaseUrl,
  sanitizeMessages,
  type AiEvidence,
} from "./aiAdvisor.js";

const CHAT_TIMEOUT_MS = Math.max(15_000, Number(process.env.AI_TIMEOUT_MS ?? 90_000));
const MODELS_TIMEOUT_MS = Math.max(5_000, Number(process.env.AI_MODELS_TIMEOUT_MS ?? 20_000));
const MAX_EVIDENCE_BLOCKS = 6;

type AiConfig = { apiKey: string; baseUrl: string; model: string | null; enabled: boolean; source: "saved" | "env" | null };

let schemaPromise: Promise<void> | null = null;
function ensureAiSchema(pool: Pool): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = pool
      .query(`create table if not exists ai_settings (
        id smallint primary key default 1 check (id = 1),
        provider text not null default 'nvidia_nim',
        base_url text not null,
        api_key text not null,
        model text,
        enabled boolean not null default true,
        updated_at timestamptz not null default now())`)
      .then(() => undefined);
  }
  return schemaPromise;
}

async function readSavedConfig(pool: Pool | null): Promise<{ apiKey: string; baseUrl: string; model: string | null; enabled: boolean } | null> {
  if (!pool) return null;
  try {
    await ensureAiSchema(pool);
    const result = await pool.query("select base_url, api_key, model, enabled from ai_settings where id = 1");
    const row = result.rows[0];
    if (!row) return null;
    return { apiKey: String(row.api_key ?? ""), baseUrl: String(row.base_url ?? DEFAULT_AI_BASE_URL), model: row.model == null ? null : String(row.model), enabled: row.enabled !== false };
  } catch {
    // A database without the ai_settings table (older install) must still allow
    // an environment-key configuration rather than failing the whole endpoint.
    return null;
  }
}

async function effectiveConfig(pool: Pool | null): Promise<AiConfig> {
  const saved = await readSavedConfig(pool);
  const envKey = String(process.env.NVIDIA_API_KEY ?? "").trim();
  const apiKey = saved?.apiKey?.trim() || envKey;
  return {
    apiKey,
    baseUrl: normalizeBaseUrl(saved?.baseUrl || process.env.NVIDIA_API_BASE_URL),
    model: saved?.model || String(process.env.NVIDIA_MODEL ?? "").trim() || null,
    enabled: saved ? saved.enabled : true,
    source: saved?.apiKey?.trim() ? "saved" : envKey ? "env" : null,
  };
}

// The API binds 0.0.0.0 inside Docker, so this assistant's configuration and
// spend are loopback-only: the dashboard always calls 127.0.0.1:4100. A remote
// host or a DNS-rebinding page (Host: evil.example) is refused rather than
// allowed to read status, overwrite the key, or burn the user's credits.
function isLoopbackRequest(req: { headers: Record<string, unknown>; socket: { remoteAddress?: string } }): boolean {
  const hostHeader = String(req.headers.host ?? "");
  const hostname = hostHeader.replace(/:\d+$/, "").replace(/^\[|\]/g, "").toLowerCase();
  if (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1") return true;
  if (hostHeader === "") return String(req.socket?.remoteAddress ?? "").startsWith("127.");
  return false;
}

function refuseRemote(_req: unknown, res: { status(code: number): { json(body: unknown): unknown } }) {
  return res.status(403).json({ ok: false, error: "AI_CONFIG_LOCAL_ONLY", message: "The AI assistant can only be configured from this machine." });
}

function upstreamHeaders(apiKey: string) {
  return { "content-type": "application/json", authorization: `Bearer ${apiKey}`, accept: "application/json" };
}

function statusPayload(config: AiConfig) {
  return {
    ok: true,
    configured: Boolean(config.apiKey) && config.enabled,
    enabled: config.enabled,
    source: config.source,
    maskedKey: maskApiKey(config.apiKey || null),
    looksLikeNvidiaKey: config.apiKey ? looksLikeNvidiaKey(config.apiKey) : null,
    baseUrl: config.baseUrl,
    model: config.model,
    disclaimer: "Optional bring-your-own-key assistant. It only re-explains numbers D-Predict already computed from real persisted data; it cannot fetch market data and is not a source of predictions. Requests go straight from this machine to the provider with your own key.",
  };
}

function evidenceFrom(body: Record<string, unknown>): AiEvidence[] {
  const raw = Array.isArray(body.evidence) ? body.evidence.slice(0, MAX_EVIDENCE_BLOCKS) : [];
  const blocks: AiEvidence[] = [];
  for (const item of raw) {
    const record = (item ?? {}) as Record<string, unknown>;
    const label = String(record.label ?? "").trim().slice(0, 120);
    if (!label) continue;
    const asOf = record.asOf == null ? null : String(record.asOf).slice(0, 40);
    blocks.push({ label, asOf, data: record.data ?? null });
  }
  return blocks;
}

async function callUpstream(config: AiConfig, path: string, payload: unknown, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${config.baseUrl}${path}`, { method: "POST", headers: { ...upstreamHeaders(config.apiKey), accept: "text/event-stream,application/json" }, body: JSON.stringify(payload), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function createAiRouter(pool: Pool | null): Router {
  const router = Router();

  router.get("/status", async (req, res) => {
    if (!isLoopbackRequest(req)) return refuseRemote(req, res);
    res.json(statusPayload(await effectiveConfig(pool)));
  });

  // Upsert. An omitted apiKey keeps the stored one so the UI can change the
  // model without re-sending a secret it was never given in full.
  router.put("/config", async (req, res) => {
    if (!isLoopbackRequest(req)) return refuseRemote(req, res);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: { apiKey?: string; baseUrl?: string; model?: string | null; enabled?: boolean } = {};
    if (body.apiKey !== undefined) {
      const key = String(body.apiKey ?? "").trim();
      if (key.length > 0 && (key.length < 12 || key.length > 300 || /\s/.test(key))) {
        return res.status(400).json({ ok: false, error: "INVALID_API_KEY", message: "An API key is a single unbroken token of 12-300 characters. Leave it blank to clear it." });
      }
      patch.apiKey = key;
    }
    if (body.baseUrl !== undefined) patch.baseUrl = normalizeBaseUrl(body.baseUrl);
    if (body.model !== undefined) patch.model = body.model == null ? null : String(body.model).trim().slice(0, 160) || null;
    if (body.enabled !== undefined) patch.enabled = body.enabled !== false;

    if (!pool) {
      // No database (dev without Postgres): honour an env key, refuse to persist.
      const envKey = String(process.env.NVIDIA_API_KEY ?? "").trim();
      if (patch.apiKey && patch.apiKey !== envKey) {
        return res.status(503).json({ ok: false, error: "DATABASE_NOT_CONFIGURED", message: "Saving an AI key needs the local database. Start D-Predict with .\\dp.ps1 start, or set NVIDIA_API_KEY in the environment." });
      }
      return res.json(statusPayload(await effectiveConfig(null)));
    }
    try {
      await ensureAiSchema(pool);
      const current = await readSavedConfig(pool);
      const apiKey = patch.apiKey !== undefined ? patch.apiKey : current?.apiKey ?? "";
      const baseUrl = patch.baseUrl !== undefined ? patch.baseUrl : normalizeBaseUrl(current?.baseUrl ?? process.env.NVIDIA_API_BASE_URL);
      const model = patch.model !== undefined ? patch.model : current?.model ?? null;
      const enabled = patch.enabled !== undefined ? patch.enabled : current?.enabled ?? true;
      if (!apiKey) {
        await pool.query("delete from ai_settings where id = 1");
        return res.json({ ...statusPayload(await effectiveConfig(pool)), removed: true });
      }
      await pool.query(
        `insert into ai_settings (id, base_url, api_key, model, enabled, updated_at) values (1,$1,$2,$3,$4,now())
         on conflict (id) do update set base_url=excluded.base_url, api_key=excluded.api_key, model=excluded.model, enabled=excluded.enabled, updated_at=now()`,
        [baseUrl, apiKey, model, enabled],
      );
      // Never echo the key back — statusPayload carries the masked form only.
      res.json(statusPayload(await effectiveConfig(pool)));
    } catch (error) {
      res.status(500).json({ ok: false, error: "AI_CONFIG_SAVE_FAILED", message: error instanceof Error ? error.message : "save_failed" });
    }
  });

  router.delete("/config", async (req, res) => {
    if (!isLoopbackRequest(req)) return refuseRemote(req, res);
    if (!pool) return res.json({ ...statusPayload(await effectiveConfig(null)), removed: true, note: process.env.NVIDIA_API_KEY ? "No database is attached, so the saved key was already absent. The environment key NVIDIA_API_KEY is still in use; unset it in .env to disable." : null });
    try {
      await ensureAiSchema(pool);
      await pool.query("delete from ai_settings where id = 1");
      res.json({ ...statusPayload(await effectiveConfig(pool)), removed: true });
    } catch (error) {
      res.status(500).json({ ok: false, error: "AI_CONFIG_CLEAR_FAILED", message: error instanceof Error ? error.message : "clear_failed" });
    }
  });

  // The user's own key decides which models exist, so list them live instead of
  // shipping a hardcoded catalog that can silently go stale.
  router.get("/models", async (req, res) => {
    if (!isLoopbackRequest(req)) return refuseRemote(req, res);
    const config = await effectiveConfig(pool);
    if (!config.apiKey) return res.status(400).json({ ok: false, error: "AI_KEY_MISSING", message: "Add your NVIDIA API key first." });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODELS_TIMEOUT_MS);
    try {
      const response = await fetch(`${config.baseUrl}/models`, { headers: upstreamHeaders(config.apiKey), signal: controller.signal });
      if (!response.ok) {
        const { code, message } = describeUpstreamError(response.status, await response.text().catch(() => ""));
        return res.status(200).json({ ok: false, error: code, message, models: [] });
      }
      const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
      const models = (Array.isArray(body.data) ? body.data : [])
        .map((entry) => String(entry?.id ?? ""))
        .filter((id) => id.length > 0 && id.length <= 160)
        .sort((a, b) => a.localeCompare(b));
      res.json({ ok: true, count: models.length, models, nemotron: models.filter((id) => id.toLowerCase().includes("nemotron")) });
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      res.status(200).json({ ok: false, error: aborted ? "AI_MODELS_TIMEOUT" : "AI_MODELS_UNREACHABLE", message: aborted ? "The provider did not answer the model list in time." : "Could not reach the provider. Check your internet connection and base URL.", models: [] });
    } finally {
      clearTimeout(timer);
    }
  });

  router.post("/chat", async (req, res) => {
    if (!isLoopbackRequest(req)) return refuseRemote(req, res);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const question = String(body.question ?? "").trim().slice(0, 4000);
    if (!question) return res.status(400).json({ ok: false, error: "AI_QUESTION_REQUIRED" });
    const history = sanitizeMessages(body.messages);
    const evidence = evidenceFrom(body);
    const config = await effectiveConfig(pool);
    if (!config.apiKey) return res.status(400).json({ ok: false, error: "AI_KEY_MISSING", message: "The assistant needs an NVIDIA API key. Open AI Assistant settings and paste your own key — it is stored locally on this machine." });
    if (!config.enabled) return res.status(400).json({ ok: false, error: "AI_DISABLED", message: "The assistant is switched off in AI Assistant settings." });
    const model = String(body.model ?? "").trim().slice(0, 160) || config.model;
    if (!model) return res.status(400).json({ ok: false, error: "AI_MODEL_REQUIRED", message: "Choose a model in AI Assistant settings first (the picker lists what your own key can access)." });

    const payload = {
      model,
      messages: [{ role: "system", content: buildSystemPrompt(evidence, body.marketContext == null ? null : String(body.marketContext)) }, ...history, { role: "user", content: question }],
      temperature: Math.min(1, Math.max(0, Number(body.temperature ?? 0.2))),
      top_p: 0.95,
      max_tokens: Math.min(2048, Math.max(64, Number(body.maxTokens ?? 700))),
      stream: body.stream !== false,
    };

    let upstream: Response;
    try {
      upstream = await callUpstream(config, "/chat/completions", payload, CHAT_TIMEOUT_MS);
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      return res.status(200).json({ ok: false, error: aborted ? "AI_TIMEOUT" : "AI_UNREACHABLE", message: aborted ? "The model took longer than the timeout. Try a shorter question or a smaller model." : "Could not reach the provider over the network." });
    }

    if (!upstream.ok) {
      const { code, message } = describeUpstreamError(upstream.status, await upstream.text().catch(() => ""));
      return res.status(200).json({ ok: false, error: code, message, model });
    }

    if (payload.stream === false) {
      const completed = (await upstream.json().catch(() => null)) as { choices?: Array<{ message?: { content?: unknown } }>; usage?: Record<string, unknown> } | null;
      const text = String(completed?.choices?.[0]?.message?.content ?? "").trim();
      if (!text) return res.status(200).json({ ok: false, error: "AI_EMPTY_RESPONSE", message: "The model returned no text.", model });
      return res.json({ ok: true, text, model, usage: completed?.usage ?? null });
    }

    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders?.();
    res.write(`event: meta\ndata: ${JSON.stringify({ ok: true, model })}\n\n`);
    try {
      const source = Readable.fromWeb(upstream.body as never);
      for await (const chunk of source) {
        if (res.writableEnded) break;
        res.write(chunk as Buffer);
      }
      if (!res.writableEnded) res.end();
    } catch (error) {
      if (!res.writableEnded) res.write(`event: aierror\ndata: ${JSON.stringify({ ok: false, error: "AI_STREAM_INTERRUPTED", message: error instanceof Error ? error.message : "stream_failed" })}\n\n`);
      if (!res.writableEnded) res.end();
    }
  });

  return router;
}
