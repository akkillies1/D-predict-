import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, BarChart3, BrainCircuit,
  CheckCircle2, Database, Gauge, RefreshCw, Search, ShieldAlert, Target, Wifi, WifiOff, Zap, BookmarkPlus,
} from "lucide-react";
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
  BarChart, Bar, ReferenceLine,
} from "recharts";
import { addToWatchlist, getForecast, getInstruments, getLatestSignal, getLiveQuote, getLocalHealth, getMarketHistory, getOptionChain, getResearch, type Forecast, type MarketOverview, type OptionRow, type PriceBar, type ResearchResult, type Signal } from "@/lib/localApi";
import { chooseInitialSymbol } from "@/lib/dashboard";
import LiveTickerSearch from "@/components/LiveTickerSearch";

const STORAGE_KEY = "dpredict:selected-symbol";

function pct(value?: number | null) { return value == null || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(1)}%`; }
function price(value?: number | null) { return value == null || !Number.isFinite(value) ? "—" : `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`; }
function duration(seconds?: number) {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}
function tone(direction?: string) { return direction === "BULLISH" || direction === "LONG" ? "text-[#c8f169]" : direction === "BEARISH" || direction === "SHORT" ? "text-[#ff9d91]" : "text-[#e5b55f]"; }
function borderTone(direction?: string) { return direction === "BULLISH" || direction === "LONG" ? "border-[#476238]" : direction === "BEARISH" || direction === "SHORT" ? "border-[#633d38]" : "border-[#5b4b2b]"; }

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <section className={`rounded-2xl border border-[#1d332f] bg-[#0b1714] shadow-[0_18px_50px_rgba(0,0,0,.16)] ${className}`}>{children}</section>;
}
function Label({ children }: { children: React.ReactNode }) { return <div className="font-mono-ui text-[9px] uppercase tracking-[.18em] text-[#70887d]">{children}</div>; }
function DecisionPill({ decision, confidence }: { decision?: string; confidence?: number }) {
  const value = decision ?? "NO DECISION";
  return <div className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 font-mono-ui text-xs font-semibold tracking-[.08em] ${borderTone(decision)} ${tone(decision)} bg-[#0a1512]`}><span className="h-2 w-2 rounded-full bg-current" />{value}{confidence != null ? ` · ${Math.round(confidence * 100)}%` : ""}</div>;
}
function Metric({ label, value, sub, icon: Icon }: { label: string; value: string; sub: string; icon: typeof Activity }) {
  return <Card className="p-4"><div className="flex items-start justify-between"><span className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#28453b] bg-[#10231e] text-[#a8c879]"><Icon size={15}/></span><span className="font-mono-ui text-[9px] text-[#557067]">LIVE</span></div><Label>{label}</Label><div className="mt-1 font-display text-2xl font-bold tracking-tight text-[#eff7ea]">{value}</div><div className="mt-1 text-[10px] text-[#789087]">{sub}</div></Card>;
}

export default function DecisionDashboard() {
  const [symbol, setSymbol] = useState(() => localStorage.getItem(STORAGE_KEY) || "NIFTY");
  const [instrumentName, setInstrumentName] = useState<string | null>(null);
  const [forecastHorizon, setForecastHorizon] = useState(5);
  const [market, setMarket] = useState<MarketOverview | null>(null);
  const [history, setHistory] = useState<PriceBar[]>([]);
  const [signal, setSignal] = useState<Signal | null>(null);
  const [options, setOptions] = useState<OptionRow[]>([]);
  const [research, setResearch] = useState<ResearchResult | null>(null);
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [watchlistSaved, setWatchlistSaved] = useState(false);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);

  const selectSymbol = useCallback(async (next: string, name?: string | null) => {
    const value = next.trim().toUpperCase();
    if (!value) return;
    setSymbol(value);
    setInstrumentName(name ?? null);
    localStorage.setItem(STORAGE_KEY, value);
    window.dispatchEvent(new Event("dpredict:symbol"));
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const health = await getLocalHealth();
      setConnected(health.ok);
      const [live, bars, latest, researchResult, forecastResult] = await Promise.allSettled([
        getLiveQuote(symbol), getMarketHistory(symbol, "1d"), getLatestSignal(symbol), getResearch(symbol), getForecast(symbol, forecastHorizon),
      ]);
      setMarket(live.status === "fulfilled" ? live.value : null);
      setHistory(bars.status === "fulfilled" ? bars.value : []);
      setSignal(latest.status === "fulfilled" ? latest.value : null);
      setResearch(researchResult.status === "fulfilled" ? researchResult.value : null);
      setForecast(forecastResult.status === "fulfilled" ? forecastResult.value : null);
      const chain = await getOptionChain(symbol).catch(() => []);
      setOptions(chain);
      setLastUpdate(new Date().toISOString());
    } finally { setLoading(false); }
  }, [forecastHorizon, symbol]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { const t = window.setInterval(() => void refresh(), 15000); return () => window.clearInterval(t); }, [refresh]);
  useEffect(() => {
    let cancelled = false;
    void getInstruments().then((instruments) => {
      if (cancelled) return;
      const next = chooseInitialSymbol(localStorage.getItem(STORAGE_KEY), instruments);
      setInstrumentName(instruments.find((item) => item.symbol === next)?.name ?? null);
      if (next !== symbol) {
        setSymbol(next);
        localStorage.setItem(STORAGE_KEY, next);
      }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const thesis = signal?.tradeThesis;
  const chart = useMemo(() => history.map(bar => ({ time: new Date(bar.timestamp).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }), close: bar.close, high: bar.high, low: bar.low })), [history]);
  const optionSummary = useMemo(() => {
    const grouped = new Map<number, { strike: number; ceOi: number; peOi: number; ceLtp: number | null; peLtp: number | null }>();
    for (const row of options) { const item = grouped.get(row.strike) ?? { strike: row.strike, ceOi: 0, peOi: 0, ceLtp: null, peLtp: null }; if (row.option_type === "CE") { item.ceOi = row.oi ?? 0; item.ceLtp = row.ltp; } else { item.peOi = row.oi ?? 0; item.peLtp = row.ltp; } grouped.set(row.strike, item); }
    return [...grouped.values()].sort((a,b) => a.strike-b.strike);
  }, [options]);
  const decision = thesis?.decision ?? signal?.direction;
  const dataStatus = market?.status ?? "OFFLINE";
  const tradeReady = thesis?.decision === "EXECUTABLE";
  const saveToWatchlist = useCallback(async () => {
    try { await addToWatchlist(symbol); setWatchlistSaved(true); } catch { setWatchlistSaved(false); }
  }, [symbol]);
  const blockers = [
    !signal ? "No stored model signal" : null,
    signal && !thesis ? "Trade thesis unavailable" : null,
    thesis && thesis.distributionStatus !== "CALIBRATED" ? `Distribution: ${thesis.distributionStatus ?? "unknown"}` : null,
    dataStatus === "STALE" || dataStatus === "OFFLINE" ? `Market data ${dataStatus.toLowerCase()}` : null,
  ].filter(Boolean) as string[];

  return <div className="min-h-screen cockpit-shell text-[#eaf4e9]">
    <div className="pointer-events-none fixed inset-0 cockpit-grid opacity-60" />
    <header className="sticky top-0 z-40 border-b border-[#173029] bg-[#07100f]/95 backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1800px] flex-wrap items-center gap-3 px-4 py-3 lg:px-8">
        <div className="flex items-center gap-2 mr-2"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#c8f169] text-[#10200b]"><BrainCircuit size={18}/></span><div><div className="font-display text-sm font-bold tracking-tight">D—PREDICT</div><div className="font-mono-ui text-[8px] tracking-[.18em] text-[#70887d]">DECISION INTELLIGENCE TERMINAL</div></div></div>
        <LiveTickerSearch value={symbol} onChange={selectSymbol}/>
        <nav className="hidden items-center gap-1 xl:flex ml-2">{["Decision", "Market", "Forecast", "Derivatives", "Evidence", "Risk"].map((item, i) => <a key={item} href={`#${item.toLowerCase()}`} className={`rounded-lg px-3 py-2 font-mono-ui text-[9px] uppercase tracking-[.12em] ${i===0 ? "bg-[#142a25] text-[#c8f169]" : "text-[#789087] hover:text-[#d9e9dc]"}`}>{item}</a>)}</nav>
        <div className="ml-auto flex items-center gap-2"><span className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono-ui text-[9px] ${connected ? "border-[#3d5b38] bg-[#142419] text-[#c8f169]" : "border-[#5a4328] bg-[#21180e] text-[#e5b55f]"}`}>{connected ? <Wifi size={11}/> : <WifiOff size={11}/>} {connected ? "LOCAL LIVE" : "OFFLINE"}</span><button onClick={() => void refresh()} disabled={loading} className="rounded-lg border border-[#26453a] p-2 text-[#a8bdb2] hover:bg-[#12251f]"><RefreshCw size={14} className={loading ? "animate-spin" : ""}/></button></div>
      </div>
    </header>

    <main className="relative mx-auto max-w-[1800px] space-y-5 px-4 py-5 lg:px-8">
      <section id="decision" className={`rounded-2xl border ${tradeReady ? "border-[#476238]" : "border-[#5a432a]"} bg-gradient-to-br from-[#10201b] to-[#09120f] p-5 shadow-[0_25px_80px_rgba(0,0,0,.22)]`}>
        <div className="flex flex-wrap items-start justify-between gap-5"><div><Label>Executive decision / {symbol}</Label><h1 className="mt-2 font-display text-3xl font-bold tracking-tight lg:text-4xl">What should the decision maker do?</h1><p className="mt-2 max-w-3xl text-sm leading-relaxed text-[#8fa69a]">{instrumentName ? `${instrumentName} (${symbol})` : symbol}. D-Predict separates forecast from tradeability. A directional model signal is not treated as an executable trade until the distribution, data quality, target/stop and risk gates agree.</p></div><div className="flex items-center gap-2"><button onClick={() => void saveToWatchlist()} className="inline-flex items-center gap-2 rounded-lg border border-[#345346] px-3 py-2 font-mono-ui text-[9px] uppercase tracking-[.12em] text-[#c8f169] hover:bg-[#142a25]"><BookmarkPlus size={14}/>{watchlistSaved ? "Saved" : "Watchlist"}</button><DecisionPill decision={decision} confidence={thesis?.confidence ?? signal?.confidence}/></div></div>
        <div className="mt-6 grid gap-4 lg:grid-cols-[1.35fr_.65fr]">
          <div className={`rounded-xl border ${tradeReady ? "border-[#3d5932] bg-[#102016]" : "border-[#5a432a] bg-[#1b160d]"} p-5`}>
            <div className="flex items-center gap-3"><span className={`flex h-12 w-12 items-center justify-center rounded-xl ${tradeReady ? "bg-[#c8f169] text-[#11210b]" : "bg-[#3a2b17] text-[#e5b55f]"}`}>{tradeReady ? <CheckCircle2 size={25}/> : <AlertTriangle size={25}/>}</span><div><div className="font-mono-ui text-[9px] tracking-[.16em] text-[#70887d]">PRIMARY ACTION · {instrumentName ?? symbol}</div><div className={`font-display text-3xl font-bold ${tradeReady ? "text-[#d7f883]" : "text-[#e5b55f]"}`}>{tradeReady ? `${thesis?.signal ?? decision}` : "WAIT / NO TRADE"}</div></div></div>
            <div className="mt-5 grid gap-3 sm:grid-cols-4"><Metric label="Entry" value={price(thesis?.entryPrice ?? market?.close)} sub="next executable reference" icon={Target}/><Metric label="Expected" value={thesis?.expectedReturn == null ? "—" : `${(thesis.expectedReturn*100).toFixed(2)}%`} sub="model return forecast" icon={Activity}/><Metric label="Horizon" value={thesis?.horizon ?? "—"} sub="requested holding window" icon={Gauge}/><Metric label="R / R" value={thesis?.riskRewardToTarget1 == null ? "—" : thesis.riskRewardToTarget1.toFixed(2)} sub="target 1 vs stop" icon={ShieldAlert}/></div>
          </div>
          <div className="rounded-xl border border-[#203a32] bg-[#08130f] p-5"><div className="flex items-center gap-2"><ShieldAlert size={15} className="text-[#e5b55f]"/><Label>Decision blockers</Label></div>{blockers.length ? <div className="mt-4 space-y-2">{blockers.map(item => <div key={item} className="flex gap-2 rounded-lg border border-[#3c3120] bg-[#15120c] px-3 py-2 text-xs text-[#c8b582]"><span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[#e5b55f]"/>{item}</div>)}</div> : <div className="mt-5 flex items-center gap-2 text-sm text-[#c8f169]"><CheckCircle2 size={16}/> No current decision blockers.</div>}<div className="mt-5 border-t border-[#1d332f] pt-4 font-mono-ui text-[9px] text-[#5f766c]">DATA STATUS: {dataStatus} · UPDATED: {lastUpdate ? new Date(lastUpdate).toLocaleTimeString("en-IN") : "—"}</div></div>
        </div>
      </section>

      <section id="market" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Spot" value={price(market?.close)} sub={`${market?.source ?? "no source"} · ${dataStatus}`} icon={Activity}/>
        <Metric label="Day range" value={market?.low != null && market?.high != null ? `${market.low.toLocaleString("en-IN")} – ${market.high.toLocaleString("en-IN")}` : "—"} sub="observed OHLC range" icon={BarChart3}/>
        <Metric label="Signal confidence" value={pct(signal?.confidence)} sub={signal?.regime ?? "regime unavailable"} icon={Zap}/>
        <Metric label="Research agreement" value={research ? pct(research.agreement) : "—"} sub={research ? `${research.evidenceScore}/100 evidence` : "research service unavailable"} icon={Database}/>
      </section>

      <section className="grid gap-5 xl:grid-cols-[1.45fr_.55fr]">
        <Card className="p-5"><div className="flex items-end justify-between"><div><Label>Price action / live local feed</Label><h2 className="mt-1 font-display text-xl font-semibold">{symbol}</h2></div><span className="font-mono-ui text-[9px] text-[#70887d]">{history.length} bars</span></div><div className="mt-4 h-[340px]">{chart.length ? <ResponsiveContainer width="100%" height="100%"><AreaChart data={chart}><defs><linearGradient id="dpPrice" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#c8f169" stopOpacity={.25}/><stop offset="100%" stopColor="#c8f169" stopOpacity={0}/></linearGradient></defs><CartesianGrid stroke="#18302a" strokeDasharray="3 5" vertical={false}/><XAxis dataKey="time" tick={{fill:"#70887d",fontSize:9}} axisLine={false} tickLine={false} minTickGap={35}/><YAxis domain={["auto","auto"]} tick={{fill:"#70887d",fontSize:9}} axisLine={false} tickLine={false} width={60}/><Tooltip contentStyle={{background:"#0b1714",border:"1px solid #29463b",borderRadius:8,color:"#eaf4e9"}}/><Area type="monotone" dataKey="close" stroke="#c8f169" strokeWidth={2} fill="url(#dpPrice)" dot={false}/></AreaChart></ResponsiveContainer> : <Empty text="No historical bars returned by the local API."/>}</div></Card>
        <Card className="p-5"><Label>Model decision / reasons</Label><div className={`mt-2 font-display text-3xl font-bold ${tone(signal?.direction)}`}>{signal?.direction ?? "NO SIGNAL"}</div><div className="mt-1 text-xs text-[#789087]">{signal?.regime ?? "No regime classification"} · model {signal?.modelVersion ?? "—"}</div><div className="mt-5 space-y-2">{signal?.reasonCodes?.length ? signal.reasonCodes.map(reason => <div key={reason} className="flex items-start gap-2 rounded-lg border border-[#1d332f] bg-[#09130f] p-3 text-xs text-[#bdc9c1]"><span className="mt-1 h-1.5 w-1.5 rounded-full bg-[#c8f169]"/>{reason}</div>) : <Empty text="No reason codes available."/>}</div></Card>
      </section>

      <section id="projection" className="grid gap-5 lg:grid-cols-[1.15fr_.85fr]">
        <Card className="p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><Label>Research forecast / {instrumentName ?? symbol}</Label><h2 className="mt-1 font-display text-xl font-semibold">Next {forecastHorizon} trading days</h2></div><select value={forecastHorizon} onChange={(event) => setForecastHorizon(Number(event.target.value))} className="rounded-lg border border-[#26453a] bg-[#10211c] px-3 py-2 font-mono-ui text-[10px] text-[#d7e8d9] outline-none"><option value={3}>3 days</option><option value={5}>5 days</option><option value={10}>10 days</option><option value={20}>20 days</option></select></div>{forecast ? <><div className="mt-4 grid gap-3 sm:grid-cols-4"><Metric label="Expected value" value={price(forecast.expectedValue)} sub={`${(forecast.expectedReturn * 100).toFixed(2)}% expected move`} icon={Target}/><Metric label="Forecast range" value={`${price(forecast.forecastRange.low)} - ${price(forecast.forecastRange.high)}`} sub="p10 to p90 distribution" icon={BarChart3}/><Metric label="Direction odds" value={pct(Math.max(forecast.probabilityAboveSpot, forecast.probabilityBelowSpot))} sub={`${forecast.strategy.direction} distribution bias`} icon={Gauge}/><Metric label="History" value={`${forecast.daysOfHistoryUsed} days`} sub="daily observations used" icon={Database}/></div><div className="mt-4 grid gap-3 md:grid-cols-2"><div className="rounded-xl border border-[#29463b] bg-[#09130f] p-4"><Label>Execution / position strategy</Label><div className={`mt-2 font-display text-2xl font-bold ${tone(forecast.strategy.direction)}`}>{forecast.strategy.action} · {forecast.strategy.direction}</div><p className="mt-2 text-xs leading-relaxed text-[#bdc9c1]">{forecast.strategy.rationale}</p><div className="mt-3 text-[10px] leading-relaxed text-[#8fa69a]"><strong className="text-[#c8f169]">Position sizing:</strong> {forecast.strategy.positionSizing}</div>{forecast.actionSuggestions?.length ? <div className="mt-4 space-y-2">{forecast.actionSuggestions.map((item, index) => <div key={item} className="flex gap-2 rounded-lg border border-[#1d332f] px-3 py-2 text-[10px] text-[#aebeb3]"><span className="font-mono-ui text-[#c8f169]">{index + 1}</span>{item}</div>)}</div> : null}</div><div className="rounded-xl border border-[#3c3120] bg-[#15120c] p-4"><Label>Why this can change</Label><p className="mt-2 text-xs leading-relaxed text-[#c8b582]"><strong>Invalidation:</strong> {forecast.strategy.invalidation}</p><p className="mt-3 text-[10px] leading-relaxed text-[#897b5a]">Expected value is the distribution median, not a promise. This baseline does not include news, gaps, liquidity or causal fundamentals.</p></div></div></> : <Empty text="No forecast available. At least 20 daily observations are required; the engine will not fabricate a projection."/>}</Card>
        <Card className="p-5"><Label>Decision engine review</Label><h2 className="mt-1 font-display text-xl font-semibold">Principles and drawbacks</h2><div className="mt-4 space-y-3"><div className="rounded-lg border border-[#29463b] bg-[#09130f] p-3 text-xs text-[#bdc9c1]"><strong className="text-[#c8f169]">Principle:</strong> separate forecast, evidence, tradeability and execution. Each gate should be independently measurable.</div><div className="rounded-lg border border-[#3c3120] bg-[#15120c] p-3 text-xs text-[#c8b582]"><strong>Current drawbacks:</strong> statistical drift is not causal, history may be thin, news can invalidate the distribution, and a median forecast can hide tail risk.</div><div className="rounded-lg border border-[#1d332f] bg-[#09130f] p-3 text-xs text-[#9fb4a8]"><strong className="text-[#d7e8d9]">Improvement path:</strong> walk-forward calibration, regime-specific residuals, event and liquidity features, probability calibration, and paper execution measured against slippage.</div>{forecast?.limitations.map((limitation) => <div key={limitation} className="text-[10px] leading-relaxed text-[#71877d]">- {limitation}</div>)}</div></Card>
      </section>

      <section id="forecast" className="grid gap-5 lg:grid-cols-[1.15fr_.85fr]">
        <Card className="p-5"><div className="flex items-center justify-between"><div><Label>Trade thesis / price distribution</Label><h2 className="mt-1 font-display text-xl font-semibold">Targets, stop & probability</h2></div><Target size={18} className="text-[#c8f169]"/></div>{thesis ? <><div className="mt-4 grid gap-3 sm:grid-cols-4"><Metric label="Entry" value={price(thesis.entryPrice)} sub="thesis entry" icon={Target}/><Metric label="Probability" value={pct(thesis.probability)} sub="directional thesis" icon={Gauge}/><Metric label="Expected move" value={thesis.expectedReturn == null ? "—" : `${(thesis.expectedReturn*100).toFixed(2)}%`} sub="conditional forecast" icon={Activity}/><Metric label="Stop" value={price(thesis.stop?.price)} sub={thesis.stop?.probability != null ? `${pct(thesis.stop.probability)} stop event` : "distribution tail"} icon={ShieldAlert}/></div><div className="mt-4 grid gap-3 md:grid-cols-3">{(thesis.targets ?? []).map((target, i) => <div key={`${target.price}-${i}`} className="rounded-xl border border-[#29463b] bg-[#09130f] p-4"><div className="flex justify-between"><Label>Target {i+1}</Label><span className="font-mono-ui text-xs text-[#c8f169]">{pct(target.probability)}</span></div><div className="mt-2 font-display text-2xl font-semibold">{price(target.price)}</div><div className="mt-2 font-mono-ui text-[9px] text-[#789087]">ETA {duration(target.timing?.p50Seconds)} · range {duration(target.timing?.p25Seconds)}–{duration(target.timing?.p75Seconds)}</div></div>)}</div></> : <Empty text="No executable trade thesis. D-Predict will not invent targets, stop or ETA."/>}</Card>
        <Card className="p-5"><Label>Confidence ladder</Label><div className="mt-5 space-y-4">{[["Forecast", thesis?.confidence ?? signal?.confidence],["Research", research?.confidence],["Evidence agreement", research?.agreement],["Data quality", market ? (market.status === "LIVE" ? 1 : market.status === "CACHED" ? .8 : market.status === "STALE" ? .35 : 0) : 0]].map(([name,value]) => <div key={name as string}><div className="mb-1 flex justify-between text-xs"><span className="text-[#a9bbb0]">{name}</span><span className="font-mono-ui text-[#c8f169]">{value == null ? "—" : pct(value as number)}</span></div><div className="h-2 overflow-hidden rounded-full bg-[#172a25]"><div className="h-full rounded-full bg-[#a9d45e]" style={{width:value == null ? "0%" : `${Math.max(0,Math.min(100,(value as number)*100))}%`}}/></div></div>)}</div><div className="mt-6 rounded-xl border border-[#293f35] bg-[#09130f] p-4 text-[10px] leading-relaxed text-[#71877d]">Confidence is displayed as evidence, not certainty. Promotion and live execution remain separate gates.</div></Card>
      </section>

      <section id="derivatives" className="grid gap-5 lg:grid-cols-[1fr_.6fr]">
        <Card className="p-5"><div className="flex items-center justify-between"><div><Label>Derivatives / option intelligence</Label><h2 className="mt-1 font-display text-xl font-semibold">{symbol} option chain</h2></div><BarChart3 size={18} className="text-[#789087]"/></div>{optionSummary.length ? <div className="mt-4 h-[280px]"><ResponsiveContainer width="100%" height="100%"><BarChart data={optionSummary}><CartesianGrid stroke="#18302a" strokeDasharray="3 5" vertical={false}/><XAxis dataKey="strike" tick={{fill:"#70887d",fontSize:9}}/><YAxis tick={{fill:"#70887d",fontSize:9}}/><Tooltip contentStyle={{background:"#0b1714",border:"1px solid #29463b"}}/>{market?.close != null && <ReferenceLine x={market.close} stroke="#e5b55f" strokeDasharray="4 4"/>}<Bar dataKey="ceOi" fill="#c8f169" name="CE OI"/><Bar dataKey="peOi" fill="#f0776b" name="PE OI"/></BarChart></ResponsiveContainer></div> : <Empty text="No option-chain snapshot available for this instrument."/>}</Card>
        <Card className="p-5"><Label>Derivative decision</Label><div className="mt-3 space-y-3">{options.slice(0,8).map(row => <div key={`${row.expiry_date}-${row.strike}-${row.option_type}`} className="flex items-center justify-between rounded-lg border border-[#1d332f] bg-[#09130f] px-3 py-2"><span className="font-mono-ui text-[9px] text-[#789087]">{row.strike} {row.option_type}</span><span className="font-mono-ui text-[10px]">LTP {row.ltp ?? "—"}</span><span className="font-mono-ui text-[10px] text-[#9fb4a8]">OI {row.oi ?? "—"}</span></div>)}{!options.length && <Empty text="No live derivative snapshot."/>}</div></Card>
      </section>

      <section id="evidence" className="grid gap-5 lg:grid-cols-[.8fr_1.2fr]">
        <Card className="p-5"><Label>Evidence stack</Label><div className={`mt-3 font-display text-3xl font-bold ${tone(research?.direction)}`}>{research?.direction ?? "UNAVAILABLE"}</div><div className="mt-2 text-sm text-[#8fa69a]">{research ? `${research.evidenceScore}/100 evidence · ${pct(research.agreement)} source agreement` : "Start the local research service to populate this panel."}</div><div className="mt-5 space-y-2">{research?.themes?.slice(0,8).map(theme => <div key={theme} className="rounded-lg border border-[#1d332f] px-3 py-2 text-xs text-[#b9c8bd]">{theme}</div>)}</div></Card>
        <Card className="p-5"><div className="flex items-center justify-between"><div><Label>Decision-maker watchlist</Label><h2 className="mt-1 font-display text-xl font-semibold">What could invalidate this view?</h2></div><AlertTriangle size={18} className="text-[#e5b55f]"/></div><div className="mt-4 grid gap-3 md:grid-cols-2">{[...(research?.risks ?? []), ...(signal?.reasonCodes?.filter(x => /risk|caution|weak|stale|insufficient/i.test(x)) ?? []), ...(blockers.length ? blockers : ["No explicit blocker recorded"])].slice(0,8).map(item => <div key={item} className="rounded-xl border border-[#3c3120] bg-[#15120c] p-4 text-xs leading-relaxed text-[#c8b582]"><span className="mr-2 text-[#e5b55f]">!</span>{item}</div>)}</div></Card>
      </section>

      <section id="risk" className="grid gap-4 md:grid-cols-3"><Metric label="Execution gate" value={tradeReady ? "READY" : "BLOCKED"} sub={tradeReady ? "thesis says executable" : "forecast ≠ trade"} icon={CheckCircle2}/><Metric label="Market freshness" value={dataStatus} sub={market?.collectedAt ? new Date(market.collectedAt).toLocaleTimeString("en-IN") : "no collection timestamp"} icon={Wifi}/><Metric label="Research evidence" value={research ? `${research.evidenceScore}/100` : "—"} sub="context layer only; not an order engine" icon={Database}/></section>

      <footer className="border-t border-[#183029] py-5 text-[9px] leading-relaxed text-[#587068]">D-Predict is a research/evaluation/simulation system. This dashboard displays model outputs and evidence supplied by the local services; it does not guarantee returns and does not send broker orders. Missing or stale data is shown explicitly rather than fabricated.</footer>
    </main>
  </div>;
}

function Empty({ text }: { text: string }) { return <div className="flex min-h-28 items-center justify-center rounded-xl border border-dashed border-[#315045] p-5 text-center text-xs text-[#789087]">{text}</div>; }
