import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, RefreshCw, Sparkles, Square, Trash2, X } from "lucide-react";
import {
  getAlerts,
  getBacktest,
  getForecast,
  getLatestSignal,
  getLivePrediction,
  getAiStatus,
  getOptionChain,
  runAiAgent,
  resolveAgentApproval,
  streamAiChat,
  type AgentApprovalRequest,
  type AgentTraceEntry,
  type AiEvidenceBlock,
  type AiMessage,
} from "@/lib/localApi";
import { openAiSettings } from "./AiSettings";

const SELECTED_SYMBOL_KEY = "dpredict:selected-symbol";

type Preset = {
  id: string;
  label: string;
  hint: string;
  question: string;
  /** What the agent is told to go and measure, using its own local tools. */
  agentQuestion: string;
  needsSymbol: boolean;
  build: (symbol: string) => Promise<{ blocks: AiEvidenceBlock[]; context: string; empty?: string }>;
};

const round = (value: number | null | undefined, digits = 2) => (value == null || !Number.isFinite(value) ? null : Number(value.toFixed(digits)));

const PRESETS: Preset[] = [
  {
    id: "alerts",
    label: "Today's radar alerts",
    hint: "Closed-form rule evidence from the collector",
    needsSymbol: false,
    question: "Explain what these radar alerts actually say. Rank them by how direct the evidence is, and be explicit about what none of them prove.",
    agentQuestion: "For the most alert-heavy symbol here, read its stored daily history and run the real backtest over the same bars, then report the measured return, drawdown and trade count next to what the alerts claim. Say plainly which of these rules the stored outcomes support and which they do not.",
    async build() {
      const result = await getAlerts(15);
      const rows = result.alerts.map((alert) => ({ symbol: alert.symbol, rule: alert.rule, price: alert.price, asOf: alert.marketTimestamp, evidence: alert.evidence, newToRadar: alert.newToRadar }));
      if (!rows.length) return { blocks: [], context: "The radar has not fired any alerts yet.", empty: "No alerts stored yet. The collector radar writes rows during NSE sessions — nothing here is simulated." };
      return {
        blocks: [{ label: "Buy-alert radar rows", data: { alerts: rows, unreadCount: result.unreadCount, ruleDisclaimer: result.disclaimer }, asOf: rows[0]?.asOf ?? null }],
        context: "alerts radar",
      };
    },
  },
  {
    id: "signal",
    label: "Current signal",
    hint: "Latest stored decision + live prediction ledger row",
    needsSymbol: true,
    question: "Walk me through the current signal for this instrument. Quote only the stored numbers, and state plainly whether any of them are validated.",
    agentQuestion: "Read this symbol's newest ledger rows, then re-ask the model for a fresh 1d forecast and compare the two. Report the divergence the tool measured, whether the artifact behind either number is promotion-ready, and whether any row has a realized outcome yet. If the artifact is the reason it is abstaining, you may propose train_model for this one symbol and horizon and say what you expect the gate to measure — it still only runs if the user approves it.",
    async build(symbol) {
      const [signal, prediction] = await Promise.all([getLatestSignal(symbol), getLivePrediction(symbol, 1)]);
      if (!signal && !prediction) return { blocks: [], context: `${symbol}: no signal on record`, empty: `No stored signal or prediction row for ${symbol} yet. Nothing was invented for this panel.` };
      const blocks: AiEvidenceBlock[] = [];
      if (signal) blocks.push({ label: `Stored signal for ${symbol}`, asOf: signal.timestamp, data: { timestamp: signal.timestamp, direction: signal.direction, confidence: round(signal.confidence, 4), regime: signal.regime, reasonCodes: signal.reasonCodes, strategyVersion: signal.strategyVersion, modelVersion: signal.modelVersion } });
      if (prediction?.ok) blocks.push({ label: `Prediction ledger row for ${symbol} (1d)`, asOf: prediction.timestamp, data: { timestamp: prediction.timestamp, prediction: prediction.prediction, probabilities: { DOWN: round(prediction.probabilities.DOWN, 4), FLAT: round(prediction.probabilities.FLAT, 4), UP: round(prediction.probabilities.UP, 4) }, expectedReturn: round(prediction.expected_return, 5), calibrationStatus: prediction.calibration_status, predictionStatus: prediction.prediction_status, actionStatus: prediction.action_status, actionReasons: prediction.action_reasons, promotionChecks: prediction.promotion_checks, oosMetrics: prediction.oos_metrics, validationExamples: prediction.validation_oos_examples } });
      return { blocks, context: `${symbol} signal state` };
    },
  },
  {
    id: "chain",
    label: "Option chain snapshot",
    hint: "Latest persisted NSE chain rows",
    needsSymbol: true,
    question: "Describe what this option chain snapshot shows about where open interest and IV sit. Do not infer a direction beyond the numbers, and note the snapshot's age.",
    agentQuestion: "Using the attached chain snapshot plus the underlying's stored daily history and the model's current stance for it, state what the options data actually establishes here and what it cannot establish.",
    async build(symbol) {
      const rows = await getOptionChain(symbol);
      if (!rows.length) return { blocks: [], context: `${symbol}: no stored chain snapshot`, empty: `No option chain snapshot stored for ${symbol}. The collector only pulls the NSE chain during market session, so try again intraday.` };
      const expiries = [...new Set(rows.map((row) => row.expiry_date))].sort();
      const nearest = expiries[0];
      const strikes = rows.filter((row) => row.expiry_date === nearest);
      const meanStrike = strikes.reduce((sum, row) => sum + (row.strike ?? 0), 0) / Math.max(1, strikes.length);
      return {
        blocks: [{
          label: `Option chain, ${symbol} nearest expiry ${nearest}`,
          data: {
            asOf: strikes[0]?.timestamp ?? null,
            expiriesStored: expiries.slice(0, 6),
            meanStrikeAcrossChain: round(meanStrike, 2),
            rows: strikes.slice(0, 60).map((row) => ({ strike: row.strike, type: row.option_type, ltp: row.ltp, bid: row.bid, ask: row.ask, iv: round(row.iv, 2), oi: row.oi, oiChange: row.oiChange, timestamp: row.timestamp })),
          },
          asOf: strikes[0]?.timestamp ?? null,
        }],
        context: `${symbol} option chain`,
      };
    },
  },
  {
    id: "forecast",
    label: "Forecast band",
    hint: "Historical-drift statistical baseline, not a model",
    needsSymbol: true,
    question: "Explain this forecast band as what it is: a statistical baseline from historical daily returns. Point out which numbers would be misread as a prediction.",
    agentQuestion: "Measure this symbol's realized behaviour from stored bars over roughly 250 days, run each rule strategy over them, and compare what those two tools measured against the statistical band. Report which numbers are historical fact and which are forecasts.",
    async build(symbol) {
      const forecast = await getForecast(symbol, 5);
      if (!forecast) return { blocks: [], context: `${symbol}: forecast unavailable`, empty: `No forecast available for ${symbol} — it needs at least 20 stored daily bars.` };
      const last = forecast.bands[forecast.bands.length - 1];
      return {
        blocks: [{ label: `Statistical forecast, ${symbol}, ${forecast.horizonDays}d`, data: {
          spot: round(forecast.spot), dailyVolatility: round(forecast.dailyVolatility, 5), daysOfHistoryUsed: forecast.daysOfHistoryUsed,
          expectedValue: round(forecast.expectedValue), expectedReturn: round(forecast.expectedReturn, 5),
          probabilityAboveSpot: round(forecast.probabilityAboveSpot, 4), probabilityBelowSpot: round(forecast.probabilityBelowSpot, 4),
          finalBandDay: last ? { day: last.day, p10: round(last.p10), median: round(last.median), p90: round(last.p90) } : null,
          status: forecast.status, strategy: forecast.strategy, limitations: forecast.limitations,
        } }],
        context: `${symbol} forecast band`,
      };
    },
  },
  {
    id: "backtest",
    label: "Backtest result",
    hint: "Real stored bars, explicit costs, closed-form rules",
    needsSymbol: true,
    question: "Interpret this backtest. Focus on what the costs, drawdown and trade count say about the strategy, and on what a reader could easily over-interpret.",
    agentQuestion: "Run all three rule strategies over the same stored bars for this symbol, report the measured differences including costs, then check the ledger's realized accuracy to see whether any model signal supports trading them.",
    async build(symbol) {
      const result = await getBacktest(symbol, "sma_trend", 365);
      if (!result) return { blocks: [], context: `${symbol}: backtest unavailable`, empty: `No backtest result for ${symbol} — not enough stored daily bars yet.` };
      return {
        blocks: [{ label: `Backtest ${symbol} sma_trend over ${result.bars} bars`, data: {
          strategy: result.strategy, bars: result.bars, smaWindow: result.smaWindow, initialCapital: result.initialCapital, finalEquity: result.finalEquity,
          totalReturn: round(result.totalReturn, 5), cagr: round(result.cagr, 5), maxDrawdown: round(result.maxDrawdown, 5), sharpePerTradeAnnualized: round(result.sharpePerTradeAnnualized, 3),
          trades: result.trades, wins: result.wins, losses: result.losses, winRate: round(result.winRate, 4), profitFactor: round(result.profitFactor, 3), totalCosts: result.totalCosts,
          lastTrades: result.tradeLog.slice(-5).map((trade) => ({ entry: trade.entryTimestamp, exit: trade.exitTimestamp, entryPrice: trade.entryPrice, exitPrice: trade.exitPrice, netPnl: trade.netPnl, costs: trade.costs, exitReason: trade.exitReason })),
        } }],
        context: `${symbol} backtest`,
      };
    },
  },
];

type Mode = "explain" | "investigate";

export default function AiAssistant() {
  const [symbol, setSymbol] = useState(() => (localStorage.getItem(SELECTED_SYMBOL_KEY) || "NIFTY").toUpperCase());
  const [mode, setMode] = useState<Mode>("explain");
  const [status, setStatus] = useState<{ configured: boolean; model: string | null; disclaimer: string } | null>(null);
  const [presetId, setPresetId] = useState<string>("alerts");
  const [attached, setAttached] = useState<{ blocks: AiEvidenceBlock[]; context: string; summary: string[] } | null>(null);
  const [loadingEvidence, setLoadingEvidence] = useState(false);
  const [emptyNotice, setEmptyNotice] = useState<string | null>(null);
  const [question, setQuestion] = useState(PRESETS[0].question);
  const [answer, setAnswer] = useState("");
  const [history, setHistory] = useState<AiMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trace, setTrace] = useState<AgentTraceEntry[]>([]);
  const [openCall, setOpenCall] = useState<string | null>(null);
  const [runInfo, setRunInfo] = useState<{ steps: number; toolCalls: number } | null>(null);
  const [approvals, setApprovals] = useState<AgentApprovalRequest[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const preset = PRESETS.find((item) => item.id === presetId) ?? PRESETS[0];

  const refreshStatus = useCallback(async () => {
    try {
      const payload = await getAiStatus();
      setStatus({ configured: payload.configured, model: payload.model, disclaimer: payload.disclaimer });
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => { void refreshStatus(); }, [refreshStatus]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const questionFor = (target: Preset, active: Mode) => (active === "investigate" ? target.agentQuestion : target.question);

  const attachEvidence = async (target: Preset) => {
    setLoadingEvidence(true);
    setError(null);
    setEmptyNotice(null);
    setAttached(null);
    try {
      const built = await target.build(target.needsSymbol ? symbol : "NIFTY");
      if (built.empty) {
        setEmptyNotice(built.empty);
        return;
      }
      setAttached({ blocks: built.blocks, context: built.context, summary: built.blocks.map((block) => `${block.label}${block.asOf ? ` · ${block.asOf}` : ""}`) });
      setQuestion(questionFor(target, mode));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not read this data from the local API.");
    } finally {
      setLoadingEvidence(false);
    }
  };

  const selectPreset = (target: Preset) => {
    setPresetId(target.id);
    setAnswer("");
    setError(null);
    setTrace([]);
    setRunInfo(null);
    setOpenCall(null);
    void attachEvidence(target);
  };

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    setAnswer("");
    setError(null);
    setTrace([]);
    setRunInfo(null);
    setOpenCall(null);
    const typedSomethingOwn = !PRESETS.some((item) => item.question === question || item.agentQuestion === question);
    if (!typedSomethingOwn) setQuestion(questionFor(preset, next));
  };

  const ask = async () => {
    const text = question.trim();
    if (!text || streaming) return;
    setStreaming(true);
    setError(null);
    setAnswer("");
    const controller = new AbortController();
    abortRef.current = controller;
    let streamed = "";
    const result = await streamAiChat({
      question: text,
      evidence: attached?.blocks ?? [],
      marketContext: attached?.context ?? null,
      messages: history,
      signal: controller.signal,
      onToken: (token) => { streamed += token; setAnswer(streamed); },
    }).catch((error) => {
      if (error instanceof Error && error.name === "AbortError") return { ok: false as const, text: streamed, model: null, error: "ABORTED", message: "Answer stopped." };
      return { ok: false as const, text: streamed, model: null, error: "AI_NETWORK", message: error instanceof Error ? error.message : "The assistant request failed." };
    });
    setStreaming(false);
    abortRef.current = null;
    if (result.ok) {
      setHistory((previous) => {
        const next: AiMessage[] = [...previous, { role: "user", content: text }, { role: "assistant", content: result.text }];
        return next.slice(-8);
      });
    } else {
      setError(result.message ?? "The assistant could not answer.");
      if (result.error === "AI_KEY_MISSING" || result.error === "AI_MODEL_REQUIRED" || result.error === "AI_DISABLED") openAiSettings();
    }
  };

  const investigate = async () => {
    const text = question.trim();
    if (!text || streaming) return;
    setStreaming(true);
    setError(null);
    setAnswer("");
    setTrace([]);
    setRunInfo(null);
    setOpenCall(null);
    setApprovals([]);
    const controller = new AbortController();
    abortRef.current = controller;
    let streamed = "";
    const result = await runAiAgent({
      question: text,
      evidence: attached?.blocks ?? [],
      marketContext: attached?.context ?? null,
      onTool: (entry) => setTrace((previous) => [...previous, entry]),
      onApproval: (request) => setApprovals((previous) => (previous.some((item) => item.callId === request.callId) ? previous : [...previous, request])),
      onApprovalResolved: (outcome) => setApprovals((previous) => previous.filter((item) => item.callId !== outcome.callId)),
      onToken: (token) => { streamed += token; setAnswer(streamed); },
      signal: controller.signal,
    }).catch((error) => {
      const aborted = error instanceof Error && error.name === "AbortError";
      return {
        ok: false as const,
        text: streamed,
        model: null,
        trace: [] as AgentTraceEntry[],
        steps: 0,
        toolCalls: 0,
        error: aborted ? "ABORTED" : "AGENT_NETWORK",
        message: aborted ? "Investigation stopped." : error instanceof Error ? error.message : "The investigation request failed.",
      };
    });
    setStreaming(false);
    abortRef.current = null;
    setApprovals([]);
    setRunInfo({ steps: result.steps, toolCalls: result.toolCalls });
    if (!result.ok) {
      setError(result.message ?? "The investigation could not complete.");
      if (result.error === "AI_KEY_MISSING" || result.error === "AI_MODEL_REQUIRED" || result.error === "AI_DISABLED") openAiSettings();
    }
  };

  /** The one thing that lets a proposed change through: this click. */
  const decide = async (request: AgentApprovalRequest, approved: boolean) => {
    setApprovals((previous) => previous.filter((item) => item.callId !== request.callId));
    const resolved = await resolveAgentApproval(request.runId, request.callId, approved).catch(() => false);
    if (!resolved) setError("That request had already expired or been answered, so nothing changed.");
  };

  const submit = () => (mode === "investigate" ? investigate() : ask());

  const forget = () => {
    setHistory([]);
    setAnswer("");
    setError(null);
    setTrace([]);
    setRunInfo(null);
    setOpenCall(null);
    setApprovals([]);
  };

  return (
    <section id="ai-assistant" className="mx-auto mb-6 w-full max-w-[1400px] px-4">
      <div className="rounded-2xl border border-border bg-card/60 p-5 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Optional · bring your own key</div>
            <h2 className="mt-1 flex items-center gap-2 text-lg font-semibold"><Sparkles size={16} className="text-[#c8f169]" />AI Assistant</h2>
          </div>
          <div className="flex items-center gap-2">
            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${status?.configured ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-border text-muted-foreground"}`}>
              {status === null ? "API OFFLINE" : status.configured ? "READY" : "NO KEY"}
            </span>
            {status?.model && <span className="hidden max-w-[220px] truncate font-mono text-[10px] text-muted-foreground sm:inline">{status.model}</span>}
            <button onClick={() => openAiSettings()} className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold hover:bg-accent">Settings</button>
          </div>
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-border p-0.5">
            {([
              { id: "explain" as Mode, label: "Explain", hint: "Re-reads the numbers already on this screen. No new measurements." },
              { id: "investigate" as Mode, label: "Investigate", hint: "Runs real local tools: stored bars, the backtest engine, a fresh forecast. Can also train, track and acknowledge — each one needs your click first." },
            ]).map((item) => (
              <button
                key={item.id}
                onClick={() => switchMode(item.id)}
                title={item.hint}
                className={`rounded-md px-3 py-1 text-[11px] font-semibold transition-colors ${mode === item.id ? "bg-[#c8f169]/15 text-[#c8f169]" : "text-muted-foreground hover:bg-accent"}`}
              >
                {item.id === "investigate" && <Bot size={11} className="mr-1 inline" />}
                {item.label}
              </button>
            ))}
          </div>
          <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            {mode === "investigate" ? "agent · local tools · writes need your click" : "commentary only"}
          </span>
        </div>

        <p className="mb-4 text-xs leading-5 text-muted-foreground">
          {mode === "investigate"
            ? "The agent asks your local D-Predict services for numbers it does not have: it reads stored daily bars, runs the real backtest engine, pulls ledger rows, and can re-ask your trained model for a fresh forecast. Every figure it quotes comes from one of those calls, listed below as they run. It can also act inside this app — retrain one artifact, add or remove a watchlist symbol, acknowledge radar alerts — but only after you read the exact change and press Apply. It cannot place orders, touch real money or reach anything outside D-Predict, and it still spends your own key."
            : (status?.disclaimer ?? "The assistant talks to the local D-Predict API only. It cannot read prices unless they are already stored on this machine.")}
        </p>

        <div className="mb-4 flex flex-wrap gap-2">
          {PRESETS.map((item) => (
            <button
              key={item.id}
              onClick={() => void selectPreset(item)}
              title={item.hint}
              className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${presetId === item.id ? "border-[#c8f169]/60 bg-[#c8f169]/10 text-[#c8f169]" : "border-border text-muted-foreground hover:bg-accent"}`}
            >
              {item.label}
            </button>
          ))}
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            {preset.needsSymbol ? "symbol" : ""}
            <input
              value={symbol}
              disabled={!preset.needsSymbol}
              onChange={(event) => {
                const next = event.target.value.toUpperCase().replace(/[^A-Z0-9._-]/g, "").slice(0, 32);
                setSymbol(next);
                localStorage.setItem(SELECTED_SYMBOL_KEY, next);
              }}
              className="w-28 rounded-md border border-border bg-transparent px-2 py-1 font-mono text-xs outline-none focus:border-[#c8f169]/60 disabled:opacity-40"
            />
          </label>
        </div>

        {loadingEvidence && <p className="mb-3 text-xs text-muted-foreground">Reading stored data for this view…</p>}
        {emptyNotice && <p className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">{emptyNotice}</p>}

        {attached && (
          <div className="mb-4 rounded-xl border border-border/70 bg-muted/20 p-3">
            <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Attached from your own data — nothing else is sent</div>
            <ul className="mt-2 space-y-1">
              {attached.summary.map((line) => <li key={line} className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground"><span className="size-1.5 rounded-full bg-[#c8f169]" />{line}</li>)}
            </ul>
          </div>
        )}

        <textarea
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          rows={3}
          placeholder={mode === "investigate"
            ? (attached ? "Ask it to measure something — it will call the local tools and show each result." : "Give it a question it has to go and measure, e.g. compare the stored signal against a fresh forecast.")
            : (attached ? "Ask about the attached numbers, or write your own question." : "Attach a view above, or ask a question about what D-Predict already computed.")}
          className="w-full resize-y rounded-xl border border-border bg-transparent p-3 text-sm outline-none focus:border-[#c8f169]/60"
        />

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={() => void submit()}
            disabled={streaming || !status?.configured || question.trim().length === 0}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-40"
          >
            {mode === "investigate" ? <Bot size={13} /> : <Sparkles size={13} />}
            {streaming ? (mode === "investigate" ? "Investigating…" : "Answering…") : mode === "investigate" ? "Investigate" : "Ask"}
          </button>
          {streaming && <button onClick={() => abortRef.current?.abort()} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-semibold hover:bg-accent"><Square size={12} />Stop</button>}
          {(history.length > 0 || answer || trace.length > 0) && <button onClick={forget} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground hover:bg-accent"><Trash2 size={12} />Clear</button>}
          {!status?.configured && <span className="text-[11px] text-muted-foreground">Add your own NVIDIA key in Settings to enable this.</span>}
          {mode === "explain" && history.length > 1 && <span className="ml-auto text-[10px] text-muted-foreground">{Math.ceil(history.length / 2)} earlier turn(s) kept in this chat</span>}
        </div>

        {mode === "investigate" && streaming && trace.length === 0 && (
          <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><RefreshCw size={12} className="animate-spin" />Deciding which local measurements to take…</p>
        )}

        {approvals.map((request) => (
          <div key={request.callId} className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
            <div className="mb-1 text-[10px] uppercase tracking-[0.18em] text-amber-300">The agent wants to change something — your call</div>
            <p className="text-sm leading-6">{request.description}</p>
            <p className="mt-1 font-mono text-[10px] text-muted-foreground">
              {request.tool}
              ({Object.entries(request.arguments).map(([key, value]) => `${key}=${String(value)}`).join(", ") || "no arguments"})
            </p>
            <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
              Nothing in D-Predict changes until you press Apply. This runs the same action the {request.tool.startsWith("watchlist") ? "watchlist" : request.tool === "train_model" ? "Training tab" : "alert bell"} uses, on this machine only. If no decision arrives within {Math.round(request.timeoutMs / 1000)}s the request lapses and the tool does not run.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button onClick={() => void decide(request, true)} className="inline-flex items-center gap-1.5 rounded-lg bg-[#c8f169] px-4 py-2 text-xs font-semibold text-[#0b1206] hover:bg-[#d5f583]">Apply this change</button>
              <button onClick={() => void decide(request, false)} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 text-xs font-semibold hover:bg-accent">Refuse</button>
            </div>
          </div>
        ))}

        {trace.length > 0 && (
          <div className="mt-4 rounded-xl border border-border/70 bg-muted/20 p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Measured on this machine — {trace.length} tool call{trace.length === 1 ? "" : "s"}</span>
              {runInfo && !streaming && <span className="font-mono text-[10px] text-muted-foreground">{runInfo.steps} step(s) · {runInfo.toolCalls} call(s) · click a row for the raw JSON</span>}
            </div>
            <ol className="space-y-1.5">
              {trace.map((entry) => (
                <li key={entry.callId} className="overflow-hidden rounded-lg border border-border/60 bg-card/50">
                  <button type="button" onClick={() => setOpenCall(openCall === entry.callId ? null : entry.callId)} className="flex w-full items-start gap-2 px-3 py-2 text-left">
                    <span className={`mt-0.5 shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold ${entry.ok ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-red-500/40 bg-red-500/10 text-red-300"}`}>
                      {entry.ok ? "MEASURED" : "NO DATA"}
                    </span>
                    {entry.write && (
                      <span className={`mt-0.5 shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold ${entry.approval === "APPROVED" ? "border-sky-500/40 bg-sky-500/10 text-sky-300" : "border-border text-muted-foreground"}`}>
                        {entry.approval === "APPROVED" ? (entry.ok ? "APPLIED BY YOU" : "APPLIED · FAILED") : entry.approval === "TIMED_OUT" ? "LAPSED · NOT RUN" : entry.approval === "NO_GATE" ? "NO GATE · NOT RUN" : "REFUSED · NOT RUN"}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[11px]">
                        {entry.tool}
                        <span className="text-muted-foreground">({Object.entries(entry.arguments).map(([key, value]) => `${key}=${String(value)}`).join(", ") || "no arguments"})</span>
                      </span>
                      <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">{entry.summary}</span>
                      {entry.truncated && <span className="mt-0.5 block text-[10px] text-amber-300">Part of this result was over the agent's context budget and was not sent to the model.</span>}
                    </span>
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
                      {entry.write && entry.approval !== "APPROVED" ? `waited ${Math.round(entry.durationMs / 1000)}s` : `${entry.durationMs} ms`}
                    </span>
                  </button>
                  {openCall === entry.callId && (
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words border-t border-border/60 bg-background/40 px-3 py-2 font-mono text-[10px] leading-4">
                      {JSON.stringify({ tool: entry.tool, arguments: entry.arguments, ok: entry.ok, result: entry.result }, null, 2)}
                    </pre>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}

        {(answer || error) && (
          <div className="mt-4 rounded-xl border border-border/70 bg-muted/20 p-4">
            <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              <span>{mode === "investigate" ? "Agent findings" : "Assistant commentary"}</span>
              <span className="flex items-center gap-2">{streaming && <span className="animate-pulse text-[#c8f169]">streaming…</span>}<button onClick={() => setAnswer("")} className="text-muted-foreground hover:text-foreground" aria-label="Dismiss"><X size={12} /></button></span>
            </div>
            {answer && <p className="whitespace-pre-wrap text-sm leading-6">{answer}</p>}
            {error && <p className="mt-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">{error}</p>}
          </div>
        )}

        <p className="mt-4 text-[10px] leading-5 text-muted-foreground">
          {mode === "investigate"
            ? "Each figure above was measured by one of the local tools and expands to its raw JSON. A row marked NO DATA means exactly that: nothing was measured, and the agent was told to say so rather than fill the gap. A row marked REFUSED or LAPSED never ran, so nothing in the app changed. The model still writes the prose, so treat it as commentary on real numbers, not as a validated forecast."
            : "Answers are generated by a model you pay for with your own key, from the evidence blocks listed above. It has no market data feed of its own, is not validated for accuracy, and is not investment advice. If a number is missing from the attached evidence, the correct answer is \"not in the data\"."}
        </p>
      </div>
    </section>
  );
}
