const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:4100";
const RESEARCH_BASE = import.meta.env.VITE_RESEARCH_BASE_URL ?? "http://127.0.0.1:4200";

export type LocalHealth = { ok: boolean; database?: string; time?: string };
export type MarketOverview = { ok: boolean; symbol: string; timestamp: string | null; collectedAt?: string | null; open: number | null; high: number | null; low: number | null; close: number | null; volume: number | null; previousClose?: number | null; change?: number | null; changePercent?: number | null; source?: string; status?: "LIVE" | "CACHED" | "STALE" | "OFFLINE" };
export type Instrument = { symbol: string; exchange: string; lotSize: number; isActive: boolean; name?: string | null; providerSymbol?: string | null; instrumentType?: string | null; source?: string; observations?: number; lastMarketTimestamp?: string | null; lastCollectedAt?: string | null };
export type PriceBar = { timestamp: string; open: number; high: number; low: number; close: number; volume: number | null };
export type TargetTiming = { expectedSeconds?: number; p25Seconds?: number; p50Seconds?: number; p75Seconds?: number; probability?: number; status?: string; samples?: number; resolution?: string };
export type TradeTarget = { price: number; probability: number; return?: number; timing?: TargetTiming };
export type TradeThesis = { signal?: string; decision?: string; direction?: "LONG" | "SHORT" | "FLAT"; entryPrice?: number; expectedReturn?: number; horizon?: string; targets?: TradeTarget[]; stop?: { price: number; probability?: number; return?: number; timing?: TargetTiming }; riskRewardToTarget1?: number; probability?: number; confidence?: number; distributionStatus?: string; tradeThesisVersion?: string };
export type Signal = { id: string; symbol: string; timestamp: string; strategyVersion: string; modelVersion: string; direction: "BULLISH" | "BEARISH" | "NEUTRAL"; confidence: number; regime: string | null; reasonCodes: string[]; parameters: Record<string, unknown>; tradeThesis?: TradeThesis | null };
export type OptionRow = { expiry_date: string; strike: number; option_type: "CE" | "PE"; timestamp: string; ltp: number | null; bid: number | null; ask: number | null; oi: number | null; oiChange: number | null; iv: number | null };
export type OptionIntelligence = { ok: boolean; status: "ACTIONABLE" | "RESEARCH_ONLY" | "ABSTAIN" | "NO_CHAIN"; symbol?: string; expiry: string | null; asOf: string | null; spot: number | null; metrics: { pcr: number | null; atmStrike: number | null; atmIv: number | null; ivSkewPutMinusCall: number | null; callWall: number | null; putWall: number | null; maxPain: number | null; averageSpreadPct: number | null; liquidityScore: number; freshnessSeconds: number | null }; recommendation: { action: "BUY_CALL" | "BUY_PUT" | "CALL_VERTICAL" | "PUT_VERTICAL" | "WAIT" | "ABSTAIN"; direction: "BULLISH" | "BEARISH" | "NEUTRAL"; confidence: number; rationale: string; evidence: string[]; risks: string[]; contract: { expiry: string; strike: number; optionType: "CE" | "PE"; price: number; bid: number; ask: number } | null; hedge: { expiry: string; strike: number; optionType: "CE" | "PE"; price: number; bid: number; ask: number } | null }; candidates: Array<{ expiry: string; strike: number; optionType: "CE" | "PE"; ltp: number | null; bid: number | null; ask: number | null; oi: number; iv: number | null; spreadPct: number | null }>; gates: Record<string, boolean>; disclaimer: string };
export type ForecastBand = { day: number; p10: number; p25: number; median: number; p75: number; p90: number };
export type Forecast = { symbol: string; spot: number; dailyVolatility: number; daysOfHistoryUsed: number; horizonDays: number; paths: number; probabilityAboveSpot: number; probabilityBelowSpot: number; expectedValue: number; expectedReturn: number; forecastRange: { low: number; high: number }; bands: ForecastBand[]; strategy: { direction: "LONG" | "SHORT" | "FLAT"; action: "WAIT" | "STAGED_ENTRY"; rationale: string; positionSizing: string; invalidation: string }; actionSuggestions?: string[]; limitations: string[]; status: string };
export type ResearchArticle = { title: string; url: string; source: string; publishedAt: string | null; language?: string; domain?: string; sourceType: "news" | "market"; score: number; stance: "BULLISH" | "BEARISH" | "NEUTRAL" };
export type ResearchResult = { symbol: string; companyName: string | null; asOf: string; direction: "BULLISH" | "BEARISH" | "MIXED"; confidence: number; evidenceScore: number; agreement: number; articles: ResearchArticle[]; themes: string[]; risks: string[]; publicDisclosureLinks: { label: string; url: string }[]; disclaimer: string };
export type IPOInput = { companyName: string; symbol?: string; revenue?: number; revenueGrowth?: number; ebitda?: number; pat?: number; issuePrice?: number; postIssueShares?: number; freshIssue?: number; ofs?: number; debt?: number; cash?: number; roe?: number; roce?: number; sourceUrls?: string[] };
export type IPOAnalysis = { score: number; verdict: "ATTRACTIVE" | "WATCH" | "CAUTION"; valuationScore: number; businessScore: number; structureScore: number; metrics: { pe: number | null; enterpriseValue: number | null; evEbitda: number | null; ebitdaMargin: number | null; profitMargin: number | null; freshIssueRatio: number | null }; risks: string[]; methodology: string; disclaimer: string };
export type PaperOptionTrade = { id: string; symbol: string; expiry_date: string; strike: number; option_type: "CE" | "PE"; side: "BUY" | "SELL"; status: "OPEN" | "CLOSED"; lots: number; lot_size: number; quantity: number; entry_price: number; entry_bid: number | null; entry_ask: number | null; entry_ltp: number | null; entry_quote_timestamp: string; entry_timestamp: string; current_price: number | null; current_quote_timestamp: string | null; unrealized_pnl: number; realized_pnl: number | null; exit_price: number | null; exit_timestamp: string | null; exit_reason: string | null };
export type PaperProduct = "CNC" | "MIS" | "NRML";
export type OrderType = "MARKET" | "LIMIT";
export type OrderStatus = "FILLED" | "REJECTED" | "RECORDED" | "OPEN" | "CANCELLED";
export type ChargeBreakdown = { brokerage: number; stt: number; exchange: number; sebi: number; stamp: number; gst: number; total: number };
export type PaperPosition = { symbol: string; product: PaperProduct; section: "HOLDINGS" | "POSITIONS"; quantity: number; averagePrice: number; costNet: number; realizedPnl: number; currentPrice: number | null; currentTimestamp: string | null; unrealizedPnl: number | null };
export type PaperOrder = { id: string; symbol: string; product: PaperProduct; side: "BUY" | "SELL" | "HOLD"; orderType: OrderType; quantity: number; limitPrice: number | null; fillPrice: number | null; notional: number; grossAmount: number; netAmount: number; costs: Partial<ChargeBreakdown>; realizedPnl: number; fillTimestamp: string | null; status: OrderStatus; note: string; rationale: string; signalSnapshot: Record<string, unknown>; createdAt: string };
export type PaperState = { ok: boolean; mode: "PAPER_RESEARCH"; marketLive?: boolean; account: null | { id: number; startingCapital: number; cash: number; realizedPnl: number; totalCosts: number; unrealizedPnl: number; equity: number; returnPct: number; openPositions: number; updatedAt: string }; positions: PaperPosition[]; orders: PaperOrder[]; marketStatus?: string; disclaimer: string };
export type PaperAnalytics = { ok: boolean; periodDays: number; since: string; summary: { actions: number; trades: number; winningTrades: number; winRate: number | null; realizedPnl: number; notional: number }; bySymbol: Array<{ symbol: string; actions: number; buys: number; sells: number; realizedPnl: number; notional: number }>; byAction: Array<{ side: "BUY" | "SELL" | "HOLD"; actions: number; realizedPnl: number; averageClosedPnl: number }>; byModelDirection: Array<{ direction: string; actions: number; realizedPnl: number; winningTrades: number }>; disclaimer: string };
export type Coverage = { symbol: string; timeframe: string; status: "FRESH" | "STALE" | "NO_DATA"; observations: number; firstTimestamp: string | null; lastTimestamp: string | null; lastCollectedAt: string | null; source: string | null; ageSeconds: number | null };
export type Performance = { symbol: string; period: string; timeframe: string; requestedDays: number; availableDays: number; coverage: number; metrics: { status: string; observations: number; startingPrice?: number; endingPrice?: number; absoluteReturn?: number; percentageReturn?: number; cagr?: number; volatility?: number; maxDrawdown?: number; bestDay?: number; worstDay?: number; positiveDayRatio?: number } };
export type WatchlistItem = { symbol: string; position: number; note: string | null; price: number | null; timestamp: string | null; status: "AVAILABLE" | "NO_DATA" };
export type DecisionCandidate = {
  status: "PAPER_CANDIDATE" | "ABSTAIN";
  symbol: string;
  horizon: string;
  direction: "LONG" | "SHORT" | "ABSTAIN";
  score: number;
  provenance: "ML_CONFIRMED" | "STATISTICAL_BASELINE" | "OPTION_INTELLIGENCE";
  modelConfidence: number | null;
  expectedReturn: number | null;
  spot: number;
  invalidation: number | null;
  rewardRisk: { reward: number; risk: number; ratio: number } | null;
  evidence: Array<{ name: string; value: number | string | boolean | null; weight: number; contribution: number }>;
  gates: Array<{ name: string; passed: boolean; reason: string }>;
  blockers: Array<{ name: string; reason: string }>;
  reasons: string[];
  option: unknown;
  paperSuggestion: { direction: string; entryReference: number; invalidation: number | null; option: unknown; note: string } | null;
  dataQuality: { observations: number; fresh: boolean };
  gateSummary: string;
};

export type MarketPick = { symbol: string; name?: string | null; spot: number; expectedReturn: number; netExpectedReturn: number; confidence: number; horizon: string; dailyVolatility: number; momentum20d: number; momentum60d: number; maxDrawdown60d: number; dataDays: number; dataAsOf: string; dataStatus: "CURRENT" | "CLOSED_LAST_SESSION"; score: number; basis: "MODEL" | "EVIDENCE"; reasons: string[]; risks: string[] };
export type PredictionPerformance = { periodDays: number; generatedAt: string; metrics: { scoredPredictions: number; pendingPredictions: number; accuracy: number | null; balancedAccuracy: number | null; directionalAccuracy: number | null; logLoss: number | null; brier: number | null; calibrationError: number | null; meanExpectedReturn: number | null; meanRealizedReturn: number | null; returnMae: number | null }; byHorizon: Array<{ horizon: string; scoredPredictions: number; accuracy: number | null; directionalAccuracy: number | null; logLoss: number | null; pendingPredictions: number }> };
export type LivePrediction = { ok: boolean; symbol: string; timestamp: string; horizon: "1d" | "3d" | "5d"; prediction: "DOWN" | "FLAT" | "UP"; probabilities: { DOWN: number; FLAT: number; UP: number }; expected_return: number; confidence: number; probability_margin: number; return_interval: { p10: number; p50: number; p90: number }; probability_net_positive: number; calibration_status: "CALIBRATED" | "UNCALIBRATED"; prediction_status: "PROMOTION_READY" | "ABSTAIN"; action_status: "ACTIONABLE_LONG" | "ACTIONABLE_SHORT" | "WATCH_FLAT" | "WATCH_LOW_EDGE" | "ABSTAIN_MODEL_GATE"; action_reasons: string[]; promotion_checks: Record<string, boolean>; oos_metrics: { accuracy: number; majority_baseline: number; log_loss: number; directional_accuracy: number | null }; model_version: string; training_cutoff: string; validation_oos_examples: number };

async function json<T>(url: string, init?: RequestInit): Promise<T> { const response = await fetch(url, init); if (!response.ok) { const body = await response.json().catch(() => null) as { error?: string; message?: string } | null; throw new Error(body?.message ?? body?.error ?? `API returned ${response.status}`); } return response.json() as Promise<T>; }
export async function getLocalHealth(signal?: AbortSignal): Promise<LocalHealth> { return json<LocalHealth>(`${API_BASE}/health`, { signal }); }
export function localApiBaseUrl() { return API_BASE; }
export async function getMarketOverview(symbol = "NIFTY", signal?: AbortSignal): Promise<MarketOverview | null> { const payload = await json<MarketOverview>(`${API_BASE}/api/market/${encodeURIComponent(symbol)}/overview`, { signal }); return payload.ok ? payload : null; }
export async function getLiveQuote(symbol = "NIFTY", signal?: AbortSignal): Promise<MarketOverview | null> { const payload = await json<MarketOverview>(`${API_BASE}/api/market/${encodeURIComponent(symbol)}/live`, { signal }); return payload.ok ? payload : null; }
export async function getInstruments(signal?: AbortSignal): Promise<Instrument[]> { const payload = await json<{ instruments: Instrument[] }>(`${API_BASE}/api/instruments`, { signal }); return payload.instruments; }
export async function searchInstruments(query: string, signal?: AbortSignal): Promise<Instrument[]> { const payload = await json<{ instruments: Instrument[] }>(`${API_BASE}/api/instruments/discover?q=${encodeURIComponent(query)}`, { signal }); return payload.instruments; }
export async function addInstrument(instrument: Pick<Instrument, "symbol" | "exchange" | "lotSize" | "name" | "providerSymbol" | "instrumentType"> | string): Promise<Instrument> { const normalized = typeof instrument === "string" ? { symbol: instrument.trim().toUpperCase(), exchange: instrument.trim().toUpperCase().endsWith(".BO") ? "BSE" : "NSE", lotSize: 1, name: null, providerSymbol: instrument.trim().toUpperCase(), instrumentType: "EQUITY" } : instrument; const payload = await json<{ instrument: Instrument }>(`${API_BASE}/api/instruments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol: normalized.symbol, exchange: normalized.exchange, lotSize: normalized.lotSize, name: normalized.name ?? null, providerSymbol: normalized.providerSymbol ?? normalized.symbol, instrumentType: normalized.instrumentType ?? "EQUITY" }) }); return payload.instrument; }
export async function getMarketHistory(symbol: string, timeframeOrSignal: string | AbortSignal = "1d", signal?: AbortSignal, limit = 120): Promise<PriceBar[]> { const timeframe = typeof timeframeOrSignal === "string" ? timeframeOrSignal : "1d"; const requestSignal = typeof timeframeOrSignal === "string" ? signal : timeframeOrSignal; const capped = Math.max(1, Math.min(1000, Math.round(limit))); const payload = await json<{ rows?: PriceBar[] }>(`${API_BASE}/api/market/${encodeURIComponent(symbol)}/history?timeframe=${encodeURIComponent(timeframe)}&limit=${capped}`, { signal: requestSignal }); return payload.rows ?? []; }
export async function getCoverage(symbol: string, timeframe = "1d", signal?: AbortSignal): Promise<Coverage> { return json<Coverage>(`${API_BASE}/api/market/${encodeURIComponent(symbol)}/coverage?timeframe=${encodeURIComponent(timeframe)}`, { signal }); }
export async function getPerformance(symbol: string, period = "1M", timeframe = "1d", signal?: AbortSignal): Promise<Performance> { return json<Performance>(`${API_BASE}/api/market/${encodeURIComponent(symbol)}/performance?period=${encodeURIComponent(period)}&timeframe=${encodeURIComponent(timeframe)}`, { signal }); }
export async function getWatchlist(signal?: AbortSignal): Promise<WatchlistItem[]> { const payload = await json<{ items: WatchlistItem[] }>(`${API_BASE}/api/watchlist`, { signal }); return payload.items; }
export async function addToWatchlist(symbol: string, note?: string): Promise<WatchlistItem> { const payload = await json<{ item: WatchlistItem }>(`${API_BASE}/api/watchlist`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol, note }) }); return payload.item; }
export async function removeFromWatchlist(symbol: string): Promise<void> { await json(`${API_BASE}/api/watchlist/${encodeURIComponent(symbol)}`, { method: "DELETE" }); }
export async function getLatestSignal(symbol: string, signal?: AbortSignal): Promise<Signal | null> { const payload = await json<{ ok: boolean; signal?: Signal | null }>(`${API_BASE}/api/signals/latest?symbol=${encodeURIComponent(symbol)}`, { signal }); if (!payload.ok || !payload.signal) return null; const signalRow = payload.signal; const parameters = signalRow.parameters ?? {}; const embedded = parameters.tradeThesis ?? parameters.trade_thesis; return { ...signalRow, tradeThesis: signalRow.tradeThesis ?? (embedded as TradeThesis | null | undefined) ?? null }; }
export async function runDecisionAgent(question: string, model: string | null, handlers: { onText?: (text: string) => void; onEvent?: (event: string, data: any) => void }, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${API_BASE}/api/ai/agent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question, model: model || undefined, stream: true }), signal });
  if (!response.ok || !response.body) throw new Error(`Agent request failed (${response.status})`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const lines = frame.split("\n");
      const event = lines.find(line => line.startsWith("event:"))?.slice(6).trim() || "message";
      const dataLine = lines.find(line => line.startsWith("data:"));
      if (!dataLine) continue;
      try {
        const data = JSON.parse(dataLine.slice(5).trim());
        handlers.onEvent?.(event, data);
        if (event === "answer" && typeof data.delta === "string") handlers.onText?.(data.delta);
      } catch { /* ignore malformed SSE frame */ }
    }
  }
}

export async function approveDecisionAgent(runId: string, callId: string, approved: boolean): Promise<{ ok: boolean; resolved: boolean; note?: string | null }> {
  return json(`${API_BASE}/api/ai/agent/approval`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId, callId, approved }),
  });
}

export async function getDecisionCandidateScan(symbols: string[], horizon: "1d" | "3d" | "5d" = "1d", signal?: AbortSignal): Promise<{ ok: boolean; horizon: string; count: number; candidates: DecisionCandidate[]; disclaimer?: string }> {
  const clean = symbols.map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 8);
  const params = new URLSearchParams({ symbols: clean.join(","), horizon });
  return json(`${API_BASE}/api/ai/candidate-scan?${params.toString()}`, { signal });
}

export async function getDecisionCandidate(symbol: string, horizon: "1d" | "3d" | "5d" = "1d", signal?: AbortSignal): Promise<DecisionCandidate> {
  const payload = await json<{ ok: boolean; summary: string; data: DecisionCandidate }>(`${API_BASE}/api/ai/candidate?symbol=${encodeURIComponent(symbol)}&horizon=${encodeURIComponent(horizon)}`, { signal });
  return payload.data;
}
export async function getOptionChain(symbol: string, signal?: AbortSignal): Promise<OptionRow[]> { const payload = await json<{ rows: OptionRow[] }>(`${API_BASE}/api/options/chain?symbol=${encodeURIComponent(symbol)}`, { signal }); return payload.rows; }
export async function getOptionIntelligence(symbol: string, signal?: AbortSignal): Promise<OptionIntelligence> { return json<OptionIntelligence>(`${API_BASE}/api/options/intelligence?symbol=${encodeURIComponent(symbol)}`, { signal }); }
export async function placeOptionPaperOrder(input: { symbol: string; expiry: string; strike: number; optionType: "CE" | "PE"; side: "BUY" | "SELL"; lots: number }): Promise<{ id: string; entryPrice: number }> { const payload = await json<{ order: { id: string; entryPrice: number } }>(`${API_BASE}/api/shadow/paper-orders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }); return payload.order; }
export async function getOptionPaperTrades(): Promise<PaperOptionTrade[]> { const payload = await json<{ trades: PaperOptionTrade[] }>(`${API_BASE}/api/shadow/paper-trades`); return payload.trades; }
export async function closeOptionPaperTrade(id: string): Promise<{ realizedPnl: number; exitPrice: number }> { return json<{ realizedPnl: number; exitPrice: number }>(`${API_BASE}/api/shadow/paper-trades/${encodeURIComponent(id)}/close`, { method: "POST" }); }
export async function getForecast(symbol: string, horizonOrSignal: number | AbortSignal = 5, signal?: AbortSignal): Promise<Forecast | null> { const horizon = typeof horizonOrSignal === "number" ? horizonOrSignal : 5; const requestSignal = typeof horizonOrSignal === "number" ? signal : horizonOrSignal; const payload = await json<Forecast & { ok?: boolean }>(`${API_BASE}/api/forecast?symbol=${encodeURIComponent(symbol)}&horizon=${Math.max(1, Math.min(30, Math.round(horizon)))}`, { signal: requestSignal }); return payload.ok === false ? null : payload; }
export async function getPaperState(signal?: AbortSignal): Promise<PaperState> { return json<PaperState>(`${API_BASE}/api/paper/state`, { signal }); }
export async function createPaperAccount(startingCapital: number): Promise<void> { await json(`${API_BASE}/api/paper/account`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ startingCapital }) }); }
export type PaperOrderInput = { symbol: string; side: "BUY" | "SELL" | "HOLD"; product?: PaperProduct; quantity?: number; orderType?: OrderType; limitPrice?: number; note?: string };
export type PaperPlaceResult = { ok: boolean; order: PaperOrder & { marketPrice?: number }; cash: number; message: string; quoteTimestamp?: string; queued?: boolean };
export async function placePaperOrder(input: PaperOrderInput): Promise<PaperPlaceResult> { return json(`${API_BASE}/api/paper/orders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }); }
export async function getPaperEstimate(input: { side: "BUY" | "SELL"; product: PaperProduct; quantity: number; price: number }, signal?: AbortSignal): Promise<{ charges: ChargeBreakdown; gross: number; net: number; margin: number }> { return json(`${API_BASE}/api/paper/estimate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal }); }
export async function cancelPaperOrder(id: string): Promise<{ ok: boolean; status: string }> { return json(`${API_BASE}/api/paper/orders/${encodeURIComponent(id)}/cancel`, { method: "POST" }); }
export async function depositPaperFunds(amount: number): Promise<{ ok: boolean; deposited: number; startingCapital: number; cash: number }> { return json(`${API_BASE}/api/paper/deposit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amount }) }); }
export async function resetPaperAccount(mode: "trades" | "all" = "trades"): Promise<{ ok: boolean; reset: string }> { return json(`${API_BASE}/api/paper/reset`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) }); }
export async function getPaperAnalytics(days = 90, signal?: AbortSignal): Promise<PaperAnalytics> { return json<PaperAnalytics>(`${API_BASE}/api/paper/analytics?days=${Math.max(1, Math.min(3650, Math.round(days)))}`, { signal }); }
export function paperExportUrl(days = 3650): string { return `${API_BASE}/api/paper/export.csv?days=${Math.max(1, Math.min(3650, Math.round(days)))}`; }
export function paperLiveUrl(): string { return `${API_BASE.replace(/^http/, "ws").replace(/\/+$/, "")}/live`; }
export type LiveMessage = { type: "state"; state: PaperState } | { type: "quote"; symbol: string; quote: MarketOverview } | { type: "alert"; alert: BuyAlert } | { type: string };
export type BuyAlert = { id: number; symbol: string; rule: string; evidence: Record<string, unknown>; price: number | null; marketTimestamp: string | null; newToRadar: boolean; acknowledged: boolean; createdAt: string | null };
export type AlertsResult = { ok: boolean; alerts: BuyAlert[]; unreadCount: number; error?: string; disclaimer?: string };
export async function getAlerts(limit = 20, symbol?: string, signal?: AbortSignal): Promise<AlertsResult> {
  const params = new URLSearchParams({ limit: String(Math.max(1, Math.min(100, Math.round(limit)))) });
  if (symbol) params.set("symbol", symbol);
  const payload = await json<AlertsResult>(`${API_BASE}/api/alerts?${params.toString()}`, { signal });
  return payload.ok ? payload : { ...payload, alerts: payload.alerts ?? [], unreadCount: payload.unreadCount ?? 0 };
}
export async function ackAlert(id: number): Promise<{ ok: boolean; id: number }> { return json(`${API_BASE}/api/alerts/${id}/ack`, { method: "POST" }); }
export async function ackAllAlerts(): Promise<{ ok: boolean; acknowledged: number }> { return json(`${API_BASE}/api/alerts/ack-all`, { method: "POST" }); }
export async function getMarketScan(limit = 5, signal?: AbortSignal): Promise<{ picks: MarketPick[]; excluded: Array<{ symbol: string; reason: string }>; asOf: string; methodology: string; disclaimer: string }> { return json(`${API_BASE}/api/market/scan?limit=${Math.max(1, Math.min(5, Math.round(limit)))}`, { signal }); }
export async function getPredictionPerformance(days = 30, signal?: AbortSignal): Promise<PredictionPerformance> { return json<PredictionPerformance>(`${API_BASE}/api/predictions/performance?days=${Math.max(1, Math.min(365, Math.round(days)))}`, { signal }); }
export async function getLivePrediction(symbol: string, horizon: 1 | 3 | 5 = 1, signal?: AbortSignal): Promise<LivePrediction | null> { try { const payload = await json<LivePrediction & { ok?: boolean }>(`${API_BASE}/api/predictions/live?symbol=${encodeURIComponent(symbol)}&horizon=${horizon}d`, { signal }); return payload.ok === false ? null : payload; } catch { return null; } }
export type BacktestStrategy = "buy_hold" | "sma_trend" | "vol_expansion";
export type BacktestTrade = { entryTimestamp: string; exitTimestamp: string; entryPrice: number; exitPrice: number; quantity: number; grossPnl: number; costs: number; netPnl: number; exitReason: "SIGNAL" | "END_OF_HISTORY" };
export type BacktestResult = { ok: boolean; symbol: string; strategy: BacktestStrategy; bars: number; smaWindow: number; initialCapital: number; finalEquity: number; totalReturn: number; cagr: number; maxDrawdown: number; sharpePerTradeAnnualized: number | null; trades: number; wins: number; losses: number; winRate: number | null; profitFactor: number | null; totalCosts: number; equityCurve: Array<{ timestamp: string; equity: number; buyHold: number }>; tradeLog: BacktestTrade[] };
export async function getBacktest(symbol: string, strategy: BacktestStrategy = "sma_trend", days = 365, signal?: AbortSignal): Promise<BacktestResult | null> { const payload = await json<BacktestResult>(`${API_BASE}/api/backtest/${encodeURIComponent(symbol)}?strategy=${encodeURIComponent(strategy)}&days=${Math.max(60, Math.min(1825, Math.round(days)))}`, { signal }); return payload.ok ? payload : null; }
export async function getResearch(symbol: string, signal?: AbortSignal): Promise<ResearchResult> { const payload = await json<{ research: ResearchResult }>(`${RESEARCH_BASE}/api/research/${encodeURIComponent(symbol)}`, { signal }); return payload.research; }
export async function analyzeIPO(input: IPOInput, signal?: AbortSignal): Promise<IPOAnalysis> { const payload = await json<{ analysis: IPOAnalysis }>(`${API_BASE}/api/ipo/analyze`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal }); return payload.analysis; }

export type TrainingInstrumentRow = { symbol: string; horizon: string; instrument_type: string | null; daily_bars: number; bars_required: number; latest_bar: string | null; training_end: string | null; model_state: "UP_TO_DATE" | "STALE" | "TRAINING_REQUIRED" | "INSUFFICIENT_HISTORY" | "WAITING_FOR_DATA"; reason: string; data_status: "LIVE" | "STALE" | "ABSENT"; model_version: string | null; promotion_ready: boolean | null; meta_ready: boolean | null };
export type TrainingCoverage = { ok: boolean; summary: { activeInstruments: number; horizons: string[]; productionModels: number; upToDate: number; trainingRequired: number; insufficientHistory: number; waitingForData: number; generatedAt: string }; instruments: TrainingInstrumentRow[] };
export type TrainingRunReport = { ok: boolean; training_run_id?: string; trigger?: string; status?: string; summary?: { total: number; trained: number; upToDate: number; skipped: number; failed: number }; instruments?: Array<Record<string, unknown>>; instrument?: Record<string, unknown>; message?: string; error?: string };

export async function getTrainingCoverage(signal?: AbortSignal): Promise<TrainingCoverage> { return json<TrainingCoverage>(`${API_BASE}/api/training/coverage`, { signal }); }
export async function runTraining(body: { forceSymbols?: string[]; trigger?: string } = {}): Promise<TrainingRunReport> { return json<TrainingRunReport>(`${API_BASE}/api/training/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trigger: body.trigger ?? "MANUAL", forceSymbols: body.forceSymbols ?? null }) }); }
export async function retrainStale(): Promise<TrainingRunReport> { return json<TrainingRunReport>(`${API_BASE}/api/training/retrain-stale`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) }); }
export async function retrainSymbol(symbol: string): Promise<TrainingRunReport> { return json<TrainingRunReport>(`${API_BASE}/api/training/${encodeURIComponent(symbol)}/retrain`, { method: "POST" }); }

// --- Optional bring-your-own-key AI assistant (NVIDIA NIM or any
// OpenAI-compatible endpoint). The key lives in the user's local database; the
// browser only ever sees the masked form the backend returns.
export type AiStatus = { ok: boolean; configured: boolean; enabled: boolean; source: "saved" | "env" | null; maskedKey: string | null; looksLikeNvidiaKey: boolean | null; baseUrl: string; model: string | null; disclaimer: string; removed?: boolean; note?: string | null };
export type AiConfigInput = { apiKey?: string; baseUrl?: string; model?: string | null; enabled?: boolean };
export type AiModelsResult = { ok: boolean; models: string[]; nemotron: string[]; count?: number; error?: string; message?: string };
export type AiEvidenceBlock = { label: string; data: unknown; asOf?: string | null };
export type AiMessage = { role: "user" | "assistant"; content: string };
export type AiChatResult = { ok: boolean; text: string; model: string | null; error?: string; message?: string };

export async function getAiStatus(signal?: AbortSignal): Promise<AiStatus> { return json<AiStatus>(`${API_BASE}/api/ai/status`, { signal }); }
export async function saveAiConfig(input: AiConfigInput): Promise<AiStatus> { return json<AiStatus>(`${API_BASE}/api/ai/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }); }
export async function clearAiConfig(): Promise<AiStatus> { return json<AiStatus>(`${API_BASE}/api/ai/config`, { method: "DELETE" }); }
export async function getAiModels(signal?: AbortSignal): Promise<AiModelsResult> {
  const payload = await json<AiModelsResult & { models?: string[] }>(`${API_BASE}/api/ai/models`, { signal });
  return { ...payload, models: payload.models ?? [], nemotron: payload.nemotron ?? [] };
}

/** Streams one answer, forwarding tokens as they arrive. Provider-side failures
 * come back as an ok:false result rather than a thrown error so the caller can
 * show the exact reason (bad key, no credits, rate limit) instead of "it hung". */
export async function streamAiChat(input: { question: string; evidence?: AiEvidenceBlock[]; messages?: AiMessage[]; marketContext?: string | null; onToken: (token: string) => void; signal?: AbortSignal }): Promise<AiChatResult> {
  const response = await fetch(`${API_BASE}/api/ai/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ question: input.question, evidence: input.evidence ?? [], messages: input.messages ?? [], marketContext: input.marketContext ?? null, stream: true }),
    signal: input.signal,
  });
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !contentType.includes("text/event-stream")) {
    const body = await response.json().catch(() => null) as { error?: string; message?: string; model?: string } | null;
    return { ok: false, text: "", model: body?.model ?? null, error: body?.error ?? `AI_REQUEST_FAILED`, message: body?.message ?? `Assistant request failed (HTTP ${response.status}).` };
  }
  if (!response.body) return { ok: false, text: "", model: null, error: "AI_NO_STREAM", message: "The assistant returned no stream to read." };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let model: string | null = null;
  let failure: { error?: string; message?: string } | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line.startsWith("event:")) {
        if (line.slice(6).trim() === "aierror") failure = { error: "AI_STREAM_INTERRUPTED" };
        continue;
      }
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let parsed: Record<string, unknown> | null = null;
      try { parsed = JSON.parse(payload) as Record<string, unknown>; } catch { continue; }
      if (parsed.ok === true && typeof parsed.model === "string") { model = parsed.model; continue; }
      if (parsed.ok === false) { failure = { error: typeof parsed.error === "string" ? parsed.error : "AI_STREAM_ERROR", message: typeof parsed.message === "string" ? parsed.message : undefined }; continue; }
      const choices = Array.isArray(parsed.choices) ? parsed.choices as Array<Record<string, unknown>> : [];
      const delta = choices[0]?.delta as Record<string, unknown> | undefined;
      const piece = typeof delta?.content === "string" ? delta.content : typeof choices[0]?.text === "string" ? choices[0].text as string : "";
      if (piece) { text += piece; input.onToken(piece); }
    }
  }
  if (failure) return { ok: false, text, model, error: failure.error ?? "AI_STREAM_ERROR", message: failure.message ?? "The assistant could not complete this answer." };
  if (!text.trim()) return { ok: false, text: "", model, error: "AI_EMPTY_RESPONSE", message: "The model returned an empty answer. Try rephrasing, or pick a smaller model in assistant settings." };
  return { ok: true, text, model };
}

export type AgentTraceEntry = {
  callId: string;
  step: number;
  tool: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  summary: string;
  durationMs: number;
  truncated: boolean;
  /** True when the tool changes app state rather than only reading it. */
  write: boolean;
  /** How the gate cleared it: your approval, or the reason the tool never ran. */
  approval: "APPROVED" | "REFUSED" | "TIMED_OUT" | "NO_GATE" | null;
  /** The raw JSON the local tool measured, for the user to audit. */
  result?: unknown;
};

/** A change the agent wants to make and cannot make without your click. */
export type AgentApprovalRequest = {
  runId: string;
  callId: string;
  step: number;
  tool: string;
  arguments: Record<string, unknown>;
  description: string;
  timeoutMs: number;
};

/** The user's click coming back as an event, so the card can settle. */
export type AgentApprovalOutcome = { callId: string; approved: boolean; source: string };

export type AgentResult = AiChatResult & { trace: AgentTraceEntry[]; steps: number; toolCalls: number; runId: string | null };

/** Runs one bounded investigation: the model calls local tools (real stored
 * bars, the real backtest engine, a fresh forecast from the user's own
 * artifacts) and the trace arrives as it happens. A tool that would change app
 * state parks until onApproval resolves; if nobody decides, it does not run.
 * A failed tool is reported as failed, never replaced with a plausible number. */
export async function runAiAgent(input: {
  question: string;
  evidence?: AiEvidenceBlock[];
  marketContext?: string | null;
  onTool?: (entry: AgentTraceEntry) => void;
  onApproval?: (request: AgentApprovalRequest) => void;
  onApprovalResolved?: (outcome: AgentApprovalOutcome) => void;
  onToken: (token: string) => void;
  signal?: AbortSignal;
}): Promise<AgentResult> {
  const empty: AgentResult = { ok: false, text: "", model: null, trace: [], steps: 0, toolCalls: 0, runId: null };
  const response = await fetch(`${API_BASE}/api/ai/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ question: input.question, evidence: input.evidence ?? [], marketContext: input.marketContext ?? null }),
    signal: input.signal,
  });
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !contentType.includes("text/event-stream")) {
    const body = await response.json().catch(() => null) as { error?: string; message?: string } | null;
    return { ...empty, error: body?.error ?? "AGENT_REQUEST_FAILED", message: body?.message ?? `Agent request failed (HTTP ${response.status}).` };
  }
  if (!response.body) return { ...empty, error: "AGENT_NO_STREAM", message: "The agent returned no stream to read." };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const trace: AgentTraceEntry[] = [];
  let buffer = "";
  let eventName = "";
  let text = "";
  let model: string | null = null;
  let steps = 0;
  let toolCalls = 0;
  let runId: string | null = null;
  let failure: { error?: string; message?: string } | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line.startsWith("event:")) { eventName = line.slice(6).trim(); continue; }
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let parsed: Record<string, unknown> | null = null;
      try { parsed = JSON.parse(payload) as Record<string, unknown>; } catch { continue; }
      if (eventName === "meta") {
        if (typeof parsed.model === "string") model = parsed.model;
        if (typeof parsed.runId === "string") runId = parsed.runId;
      } else if (eventName === "tool") {
        const entry = parsed as unknown as AgentTraceEntry;
        trace.push(entry);
        input.onTool?.(entry);
      } else if (eventName === "approval") {
        const request = parsed as unknown as AgentApprovalRequest;
        if (request.callId) input.onApproval?.({ ...request, runId: request.runId || runId || "" });
      } else if (eventName === "approval_resolved") {
        input.onApprovalResolved?.({ callId: String(parsed.callId ?? ""), approved: parsed.approved === true, source: String(parsed.source ?? "user") });
      } else if (eventName === "answer") {
        const piece = typeof parsed.delta === "string" ? parsed.delta : "";
        if (piece) { text += piece; input.onToken(piece); }
      } else if (eventName === "done") {
        steps = Number(parsed.steps ?? 0);
        toolCalls = Number(parsed.toolCalls ?? 0);
        if (Array.isArray(parsed.trace) && !trace.length) trace.push(...(parsed.trace as AgentTraceEntry[]));
      } else if (eventName === "aierror") {
        failure = { error: typeof parsed.error === "string" ? parsed.error : "AGENT_FAILED", message: typeof parsed.message === "string" ? parsed.message : undefined };
        if (Array.isArray(parsed.trace)) trace.push(...(parsed.trace as AgentTraceEntry[]));
      }
      eventName = "";
    }
  }
  if (failure) return { ok: false, text, model, runId, error: failure.error ?? "AGENT_FAILED", message: failure.message ?? "The investigation could not complete.", trace, steps, toolCalls };
  if (!text.trim()) return { ok: false, text: "", model, runId, error: "AGENT_EMPTY_RESPONSE", message: "The agent finished without an answer.", trace, steps, toolCalls };
  return { ok: true, text, model, runId, trace, steps, toolCalls };
}

/** Applies or refuses one parked change. The backend treats no decision as a refusal. */
export async function resolveAgentApproval(runId: string, callId: string, approved: boolean): Promise<boolean> {
  const response = await fetch(`${API_BASE}/api/ai/agent/approval`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runId, callId, approved }),
  });
  const body = (await response.json().catch(() => null)) as { resolved?: boolean } | null;
  return body?.resolved === true;
}
