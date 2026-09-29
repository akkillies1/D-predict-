import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles, Square, Trash2, X } from "lucide-react";
import {
  getAlerts,
  getBacktest,
  getForecast,
  getLatestSignal,
  getLivePrediction,
  getAiStatus,
  getOptionChain,
  streamAiChat,
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
    async build(symbol) {
      const [signal, prediction] = await Promise.all([getLatestSignal(symbol), getLivePrediction(symbol, 1)]);
      if (!signal && !prediction) return { blocks: [], context: `${symbol}: no signal on record`, empty: `No stored signal or prediction row for ${symbol} yet. Nothing was invented for this panel.` };
      const blocks: AiEvidenceBlock[] = [];
      if (signal) blocks.push({ label: `Stored signal for ${symbol}`, asOf: signal.timestamp, data: { timestamp: signal.timestamp, direction: signal.direction, confidence: round(signal.confidence, 4), regime: signal.regime, reasonCodes: signal.reasonCodes, strategyVersion: signal.strategyVersion, modelVersion: signal.modelVersion } });
      if (prediction) blocks.push({ label: `Prediction ledger row for ${symbol} (1d)`, asOf: prediction.timestamp, data: { timestamp: prediction.timestamp, prediction: prediction.prediction, probabilities: { DOWN: round(prediction.probabilities.DOWN, 4), FLAT: round(prediction.probabilities.FLAT, 4), UP: round(prediction.probabilities.UP, 4) }, expectedReturn: round(prediction.expected_return, 5), calibrationStatus: prediction.calibration_status, predictionStatus: prediction.prediction_status, actionStatus: prediction.action_status, actionReasons: prediction.action_reasons, promotionChecks: prediction.promotion_checks, oosMetrics: prediction.oos_metrics, validationExamples: prediction.validation_oos_examples } });
      return { blocks, context: `${symbol} signal state` };
    },
  },
  {
    id: "chain",
    label: "Option chain snapshot",
    hint: "Latest persisted NSE chain rows",
    needsSymbol: true,
    question: "Describe what this option chain snapshot shows about where open interest and IV sit. Do not infer a direction beyond the numbers, and note the snapshot's age.",
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

export default function AiAssistant() {
  const [symbol, setSymbol] = useState(() => (localStorage.getItem(SELECTED_SYMBOL_KEY) || "NIFTY").toUpperCase());
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
      setQuestion(target.question);
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
    void attachEvidence(target);
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

  const forget = () => {
    setHistory([]);
    setAnswer("");
    setError(null);
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

        <p className="mb-4 text-xs leading-5 text-muted-foreground">
          {status?.disclaimer ?? "The assistant talks to the local D-Predict API only. It cannot read prices unless they are already stored on this machine."}
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
          placeholder={attached ? "Ask about the attached numbers, or write your own question." : "Attach a view above, or ask a question about what D-Predict already computed."}
          className="w-full resize-y rounded-xl border border-border bg-transparent p-3 text-sm outline-none focus:border-[#c8f169]/60"
        />

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={() => void ask()}
            disabled={streaming || !status?.configured || question.trim().length === 0}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-40"
          >
            <Sparkles size={13} />{streaming ? "Answering…" : "Ask"}
          </button>
          {streaming && <button onClick={() => abortRef.current?.abort()} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-semibold hover:bg-accent"><Square size={12} />Stop</button>}
          {(history.length > 0 || answer) && <button onClick={forget} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground hover:bg-accent"><Trash2 size={12} />Clear</button>}
          {!status?.configured && <span className="text-[11px] text-muted-foreground">Add your own NVIDIA key in Settings to enable this.</span>}
          {history.length > 1 && <span className="ml-auto text-[10px] text-muted-foreground">{Math.ceil(history.length / 2)} earlier turn(s) kept in this chat</span>}
        </div>

        {(answer || error) && (
          <div className="mt-4 rounded-xl border border-border/70 bg-muted/20 p-4">
            <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              <span>Assistant commentary</span>
              <span className="flex items-center gap-2">{streaming && <span className="animate-pulse text-[#c8f169]">streaming…</span>}<button onClick={() => setAnswer("")} className="text-muted-foreground hover:text-foreground" aria-label="Dismiss"><X size={12} /></button></span>
            </div>
            {answer && <p className="whitespace-pre-wrap text-sm leading-6">{answer}</p>}
            {error && <p className="mt-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">{error}</p>}
          </div>
        )}

        <p className="mt-4 text-[10px] leading-5 text-muted-foreground">
          Answers are generated by a model you pay for with your own key, from the evidence blocks listed above. It has no market data feed of its own, is not validated for accuracy, and is not investment advice. If a number is missing from the attached evidence, the correct answer is "not in the data".
        </p>
      </div>
    </section>
  );
}
