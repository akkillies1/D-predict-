import assert from "node:assert/strict";
import {
  DEFAULT_AI_BASE_URL,
  buildEvidenceBlock,
  buildSystemPrompt,
  describeUpstreamError,
  extractStreamDelta,
  looksLikeNvidiaKey,
  maskApiKey,
  normalizeBaseUrl,
  sanitizeMessages,
} from "../dist/aiAdvisor.js";

// --- base URL normalisation: users paste anything from a bare host to a full
// chat-completions URL; the router must end up with a usable /v1 root.
assert.equal(normalizeBaseUrl(""), DEFAULT_AI_BASE_URL);
assert.equal(normalizeBaseUrl("integrate.api.nvidia.com/v1"), "https://integrate.api.nvidia.com/v1");
assert.equal(normalizeBaseUrl("https://integrate.api.nvidia.com/v1/"), "https://integrate.api.nvidia.com/v1");
assert.equal(normalizeBaseUrl("https://example.com/v1/chat/completions"), "https://example.com/v1");
assert.equal(normalizeBaseUrl("http://127.0.0.1:8000/v1"), "http://127.0.0.1:8000/v1");
assert.equal(normalizeBaseUrl("not a url at all"), DEFAULT_AI_BASE_URL);

// --- the key must never be reconstructable from what the API returns.
assert.equal(maskApiKey(null), null);
assert.equal(maskApiKey("nvapi-AAAAAAAAAAAAAAAA1234"), "nvapi-…1234");
assert.equal(maskApiKey("short"), "••••");
assert.ok(!maskApiKey("nvapi-SecretMaterial9999").includes("SecretMaterial"));
assert.equal(looksLikeNvidiaKey("nvapi-abc123def456"), true);
assert.equal(looksLikeNvidiaKey("sk-somethingelse"), false);

// --- conversation replay: only user/assistant survive, newest last, capped.
const messages = sanitizeMessages([
  { role: "system", content: "should be dropped" },
  { role: "user", content: "first" },
  { role: "assistant", content: "second" },
  { role: "tool", content: "dropped too" },
  { role: "user", content: "   " },
  { role: "user", content: "x".repeat(9000) },
]);
assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "user"]);
assert.equal(messages[2].content.length, 4000);
const many = sanitizeMessages(Array.from({ length: 30 }, (_, i) => ({ role: "user", content: `t${i}` })));
assert.equal(many.length, 8);
assert.equal(many[7].content, "t29");
assert.deepEqual(sanitizeMessages("nonsense"), []);

// --- evidence block is the only factual source, and it must be complete or
// explicitly marked truncated.
const block = buildEvidenceBlock([
  { label: "Signal for RELIANCE", data: { direction: "UP", confidence: 0.6123456789 }, asOf: "2026-09-29T09:15:00Z" },
  { label: "Empty", data: null },
]);
assert.ok(block.includes("Signal for RELIANCE (as of 2026-09-29T09:15:00Z):"));
assert.ok(block.includes('"confidence":0.612346'));
assert.ok(block.includes("Empty:\nnull"));
assert.equal(buildEvidenceBlock([]), "EVIDENCE: none supplied for this request.");
const huge = buildEvidenceBlock([{ label: "Big", data: { blob: "y".repeat(40000) } }]);
assert.ok(huge.length < 17000);
assert.ok(huge.includes("truncated to 16000 characters"));

// --- the honesty rules live in the system prompt.
const prompt = buildSystemPrompt([{ label: "Alerts", data: [{ rule: "sma20_cross_up", close: 152.4 }] }], "market open");
assert.ok(prompt.includes("only source of facts"));
assert.ok(prompt.includes("EVIDENCE:"));
assert.ok(prompt.includes("152.4"));
assert.ok(prompt.includes("not in the data"));
assert.ok(prompt.includes("Session context: market open"));
assert.ok(!buildSystemPrompt([{ label: "A", data: 1 }]).includes("Session context"));
assert.ok(buildSystemPrompt([]).includes("EVIDENCE: none supplied"));

// --- upstream failures must map to codes the UI can explain honestly.
assert.equal(describeUpstreamError(401, '{"error":"Invalid API key"}').code, "AI_KEY_REJECTED");
assert.equal(describeUpstreamError(403, "").code, "AI_KEY_REJECTED");
assert.ok(describeUpstreamError(404, '{"detail":{"code":"Not_Found","message":"model removed"}}').message.includes("model removed"));
assert.equal(describeUpstreamError(404, "").code, "AI_MODEL_UNAVAILABLE");
assert.equal(describeUpstreamError(429, "too many requests").code, "AI_RATE_LIMITED");
assert.equal(describeUpstreamError(429, "too many requests").message.includes("too many requests"), true);
assert.equal(describeUpstreamError(400, '{"detail":"bad model"}').code, "AI_REQUEST_REJECTED");
assert.equal(describeUpstreamError(503, "<html>oops</html>").code, "AI_UPSTREAM_ERROR");
assert.equal(describeUpstreamError(418, "").code, "AI_UPSTREAM_ERROR");

// --- SSE chunk shapes the client will see.
assert.equal(extractStreamDelta({ choices: [{ delta: { content: "Hel" } }] }), "Hel");
assert.equal(extractStreamDelta({ choices: [{ message: { content: "done" } }] }), "done");
assert.equal(extractStreamDelta({ choices: [{ text: "legacy" }] }), "legacy");
assert.equal(extractStreamDelta({ choices: [] }), "");
assert.equal(extractStreamDelta(null), "");

console.log("ai advisor purity tests passed");
