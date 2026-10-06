import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { request } from "node:http";
import { DEFAULT_AI_MODEL } from "../dist/aiAdvisor.js";

// A stand-in for the provider: records what D-Predict actually sent upstream so
// the tests can prove the honesty guardrails reach the model, without a key.
const received = [];
let mockBehaviour = "ok";
const provider = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    received.push({ url: req.url, authorization: req.headers.authorization ?? null, body: raw ? JSON.parse(raw) : null });
    if (req.url === "/v1/models") {
      if (mockBehaviour === "models-401") { res.writeHead(401, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "Invalid API key" })); }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "nvidia/llama-3.1-nemotron-70b-instruct" }, { id: "meta/llama-3.3-70b-instruct" }, { id: "" }, { id: "nvidia/nemotron-nano-9b-v2" }] }));
    }
    if (req.url === "/v1/chat/completions") {
      if (mockBehaviour === "deny") { res.writeHead(401, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "Unauthorized" })); }
      if (mockBehaviour === "stream") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"PCR "}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"is 1.12"}}]}\n\n');
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ choices: [{ message: { content: "The evidence shows one rule fired." } }], usage: { total_tokens: 42 } }));
    }
    res.writeHead(404).end();
  });
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerPort = provider.address().port;

// Node's fetch will not let a test override the Host header, so this raw helper
// stands in for a non-loopback caller trying to reach the AI endpoints.
function rawHttp(port, { method = "GET", path = "/", host, body }) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host: host ?? `127.0.0.1:${port}`, "content-type": "application/json" } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function startServer(env) {
  const port = 4198;
  const child = spawn(process.execPath, ["dist/server.js"], {
    env: { ...process.env, API_PORT: String(port), DATABASE_URL: "", NVIDIA_API_BASE_URL: `http://127.0.0.1:${providerPort}/v1`, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("API did not start within 5 seconds")), 5000);
      child.stdout.on("data", (chunk) => {
        if (String(chunk).includes(`D-predict backend listening on ${port}`)) { clearTimeout(timer); resolve(); }
      });
      child.stderr.on("data", (chunk) => { const m = String(chunk).trim(); if (m) console.error(m); });
      child.on("exit", (code) => { if (code !== null && code !== 0) reject(new Error(`API exited early (code ${code})`)); });
    });
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
  return { child, port };
}

const SECRET = "nvapi-TestOnlySecretMaterial-8899";
const { child, port } = await startServer({ NVIDIA_API_KEY: SECRET, NVIDIA_MODEL: "nvidia/llama-3.1-nemotron-70b-instruct" });

try {
  // 1. Status must report capability without ever returning the key.
  const status = await (await fetch(`http://127.0.0.1:${port}/api/ai/status`)).json();
  assert.equal(status.ok, true);
  assert.equal(status.configured, true);
  assert.equal(status.source, "env");
  assert.equal(status.maskedKey, "nvapi-…8899");
  assert.ok(!JSON.stringify(status).includes(SECRET), "the raw key must never appear in a response body");
  assert.equal(status.baseUrl, `http://127.0.0.1:${providerPort}/v1`);

  // 2. A non-loopback Host is refused: no config read, no key overwrite.
  const remoteStatus = await rawHttp(port, { host: "attacker.example", path: "/api/ai/status" });
  assert.equal(remoteStatus.status, 403);
  assert.ok(remoteStatus.text.includes("AI_CONFIG_LOCAL_ONLY"));
  const remoteWrite = await rawHttp(port, { method: "PUT", host: "attacker.example", path: "/api/ai/config", body: JSON.stringify({ apiKey: "nvapi-injectedkey123456" }) });
  assert.equal(remoteWrite.status, 403);
  const remoteChat = await rawHttp(port, { method: "POST", host: "attacker.example", path: "/api/ai/chat", body: JSON.stringify({ question: "hi" }) });
  assert.equal(remoteChat.status, 403);

  // 3. The model picker reflects what the user's own key can actually reach.
  const models = await (await fetch(`http://127.0.0.1:${port}/api/ai/models`)).json();
  assert.equal(models.ok, true);
  assert.equal(models.count, 3, "blank model ids are dropped");
  assert.deepEqual(models.nemotron, ["nvidia/llama-3.1-nemotron-70b-instruct", "nvidia/nemotron-nano-9b-v2"]);
  const modelsCall = received[received.length - 1];
  assert.equal(modelsCall.authorization, `Bearer ${SECRET}`);

  // 4. Chat forwards the question plus the evidence-derived system prompt.
  const chat = await (await fetch(`http://127.0.0.1:${port}/api/ai/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "What does today's alert mean?", stream: false, evidence: [{ label: "Alerts", data: [{ rule: "pcr_band_cross", price: 152.4 }], asOf: "2026-09-29T09:20:00Z" }], messages: [{ role: "user", content: "earlier question" }] }),
  })).json();
  assert.equal(chat.ok, true);
  assert.equal(chat.text, "The evidence shows one rule fired.");
  assert.equal(chat.model, DEFAULT_AI_MODEL);
  assert.equal(chat.usage.total_tokens, 42);
  const chatCall = received[received.length - 1];
  const system = chatCall.body.messages[0];
  assert.equal(system.role, "system");
  assert.ok(system.content.includes("only source of facts"));
  assert.ok(system.content.includes("pcr_band_cross"));
  assert.ok(system.content.includes("152.4"));
  assert.equal(chatCall.body.messages[1].content, "earlier question");
  assert.equal(chatCall.body.messages[2].role, "user");
  assert.ok(!JSON.stringify(chatCall.body.messages[0]).includes(SECRET), "the key must not leak into the prompt");

  // 5. Streaming is passed through, and the model identity arrives up front.
  mockBehaviour = "stream";
  const streamResponse = await fetch(`http://127.0.0.1:${port}/api/ai/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "Explain the chain PCR", evidence: [{ label: "Chain", data: { pcr: 1.12 } }] }),
  });
  assert.ok(streamResponse.headers.get("content-type").includes("text/event-stream"));
  const streamed = await streamResponse.text();
  assert.ok(streamed.includes("event: meta"));
  assert.ok(streamed.includes("PCR ") && streamed.includes("is 1.12"));
  assert.ok(streamed.includes("[DONE]"));
  mockBehaviour = "ok";

  // 6. Provider failures surface as honest, actionable codes.
  mockBehaviour = "deny";
  const denied = await (await fetch(`http://127.0.0.1:${port}/api/ai/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "hi", stream: false }) })).json();
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "AI_KEY_REJECTED");
  mockBehaviour = "models-401";
  const deniedModels = await (await fetch(`http://127.0.0.1:${port}/api/ai/models`)).json();
  assert.equal(deniedModels.error, "AI_KEY_REJECTED");
  assert.deepEqual(deniedModels.models, []);
  mockBehaviour = "ok";

  // 7. Validation without touching the database.
  const badKey = await (await fetch(`http://127.0.0.1:${port}/api/ai/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ apiKey: "has spaces" }) })).json();
  assert.equal(badKey.error, "INVALID_API_KEY");
  const noQuestion = await (await fetch(`http://127.0.0.1:${port}/api/ai/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "  " }) }));
  assert.equal(noQuestion.status, 400);
  // Without a database a key cannot be persisted, and claiming otherwise would be a lie.
  const persistAttempt = await (await fetch(`http://127.0.0.1:${port}/api/ai/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ apiKey: "nvapi-anotherkey567890" }) }));
  assert.equal(persistAttempt.status, 503);
  assert.equal((await persistAttempt.json()).error, "DATABASE_NOT_CONFIGURED");
} finally {
  child.kill("SIGTERM");
}

// 8. With no key anywhere, the assistant says so instead of pretending.
const bare = await startServer({ NVIDIA_API_KEY: "" });
try {
  const status = await (await fetch(`http://127.0.0.1:${bare.port}/api/ai/status`)).json();
  assert.equal(status.configured, false);
  assert.equal(status.maskedKey, null);
  const chat = await (await fetch(`http://127.0.0.1:${bare.port}/api/ai/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "hi" }) }));
  assert.equal(chat.status, 400);
  assert.equal((await chat.json()).error, "AI_KEY_MISSING");
} finally {
  bare.child.kill("SIGTERM");
  provider.close();
}

console.log("ai assistant proxy tests passed");
