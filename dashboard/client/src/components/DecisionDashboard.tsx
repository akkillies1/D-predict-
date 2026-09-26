import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  BrainCircuit,
  CheckCircle2,
  Database,
  Gauge,
  Loader2,
  RefreshCw,
  Search,
  ShieldAlert,
  Target,
  Wifi,
  WifiOff,
  Zap,
  BookmarkPlus,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  BarChart,
  Bar,
  ReferenceLine,
} from "recharts";
import {
  addToWatchlist,
  getForecast,
  getInstruments,
  getLatestSignal,
  getLiveQuote,
  getLocalHealth,
  getLivePrediction,
  getMarketHistory,
  getMarketScan,
  getPredictionPerformance,
  getOptionChain,
  getResearch,
  paperLiveUrl,
  type Forecast,
  type LiveMessage,
  type MarketOverview,
  type MarketPick,
  type OptionRow,
  type LivePrediction,
  type PredictionPerformance,
  type PriceBar,
  type ResearchResult,
  type Signal,
} from "@/lib/localApi";
import { chooseInitialSymbol } from "@/lib/dashboard";
import LiveTickerSearch from "@/components/LiveTickerSearch";
import MarketSessionClock from "@/components/MarketSessionClock";
import TradingDesk from "@/components/TradingDesk";
import PriceChart, { type ChartOverlays } from "@/components/PriceChart";

const STORAGE_KEY = "dpredict:selected-symbol";
const TIMEFRAME_KEY = "dpredict:chart-timeframe";

type ChartTimeframe = "1m" | "1d" | "1w" | "1mo";
const TIMEFRAMES: Array<{ id: ChartTimeframe; label: string; unit: string; hint: string }> = [
  { id: "1m", label: "1m", unit: "minute", hint: "One-minute bars from the live collector feed" },
  { id: "1d", label: "1D", unit: "daily", hint: "Daily bars" },
  { id: "1w", label: "1W", unit: "weekly", hint: "Weekly bars aggregated from persisted daily bars (Mon–Sun sessions)" },
  { id: "1mo", label: "1M", unit: "monthly", hint: "Monthly bars aggregated from persisted daily bars" },
];

function istDayKey(value: string) { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value)); }
function bucketKey(value: string, mode: "day" | "week" | "month") {
  const day = istDayKey(value);
  if (mode === "day") return day;
  if (mode === "month") return day.slice(0, 7);
  const [y, m, d] = day.split("-").map(Number);
  const utc = Date.UTC(y, m - 1, d);
  const dow = new Date(utc).getUTCDay();
  const weekStart = new Date(utc - ((dow + 6) % 7) * 86400000);
  return `${weekStart.getUTCFullYear()}-${String(weekStart.getUTCMonth() + 1).padStart(2, "0")}-${String(weekStart.getUTCDate()).padStart(2, "0")}`;
}
function resampleBars(bars: PriceBar[], mode: "week" | "month"): PriceBar[] {
  const groups = new Map<string, PriceBar[]>();
  for (const bar of bars) { const key = bucketKey(bar.timestamp, mode); const rows = groups.get(key); if (rows) rows.push(bar); else groups.set(key, [bar]); }
  return [...groups.values()].map(rows => {
    const volumes = rows.map(row => row.volume).filter((value): value is number => value != null);
    return { timestamp: rows[rows.length - 1].timestamp, open: rows[0].open, high: Math.max(...rows.map(row => row.high)), low: Math.min(...rows.map(row => row.low)), close: rows[rows.length - 1].close, volume: volumes.length ? volumes.reduce((sum, value) => sum + value, 0) : null };
  });
}
function formatBarTime(timestamp: string, timeframe: ChartTimeframe) {
  const date = new Date(timestamp);
  if (timeframe === "1m") return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  if (timeframe === "1mo") return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", month: "short", year: "2-digit" }).format(date);
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short" }).format(date);
}

const CHART_LEGEND: Array<{ key: keyof ChartOverlays; label: string; color: string }> = [
  { key: "sma20", label: "SMA20", color: "#e5b55f" },
  { key: "ema12", label: "EMA12", color: "#76b9ff" },
  { key: "ema26", label: "EMA26", color: "#d19cff" },
  { key: "volume", label: "VOLUME", color: "#70887d" },
  { key: "cone", label: "BASELINE P10·P50·P90", color: "#c8f169" },
];

function pct(value?: number | null) {
  return value == null || !Number.isFinite(value)
    ? "—"
    : `${(value * 100).toFixed(1)}%`;
}
function price(value?: number | null) {
  return value == null || !Number.isFinite(value)
    ? "—"
    : `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}
function duration(seconds?: number) {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  if (s >= 86400)
    return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  if (s >= 3600)
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}
function tone(direction?: string) {
  return direction === "BULLISH" || direction === "LONG"
    ? "text-[#c8f169]"
    : direction === "BEARISH" || direction === "SHORT"
      ? "text-[#ff9d91]"
      : "text-[#e5b55f]";
}
function borderTone(direction?: string) {
  return direction === "BULLISH" || direction === "LONG"
    ? "border-[#476238]"
    : direction === "BEARISH" || direction === "SHORT"
      ? "border-[#633d38]"
      : "border-[#5b4b2b]";
}

function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-2xl border border-[#1d332f] bg-[#0b1714] shadow-[0_18px_50px_rgba(0,0,0,.16)] ${className}`}
    >
      {children}
    </section>
  );
}
function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono-ui text-[9px] uppercase tracking-[.18em] text-[#70887d]">
      {children}
    </div>
  );
}
function DecisionPill({
  decision,
  confidence,
}: {
  decision?: string;
  confidence?: number;
}) {
  const value = decision ?? "NO DECISION";
  return (
    <div
      className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 font-mono-ui text-xs font-semibold tracking-[.08em] ${borderTone(decision)} ${tone(decision)} bg-[#0a1512]`}
    >
      <span className="h-2 w-2 rounded-full bg-current" />
      {value}
      {confidence != null ? ` · ${Math.round(confidence * 100)}%` : ""}
    </div>
  );
}
function Metric({
  label,
  value,
  sub,
  icon: Icon,
}: {
  label: string;
  value: string;
  sub: string;
  icon: typeof Activity;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#28453b] bg-[#10231e] text-[#a8c879]">
          <Icon size={15} />
        </span>
        <span className="font-mono-ui text-[9px] text-[#557067]">LIVE</span>
      </div>
      <Label>{label}</Label>
      <div className="mt-1 font-display text-2xl font-bold tracking-tight text-[#eff7ea]">
        {value}
      </div>
      <div className="mt-1 text-[10px] text-[#789087]">{sub}</div>
    </Card>
  );
}

export default function DecisionDashboard() {
  const [symbol, setSymbol] = useState(
    () => localStorage.getItem(STORAGE_KEY) || "NIFTY"
  );
  const [instrumentName, setInstrumentName] = useState<string | null>(null);
  const [forecastHorizon, setForecastHorizon] = useState<1 | 3 | 5>(5);
  const [market, setMarket] = useState<MarketOverview | null>(null);
  const [history, setHistory] = useState<PriceBar[]>([]);
  const [chartTimeframe, setChartTimeframe] = useState<ChartTimeframe>(() => {
    const saved = localStorage.getItem(TIMEFRAME_KEY);
    return saved === "1m" || saved === "1w" || saved === "1mo" ? saved : "1d";
  });
  const [liveQuote, setLiveQuote] = useState<MarketOverview | null>(null);
  const [chartOverlays, setChartOverlays] = useState<ChartOverlays>({ sma20: true, ema12: true, ema26: true, volume: true, cone: true });
  const wsRef = useRef<WebSocket | null>(null);
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;
  const [signal, setSignal] = useState<Signal | null>(null);
  const [options, setOptions] = useState<OptionRow[]>([]);
  const [research, setResearch] = useState<ResearchResult | null>(null);
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [marketPicks, setMarketPicks] = useState<MarketPick[]>([]);
  const [predictionPerformance, setPredictionPerformance] = useState<PredictionPerformance | null>(null);
  const [livePrediction, setLivePrediction] = useState<LivePrediction | null>(null);
  const [scanExcluded, setScanExcluded] = useState<
    Array<{ symbol: string; reason: string }>
  >([]);
  const [scanLoading, setScanLoading] = useState(false);
  const [watchlistSaved, setWatchlistSaved] = useState(false);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [enrichmentLoading, setEnrichmentLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const refreshSequence = useRef(0);
  const predictionGate = useRef({ key: "", until: 0, wait: 15000 });

  const selectSymbol = useCallback(
    async (next: string, name?: string | null) => {
      const value = next.trim().toUpperCase();
      if (!value) return;
      refreshSequence.current += 1;
      setLoading(true);
      setSymbol(value);
      setInstrumentName(name ?? null);
      setMarket(null);
      setHistory([]);
      setSignal(null);
      setResearch(null);
      setForecast(null);
      setOptions([]);
      setLivePrediction(null);
      setWatchlistSaved(false);
      localStorage.setItem(STORAGE_KEY, value);
      window.dispatchEvent(new Event("dpredict:symbol"));
    },
    []
  );

  const refresh = useCallback(async () => {
    const requestId = ++refreshSequence.current;
    setLoading(true);
    try {
      const [health, live, bars, latest, forecastResult] = await Promise.allSettled([
        getLocalHealth(),
        getLiveQuote(symbol),
        getMarketHistory(symbol, chartTimeframe === "1m" ? "1m" : "1d", undefined, chartTimeframe === "1m" ? 400 : chartTimeframe === "1d" ? 140 : 520),
        getLatestSignal(symbol),
        getForecast(symbol, forecastHorizon),
      ]);
      if (requestId !== refreshSequence.current) return;
      setConnected(health.status === "fulfilled" && health.value.ok);
      setMarket(live.status === "fulfilled" ? live.value : null);
      setHistory(bars.status === "fulfilled" ? bars.value : []);
      setSignal(latest.status === "fulfilled" ? latest.value : null);
      setForecast(
        forecastResult.status === "fulfilled" ? forecastResult.value : null
      );
      setLastUpdate(new Date().toISOString());
      setLoading(false);
      setEnrichmentLoading(true);

      // When the model endpoint honestly 503s (no promoted model), back off
      // exponentially instead of hammering it every cycle and flooding the console.
      const predictionKey = `${symbol}:${forecastHorizon}`;
      const gate = predictionGate.current;
      const skipPrediction = gate.key === predictionKey && Date.now() < gate.until;

      const [researchResult, scanResult, performanceResult, livePredictionResult, chainResult] =
        await Promise.allSettled([
          getResearch(symbol),
          getMarketScan(5),
          getPredictionPerformance(30),
          skipPrediction ? Promise.resolve(null) : getLivePrediction(symbol, forecastHorizon),
          getOptionChain(symbol),
        ]);
      if (requestId !== refreshSequence.current) return;
      if (!skipPrediction) {
        const value = livePredictionResult.status === "fulfilled" ? livePredictionResult.value : null;
        setLivePrediction(value);
        if (value) { gate.key = predictionKey; gate.wait = 15000; gate.until = 0; }
        else { gate.wait = Math.min(300000, Math.max(15000, gate.key === predictionKey ? gate.wait : 15000) * 2); gate.key = predictionKey; gate.until = Date.now() + gate.wait; }
      }
      setResearch(
        researchResult.status === "fulfilled" ? researchResult.value : null
      );
      setMarketPicks(
        scanResult.status === "fulfilled" ? scanResult.value.picks : []
      );
      setScanExcluded(
        scanResult.status === "fulfilled" ? scanResult.value.excluded : []
      );
      setPredictionPerformance(
        performanceResult.status === "fulfilled" ? performanceResult.value : null
      );
      setOptions(chainResult.status === "fulfilled" ? chainResult.value : []);
      setLastUpdate(new Date().toISOString());
    } finally {
      if (requestId === refreshSequence.current) setLoading(false);
      if (requestId === refreshSequence.current) setEnrichmentLoading(false);
    }
  }, [chartTimeframe, forecastHorizon, symbol]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const t = window.setInterval(() => void refresh(), 15000);
    return () => window.clearInterval(t);
  }, [refresh]);
  useEffect(() => {
    let cancelled = false;
    void getInstruments()
      .then(instruments => {
        if (cancelled) return;
        const next = chooseInitialSymbol(
          localStorage.getItem(STORAGE_KEY),
          instruments
        );
        setInstrumentName(
          instruments.find(item => item.symbol === next)?.name ?? null
        );
        if (next !== symbol) {
          setSymbol(next);
          localStorage.setItem(STORAGE_KEY, next);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: number | undefined;
    let closed = false;
    const connect = () => {
      try { socket = new WebSocket(paperLiveUrl()); } catch { return; }
      wsRef.current = socket;
      socket.onopen = () => socket?.send(JSON.stringify({ type: "watch", symbol: symbolRef.current }));
      socket.onmessage = event => {
        let message: LiveMessage; try { message = JSON.parse(String(event.data)) as LiveMessage; } catch { return; }
        if (message.type === "quote") {
          const envelope = message as Extract<LiveMessage, { type: "quote" }>;
          if (envelope.symbol === symbolRef.current && envelope.quote?.ok) setLiveQuote(envelope.quote as MarketOverview);
        }
      };
      socket.onclose = () => { wsRef.current = null; if (!closed) retry = window.setTimeout(connect, 4000); };
      socket.onerror = () => socket?.close();
    };
    connect();
    return () => { closed = true; if (retry) window.clearTimeout(retry); socket?.close(); wsRef.current = null; };
  }, []);
  useEffect(() => {
    setLiveQuote(null);
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: "watch", symbol }));
  }, [symbol]);

  const thesis = signal?.tradeThesis;
  const liveActive = liveQuote?.status === "LIVE" && liveQuote.close != null && !!liveQuote.timestamp;
  const displayBars = useMemo(() => {
    const base = chartTimeframe === "1w" || chartTimeframe === "1mo" ? resampleBars(history, chartTimeframe === "1w" ? "week" : "month") : history;
    const quote = liveQuote;
    if (!quote || quote.close == null || !quote.timestamp || (quote.status !== "LIVE" && quote.status !== "CACHED")) return base;
    const bars = [...base];
    const last = bars[bars.length - 1];
    if (chartTimeframe === "1m") {
      // The hub quote carries the newest persisted 1-minute bar verbatim: refresh it in
      // place, or append it when it opens a new minute. Nothing is interpolated.
      if (last && last.timestamp === quote.timestamp) bars[bars.length - 1] = { ...last, open: quote.open ?? last.open, high: quote.high ?? last.high, low: quote.low ?? last.low, close: quote.close, volume: quote.volume ?? last.volume };
      else if (!last || Date.parse(quote.timestamp) > Date.parse(last.timestamp)) bars.push({ timestamp: quote.timestamp, open: quote.open ?? quote.close, high: quote.high ?? quote.close, low: quote.low ?? quote.close, close: quote.close, volume: quote.volume });
      return bars;
    }
    const mode = chartTimeframe === "1d" ? "day" : chartTimeframe === "1w" ? "week" : "month";
    const quoteKey = bucketKey(quote.timestamp, mode);
    const lastKey = last ? bucketKey(last.timestamp, mode) : null;
    if (last && quoteKey === lastKey) {
      // The forming bucket's close becomes the live last price; OHLC extremes only widen.
      bars[bars.length - 1] = { ...last, high: Math.max(last.high, quote.high ?? last.high), low: Math.min(last.low, quote.low ?? last.low), close: quote.close };
    } else if (!last || (lastKey && quoteKey > lastKey)) {
      bars.push({ timestamp: quote.timestamp, open: quote.close, high: quote.close, low: quote.close, close: quote.close, volume: null });
    }
    return bars;
  }, [chartTimeframe, history, liveQuote]);
  const chart = useMemo(
    () => {
      const bars = displayBars.map((bar, index) => {
        const closes = displayBars.slice(Math.max(0, index - 19), index + 1).map(item => item.close);
        const ema12Window = displayBars.slice(Math.max(0, index - 11), index + 1).map(item => item.close);
        const ema26Window = displayBars.slice(Math.max(0, index - 25), index + 1).map(item => item.close);
        const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
        return { ...bar, sma20: average(closes), ema12: average(ema12Window), ema26: average(ema26Window), time: formatBarTime(bar.timestamp, chartTimeframe) };
      });
      // The forecast cone projects trading days ahead; it is only meaningful on the daily axis.
      const bands = chartTimeframe === "1d" ? forecast?.bands ?? [] : [];
      const values = [...bars.flatMap(bar => [bar.high, bar.low]), ...bands.flatMap(band => [band.p10, band.p90])].filter(Number.isFinite);
      const min = values.length ? Math.min(...values) : 0;
      const max = values.length ? Math.max(...values) : 1;
      return { bars, min, max: max === min ? min + 1 : max, volumeMax: Math.max(1, ...bars.map(bar => bar.volume ?? 0)), bands };
    },
    [chartTimeframe, displayBars, forecast]
  );
  const optionSummary = useMemo(() => {
    const grouped = new Map<
      number,
      {
        strike: number;
        ceOi: number;
        peOi: number;
        ceLtp: number | null;
        peLtp: number | null;
      }
    >();
    for (const row of options) {
      const item = grouped.get(row.strike) ?? {
        strike: row.strike,
        ceOi: 0,
        peOi: 0,
        ceLtp: null,
        peLtp: null,
      };
      if (row.option_type === "CE") {
        item.ceOi = row.oi ?? 0;
        item.ceLtp = row.ltp;
      } else {
        item.peOi = row.oi ?? 0;
        item.peLtp = row.ltp;
      }
      grouped.set(row.strike, item);
    }
    return [...grouped.values()].sort((a, b) => a.strike - b.strike);
  }, [options]);
  const decision = thesis?.decision ?? signal?.direction;
  const dataStatus = market?.status ?? "OFFLINE";
  const tradeReady = thesis?.decision === "EXECUTABLE";
  const saveToWatchlist = useCallback(async () => {
    try {
      await addToWatchlist(symbol);
      setWatchlistSaved(true);
    } catch {
      setWatchlistSaved(false);
    }
  }, [symbol]);
  const refreshScan = useCallback(async () => {
    setScanLoading(true);
    try {
      const result = await getMarketScan(5);
      setMarketPicks(result.picks);
      setScanExcluded(result.excluded);
    } finally {
      setScanLoading(false);
    }
  }, []);
  const blockers = [
    !signal ? "No stored model signal" : null,
    signal && !thesis ? "Trade thesis unavailable" : null,
    thesis && thesis.distributionStatus !== "CALIBRATED"
      ? `Distribution: ${thesis.distributionStatus ?? "unknown"}`
      : null,
    dataStatus === "STALE" || dataStatus === "OFFLINE"
      ? `Market data ${dataStatus.toLowerCase()}`
      : null,
  ].filter(Boolean) as string[];
  const isRefreshing = loading || enrichmentLoading;

  return (
    <div className="min-h-screen cockpit-shell text-[#eaf4e9]">
      <div className="pointer-events-none fixed inset-0 cockpit-grid opacity-60" />
      <header className="sticky top-0 z-40 border-b border-[#173029] bg-[#07100f]/95 backdrop-blur-xl">
        {isRefreshing ? <div className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-[#173029]"><div className="h-full w-1/3 animate-[loading-bar_1.2s_ease-in-out_infinite] bg-[#c8f169]" /></div> : null}
        <div className="mx-auto flex max-w-[1800px] flex-wrap items-center gap-3 px-4 py-3 lg:px-8">
          <div className="flex items-center gap-2 mr-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#c8f169] text-[#10200b]">
              <BrainCircuit size={18} />
            </span>
            <div>
              <div className="font-display text-sm font-bold tracking-tight">
                D—PREDICT
              </div>
              <div className="font-mono-ui text-[8px] tracking-[.18em] text-[#70887d]">
                DECISION INTELLIGENCE TERMINAL
              </div>
            </div>
          </div>
          <LiveTickerSearch value={symbol} onChange={selectSymbol} />
          <nav className="hidden items-center gap-1 xl:flex ml-2">
            {[
              "Decision",
              "Market",
              "Forecast",
              "Derivatives",
              "Evidence",
              "Risk",
              "Paper Lab",
            ].map((item, i) => (
              <a
                key={item}
                href={`#${item === "Paper Lab" ? "paper-lab" : item.toLowerCase()}`}
                className={`rounded-lg px-3 py-2 font-mono-ui text-[9px] uppercase tracking-[.12em] ${i === 0 ? "bg-[#142a25] text-[#c8f169]" : "text-[#789087] hover:text-[#d9e9dc]"}`}
              >
                {item}
              </a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <MarketSessionClock className="hidden md:inline-flex" />
            <span
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono-ui text-[9px] ${connected ? "border-[#3d5b38] bg-[#142419] text-[#c8f169]" : "border-[#5a4328] bg-[#21180e] text-[#e5b55f]"}`}
            >
              {connected ? <Wifi size={11} /> : <WifiOff size={11} />}{" "}
              {connected ? "LOCAL LIVE" : "OFFLINE"}
            </span>
            <button
              onClick={() => void refresh()}
              disabled={loading}
              className="flex items-center gap-2 rounded-lg border border-[#26453a] px-2 py-2 text-[#a8bdb2] hover:bg-[#12251f]"
              aria-label={isRefreshing ? "Loading instrument" : "Refresh instrument"}
            >
              {isRefreshing ? <Loader2 size={14} className="animate-spin text-[#c8f169]" /> : <RefreshCw size={14} />}
              {isRefreshing ? <span className="hidden font-mono-ui text-[9px] uppercase tracking-[.12em] text-[#c8f169] sm:inline">Loading</span> : null}
            </button>
          </div>
        </div>
      </header>

      <main className="relative mx-auto max-w-[1800px] space-y-5 px-4 py-5 lg:px-8">
        {isRefreshing ? <div className="flex items-center gap-3 rounded-xl border border-[#36513e] bg-[#0d211a] px-4 py-3 text-xs text-[#c8f169] animate-pulse"><Loader2 size={15} className="animate-spin" /><span>{loading ? <>Loading live data for <strong>{symbol}</strong>...</> : <>Finishing analysis for <strong>{symbol}</strong>...</>}</span><span className="ml-auto hidden text-[10px] text-[#789087] sm:inline">{loading ? "Core data first" : "Research and signals updating"}</span></div> : null}
        <section
          id="decision"
          className={`rounded-2xl border ${tradeReady ? "border-[#476238]" : "border-[#5a432a]"} bg-gradient-to-br from-[#10201b] to-[#09120f] p-5 shadow-[0_25px_80px_rgba(0,0,0,.22)]`}
        >
          <div className="flex flex-wrap items-start justify-between gap-5">
            <div>
              <Label>Executive decision / {symbol}</Label>
              <h1 className="mt-2 font-display text-3xl font-bold tracking-tight lg:text-4xl">
                What should the decision maker do?
              </h1>
              <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[#8fa69a]">
                {instrumentName ? `${instrumentName} (${symbol})` : symbol}.
                D-Predict separates forecast from tradeability. A directional
                model signal is not treated as an executable trade until the
                distribution, data quality, target/stop and risk gates agree.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void saveToWatchlist()}
                className="inline-flex items-center gap-2 rounded-lg border border-[#345346] px-3 py-2 font-mono-ui text-[9px] uppercase tracking-[.12em] text-[#c8f169] hover:bg-[#142a25]"
              >
                <BookmarkPlus size={14} />
                {watchlistSaved ? "Saved" : "Watchlist"}
              </button>
              <DecisionPill
                decision={decision}
                confidence={thesis?.confidence ?? signal?.confidence}
              />
            </div>
          </div>
          <div className="mt-6 grid gap-4 lg:grid-cols-[1.35fr_.65fr]">
            <div
              className={`rounded-xl border ${tradeReady ? "border-[#3d5932] bg-[#102016]" : "border-[#5a432a] bg-[#1b160d]"} p-5`}
            >
              <div className="flex items-center gap-3">
                <span
                  className={`flex h-12 w-12 items-center justify-center rounded-xl ${tradeReady ? "bg-[#c8f169] text-[#11210b]" : "bg-[#3a2b17] text-[#e5b55f]"}`}
                >
                  {tradeReady ? (
                    <CheckCircle2 size={25} />
                  ) : (
                    <AlertTriangle size={25} />
                  )}
                </span>
                <div>
                  <div className="font-mono-ui text-[9px] tracking-[.16em] text-[#70887d]">
                    PRIMARY ACTION
                  </div>
                  <div className="mt-1 font-display text-lg font-semibold text-[#eff7ea]">
                    {instrumentName ?? symbol}
                  </div>
                  <div className="font-mono-ui text-[9px] text-[#789087]">
                    {symbol}
                  </div>
                  <div
                    className={`mt-1 font-display text-3xl font-bold ${tradeReady ? "text-[#d7f883]" : "text-[#e5b55f]"}`}
                  >
                    {tradeReady
                      ? `${thesis?.signal ?? decision}`
                      : "WAIT / NO TRADE"}
                  </div>
                </div>
              </div>
              <div className="mt-5 grid gap-3 sm:grid-cols-4">
                <Metric
                  label="Entry"
                  value={price(thesis?.entryPrice ?? market?.close)}
                  sub="next executable reference"
                  icon={Target}
                />
                <Metric
                  label="Expected"
                  value={
                    thesis?.expectedReturn == null
                      ? "—"
                      : `${(thesis.expectedReturn * 100).toFixed(2)}%`
                  }
                  sub="model return forecast"
                  icon={Activity}
                />
                <Metric
                  label="Horizon"
                  value={thesis?.horizon ?? "—"}
                  sub="requested holding window"
                  icon={Gauge}
                />
                <Metric
                  label="R / R"
                  value={
                    thesis?.riskRewardToTarget1 == null
                      ? "—"
                      : thesis.riskRewardToTarget1.toFixed(2)
                  }
                  sub="target 1 vs stop"
                  icon={ShieldAlert}
                />
              </div>
            </div>
            <div className="rounded-xl border border-[#203a32] bg-[#08130f] p-5">
              <div className="flex items-center gap-2">
                <ShieldAlert size={15} className="text-[#e5b55f]" />
                <Label>Decision blockers</Label>
              </div>
              {blockers.length ? (
                <div className="mt-4 space-y-2">
                  {blockers.map(item => (
                    <div
                      key={item}
                      className="flex gap-2 rounded-lg border border-[#3c3120] bg-[#15120c] px-3 py-2 text-xs text-[#c8b582]"
                    >
                      <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[#e5b55f]" />
                      {item}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-5 flex items-center gap-2 text-sm text-[#c8f169]">
                  <CheckCircle2 size={16} /> No current decision blockers.
                </div>
              )}
              <div className="mt-5 border-t border-[#1d332f] pt-4 font-mono-ui text-[9px] text-[#5f766c]">
                DATA STATUS: {dataStatus} · UPDATED:{" "}
                {lastUpdate
                  ? new Date(lastUpdate).toLocaleTimeString("en-IN")
                  : "—"}
              </div>
            </div>
          </div>
        </section>

        <section
          id="market"
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          <Metric
            label="Spot"
            value={price(market?.close)}
            sub={`${market?.source ?? "no source"} · ${dataStatus}`}
            icon={Activity}
          />
          <Metric
            label="Day range"
            value={
              market?.low != null && market?.high != null
                ? `${market.low.toLocaleString("en-IN")} – ${market.high.toLocaleString("en-IN")}`
                : "—"
            }
            sub="observed OHLC range"
            icon={BarChart3}
          />
          <Metric
            label="Signal confidence"
            value={pct(signal?.confidence)}
            sub={signal?.regime ?? "regime unavailable"}
            icon={Zap}
          />
          <Metric
            label="Research agreement"
            value={research ? pct(research.agreement) : "—"}
            sub={
              research
                ? `${research.evidenceScore}/100 evidence`
                : "research service unavailable"
            }
            icon={Database}
          />
        </section>

        <section className="grid gap-5 xl:grid-cols-[1.45fr_.55fr]">
          <Card className="p-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <Label>Price action · WebSocket live feed</Label>
                <h2 className="mt-1 font-display text-xl font-semibold">
                  {symbol}
                </h2>
                <div className="mt-1 flex items-center gap-1.5 font-mono-ui text-[9px] uppercase tracking-[.12em]">
                  <span className={`h-1.5 w-1.5 rounded-full ${liveActive ? "animate-pulse bg-[#c8f169]" : "bg-[#e5b55f]"}`} />
                  <span className={liveActive ? "text-[#c8f169]" : "text-[#c8b582]"}>
                    {liveActive
                      ? `Live tick ${liveQuote?.close != null ? liveQuote.close.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : ""} · ${liveQuote?.timestamp ? formatBarTime(liveQuote.timestamp, "1m") : ""} IST`
                      : "Feed idle — showing last verified session"}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-mono-ui text-[9px] text-[#70887d]">
                  {TIMEFRAMES.find(item => item.id === chartTimeframe)?.unit} · {chart.bars.length} bars
                </span>
                <div className="flex items-center gap-1 rounded-lg border border-[#1d332f] bg-[#09130f] p-1" role="group" aria-label="Chart timeframe">
                  {TIMEFRAMES.map(item => (
                    <button
                      key={item.id}
                      type="button"
                      title={item.hint}
                      aria-pressed={chartTimeframe === item.id}
                      onClick={() => { setChartTimeframe(item.id); localStorage.setItem(TIMEFRAME_KEY, item.id); }}
                      className={`rounded-md px-2.5 py-1 font-mono-ui text-[10px] transition-colors ${chartTimeframe === item.id ? "bg-[#1d332f] text-[#c8f169]" : "text-[#789087] hover:text-[#d7e8d9]"}`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {CHART_LEGEND.filter(item => item.key !== "cone" || chart.bands.length > 0).map(item => (
                <button
                  key={item.key}
                  type="button"
                  aria-pressed={chartOverlays[item.key]}
                  onClick={() => setChartOverlays(prev => ({ ...prev, [item.key]: !prev[item.key] }))}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono-ui text-[9px] tracking-[.1em] transition-all ${chartOverlays[item.key] ? "border-[#29463b] bg-[#0d1a15] text-[#d7e8d9]" : "border-[#1a2a24] bg-transparent text-[#4f6459] line-through"}`}
                  title={item.key === "cone" ? "Statistical baseline: historical daily drift ± √time log-vol extrapolated from realized closes — not a model prediction" : chartOverlays[item.key] ? `Hide ${item.label}` : `Show ${item.label}`}
                >
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: chartOverlays[item.key] ? item.color : "#33453c" }} />
                  {item.label}
                </button>
              ))}
            </div>
            <div className="mt-3 h-[360px]">
              {chart.bars.length ? (
                <PriceChart
                  bars={chart.bars}
                  bands={chart.bands}
                  minuteScale={chartTimeframe === "1m"}
                  livePrice={liveQuote?.close ?? null}
                  liveActive={liveActive}
                  overlays={chartOverlays}
                />
              ) : (
                <Empty text={chartTimeframe === "1m" ? "No minute bars collected for this instrument yet — the feed stores them during market sessions." : "No historical bars returned by the local API."} />
              )}
            </div>
            {chart.bands.length && chartOverlays.cone ? (
              <p className="mt-2 text-[9px] leading-relaxed text-[#5f7869]">
                Cone = statistical baseline: {forecast?.daysOfHistoryUsed ?? chart.bars.length} daily closes
                extrapolated with historical drift ± √time log-vol on trading-day steps. No ML model
                contributes to it — model signals abstain until an artifact clears the OOS promotion gate.
              </p>
            ) : null}
          </Card>
          <Card className="p-5">
            <Label>Model decision / reasons</Label>
            <div
              className={`mt-2 font-display text-3xl font-bold ${tone(signal?.direction)}`}
            >
              {signal?.direction ?? "NO SIGNAL"}
            </div>
            <div className="mt-1 text-xs text-[#789087]">
              {signal?.regime ?? "No regime classification"} · model{" "}
              {signal?.modelVersion ?? "—"}
            </div>
            <div className="mt-5 space-y-2">
              {signal?.reasonCodes?.length ? (
                signal.reasonCodes.map(reason => (
                  <div
                    key={reason}
                    className="flex items-start gap-2 rounded-lg border border-[#1d332f] bg-[#09130f] p-3 text-xs text-[#bdc9c1]"
                  >
                    <span className="mt-1 h-1.5 w-1.5 rounded-full bg-[#c8f169]" />
                    {reason}
                  </div>
                ))
              ) : (
                <Empty text="No reason codes available." />
              )}
            </div>
          </Card>
        </section>

        <section
          id="projection"
          className="grid gap-5 lg:grid-cols-[1.15fr_.85fr]"
        >
          <Card className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <Label>Statistical baseline forecast / {instrumentName ?? symbol}</Label>
                <h2 className="mt-1 flex flex-wrap items-center gap-2 font-display text-xl font-semibold">
                  Next {forecastHorizon} trading days
                  {forecast?.status === "STATISTICAL_BASELINE" ? (
                    <span
                      className="rounded-md border border-[#4e4226] bg-[#211d12] px-2 py-0.5 font-mono-ui text-[9px] tracking-[.12em] text-[#e5b55f]"
                      title="These bands are extrapolated from historical daily log returns (drift ± √time volatility). No ML model contributes to them; model signals stay abstained until an artifact clears the OOS promotion gate."
                    >
                      NO MODEL — HISTORICAL EXTRAPOLATION
                    </span>
                  ) : null}
                </h2>
              </div>
              <select
                value={forecastHorizon}
                onChange={event =>
                  setForecastHorizon(Number(event.target.value) as 1 | 3 | 5)
                }
                className="rounded-lg border border-[#26453a] bg-[#10211c] px-3 py-2 font-mono-ui text-[10px] text-[#d7e8d9] outline-none"
              >
                <option value={3}>3 days</option>
                <option value={5}>5 days</option>
                <option value={10}>10 days</option>
                <option value={20}>20 days</option>
              </select>
            </div>
            {forecast ? (
              <>
                <div className="mt-4 grid gap-3 sm:grid-cols-4">
                  <Metric
                    label="Expected value"
                    value={price(forecast.expectedValue)}
                    sub={`${(forecast.expectedReturn * 100).toFixed(2)}% expected move`}
                    icon={Target}
                  />
                  <Metric
                    label="Forecast range"
                    value={`${price(forecast.forecastRange.low)} - ${price(forecast.forecastRange.high)}`}
                    sub="p10 to p90 distribution"
                    icon={BarChart3}
                  />
                  <Metric
                    label="Direction odds"
                    value={pct(
                      Math.max(
                        forecast.probabilityAboveSpot,
                        forecast.probabilityBelowSpot
                      )
                    )}
                    sub={`${forecast.strategy.direction} distribution bias`}
                    icon={Gauge}
                  />
                  <Metric
                    label="History"
                    value={`${forecast.daysOfHistoryUsed} days`}
                    sub="daily observations used"
                    icon={Database}
                  />
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <div className="rounded-xl border border-[#29463b] bg-[#09130f] p-4">
                    <Label>Execution / position strategy</Label>
                    <div
                      className={`mt-2 font-display text-2xl font-bold ${tone(forecast.strategy.direction)}`}
                    >
                      {forecast.strategy.action} · {forecast.strategy.direction}
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-[#bdc9c1]">
                      {forecast.strategy.rationale}
                    </p>
                    <div className="mt-3 text-[10px] leading-relaxed text-[#8fa69a]">
                      <strong className="text-[#c8f169]">
                        Position sizing:
                      </strong>{" "}
                      {forecast.strategy.positionSizing}
                    </div>
                    {forecast.actionSuggestions?.length ? (
                      <div className="mt-4 space-y-2">
                        {forecast.actionSuggestions.map((item, index) => (
                          <div
                            key={item}
                            className="flex gap-2 rounded-lg border border-[#1d332f] px-3 py-2 text-[10px] text-[#aebeb3]"
                          >
                            <span className="font-mono-ui text-[#c8f169]">
                              {index + 1}
                            </span>
                            {item}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <div className="rounded-xl border border-[#3c3120] bg-[#15120c] p-4">
                    <Label>Why this can change</Label>
                    <p className="mt-2 text-xs leading-relaxed text-[#c8b582]">
                      <strong>Invalidation:</strong>{" "}
                      {forecast.strategy.invalidation}
                    </p>
                    <p className="mt-3 text-[10px] leading-relaxed text-[#897b5a]">
                      Expected value is the distribution median, not a promise.
                      This baseline does not include news, gaps, liquidity or
                      causal fundamentals.
                    </p>
                  </div>
                </div>
              </>
            ) : (
              <Empty text="No forecast available. At least 20 daily observations are required; the engine will not fabricate a projection." />
            )}
          </Card>
          <Card className="p-5">
            <Label>Decision engine review</Label>
            <h2 className="mt-1 font-display text-xl font-semibold">
              Principles and drawbacks
            </h2>
            <div className="mt-4 space-y-3">
              <div className="rounded-lg border border-[#29463b] bg-[#09130f] p-3 text-xs text-[#bdc9c1]">
                <strong className="text-[#c8f169]">Principle:</strong> separate
                forecast, evidence, tradeability and execution. Each gate should
                be independently measurable.
              </div>
              <div className="rounded-lg border border-[#3c3120] bg-[#15120c] p-3 text-xs text-[#c8b582]">
                <strong>Current drawbacks:</strong> statistical drift is not
                causal, history may be thin, news can invalidate the
                distribution, and a median forecast can hide tail risk.
              </div>
              <div className="rounded-lg border border-[#1d332f] bg-[#09130f] p-3 text-xs text-[#9fb4a8]">
                <strong className="text-[#d7e8d9]">Improvement path:</strong>{" "}
                walk-forward calibration, regime-specific residuals, event and
                liquidity features, probability calibration, and paper execution
                measured against slippage.
              </div>
              {forecast?.limitations.map(limitation => (
                <div
                  key={limitation}
                  className="text-[10px] leading-relaxed text-[#71877d]"
                >
                  - {limitation}
                </div>
              ))}
            </div>
          </Card>
        </section>

        <section
          id="picks"
          className="rounded-2xl border border-[#29463b] bg-[#0b1714] p-5 shadow-[0_18px_50px_rgba(0,0,0,.16)]"
        >
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <Label>Market-wide research scan</Label>
              <h2 className="mt-1 font-display text-xl font-semibold">
                Pick of the day · up to five instruments
              </h2>
              <p className="mt-1 text-xs text-[#789087]">
                Ranks fresh or last-session data. Signal-grade picks need a
                calibrated model that cleared the OOS gate; otherwise qualifying
                instruments surface as momentum-evidence picks from realized
                closes — never a fabricated forecast.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded-full border border-[#29463b] px-3 py-1 font-mono-ui text-[9px] uppercase tracking-[.12em] text-[#c8f169]">
                {marketPicks.length
                  ? `${marketPicks.length} candidates`
                  : "NO QUALIFIED PICKS"}
              </span>
              <button
                onClick={() => void refreshScan()}
                disabled={scanLoading}
                aria-label="Refresh pick of the day"
                title="Refresh pick of the day"
                className="rounded-lg border border-[#345346] p-2 text-[#c8f169] hover:bg-[#142a25] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw size={14} className={scanLoading ? "animate-spin" : ""} />
              </button>
            </div>
          </div>
          {marketPicks.length ? (
            <div className="mt-4 grid gap-3 lg:grid-cols-2">
              {marketPicks.map((pick, index) => (
                <div
                  key={pick.symbol}
                  className="rounded-xl border border-[#1d332f] bg-[#09130f] p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 font-mono-ui text-[9px] text-[#70887d]">
                        <span>RANK {String(index + 1).padStart(2, "0")} · {pick.horizon}</span>
                        <span
                          className={`rounded-full border px-2 py-0.5 uppercase tracking-[.1em] ${
                            pick.basis === "MODEL"
                              ? "border-[#476238] text-[#c8f169]"
                              : "border-[#5b4b2b] text-[#c8b582]"
                          }`}
                          title={
                            pick.basis === "MODEL"
                              ? "Validated model signal that cleared the OOS promotion gate."
                              : "Ranked from realized closes only — a technical-evidence screen, not a forward return forecast."
                          }
                        >
                          {pick.basis === "MODEL" ? "Model signal" : "Momentum evidence"}
                        </span>
                      </div>
                      <div className="mt-1 font-display text-2xl font-semibold">
                        {pick.symbol}
                      </div>
                      <div className="text-[10px] text-[#789087]">
                        {pick.name ?? "Instrument"} · data{" "}
                        {new Date(pick.dataAsOf).toLocaleDateString("en-IN")} ·{" "}
                        {pick.dataStatus === "CLOSED_LAST_SESSION"
                          ? "LAST SESSION"
                          : "CURRENT"}
                      </div>
                    </div>
                    <div className="text-right">
                      <div
                        className={`font-mono-ui text-sm font-semibold ${tone(pick.expectedReturn >= 0 ? "LONG" : "SHORT")}`}
                      >
                        {pct(pick.expectedReturn)}
                      </div>
                      <div className="text-[10px] text-[#789087]">
                        {pick.basis === "MODEL" ? "expected" : "realized 20d"} · net {pct(pick.netExpectedReturn)}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-[10px]">
                    <div>
                      <Label>Confidence</Label>
                      <div className="mt-1 text-[#d7e8d9]">
                        {pct(pick.confidence)}
                      </div>
                    </div>
                    <div>
                      <Label>20d momentum</Label>
                      <div className="mt-1 text-[#d7e8d9]">
                        {pct(pick.momentum20d)}
                      </div>
                    </div>
                    <div>
                      <Label>60d drawdown</Label>
                      <div className="mt-1 text-[#e5b55f]">
                        {pct(pick.maxDrawdown60d)}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 space-y-1 text-[10px] leading-relaxed text-[#aebeb3]">
                    {pick.reasons.slice(0, 3).map(reason => (
                      <div key={reason}>• {reason}</div>
                    ))}
                  </div>
                  <div className="mt-3 text-[10px] leading-relaxed text-[#c8b582]">
                    Risk: {pick.risks[0]}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-4 rounded-xl border border-[#3c3120] bg-[#15120c] p-4 text-sm text-[#c8b582]">
              No instrument currently clears the scanner. This is an intentional
              abstention, not a missing prediction: neither a model signal nor a
              positive realized-momentum trend net of cost qualified.{" "}
              {scanExcluded.length
                ? `${scanExcluded.length} candidates were excluded for insufficient history, stale data, or non-positive momentum after assumed costs.`
                : "The local API may be offline or the active universe has no evaluated data yet."}
            </div>
          )}
        </section>

        <section
          id="live-prediction"
          className="rounded-2xl border border-[#29463b] bg-[#0b1714] p-5 shadow-[0_18px_50px_rgba(0,0,0,.16)]"
        >
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <Label>Horizon-aware ML inference</Label>
              <h2 className="mt-1 font-display text-xl font-semibold">
                {symbol} model decision
              </h2>
              <p className="mt-1 text-xs text-[#789087]">
                Each horizon uses its own forward label, purge period, model cache, calibration, and promotion gate.
              </p>
            </div>
            <select
              value={forecastHorizon}
              onChange={event => setForecastHorizon(Number(event.target.value) as 1 | 3 | 5)}
              className="rounded-lg border border-[#345346] bg-[#09130f] px-3 py-2 font-mono-ui text-xs text-[#d7e8d9] outline-none"
              aria-label="Prediction horizon"
            >
              <option value={1}>1 trading day</option>
              <option value={3}>3 trading days</option>
              <option value={5}>5 trading days</option>
            </select>
          </div>
          {livePrediction ? (
            <div className="mt-4 grid gap-3 lg:grid-cols-[1.1fr_1fr]">
              <div className={`rounded-xl border ${livePrediction.prediction_status === "PROMOTION_READY" ? "border-[#476238]" : "border-[#5a432a]"} bg-[#09130f] p-4`}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <Label>Model output · {livePrediction.horizon}</Label>
                    <div className={`mt-2 font-display text-3xl font-semibold ${livePrediction.prediction === "UP" ? "text-[#c8f169]" : livePrediction.prediction === "DOWN" ? "text-[#ff9d91]" : "text-[#e5b55f]"}`}>
                      {livePrediction.prediction}
                    </div>
                  </div>
                  <span className={`rounded-full border px-3 py-1 font-mono-ui text-[9px] uppercase tracking-[.12em] ${livePrediction.action_status.startsWith("ACTIONABLE") ? "border-[#476238] text-[#c8f169]" : "border-[#5a432a] text-[#c8b582]"}`}>
                    {livePrediction.action_status.replaceAll("_", " ")}
                  </span>
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
                  {(["DOWN", "FLAT", "UP"] as const).map(label => (
                    <div key={label} className="rounded-lg border border-[#1d332f] bg-[#0b1714] p-3">
                      <Label>{label}</Label>
                      <div className="mt-1 text-[#d7e8d9]">{pct(livePrediction.probabilities[label])}</div>
                    </div>
                  ))}
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-[#9fb4a8]">
                  <div>Expected return: <strong className="text-[#d7e8d9]">{pct(livePrediction.expected_return)}</strong></div>
                  <div>Confidence: <strong className="text-[#d7e8d9]">{pct(livePrediction.confidence)}</strong></div>
                  <div>Probability margin: <strong className="text-[#d7e8d9]">{pct(livePrediction.probability_margin)}</strong></div>
                  <div>Calibration: <strong className="text-[#d7e8d9]">{livePrediction.calibration_status}</strong></div>
                  <div>OOS examples: <strong className="text-[#d7e8d9]">{livePrediction.validation_oos_examples}</strong></div>
                </div>
                <div className="mt-3 rounded-lg border border-[#1d332f] bg-[#0b1714] p-3 text-[10px] text-[#9fb4a8]">
                  <div className="flex flex-wrap justify-between gap-2"><span>Empirical return interval</span><strong className="text-[#d7e8d9]">{pct(livePrediction.return_interval.p10)} · {pct(livePrediction.return_interval.p50)} · {pct(livePrediction.return_interval.p90)}</strong></div>
                  <div className="mt-1 flex justify-between"><span>Probability net-positive after cost</span><strong className="text-[#c8f169]">{pct(livePrediction.probability_net_positive)}</strong></div>
                </div>
              </div>
              <div className="rounded-xl border border-[#1d332f] bg-[#09130f] p-4">
                <Label>Evidence and model identity</Label>
                <div className="mt-3 space-y-2 text-[10px] text-[#9fb4a8]">
                  <div className="flex justify-between gap-3"><span>Model</span><strong className="text-right text-[#d7e8d9]">{livePrediction.model_version}</strong></div>
                  <div className="flex justify-between gap-3"><span>Training cutoff</span><strong className="text-right text-[#d7e8d9]">{new Date(livePrediction.training_cutoff).toLocaleDateString("en-IN")}</strong></div>
                  <div className="flex justify-between gap-3"><span>OOS accuracy</span><strong className="text-[#d7e8d9]">{pct(livePrediction.oos_metrics.accuracy)}</strong></div>
                  <div className="flex justify-between gap-3"><span>OOS log loss</span><strong className="text-[#d7e8d9]">{livePrediction.oos_metrics.log_loss.toFixed(3)}</strong></div>
                </div>
                <div className="mt-4 border-t border-[#1d332f] pt-3 text-[10px] leading-relaxed text-[#c8b582]">
                  <div>{livePrediction.action_reasons.map(reason => `• ${reason.replaceAll("_", " ")}`).join("  ")}</div>
                  <div className="mt-2">{livePrediction.action_status.startsWith("ACTIONABLE")
                    ? "This individual forecast cleared the model, confidence, probability-margin, and net-edge gates. It remains research output, not a guarantee or an instruction to trade."
                    : "The system is intentionally not promoting this individual forecast as an action. The raw model output remains visible for research."}</div>
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-4 rounded-xl border border-[#3c3120] bg-[#15120c] p-4 text-sm text-[#c8b582]">
              Horizon-specific ML inference is unavailable or the instrument does not yet have enough daily history. No prediction is fabricated.
            </div>
          )}
        </section>

        <section
          id="paper-lab"
          className="rounded-2xl border border-[#29463b] bg-[#0b1714] p-5 shadow-[0_18px_50px_rgba(0,0,0,.16)]"
        >
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <Label>Research execution desk</Label>
              <h2 className="mt-1 font-display text-xl font-semibold">Paper trading · {symbol}</h2>
              <p className="mt-1 text-xs text-[#789087]">Virtual funds only. Market and limit orders fill only when a live tick crosses them — after hours they queue and never reach a broker.</p>
            </div>
            <span className="rounded-full border border-[#5b4b2b] px-3 py-1 font-mono-ui text-[9px] uppercase tracking-[.12em] text-[#c8b582]">RESEARCH ONLY</span>
          </div>
          <div className="mt-4">
            <TradingDesk embedded />
          </div>
          <div className="mt-4 text-[10px] leading-relaxed text-[#789087]">This workspace is a simulation ledger for research and education. It does not provide investment advice, does not guarantee outcomes, and does not submit orders to any exchange or broker.</div>
        </section>

        <section
          id="prediction-performance"
          className="rounded-2xl border border-[#29463b] bg-[#0b1714] p-5 shadow-[0_18px_50px_rgba(0,0,0,.16)]"
        >
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <Label>Live model feedback</Label>
              <h2 className="mt-1 font-display text-xl font-semibold">
                Realized prediction performance
              </h2>
              <p className="mt-1 text-xs text-[#789087]">
                Causally scored from later persisted daily closes; pending predictions are not counted as wins or losses.
              </p>
            </div>
            <span className="rounded-full border border-[#29463b] px-3 py-1 font-mono-ui text-[9px] uppercase tracking-[.12em] text-[#a8c879]">
              {predictionPerformance ? `${predictionPerformance.periodDays}D WINDOW` : "NO DATA"}
            </span>
          </div>
          {predictionPerformance?.metrics.scoredPredictions ? (
            <>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <Metric label="Accuracy" value={pct(predictionPerformance.metrics.accuracy)} sub={`${predictionPerformance.metrics.scoredPredictions} resolved`} icon={Target} />
              <Metric label="Directional" value={pct(predictionPerformance.metrics.directionalAccuracy)} sub="UP/DOWN calls only" icon={ArrowUpRight} />
              <Metric label="Log loss" value={predictionPerformance.metrics.logLoss == null ? "—" : predictionPerformance.metrics.logLoss.toFixed(3)} sub="lower is better" icon={Gauge} />
              <Metric label="Brier" value={predictionPerformance.metrics.brier == null ? "—" : predictionPerformance.metrics.brier.toFixed(3)} sub="probability error" icon={BarChart3} />
              <Metric label="Pending" value={String(predictionPerformance.metrics.pendingPredictions)} sub="awaiting horizon" icon={Activity} />
            </div>
            <div className="mt-4 grid gap-2 md:grid-cols-3">
              {predictionPerformance.byHorizon.map(item => (
                <div key={item.horizon} className="rounded-lg border border-[#1d332f] bg-[#09130f] p-3 text-[10px] text-[#9fb4a8]">
                  <div className="flex justify-between"><Label>{item.horizon} realized</Label><strong className="text-[#d7e8d9]">{item.scoredPredictions} scored</strong></div>
                  <div className="mt-2 flex justify-between"><span>Accuracy</span><strong className="text-[#d7e8d9]">{pct(item.accuracy)}</strong></div>
                  <div className="mt-1 flex justify-between"><span>Directional</span><strong className="text-[#d7e8d9]">{pct(item.directionalAccuracy)}</strong></div>
                  <div className="mt-1 flex justify-between"><span>Log loss</span><strong className="text-[#d7e8d9]">{item.logLoss == null ? "—" : item.logLoss.toFixed(3)}</strong></div>
                  <div className="mt-1 flex justify-between"><span>Pending</span><strong className="text-[#c8b582]">{item.pendingPredictions}</strong></div>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[10px] leading-relaxed text-[#5c736a]">
              Accuracy is measured only for the horizons the engine records to the ledger (currently 1d). The 3d and 5d selectors drive live forward inference for display, but their outcomes are not yet tracked here, so no multi-horizon accuracy is implied.
            </p>
            </>
          ) : (
            <div className="mt-4 rounded-xl border border-[#3c3120] bg-[#15120c] p-4 text-sm text-[#c8b582]">
              No resolved live predictions are available in the current window. The engine will abstain from claiming live accuracy until outcomes mature.
            </div>
          )}
        </section>

        <section
          id="forecast"
          className="grid gap-5 lg:grid-cols-[1.15fr_.85fr]"
        >
          <Card className="p-5">
            <div className="flex items-center justify-between">
              <div>
                <Label>Trade thesis / price distribution</Label>
                <h2 className="mt-1 font-display text-xl font-semibold">
                  Targets, stop & probability
                </h2>
              </div>
              <Target size={18} className="text-[#c8f169]" />
            </div>
            {thesis ? (
              <>
                <div className="mt-4 grid gap-3 sm:grid-cols-4">
                  <Metric
                    label="Entry"
                    value={price(thesis.entryPrice)}
                    sub="thesis entry"
                    icon={Target}
                  />
                  <Metric
                    label="Probability"
                    value={pct(thesis.probability)}
                    sub="directional thesis"
                    icon={Gauge}
                  />
                  <Metric
                    label="Expected move"
                    value={
                      thesis.expectedReturn == null
                        ? "—"
                        : `${(thesis.expectedReturn * 100).toFixed(2)}%`
                    }
                    sub="conditional forecast"
                    icon={Activity}
                  />
                  <Metric
                    label="Stop"
                    value={price(thesis.stop?.price)}
                    sub={
                      thesis.stop?.probability != null
                        ? `${pct(thesis.stop.probability)} stop event`
                        : "distribution tail"
                    }
                    icon={ShieldAlert}
                  />
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  {(thesis.targets ?? []).map((target, i) => (
                    <div
                      key={`${target.price}-${i}`}
                      className="rounded-xl border border-[#29463b] bg-[#09130f] p-4"
                    >
                      <div className="flex justify-between">
                        <Label>Target {i + 1}</Label>
                        <span className="font-mono-ui text-xs text-[#c8f169]">
                          {pct(target.probability)}
                        </span>
                      </div>
                      <div className="mt-2 font-display text-2xl font-semibold">
                        {price(target.price)}
                      </div>
                      <div className="mt-2 font-mono-ui text-[9px] text-[#789087]">
                        ETA {duration(target.timing?.p50Seconds)} · range{" "}
                        {duration(target.timing?.p25Seconds)}–
                        {duration(target.timing?.p75Seconds)}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <Empty text="No executable trade thesis. D-Predict will not invent targets, stop or ETA." />
            )}
          </Card>
          <Card className="p-5">
            <Label>Confidence ladder</Label>
            <div className="mt-5 space-y-4">
              {[
                ["Forecast", thesis?.confidence ?? signal?.confidence],
                ["Research", research?.confidence],
                ["Evidence agreement", research?.agreement],
                [
                  "Data quality",
                  market
                    ? market.status === "LIVE"
                      ? 1
                      : market.status === "CACHED"
                        ? 0.8
                        : market.status === "STALE"
                          ? 0.35
                          : 0
                    : 0,
                ],
              ].map(([name, value]) => (
                <div key={name as string}>
                  <div className="mb-1 flex justify-between text-xs">
                    <span className="text-[#a9bbb0]">{name}</span>
                    <span className="font-mono-ui text-[#c8f169]">
                      {value == null ? "—" : pct(value as number)}
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-[#172a25]">
                    <div
                      className="h-full rounded-full bg-[#a9d45e]"
                      style={{
                        width:
                          value == null
                            ? "0%"
                            : `${Math.max(0, Math.min(100, (value as number) * 100))}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-6 rounded-xl border border-[#293f35] bg-[#09130f] p-4 text-[10px] leading-relaxed text-[#71877d]">
              Confidence is displayed as evidence, not certainty. Promotion and
              live execution remain separate gates.
            </div>
          </Card>
        </section>

        <section
          id="derivatives"
          className="grid gap-5 lg:grid-cols-[1fr_.6fr]"
        >
          <Card className="p-5">
            <div className="flex items-center justify-between">
              <div>
                <Label>Derivatives / option intelligence</Label>
                <h2 className="mt-1 font-display text-xl font-semibold">
                  {symbol} option chain
                </h2>
              </div>
              <BarChart3 size={18} className="text-[#789087]" />
            </div>
            {optionSummary.length ? (
              <div className="mt-4 h-[280px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={optionSummary}>
                    <CartesianGrid
                      stroke="#18302a"
                      strokeDasharray="3 5"
                      vertical={false}
                    />
                    <XAxis
                      dataKey="strike"
                      tick={{ fill: "#70887d", fontSize: 9 }}
                    />
                    <YAxis tick={{ fill: "#70887d", fontSize: 9 }} />
                    <Tooltip
                      contentStyle={{
                        background: "#0b1714",
                        border: "1px solid #29463b",
                      }}
                    />
                    {market?.close != null && (
                      <ReferenceLine
                        x={market.close}
                        stroke="#e5b55f"
                        strokeDasharray="4 4"
                      />
                    )}
                    <Bar dataKey="ceOi" fill="#c8f169" name="CE OI" />
                    <Bar dataKey="peOi" fill="#f0776b" name="PE OI" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <Empty text="No option-chain snapshot available for this instrument." />
            )}
          </Card>
          <Card className="p-5">
            <Label>Derivative decision</Label>
            <div className="mt-3 space-y-3">
              {options.slice(0, 8).map(row => (
                <div
                  key={`${row.expiry_date}-${row.strike}-${row.option_type}`}
                  className="flex items-center justify-between rounded-lg border border-[#1d332f] bg-[#09130f] px-3 py-2"
                >
                  <span className="font-mono-ui text-[9px] text-[#789087]">
                    {row.strike} {row.option_type}
                  </span>
                  <span className="font-mono-ui text-[10px]">
                    LTP {row.ltp ?? "—"}
                  </span>
                  <span className="font-mono-ui text-[10px] text-[#9fb4a8]">
                    OI {row.oi ?? "—"}
                  </span>
                </div>
              ))}
              {!options.length && <Empty text="No live derivative snapshot." />}
            </div>
          </Card>
        </section>

        <section id="evidence" className="grid gap-5 lg:grid-cols-[.8fr_1.2fr]">
          <Card className="p-5">
            <Label>Evidence stack</Label>
            <div
              className={`mt-3 font-display text-3xl font-bold ${tone(research?.direction)}`}
            >
              {research?.direction ?? "UNAVAILABLE"}
            </div>
            <div className="mt-2 text-sm text-[#8fa69a]">
              {research
                ? `${research.evidenceScore}/100 evidence · ${pct(research.agreement)} source agreement`
                : "Start the local research service to populate this panel."}
            </div>
            <div className="mt-5 space-y-2">
              {research?.themes?.slice(0, 8).map(theme => (
                <div
                  key={theme}
                  className="rounded-lg border border-[#1d332f] px-3 py-2 text-xs text-[#b9c8bd]"
                >
                  {theme}
                </div>
              ))}
            </div>
          </Card>
          <Card className="p-5">
            <div className="flex items-center justify-between">
              <div>
                <Label>Decision-maker watchlist</Label>
                <h2 className="mt-1 font-display text-xl font-semibold">
                  What could invalidate this view?
                </h2>
              </div>
              <AlertTriangle size={18} className="text-[#e5b55f]" />
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {[
                ...(research?.risks ?? []),
                ...(signal?.reasonCodes?.filter(x =>
                  /risk|caution|weak|stale|insufficient/i.test(x)
                ) ?? []),
                ...(blockers.length
                  ? blockers
                  : ["No explicit blocker recorded"]),
              ]
                .slice(0, 8)
                .map(item => (
                  <div
                    key={item}
                    className="rounded-xl border border-[#3c3120] bg-[#15120c] p-4 text-xs leading-relaxed text-[#c8b582]"
                  >
                    <span className="mr-2 text-[#e5b55f]">!</span>
                    {item}
                  </div>
                ))}
            </div>
          </Card>
        </section>

        <section id="risk" className="grid gap-4 md:grid-cols-3">
          <Metric
            label="Execution gate"
            value={tradeReady ? "READY" : "BLOCKED"}
            sub={tradeReady ? "thesis says executable" : "forecast ≠ trade"}
            icon={CheckCircle2}
          />
          <Metric
            label="Market freshness"
            value={dataStatus}
            sub={
              market?.collectedAt
                ? new Date(market.collectedAt).toLocaleTimeString("en-IN")
                : "no collection timestamp"
            }
            icon={Wifi}
          />
          <Metric
            label="Research evidence"
            value={research ? `${research.evidenceScore}/100` : "—"}
            sub="context layer only; not an order engine"
            icon={Database}
          />
        </section>

        <footer className="border-t border-[#183029] py-5 text-[9px] leading-relaxed text-[#587068]">
          D-Predict is a research/evaluation/simulation system. This dashboard
          displays model outputs and evidence supplied by the local services; it
          does not guarantee returns and does not send broker orders. Missing or
          stale data is shown explicitly rather than fabricated.
        </footer>
      </main>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex min-h-28 items-center justify-center rounded-xl border border-dashed border-[#315045] p-5 text-center text-xs text-[#789087]">
      {text}
    </div>
  );
}
