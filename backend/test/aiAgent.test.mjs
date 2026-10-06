// Agent loop tests: no network, no database. globalThis.fetch is stubbed with a
// scripted OpenAI-compatible model, so every assertion is about the loop's
// honesty limits — bounded steps, a forced tool-less final answer, and a failed
// tool staying a failed tool instead of becoming a number.
import assert from "node:assert/strict";
import { runAgent, buildAgentSystemPrompt } from "../dist/aiAgent.js";
import { executeAgentTool, parseToolArguments, AGENT_TOOL_NAMES, TOOL_RESULT_CHAR_CAP, isWriteTool, describeAgentWrite } from "../dist/aiTools.js";
import { abandonRun, pendingCount, settle, waitForApproval } from "../dist/agentApprovals.js";

const ORIGINAL_FETCH = globalThis.fetch;

function json(modelMessage) {
  return new Response(JSON.stringify({ choices: [{ message: modelMessage }] }), { status: 200, headers: { "content-type": "application/json" } });
}

function sse(text) {
  const frames = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` + "data: [DONE]\n\n";
  return new Response(frames, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Records every upstream request and answers per the supplied script. */
function stubModel(onCall) {
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    // A real fetch refuses an already-aborted signal; the stub must too, or an
    // abort test would silently "succeed".
    if (init?.signal?.aborted) {
      const error = new Error("This operation was aborted");
      error.name = "AbortError";
      throw error;
    }
    const body = JSON.parse(init.body);
    calls.push(body);
    return onCall(calls.length, body);
  };
  return calls;
}

const toolEnv = { pool: null, mlFetch: async () => ({ status: 200, body: { ok: true } }) };

async function collect(request) {
  const events = [];
  const result = await runAgent({ ...request, onEvent: (event) => events.push(event) });
  return { result, events };
}

async function testLoopUsesRealToolsThenAnswersWithoutThem() {
  const calls = stubModel((count, body) => {
    if (body.stream === true) return sse("Measured from your own store.");
    if (count > 1) return json({ content: "Measured from your own store.", tool_calls: [] });
    return json({
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "price_history", arguments: JSON.stringify({ symbol: "reliance", days: 4000 }) } }],
    });
  });
  const { result, events } = await collect({
    apiKey: "nvapi-test", baseUrl: "https://example.invalid/v1", model: "test-model",
    question: "How has RELIANCE actually moved?", env: toolEnv,
  });

  assert.equal(calls.length, 2, "one tool step, then the model answers instead of investigating further");
  const offered = calls[0].tools.map((tool) => tool.function.name);
  assert.deepEqual(offered.sort(), [...AGENT_TOOL_NAMES].sort(), "the model is offered exactly the local tools");
  assert.equal(calls[0].tool_choice, "required", "the first agent turn must use a real D-Predict tool");
  assert.equal(calls[0].stream, false, "investigation steps are answered as JSON so tool calls can be parsed");

  const toolMessage = calls[1].messages.find((message) => message.role === "tool");
  assert.ok(toolMessage, "the assistant tool_call is answered with a tool result");
  const outcome = JSON.parse(toolMessage.content);
  assert.equal(outcome.ok, false, "no database means no data — the tool must not pretend");
  assert.match(outcome.summary, /DATABASE_UNAVAILABLE/);
  assert.ok(!/"lastClose"/.test(toolMessage.content), "a failed tool returns no numbers at all");

  assert.equal(result.ok, true);
  assert.equal(result.text, "Measured from your own store.");
  assert.equal(result.toolCalls, 1);
  assert.equal(result.trace.length, 1);
  assert.equal(result.trace[0].tool, "price_history");
  assert.deepEqual(result.trace[0].arguments, { symbol: "reliance", days: 4000 }, "the trace shows exactly what the model asked for");
  assert.equal(events.filter((event) => event.event === "tool").length, 1);
  assert.equal(events[0].event, "meta");
  assert.equal(events.at(-1).event, "done");
}

async function testModelAnsweringWithoutToolsFailsClosed() {
  const calls = stubModel(() => json({ content: "The ledger has no scored rows in that window.", tool_calls: [] }));
  const { result, events } = await collect({
    apiKey: "nvapi-test", baseUrl: "https://example.invalid/v1", model: "test-model",
    question: "Is the model working?", env: toolEnv,
  });
  assert.equal(calls.length, 1, "the first turn is still a tool-required investigation turn");
  assert.equal(calls[0].tool_choice, "required");
  assert.equal(result.ok, false);
  assert.equal(result.error, "AGENT_TOOL_REQUIRED");
  assert.equal(result.text, "");
  assert.equal(result.toolCalls, 0);
  assert.deepEqual(events.map((event) => event.event), ["meta", "aierror"]);
}

async function testStepsAndToolCallsAreCapped() {
  const calls = stubModel((count, body) => {
    if (body.stream === true) return sse("Stopping at the ceiling.");
    return json({
      content: null,
      tool_calls: Array.from({ length: 4 }, (_, index) => ({
        id: `call_${count}_${index}`,
        function: { name: "recent_alerts", arguments: JSON.stringify({ limit: 5 }) },
      })),
    });
  });
  const { result } = await collect({
    apiKey: "nvapi-test", baseUrl: "https://example.invalid/v1", model: "test-model",
    question: "Keep going forever.", env: toolEnv, maxSteps: 8,
  });
  assert.equal(result.toolCalls, 14, "the tool-call budget is the hard stop, not the step count");
  assert.equal(result.trace.length, 14);
  assert.equal(result.steps, 8, "7 investigating steps plus the forced answer");
  assert.equal(calls.length, 8);
  assert.ok(!("tools" in calls.at(-1)));
  const withheld = JSON.stringify(calls.at(-1).messages);
  assert.match(withheld, /TOOL_BUDGET_EXCEEDED/, "calls past the budget are reported as unmeasured, never guessed");
}

async function testUnknownToolFailsWithoutFabricating() {
  const calls = stubModel((count, body) => {
    if (body.stream === true) return sse("That request could not be measured.");
    if (count === 1) {
      return json({ content: null, tool_calls: [{ id: "x", function: { name: "get_live_nse_prices", arguments: "{}" } }] });
    }
    return json({ content: null, tool_calls: [] });
  });
  const { result } = await collect({
    apiKey: "nvapi-test", baseUrl: "https://example.invalid/v1", model: "test-model",
    question: "Fetch today's live prices.", env: toolEnv,
  });
  assert.equal(result.trace.length, 1);
  assert.equal(result.trace[0].ok, false);
  assert.match(result.trace[0].summary, /UNKNOWN_TOOL/);
  const toolMessage = calls[1].messages.find((message) => message.role === "tool");
  assert.match(toolMessage.content, /Do not guess a result for it/);
  assert.equal(calls.length, 2, "an unknown tool does not abort the run; the model still gets to answer");
}

async function testProviderFailureSurfacesAsErrorNotInventedAnswer() {
  stubModel(() => new Response(JSON.stringify({ detail: "cuda error" }), { status: 500, headers: { "content-type": "application/json" } }));
  const { result, events } = await collect({
    apiKey: "nvapi-test", baseUrl: "https://example.invalid/v1", model: "test-model",
    question: "Anything.", env: toolEnv,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "AI_UPSTREAM_ERROR");
  assert.equal(result.text, "");
  assert.equal(events.at(-1).event, "aierror");
  assert.match(events.at(-1).data.message, /cuda error/);
}

async function testFinalAnswerIsStreamedAndEmptyStreamIsNotInvented() {
  const frames = [
    "The ledger has",
    " 0 scored rows",
    " so accuracy is unmeasurable",
  ];
  const finalRequests = [];
  function sseFrames(parts) {
    const body = parts.map((part) => `data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }
  // The model never stops investigating, so the only way to an answer is the
  // forced, tool-less final call.
  const calls = stubModel((count, body) => {
    if (body.stream === true) {
      finalRequests.push(body);
      return sseFrames(frames);
    }
    return json({ content: null, tool_calls: [{ id: `p${count}`, function: { name: "prediction_performance", arguments: JSON.stringify({ days: 30 }) } }] });
  });
  const runEvents = [];
  const result = await runAgent({
    apiKey: "nvapi-test", baseUrl: "https://example.invalid/v1", model: "test-model",
    question: "Score the ledger over the last month.", env: toolEnv, maxSteps: 2,
    onEvent: (event) => runEvents.push(event),
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, "The ledger has 0 scored rows so accuracy is unmeasurable");
  const deltas = runEvents.filter((event) => event.event === "answer").map((event) => event.data.delta);
  assert.deepEqual(deltas, frames, "the answer reaches the UI as it is generated, in order");
  assert.equal(calls.length, 2);
  const finalRequest = finalRequests.at(0);
  assert.ok(!("tools" in finalRequest), "the last upstream call offers no tools at all");
  assert.match(JSON.stringify(finalRequest.messages.filter((message) => message.role === "tool")), /DATABASE_UNAVAILABLE/);
  assert.match(finalRequest.messages.at(-1).content, /Answer now from the tool results above only/);

  stubModel((_count, body) => (body.stream === true ? sseFrames([]) : json({ content: null, tool_calls: [{ id: "z", function: { name: "market_scan", arguments: "{}" } }] })));
  const empty = await collect({
    apiKey: "nvapi-test", baseUrl: "https://example.invalid/v1", model: "test-model",
    question: "Anything.", env: toolEnv, maxSteps: 2,
  });
  assert.equal(empty.result.ok, false);
  assert.equal(empty.result.error, "AGENT_EMPTY_RESPONSE");
  assert.equal(empty.result.text, "", "no streamed text means no answer, never a placeholder one");
}

async function testStoppedInvestigationReportsAbort() {
  stubModel(() => json({ content: null, tool_calls: [] }));
  const controller = new AbortController();
  controller.abort();
  const { result } = await collect({
    apiKey: "nvapi-test", baseUrl: "https://example.invalid/v1", model: "test-model",
    question: "Anything.", env: toolEnv, signal: controller.signal,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "AGENT_ABORTED");
}

async function testToolArgumentValidation() {
  assert.equal((await executeAgentTool(toolEnv, "price_history", { symbol: "NIFTY" })).data.error, "DATABASE_UNAVAILABLE");
  assert.match((await executeAgentTool(toolEnv, "price_history", { symbol: "nifty; drop table" })).summary, /INVALID_SYMBOL/);
  assert.match((await executeAgentTool(toolEnv, "price_history", {})).summary, /INVALID_SYMBOL/);
  assert.match((await executeAgentTool(toolEnv, "run_backtest", { symbol: "NIFTY", strategy: "macross" })).summary, /INVALID_STRATEGY/);
  assert.match((await executeAgentTool(toolEnv, "compare_forecast", { symbol: "NIFTY", horizon: "9d" })).summary, /DATABASE_UNAVAILABLE/);
  assert.match((await executeAgentTool(toolEnv, "nope", {})).summary, /UNKNOWN_TOOL/);
  assert.match((await executeAgentTool(toolEnv, "market_scan", {})).summary, /DATABASE_UNAVAILABLE/);
}

async function testMlServiceFailureIsNotRewrittenAsZero() {
  const env = { pool: null, mlFetch: async () => ({ status: 503, body: { detail: "no trained artifact for TATASTEEL" } }) };
  const outcome = await executeAgentTool(env, "fresh_forecast", { symbol: "TATASTEEL", horizon: "1d" });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.data.error, "MODEL_NOT_READY");
  assert.match(outcome.data.message, /no trained artifact/);
  assert.ok(!JSON.stringify(outcome.data).includes("expectedReturn"), "a refused forecast must not carry a return number");
}

async function testCoverageStaysSmallAndDeclared() {
  const bigEnv = { pool: null, mlFetch: async () => ({ status: 200, body: { instruments: Array.from({ length: 400 }, (_, index) => ({ symbol: `SYM${index}`, ready: true })) } }) };
  const big = await executeAgentTool(bigEnv, "model_coverage", {});
  assert.equal(big.data.truncated, true, "an oversized payload must announce that part of it was withheld");
  assert.equal(big.data.excerpt.length, TOOL_RESULT_CHAR_CAP);
  assert.ok(big.data.originalChars > TOOL_RESULT_CHAR_CAP);
  assert.match(big.data.note, /was not sent/);

  const smallEnv = { pool: null, mlFetch: async () => ({ status: 200, body: { instruments: [{ symbol: "NIFTY", ready: false }] } }) };
  const small = await executeAgentTool(smallEnv, "model_coverage", {});
  assert.equal(small.data.truncated, undefined, "a payload that fits is passed through untouched");
  assert.equal(small.data.instruments.length, 1);
}

async function testArgumentParsingIsInert() {
  assert.deepEqual(parseToolArguments('{"symbol":"nifty"}'), { symbol: "nifty" });
  assert.deepEqual(parseToolArguments("{oops"), {});
  assert.deepEqual(parseToolArguments("[1,2]"), {});
  assert.deepEqual(parseToolArguments(undefined), {});
  assert.deepEqual(parseToolArguments({ symbol: "NIFTY" }), { symbol: "NIFTY" });
}

async function testPromptNamesOnlyRealToolsAndKeepsHonestyRules() {
  const prompt = buildAgentSystemPrompt([{ label: "Attached ledger row", data: { accuracy: null } }], "post-close session");
  for (const name of AGENT_TOOL_NAMES) assert.ok(prompt.includes(name), `${name} must be listed for the model`);
  assert.match(prompt, /Facts come from two places only/);
  assert.match(prompt, /ABSTAIN/);
  assert.match(prompt, /act inside this app in three ways/);
  assert.match(prompt, /the user sees the exact change and clicks Apply or Refuse/);
  assert.match(prompt, /You cannot place orders/);
  assert.match(prompt, /never override or reinterpret/);
  assert.match(prompt, /Attached ledger row/);
  assert.ok(!prompt.includes("undefined"));
  const noEvidence = buildAgentSystemPrompt([]);
  assert.match(noEvidence, /EVIDENCE: none supplied/);
}

const WRITE_TOOLS = ["train_model", "watchlist_add", "watchlist_remove", "acknowledge_alerts", "option_paper_order"];

/** A database stand-in that records every statement, so "nothing was written" is
 * an observation rather than a claim. */
function recordingDb() {
  const statements = [];
  return {
    statements,
    async query(sql) {
      statements.push(String(sql).replace(/\s+/g, " ").trim().slice(0, 160));
      return { rows: [{ symbol: "RELIANCE", position: 7, note: null, id: 3, count: 2 }], rowCount: 1 };
    },
  };
}

function modelWantsWatchlistAdd() {
  return stubModel((count, body) => {
    if (body.stream === true) return sse("Recorded.");
    if (count > 1) return json({ content: "Recorded.", tool_calls: [] });
    return json({ content: null, tool_calls: [{ id: "write_1", type: "function", function: { name: "watchlist_add", arguments: JSON.stringify({ symbol: "RELIANCE" }) } }] });
  });
}

async function testRefusedWriteTouchesNothing() {
  const db = recordingDb();
  modelWantsWatchlistAdd();
  const seen = [];
  const { result, events } = await collect({
    apiKey: "nvapi-test", baseUrl: "https://example.invalid/v1", model: "test-model",
    question: "Track RELIANCE for me.", env: { pool: db, mlFetch: async () => ({ status: 200, body: {} }) },
    runId: "run-refuse",
    requestApproval: async (pending) => { seen.push(pending); return { approved: false, source: "user" }; },
  });

  assert.equal(seen.length, 1, "the loop asked before executing");
  assert.match(seen[0].description, /RELIANCE/, "the card names the exact change");
  assert.equal(seen[0].tool, "watchlist_add");
  const approvalEvent = events.find((event) => event.event === "approval");
  assert.equal(approvalEvent.data.runId, "run-refuse", "the event carries the run id the click must be sent back to");
  assert.deepEqual(db.statements, [], "a refused write must not run a single statement");
  assert.equal(result.trace[0].write, true);
  assert.equal(result.trace[0].approval, "REFUSED");
  assert.match(result.trace[0].summary, /REFUSED — the user did not approve/);
  assert.match(result.trace[0].summary, /nothing in the app was altered/);
}

async function testApprovedWriteRunsTheSameTool() {
  const db = recordingDb();
  const calls = modelWantsWatchlistAdd();
  const { result } = await collect({
    apiKey: "nvapi-test", baseUrl: "https://example.invalid/v1", model: "test-model",
    question: "Track RELIANCE for me.", env: { pool: db, mlFetch: async () => ({ status: 200, body: {} }) },
    runId: "run-approve",
    requestApproval: async () => ({ approved: true, source: "user" }),
  });

  assert.equal(result.trace[0].approval, "APPROVED");
  assert.equal(result.trace[0].ok, true, "the stub database accepted the statement");
  assert.ok(db.statements.length >= 2, `the approved write ran: ${JSON.stringify(db.statements)}`);
  assert.ok(db.statements.some((statement) => statement.includes("insert into instruments")), "it activated the instrument the same way the dashboard does");
  assert.ok(db.statements.some((statement) => statement.includes("watchlist_items")), "it wrote the watchlist row itself, not some side table");
  const toolMessage = calls[1].messages.find((message) => message.role === "tool");
  assert.equal(JSON.parse(toolMessage.content).ok, true);
}

async function testWriteWithoutAnApprovalGateIsRefusedByDefault() {
  const db = recordingDb();
  modelWantsWatchlistAdd();
  const { result } = await collect({
    apiKey: "nvapi-test", baseUrl: "https://example.invalid/v1", model: "test-model",
    question: "Track RELIANCE.", env: { pool: db, mlFetch: async () => ({ status: 200, body: {} }) },
    runId: "run-nogate",
  });
  assert.equal(result.trace[0].approval, "NO_GATE", "a run with no UI attached must not write");
  assert.deepEqual(db.statements, []);
}

async function testExpiredApprovalDoesNotRun() {
  const db = recordingDb();
  modelWantsWatchlistAdd();
  const { result } = await collect({
    apiKey: "nvapi-test", baseUrl: "https://example.invalid/v1", model: "test-model",
    question: "Track RELIANCE.", env: { pool: db, mlFetch: async () => ({ status: 200, body: {} }) },
    runId: "run-late",
    requestApproval: async () => ({ approved: false, source: "timeout" }),
  });
  assert.equal(result.trace[0].approval, "TIMED_OUT");
  assert.deepEqual(db.statements, [], "a decision that never arrived counts as a refusal");
}

async function testApprovalRegistryOnlyMarksRealWrites() {
  assert.deepEqual(AGENT_TOOL_NAMES.filter(isWriteTool).sort(), [...WRITE_TOOLS].sort());
  assert.equal(isWriteTool("price_history"), false);
  assert.equal(describeAgentWrite("run_backtest", { symbol: "NIFTY" }), null, "a read tool has nothing to approve");
  assert.match(describeAgentWrite("train_model", { symbol: "nifty", horizon: "3d" }), /Retrain the 3d model artifact for NIFTY/);
  assert.match(describeAgentWrite("acknowledge_alerts", { ids: [4, 4, 5] }), /Mark 2 radar row\(s\) as acknowledged: 4, 5/);
  assert.match(describeAgentWrite("watchlist_remove", { symbol: "TATASTEEL" }), /not deleted/i);\n  assert.match(describeAgentWrite("option_paper_order", { symbol: "NIFTY", expiry: "2026-10-08", strike: 25000, optionType: "CE", side: "BUY", lots: 1 }), /PAPER BUY.*NIFTY.*CE.*25000/i);\n  assert.equal(isWriteTool("option_chain"), false);

  const empty = await executeAgentTool({ pool: null, mlFetch: async () => ({ status: 200, body: {} }) }, "acknowledge_alerts", { ids: ["x"] });
  assert.equal(empty.ok, false);
  assert.match(empty.summary, /INVALID_ALERT_IDS/, "no wildcard acknowledgement exists");
  assert.match(empty.summary, /recent_alerts/);
}

async function testApprovalGateSettlesExactlyOnce() {
  assert.equal(settle("gate-run", "c1", { approved: true, source: "user" }), false, "nothing is parked yet");
  const waiter = waitForApproval("gate-run", "c1", 5000);
  assert.equal(pendingCount(), 1);
  assert.equal(settle("gate-run", "c1", { approved: true, source: "user" }), true);
  assert.equal(settle("gate-run", "c1", { approved: false, source: "user" }), false, "a settled call cannot be answered twice");
  assert.deepEqual(await waiter, { approved: true, source: "user" });

  const abandoned = waitForApproval("gate-run", "c2", 5000);
  assert.ok(abandonRun("gate-run") >= 1, "a dead run must not leave a write parked");
  assert.deepEqual(await abandoned, { approved: false, source: "abandoned" });

  const lapsed = await waitForApproval("gate-run", "c3", 5);
  assert.deepEqual(lapsed, { approved: false, source: "timeout" });
  assert.equal(pendingCount(), 0);
}

const tests = [
  testLoopUsesRealToolsThenAnswersWithoutThem,
  testModelAnsweringWithoutToolsFailsClosed,
  testStepsAndToolCallsAreCapped,
  testUnknownToolFailsWithoutFabricating,
  testProviderFailureSurfacesAsErrorNotInventedAnswer,
  testFinalAnswerIsStreamedAndEmptyStreamIsNotInvented,
  testStoppedInvestigationReportsAbort,
  testToolArgumentValidation,
  testMlServiceFailureIsNotRewrittenAsZero,
  testCoverageStaysSmallAndDeclared,
  testArgumentParsingIsInert,
  testPromptNamesOnlyRealToolsAndKeepsHonestyRules,
  testRefusedWriteTouchesNothing,
  testApprovedWriteRunsTheSameTool,
  testWriteWithoutAnApprovalGateIsRefusedByDefault,
  testExpiredApprovalDoesNotRun,
  testApprovalRegistryOnlyMarksRealWrites,
  testApprovalGateSettlesExactlyOnce,
];

try {
  for (const test of tests) {
    await test();
  }
} finally {
  globalThis.fetch = ORIGINAL_FETCH;
}

console.log(`aiAgent.test.mjs: all ${tests.length} assertions groups passed`);
