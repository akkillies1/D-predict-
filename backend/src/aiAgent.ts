// The agent loop: give the model a question, let it call real local tools, and
// force it to answer from what those tools measured. Three hard properties:
//   1. every upstream call is bounded — steps, tool calls and context chars —
//      so a rambling model cannot spend the user's credits without a ceiling;
//   2. the last call has no tools at all, so the answer can only be a summary
//      of the tool results already gathered and shown to the user;
//   3. a tool that changes app state parks on the user's approval click, and a
//      decision that never arrives counts as a refusal.
import {
  buildEvidenceBlock,
  describeUpstreamError,
  extractStreamDelta,
  type AiEvidence,
} from "./aiAdvisor.js";
import { AGENT_TOOL_NAMES, agentToolSpecs, describeAgentWrite, executeAgentTool, parseToolArguments, type ToolEnv, type ToolOutcome } from "./aiTools.js";
import { APPROVAL_TIMEOUT_MS, type ApprovalDecision, type ApprovalSource } from "./agentApprovals.js";

const DEFAULT_MAX_STEPS = 6;
const MAX_STEPS_CEILING = 8;
const MAX_TOOL_CALLS = 14;
const MAX_TOOL_CALLS_PER_STEP = 4;
/** Total characters of tool JSON replayed into the model's context. */
const MAX_TOOL_CONTEXT_CHARS = 45_000;
const STEP_TIMEOUT_MS = Math.max(20_000, Number(process.env.AGENT_STEP_TIMEOUT_MS ?? 60_000));
const FINAL_TIMEOUT_MS = Math.max(30_000, Number(process.env.AGENT_FINAL_TIMEOUT_MS ?? 120_000));

export type AgentToolCall = { id: string; name: string; arguments: Record<string, unknown> };

/** How a state-changing tool call was cleared — or why it never ran. */
export type AgentApprovalState = "APPROVED" | "REFUSED" | "TIMED_OUT" | "NO_GATE" | null;

export type AgentTraceEntry = {
  callId: string;
  step: number;
  tool: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  summary: string;
  durationMs: number;
  truncated: boolean;
  /** True for a tool that changes app state. */
  write: boolean;
  /** How a write was cleared to run — null when the tool only reads. */
  approval: AgentApprovalState;
};

export type AgentToolEvent = AgentTraceEntry & { result: unknown };

export type AgentApprovalEvent = {
  runId: string;
  callId: string;
  step: number;
  tool: string;
  arguments: Record<string, unknown>;
  description: string;
  timeoutMs: number;
};

export type AgentEvent =
  | { event: "meta"; data: { ok: true; model: string; maxSteps: number; runId: string } }
  | { event: "tool"; data: AgentToolEvent }
  | { event: "approval"; data: AgentApprovalEvent }
  | { event: "answer"; data: { delta: string } }
  | { event: "done"; data: { ok: true; model: string; steps: number; toolCalls: number; answerChars: number; trace: AgentTraceEntry[] } }
  | { event: "aierror"; data: { ok: false; error: string; message: string; trace: AgentTraceEntry[] } };

export type AgentRequest = {
  apiKey: string;
  baseUrl: string;
  model: string;
  question: string;
  marketContext?: string | null;
  evidence?: AiEvidence[];
  env: ToolEnv;
  maxSteps?: number;
  /** Identifies this run to the approval route. */
  runId: string;
  /** Resolves when the user has decided on a proposed write. No gate means no writes. */
  requestApproval?: (pending: { callId: string; step: number; tool: string; arguments: Record<string, unknown>; description: string }) => Promise<ApprovalDecision>;
  approvalTimeoutMs?: number;
  onEvent: (event: AgentEvent) => void;
  signal?: AbortSignal;
};

export type AgentRunResult = { ok: boolean; text: string; error?: string; message?: string; steps: number; toolCalls: number; trace: AgentTraceEntry[] };

type ChatMessage = Record<string, unknown> & { role: string; content: string | null };

export function buildAgentSystemPrompt(evidence: AiEvidence[], marketContext?: string | null): string {
  const block = buildEvidenceBlock(evidence);
  const context = String(marketContext ?? "").trim();
  return [
    "You are the D-Predict investigation agent, running inside a local-first decision terminal for Indian equities and NIFTY/BANKNIFTY derivatives. All prices are ₹; timestamps are the ones the tools return. The user is a retail trader on their own machine.",
    "",
    "You have tools that read the user's own persisted market data and their own trained models. Available tools: " + AGENT_TOOL_NAMES.join(", ") + ".",
    "",
    "HARD RULES — these override everything else:",
    "1. Facts come from two places only: the tools you call, and the EVIDENCE block attached to this request. Before stating any price, return, probability, accuracy, drawdown, trade count, date or symbol, have it measured by one of those. Never recall market data, never estimate, never give an example number.",
    "2. If a tool fails or says there is no data, report that exact gap in your answer. Do not fill it from anywhere else. Saying 'the ledger has no scored rows yet' is a correct answer.",
    "3. Respect the status fields the tools return. prediction_status ABSTAIN, calibration_status UNCALIBRATED or CALIBRATION_UNVERIFIED, and a failing promotion_checks entry all mean that number is not a validated forecast — say so plainly. Every ML artifact in this project currently fails the out-of-sample promotion gate. If fresh_forecast fails because the horizon model is unavailable, use prediction_health to identify the exact coverage/history/inference failure, then use statistical_baseline when enough real daily history exists.",
    "4. You may run backtests and re-ask the model. You may also use statistical_baseline or option_intelligence to produce a clearly labeled research/paper candidate from deterministic calculations. Never call that result an ML forecast, and never invent a probability, target, price or expected return outside a tool result.",
    "5. You can act inside this app through gated tools: retrain ONE symbol/horizon artifact, change the watchlist, acknowledge specific alerts, and place a quote-backed OPTION PAPER ORDER. Every write is gated: the user sees the exact change and clicks Apply or Refuse. Before any of them runs, the user sees the exact change and clicks Apply or Refuse. Report an action as done only when its tool returned ok, and quote what the tool measured about the result — for train_model that is the promotion gate's own verdict, which you never override or reinterpret. If a call comes back REFUSED or TIMED_OUT, say the user did not approve it and move on.",
    "5b. Measure before you propose: for options, use option_chain and option_intelligence (and option_candidate/payoff when useful) before option_paper_order. The option order is paper-only, quote-backed, and never reaches a broker. You cannot move money, edit radar rule definitions or assistant settings, or reach anything outside D-Predict.",
    "6. You may present a D-Predict research/paper-trade suggestion when a tool explicitly returns one. Clearly label its provenance (ML CONFIRMED, ML UNAVAILABLE / STATISTICAL BASELINE, or OPTION INTELLIGENCE), include the measured invalidation/risk fields, and never send a live broker order.",
    "7. Never reveal, restate or discuss API keys or provider configuration.",
    "",
    "Method: plan the two or three tool calls that actually answer the question, call them, then answer. Quote the tool's number with the tool name next to it so the user can trace it. Prefer compare_forecast when the question is whether a stored signal is stale, and prediction_performance when the question is whether the model works at all.",
    "",
    "Style: plain English, at most ~260 words, short paragraphs, no markdown headings, no emoji, no bullet spam. End with the one or two measurements that would change your read.",
    context ? `Session context: ${context}` : "",
    "",
    block,
  ].filter((line) => line !== "").join("\n");
}

function headers(apiKey: string) {
  return { "content-type": "application/json", authorization: `Bearer ${apiKey}`, accept: "application/json" };
}

async function postJson(url: string, apiKey: string, payload: unknown, timeoutMs: number, signal?: AbortSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortParent = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abortParent);
  try {
    const response = await fetch(`${url}/chat/completions`, { method: "POST", headers: headers(apiKey), body: JSON.stringify(payload), signal: controller.signal });
    return { response };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortParent);
  }
}

/** Consumes an OpenAI-compatible SSE body and forwards each text delta. */
async function streamCompletion(url: string, apiKey: string, payload: Record<string, unknown>, timeoutMs: number, onDelta: (text: string) => void, signal?: AbortSignal) {
  const { response } = await postJson(url, apiKey, { ...payload, stream: true }, timeoutMs, signal);
  if (!response.ok || !response.body) {
    const { code, message } = describeUpstreamError(response.status, await response.text().catch(() => ""));
    throw new AgentUpstreamError(code, message);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const delta = extractStreamDelta(JSON.parse(data));
          if (delta) {
            text += delta;
            onDelta(delta);
          }
        } catch {
          // A partial or non-JSON line is not an error: the next chunk completes it.
        }
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  return text;
}

class AgentUpstreamError extends Error {
  constructor(public code: string, public userMessage: string) {
    super(code);
  }
}

function toolOutcomeMessage(outcome: ToolOutcome, budgetLeft: number): { content: string; truncated: boolean } {
  const payload = { ok: outcome.ok, summary: outcome.summary, data: outcome.data };
  const serialized = JSON.stringify(payload);
  if (serialized.length <= budgetLeft) return { content: serialized, truncated: false };
  const stub = JSON.stringify({
    ok: outcome.ok,
    summary: outcome.summary,
    data: { omitted: true, reason: `this result was ${serialized.length} characters and the agent's remaining context budget was ${Math.max(0, budgetLeft)}; the full data was not sent to the model`, charsWithheld: serialized.length },
  });
  return { content: stub, truncated: true };
}

export async function runAgent(request: AgentRequest): Promise<AgentRunResult> {
  const question = String(request.question ?? "").trim();
  // Agent mode must actually investigate before it is allowed to answer. A single-step\n  // run is therefore promoted to one tool turn plus the final synthesis turn.\n  const maxSteps = Math.max(2, Math.min(MAX_STEPS_CEILING, Math.round(Number(request.maxSteps ?? DEFAULT_MAX_STEPS))));
  const evidence = Array.isArray(request.evidence) ? request.evidence : [];
  const url = request.baseUrl.replace(/\/$/, "");
  const trace: AgentTraceEntry[] = [];
  const messages: ChatMessage[] = [
    { role: "system", content: buildAgentSystemPrompt(evidence, request.marketContext) },
    { role: "user", content: question },
  ];
  let contextChars = 0;
  let toolCalls = 0;
  let step = 0;

  const fail = (error: string, message: string): AgentRunResult => {
    request.onEvent({ event: "aierror", data: { ok: false, error, message, trace } });
    return { ok: false, text: "", error, message, steps: step, toolCalls, trace };
  };

  if (!question) return fail("AGENT_QUESTION_REQUIRED", "Ask something the tools can measure.");

  request.onEvent({ event: "meta", data: { ok: true, model: request.model, maxSteps, runId: request.runId } });

  while (step < maxSteps - 1) {
    step += 1;
    let response: Response;
    try {
      const posted = await postJson(url, request.apiKey, {
        model: request.model,
        messages,
        tools: agentToolSpecs(),
        // The first turn is an investigation turn, not a chat turn. Force a real\n        // D-Predict tool call so Nemotron has to drive the machinery before deciding.\n        // Later turns remain autonomous: the model can choose another tool or finish.\n        tool_choice: step === 1 ? "required" : "auto",
        temperature: 0.1,
        top_p: 0.95,
        max_tokens: Math.min(1200, Math.max(128, Number(process.env.AGENT_STEP_MAX_TOKENS ?? 700))),
        stream: false,
      }, STEP_TIMEOUT_MS, request.signal);
      response = posted.response;
    } catch (error) {
      const aborted = request.signal?.aborted || (error instanceof Error && error.name === "AbortError");
      return fail(aborted ? "AGENT_ABORTED" : "AGENT_UNREACHABLE", aborted ? "Investigation stopped." : "Could not reach the provider for this investigation step.");
    }
    if (!response.ok) {
      const { code, message } = describeUpstreamError(response.status, await response.text().catch(() => ""));
      return fail(code, message);
    }
    const completed = (await response.json().catch(() => null)) as { choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown } }> } | null;
    const message = completed?.choices?.[0]?.message;
    const rawCalls = Array.isArray(message?.tool_calls) ? (message!.tool_calls as Array<Record<string, unknown>>) : [];
    const content = typeof message?.content === "string" ? message.content.trim() : "";

    if (!rawCalls.length) {
      if (step === 1) return fail("AGENT_TOOL_REQUIRED", "The investigation agent must call a D-Predict tool before answering.");
      // The model chose to answer instead of investigating further. That answer
      // is still only trustworthy if it came from tool results already shown.
      if (!content) return fail("AGENT_EMPTY_RESPONSE", "The model returned neither a tool request nor an answer.");
      request.onEvent({ event: "answer", data: { delta: content } });
      request.onEvent({ event: "done", data: { ok: true, model: request.model, steps: step, toolCalls, answerChars: content.length, trace } });
      return { ok: true, text: content, steps: step, toolCalls, trace };
    }

    const calls: AgentToolCall[] = [];
    for (const entry of rawCalls.slice(0, MAX_TOOL_CALLS_PER_STEP)) {
      const fn = (entry.function ?? {}) as Record<string, unknown>;
      const id = String(entry.id ?? `call_${calls.length}_${step}`);
      const name = String(fn.name ?? "");
      if (!AGENT_TOOL_NAMES.includes(name)) {
        calls.push({ id, name: name.slice(0, 64) || "unnamed", arguments: {} });
        continue;
      }
      calls.push({ id, name, arguments: parseToolArguments(fn.arguments) });
    }
    messages.push({ role: "assistant", content: content || null, tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) });

    for (const call of calls) {
      if (toolCalls >= MAX_TOOL_CALLS) {
        const withheld = JSON.stringify({ ok: false, summary: "The agent reached its tool-call budget for this question; nothing was measured for this request.", data: { error: "TOOL_BUDGET_EXCEEDED" } });
        messages.push({ role: "tool", tool_call_id: call.id, content: withheld });
        continue;
      }
      toolCalls += 1;
      const startedAt = Date.now();
      // A write tool parks on the user's decision; nothing in the app changes
      // until they approve this exact change, and a missing decision is a refusal.
      const proposed = describeAgentWrite(call.name, call.arguments);
      let approval: AgentApprovalState = null;
      let outcome: ToolOutcome;
      if (proposed === null) {
        outcome = await executeAgentTool(request.env, call.name, call.arguments);
      } else {
        request.onEvent({
          event: "approval",
          data: {
            runId: request.runId,
            callId: call.id,
            step,
            tool: call.name,
            arguments: call.arguments,
            description: proposed,
            timeoutMs: request.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS,
          },
        });
        const decision = request.requestApproval
          ? await request.requestApproval({ callId: call.id, step, tool: call.name, arguments: call.arguments, description: proposed })
          : { approved: false, source: "unavailable" as ApprovalSource };
        approval = decision.approved ? "APPROVED" : decision.source === "timeout" ? "TIMED_OUT" : decision.source === "unavailable" ? "NO_GATE" : "REFUSED";
        outcome = decision.approved
          ? await executeAgentTool(request.env, call.name, call.arguments)
          : {
              ok: false,
              summary: `USER_${approval === "TIMED_OUT" ? "APPROVAL_TIMEOUT" : approval === "NO_GATE" ? "GATE_UNAVAILABLE" : "REFUSED"} — the user did not approve this change, so ${call.name} was not run and nothing in the app was altered.`,
              data: {
                error: approval === "TIMED_OUT" ? "APPROVAL_TIMED_OUT" : approval === "NO_GATE" ? "APPROVAL_UNAVAILABLE" : "REFUSED_BY_USER",
                executed: false,
                tool: call.name,
                reason: approval === "TIMED_OUT" ? "No decision arrived before the request lapsed." : approval === "NO_GATE" ? "This run has no approval UI attached to it." : "The user refused.",
              },
            };
      }
      const durationMs = Date.now() - startedAt;
      const { content: toolContent, truncated } = toolOutcomeMessage(outcome, MAX_TOOL_CONTEXT_CHARS - contextChars);
      if (!truncated) contextChars += toolContent.length;
      messages.push({ role: "tool", tool_call_id: call.id, content: toolContent });
      const entry: AgentTraceEntry = {
        callId: call.id,
        step,
        tool: call.name,
        arguments: call.arguments,
        ok: outcome.ok,
        summary: outcome.summary.slice(0, 600),
        durationMs,
        truncated,
        write: proposed !== null,
        approval,
      };
      trace.push(entry);
      // The UI gets the raw tool payload alongside the entry so the user can
      // audit the exact numbers behind the answer; the returned trace stays small.
      request.onEvent({ event: "tool", data: { ...entry, result: outcome.data } });
    }
  }

  // Final call: no tools offered, so the model can only synthesize what the
  // trace above already showed it (and the user).
  messages.push({ role: "user", content: "Answer now from the tool results above only. Do not request more data. Cite each number with the tool it came from, and name any tool that failed or returned no data." });
  let answer = "";
  try {
    answer = await streamCompletion(
      url,
      request.apiKey,
      { model: request.model, messages, temperature: 0.2, top_p: 0.95, max_tokens: Math.min(1600, Math.max(128, Number(process.env.AGENT_ANSWER_MAX_TOKENS ?? 800))) },
      FINAL_TIMEOUT_MS,
      (delta) => request.onEvent({ event: "answer", data: { delta } }),
      request.signal,
    );
  } catch (error) {
    if (error instanceof AgentUpstreamError) return fail(error.code, error.userMessage);
    const aborted = request.signal?.aborted || (error instanceof Error && error.name === "AbortError");
    return fail(aborted ? "AGENT_ABORTED" : "AGENT_STREAM_INTERRUPTED", aborted ? "Investigation stopped." : error instanceof Error ? error.message : "The answer stream failed.");
  }
  if (!answer.trim()) {
    if (request.signal?.aborted) return fail("AGENT_ABORTED", "Investigation stopped.");
    return fail("AGENT_EMPTY_RESPONSE", "The model streamed no text for the final answer.");
  }
  request.onEvent({ event: "done", data: { ok: true, model: request.model, steps: step + 1, toolCalls, answerChars: answer.length, trace } });
  return { ok: true, text: answer, steps: step + 1, toolCalls, trace };
}
