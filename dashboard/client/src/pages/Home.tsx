import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { addInstrument, getForecast, getInstruments, getLatestSignal, getLocalHealth, getMarketHistory, getMarketOverview, getOptionChain, type Forecast, type Instrument, type MarketOverview, type OptionRow, type PriceBar, type Signal } from "@/lib/localApi";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Bell,
  BookOpen,
  BrainCircuit,
  CalendarDays,
  ChevronDown,
  CircleHelp,
  Database,
  Gauge,
  LayoutDashboard,
  LineChart,
  Menu,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingUp,
  Wifi,
  X,
  Zap,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type IconType = typeof Activity;

type NavItem = {
  id: string;
  label: string;
  icon: IconType;
  badge?: string;
};

const navItems: NavItem[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "signals", label: "Signal desk", icon: Zap, badge: "01" },
  { id: "chain", label: "Option chain", icon: BarChart3 },
  { id: "forecast", label: "Forecast", icon: LineChart },
  { id: "backtest", label: "Backtest lab", icon: BrainCircuit },
];

const chartData = [
  { time: "09:20", price: 24818, ema: 24792 },
  { time: "09:40", price: 24876, ema: 24811 },
  { time: "10:00", price: 24852, ema: 24826 },
  { time: "10:20", price: 24928, ema: 24864 },
  { time: "10:40", price: 24976, ema: 24894 },
  { time: "11:00", price: 24941, ema: 24911 },
  { time: "11:20", price: 25008, ema: 24938 },
  { time: "11:40", price: 24988, ema: 24955 },
  { time: "12:00", price: 25042, ema: 24980 },
  { time: "12:20", price: 25016, ema: 24995 },
  { time: "12:40", price: 25078, ema: 25018 },
  { time: "13:00", price: 25110, ema: 25046 },
];

const coneData = [
  { day: "Now", p10: 25108, p25: 25108, median: 25108, p75: 25108, p90: 25108 },
  { day: "D+1", p10: 24880, p25: 25002, median: 25112, p75: 25222, p90: 25346 },
  { day: "D+2", p10: 24740, p25: 24938, median: 25118, p75: 25314, p90: 25526 },
  { day: "D+3", p10: 24590, p25: 24872, median: 25128, p75: 25396, p90: 25674 },
  { day: "D+4", p10: 24440, p25: 24790, median: 25136, p75: 25482, p90: 25818 },
  { day: "D+5", p10: 24278, p25: 24702, median: 25144, p75: 25596, p90: 25990 },
];

const optionRows = [
  { strike: "—", call: "—", callOi: "—", put: "—", putOi: "—", iv: "—", tone: "neutral" },
  { strike: "—", call: "—", callOi: "—", put: "—", putOi: "—", iv: "—", tone: "bullish" },
  { strike: "—", call: "—", callOi: "—", put: "—", putOi: "—", iv: "—", tone: "selected" },
  { strike: "—", call: "—", callOi: "—", put: "—", putOi: "—", iv: "—", tone: "bearish" },
  { strike: "—", call: "—", callOi: "—", put: "—", putOi: "—", iv: "—", tone: "neutral" },
];

const reasonCodes = [
  { label: "Trend up", value: "EMA slope +", positive: true },
  { label: "Momentum confirms", value: "+0.20", positive: true },
  { label: "MACD confirms", value: "+0.10", positive: true },
  { label: "Volume confirms", value: "z-score 1.4", positive: true },
  { label: "RSI elevated", value: "68.2 / caution", positive: false },
];

function formatDateTime() {
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date());
}

function SectionHeading({ eyebrow, title, detail, action }: { eyebrow: string; title: string; detail?: string; action?: React.ReactNode }) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        <div className="font-mono-ui mb-1 text-[10px] uppercase tracking-[0.22em] text-[#7c948b]">{eyebrow}</div>
        <h2 className="font-display text-xl font-semibold tracking-tight text-[#edf5e9]">{title}</h2>
        {detail ? <p className="mt-1 text-xs text-[#7c948b]">{detail}</p> : null}
      </div>
      {action}
    </div>
  );
}

function MiniSpark({ positive = true }: { positive?: boolean }) {
  const points = positive ? "0,29 8,26 16,27 24,18 32,21 40,15 48,16 56,8 64,10 72,3" : "0,4 8,7 16,5 24,15 32,11 40,18 48,14 56,24 64,22 72,29";
  return (
    <svg viewBox="0 0 72 32" className="h-8 w-[72px] overflow-visible" aria-hidden="true">
      <polyline points={points} fill="none" stroke={positive ? "#c8f169" : "#f0776b"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MetricCard({ label, value, sub, trend, positive = true, icon: Icon }: { label: string; value: string; sub: string; trend: string; positive?: boolean; icon: IconType }) {
  return (
    <div className="glass-panel fade-up rounded-2xl border border-[#1d332f] p-4 transition duration-200 hover:-translate-y-0.5 hover:border-[#36584c]">
      <div className="flex items-start justify-between">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#28453b] bg-[#10231e] text-[#a8c879]"><Icon size={15} /></div>
        <MiniSpark positive={positive} />
      </div>
      <div className="mt-4 flex items-end justify-between gap-2">
        <div>
          <div className="font-mono-ui text-[10px] uppercase tracking-[0.16em] text-[#789087]">{label}</div>
          <div className="font-display mt-1 text-2xl font-semibold tracking-tight text-[#eff7ea]">{value}</div>
        </div>
        <span className={`font-mono-ui mb-1 text-[10px] ${positive ? "text-[#c8f169]" : "text-[#f0776b]"}`}>{trend}</span>
      </div>
      <div className="mt-2 text-[11px] text-[#7a9187]">{sub}</div>
    </div>
  );
}

function SignalCard({ symbol, signal }: { symbol: string; signal: Signal | null }) {
  const bullish = signal?.direction === "BULLISH";
  return <div id="signals" className="glass-panel glow-lime fade-up-1 scroll-mt-6 overflow-hidden rounded-2xl border border-[#385238]"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#233d34] px-5 py-4"><div className="flex items-center gap-2"><div className="flex h-7 w-7 items-center justify-center rounded-md bg-[#c8f169] text-[#10200b]"><Zap size={14} fill="currentColor" /></div><div><div className="font-mono-ui text-[10px] uppercase tracking-[0.18em] text-[#87a191]">Signal desk</div><div className="font-display text-sm font-semibold text-[#f0f7ea]">{symbol} decision stream</div></div></div><span className={`font-mono-ui rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] ${signal ? "border-[#46603d] bg-[#20301c] text-[#c8f169]" : "border-[#4e4226] bg-[#211d12] text-[#e5b55f]"}`}>{signal ? `LIVE · ${new Date(signal.timestamp).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}` : "NO SIGNAL"}</span></div>{signal ? <><div className="grid gap-5 p-5 lg:grid-cols-[1.1fr_.9fr]"><div><div className="flex items-center gap-3"><span className={`flex h-12 w-12 items-center justify-center rounded-xl ${bullish ? "bg-[#c8f169] text-[#15250d]" : "bg-[#f0776b] text-[#2a100e]"}`}><ArrowUpRight size={25} strokeWidth={2.5} /></span><div><div className={`font-display text-3xl font-bold tracking-tight ${bullish ? "text-[#d7f883]" : "text-[#ff9d91]"}`}>{signal.direction}</div><div className="mt-0.5 text-xs text-[#8fa69a]">Confidence score <span className="font-mono-ui text-[#d7f883]">{(signal.confidence * 100).toFixed(1)}%</span> · {signal.regime ?? "regime unavailable"}</div></div></div><div className="mt-6 flex items-center gap-3"><div className="h-2 flex-1 overflow-hidden rounded-full bg-[#1a3028]"><div className="h-full rounded-full bg-gradient-to-r from-[#83ad51] to-[#d9ff81]" style={{ width: `${Math.round(signal.confidence * 100)}%` }} /></div><span className="font-mono-ui text-xs text-[#c8f169]">{Math.round(signal.confidence * 100)}%</span></div></div><div className="rounded-xl border border-[#203b33] bg-[#0a1513]/70 p-4"><div className="font-mono-ui mb-3 text-[10px] uppercase tracking-[0.16em] text-[#789087]">Reason codes</div><div className="space-y-2.5">{signal.reasonCodes.length ? signal.reasonCodes.map((reason) => <div key={reason} className="flex items-center gap-2 text-xs text-[#bdc9c1]"><span className="h-1.5 w-1.5 rounded-full bg-[#c8f169]" />{reason}</div>) : <div className="text-xs text-[#789087]">No reason codes recorded.</div>}</div></div></div><div className="grid grid-cols-2 border-t border-[#233d34] sm:grid-cols-4">{[["MODEL", signal.modelVersion], ["STRATEGY", signal.strategyVersion], ["REGIME", signal.regime ?? "—"], ["TIMESTAMP", new Date(signal.timestamp).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })]].map(([label, value]) => <div key={label} className="border-r border-[#233d34] px-5 py-3 last:border-r-0"><div className="font-mono-ui text-[9px] tracking-[0.18em] text-[#71877d]">{label}</div><div className="font-mono-ui mt-1 truncate text-xs text-[#d3e2d6]">{value}</div></div>)}</div></> : <div className="p-5 text-sm text-[#bca974]">No stored signal decision for {symbol}. Run <code>./dp features</code> and <code>./dp signal</code> after collecting enough data.</div>}</div>;
}

function PriceChart({ market, history, symbol }: { market: MarketOverview | null; history: PriceBar[]; symbol: string }) {
  const liveChartData = history.map((bar) => ({ time: new Date(bar.timestamp).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }), price: bar.close, ema: undefined }));
  return (
    <div id="overview" className="glass-panel fade-up-2 scroll-mt-6 rounded-2xl border border-[#1d332f] p-5">
      <SectionHeading eyebrow="Market context / spot" title={symbol} detail="Intraday price action · collected 1 minute bars" action={<span className="font-mono-ui rounded-md border border-[#244238] bg-[#10211c] px-2 py-1 text-[10px] text-[#99b0a5]">{history.length ? "LIVE HISTORY" : "NO DATA"}</span>} />
      <div className="mb-4 flex flex-wrap items-end gap-x-5 gap-y-2">
        <div className="font-display text-3xl font-semibold tracking-tight text-[#edf5e9]">{market ? market.close.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : "—"}</div>
        <div className="flex items-center gap-1 text-sm text-[#c8f169]"><ArrowUpRight size={16} /> {market ? "LIVE" : "WAITING"} <span className="font-mono-ui text-xs">{market ? new Date(market.timestamp).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : ""}</span></div>
        <div className="font-mono-ui text-[10px] text-[#71877d]">{market ? `source timestamp ${new Date(market.timestamp).toLocaleString("en-IN")}` : "waiting for local API"}</div>
      </div>
      <div className="h-[250px] min-w-0 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={liveChartData} margin={{ top: 8, right: 4, left: -20, bottom: 0 }}>
            <defs><linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#b8e56a" stopOpacity={0.23} /><stop offset="100%" stopColor="#b8e56a" stopOpacity={0} /></linearGradient></defs>
            <CartesianGrid stroke="#18302a" strokeDasharray="3 5" vertical={false} />
            <XAxis dataKey="time" tick={{ fill: "#70867c", fontSize: 10, fontFamily: "DM Mono" }} axisLine={false} tickLine={false} interval={2} />
            <YAxis domain={[24720, 25240]} tick={{ fill: "#70867c", fontSize: 10, fontFamily: "DM Mono" }} axisLine={false} tickLine={false} tickFormatter={(value) => `${(value / 1000).toFixed(1)}k`} />
            <Tooltip contentStyle={{ background: "#10211c", border: "1px solid #2b4b3d", borderRadius: 10, fontFamily: "DM Mono", fontSize: 11, color: "#d9f2b3" }} labelStyle={{ color: "#7f988c" }} />
            <Area type="monotone" dataKey="price" stroke="#c8f169" strokeWidth={2.2} fill="url(#priceFill)" name="Spot" />
            <Area type="monotone" dataKey="ema" stroke="#6c9b86" strokeWidth={1.4} fill="none" strokeDasharray="5 5" name="EMA 21" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-[10px] text-[#789087]"><span className="flex items-center gap-1.5"><i className="h-1.5 w-4 rounded-full bg-[#c8f169]" />Live spot</span><span className="ml-auto font-mono-ui text-[#b0c0b7]">{history.length ? `${history.length} bars · source: collector` : "No local bars yet"}</span></div>
    </div>
  );
}

function TradeCard() {
  return <div className="glass-panel fade-up-3 rounded-2xl border border-[#1d332f] p-5"><SectionHeading eyebrow="Construction / candidate" title="Trade idea" detail="Only shown after a computed signal" action={<Target size={18} className="text-[#849e8f]" />} /><div className="rounded-xl border border-[#4e4226] bg-[#211d12] p-4"><div className="flex items-center gap-2 text-sm text-[#e5b55f]"><AlertTriangle size={15} /> No trade candidate available</div><p className="mt-2 text-xs leading-relaxed text-[#bca974]">Trade construction appears only when the engine produces a signal and option data is available.</p></div><p className="mt-4 text-center text-[10px] leading-relaxed text-[#71877d]">Read-only research interface. No order is sent.</p></div>;
}

function OptionChain({ symbol, rows }: { symbol: string; rows: OptionRow[] }) {
  const strikes = Array.from(new Set(rows.map((row) => row.strike))).sort((a, b) => a - b).slice(0, 12);
  const latest = (strike: number, type: OptionRow["option_type"]) => rows.find((row) => row.strike === strike && row.option_type === type);
  return <div id="chain" className="glass-panel scroll-mt-6 rounded-2xl border border-[#1d332f] p-5"><SectionHeading eyebrow="Derivatives / nearest expiry" title="Option chain" detail={`${symbol} · ${rows.length ? `${rows.length} live contracts` : "awaiting NSE snapshot"}`} action={<span className={`font-mono-ui rounded-md border px-2 py-1 text-[10px] ${rows.length ? "border-[#46603d] bg-[#20301c] text-[#c8f169]" : "border-[#4e4226] bg-[#211d12] text-[#e5b55f]"}`}>{rows.length ? "LIVE" : "NO DATA"}</span>} />{rows.length ? <div className="overflow-x-auto"><table className="w-full min-w-[650px] border-collapse text-left"><thead><tr className="border-y border-[#1e3830] text-[9px] uppercase tracking-[0.16em] text-[#6f877c]"><th className="px-3 py-3 font-normal">Call LTP</th><th className="px-3 py-3 font-normal">Call OI</th><th className="px-3 py-3 text-center font-normal">Strike</th><th className="px-3 py-3 font-normal">Put OI</th><th className="px-3 py-3 font-normal">Put LTP</th><th className="px-3 py-3 font-normal">IV</th></tr></thead><tbody>{strikes.map((strike) => { const call = latest(strike, "CE"); const put = latest(strike, "PE"); return <tr key={strike} className="border-b border-[#172d27] text-xs"><td className="px-3 py-3 font-mono-ui text-[#b9c8bd]">{call?.ltp ?? "—"}</td><td className="px-3 py-3 font-mono-ui text-[#80978d]">{call?.oi ?? "—"}</td><td className="px-3 py-3 text-center"><span className="rounded-md bg-[#172d25] px-2 py-1 font-mono-ui text-[#e6f0e5]">{strike.toLocaleString("en-IN")}</span></td><td className="px-3 py-3 font-mono-ui text-[#80978d]">{put?.oi ?? "—"}</td><td className="px-3 py-3 font-mono-ui text-[#b9c8bd]">{put?.ltp ?? "—"}</td><td className="px-3 py-3 font-mono-ui text-[#8ca79b]">{call?.iv ?? put?.iv ?? "—"}</td></tr>; })}</tbody></table></div> : <div className="rounded-xl border border-dashed border-[#315045] p-8 text-center"><BarChart3 size={20} className="mx-auto text-[#789087]" /><p className="mt-3 text-sm text-[#b7c7bd]">No collected option snapshot</p><p className="mt-1 text-xs text-[#789087]">NSE option chains are collected for NIFTY and BANKNIFTY during market hours.</p></div>}</div>;
}

function ForecastCard({ forecast, symbol }: { forecast: Forecast | null; symbol: string }) {
  const data = forecast?.bands.map((band) => ({ ...band, label: band.day === 0 ? "Now" : `D+${band.day}` })) ?? [];
  return <div id="forecast" className="glass-panel scroll-mt-6 rounded-2xl border border-[#1d332f] p-5"><SectionHeading eyebrow="Uncertainty / Monte Carlo" title="Probability cone" detail={forecast ? `${symbol} · ${forecast.paths.toLocaleString()} paths · ${forecast.daysOfHistoryUsed} days history` : `${symbol} · requires price history`} action={<span className={`font-mono-ui rounded-md border px-2 py-1 text-[10px] ${forecast ? "border-[#46603d] bg-[#20301c] text-[#c8f169]" : "border-[#4e4226] bg-[#211d12] text-[#e5b55f]"}`}>{forecast ? "LIVE" : "NO DATA"}</span>} />{forecast ? <><div className="h-[230px] min-w-0 w-full"><ResponsiveContainer width="100%" height="100%"><AreaChart data={data} margin={{ top: 8, right: 4, left: -20, bottom: 0 }}><defs><linearGradient id="coneFillLive" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#739d6f" stopOpacity={.26} /><stop offset="100%" stopColor="#739d6f" stopOpacity={.03} /></linearGradient></defs><CartesianGrid stroke="#18302a" strokeDasharray="3 5" vertical={false} /><XAxis dataKey="label" tick={{ fill: "#70867c", fontSize: 10, fontFamily: "DM Mono" }} axisLine={false} tickLine={false} /><YAxis domain={["auto", "auto"]} tick={{ fill: "#70867c", fontSize: 10, fontFamily: "DM Mono" }} axisLine={false} tickLine={false} tickFormatter={(value) => `${(value / 1000).toFixed(1)}k`} /><Tooltip contentStyle={{ background: "#10211c", border: "1px solid #2b4b3d", borderRadius: 10, fontFamily: "DM Mono", fontSize: 11 }} /><Area type="monotone" dataKey="p90" stroke="transparent" fill="url(#coneFillLive)" name="p90" /><Area type="monotone" dataKey="p10" stroke="#739d6f" strokeWidth={1} strokeDasharray="3 3" fill="#07100f" fillOpacity={1} name="p10" /><Area type="monotone" dataKey="median" stroke="#c8f169" strokeWidth={2} fill="none" name="median" /></AreaChart></ResponsiveContainer></div><div className="mt-3 grid grid-cols-3 gap-2 text-center"><div className="rounded-lg border border-[#1c382f] bg-[#0b1815] p-2"><div className="font-mono-ui text-[9px] text-[#71877d]">P(ABOVE)</div><div className="font-display mt-1 text-sm text-[#c8f169]">{(forecast.probabilityAboveSpot * 100).toFixed(1)}%</div></div><div className="rounded-lg border border-[#1c382f] bg-[#0b1815] p-2"><div className="font-mono-ui text-[9px] text-[#71877d]">SPOT</div><div className="font-display mt-1 text-sm text-[#e2eee3]">{forecast.spot.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</div></div><div className="rounded-lg border border-[#1c382f] bg-[#0b1815] p-2"><div className="font-mono-ui text-[9px] text-[#71877d]">DAILY VOL</div><div className="font-display mt-1 text-sm text-[#e5b55f]">{(forecast.dailyVolatility * 100).toFixed(2)}%</div></div></div></> : <div className="flex h-[230px] items-center justify-center rounded-xl border border-dashed border-[#315045] text-center"><div><LineChart size={20} className="mx-auto text-[#789087]" /><p className="mt-3 text-sm text-[#b7c7bd]">Forecast unavailable</p><p className="mt-1 text-xs text-[#789087]">Collect at least five trading days before forecasting.</p></div></div>}</div>;
}

function BacktestCard() {
  return <div id="backtest" className="glass-panel scroll-mt-6 rounded-2xl border border-[#1d332f] p-5"><SectionHeading eyebrow="Evidence / strategy" title="Backtest pulse" detail="Requires stored signals and price history" action={<Settings2 size={17} className="text-[#8fab9e]" />} /><div className="rounded-xl border border-dashed border-[#315045] p-8 text-center"><BrainCircuit size={20} className="mx-auto text-[#789087]" /><p className="mt-3 text-sm text-[#b7c7bd]">No backtest results</p><p className="mt-1 text-xs text-[#789087]">Run <code>./dp backtest</code> after enough historical data is collected.</p></div></div>;
}

function HealthRail({ apiState, historyCount }: { apiState: "checking" | "connected" | "offline"; historyCount: number }) {
  const apiOk = apiState === "connected";
  const checks = [["Local API", apiOk ? "connected" : apiState, apiOk], ["Price bars", historyCount ? `${historyCount} bars` : "no data", historyCount > 0], ["Signals", "awaiting engine", false], ["Risk engine", "not configured", false]] as const;
  return <div className="glass-panel rounded-2xl border border-[#1d332f] p-5"><div className="mb-4 flex items-center justify-between"><div><div className="font-mono-ui text-[10px] uppercase tracking-[0.18em] text-[#789087]">Operational state</div><h2 className="font-display mt-1 text-lg font-semibold text-[#edf5e9]">Data health</h2></div><Database size={17} className="text-[#89a797]" /></div><div className="space-y-3">{checks.map(([label, time, ok]) => <div key={label} className="flex items-center justify-between gap-3 text-xs"><span className="flex items-center gap-2 text-[#b7c7bd]"><span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-[#c8f169]" : "bg-[#e5b55f]"}`} />{label}</span><span className={`font-mono-ui text-[10px] ${ok ? "text-[#78978a]" : "text-[#d0aa63]"}`}>{time}</span></div>)}</div><p className="mt-5 border-t border-[#1d332f] pt-4 text-[10px] leading-relaxed text-[#789087]">The UI never fills missing market data with estimates.</p></div>
}

export default function Home() {
  const [active, setActive] = useState("overview");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [instrument, setInstrument] = useState("NIFTY");
  const [newTicker, setNewTicker] = useState("");
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [apiState, setApiState] = useState<"checking" | "connected" | "offline">("checking");
  const [market, setMarket] = useState<MarketOverview | null>(null);
  const [history, setHistory] = useState<PriceBar[]>([]);
  const [signal, setSignal] = useState<Signal | null>(null);
  const [optionRows, setOptionRows] = useState<OptionRow[]>([]);
  const [forecast, setForecast] = useState<Forecast | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([getLocalHealth(controller.signal), getInstruments(controller.signal)]).then(([, available]) => {
      setApiState("connected");
      setInstruments(available);
      return Promise.allSettled([getMarketOverview(instrument, controller.signal), getMarketHistory(instrument, controller.signal), getLatestSignal(instrument, controller.signal), getOptionChain(instrument, controller.signal), getForecast(instrument, controller.signal)]);
    }).then((results) => {
      if (!results) return;
      const [overview, bars, latestSignal, options, latestForecast] = results;
      setMarket(overview.status === "fulfilled" ? overview.value : null);
      setHistory(bars.status === "fulfilled" ? bars.value : []);
      setSignal(latestSignal.status === "fulfilled" ? latestSignal.value : null);
      setOptionRows(options.status === "fulfilled" ? options.value : []);
      setForecast(latestForecast.status === "fulfilled" ? latestForecast.value : null);
    }).catch(() => setApiState("offline"));
    return () => controller.abort();
  }, [instrument]);

  const scrollTo = (id: string) => {
    setActive(id);
    setMobileOpen(false);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="cockpit-shell relative overflow-x-hidden">
      <div className="cockpit-grid absolute inset-0 h-[780px]" />
      <div className="relative flex min-h-screen">
        <aside className={`fixed inset-y-0 left-0 z-40 w-[256px] border-r border-[#152b26] bg-[#091412]/95 px-4 py-5 backdrop-blur-xl transition-transform duration-200 lg:sticky lg:top-0 lg:flex lg:h-screen lg:translate-x-0 lg:flex-col ${mobileOpen ? "translate-x-0" : "-translate-x-full"}`}>
          <div className="flex items-center justify-between px-2"><button onClick={() => scrollTo("overview")} className="flex items-center gap-2.5 text-left"><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#c8f169] text-[#11210b]"><Activity size={18} strokeWidth={2.5} /></span><span className="font-display text-lg font-bold tracking-tight text-[#eff8e9]">d<span className="text-[#c8f169]">—</span>predict</span></button><button onClick={() => setMobileOpen(false)} className="rounded-md p-1 text-[#789087] hover:bg-[#132922] lg:hidden"><X size={17} /></button></div>
          <div className="mt-8 px-2"><div className="font-mono-ui text-[9px] uppercase tracking-[0.22em] text-[#597369]">Workspace</div><div className="mt-2 flex items-center justify-between rounded-lg border border-[#1e3a31] bg-[#10211c] px-3 py-2.5"><div><div className="font-display text-xs font-semibold text-[#dce9df]">Research cockpit</div><div className="font-mono-ui mt-0.5 text-[9px] text-[#779188]">personal / paper</div></div><ChevronDown size={14} className="text-[#789087]" /></div></div>
          <nav className="mt-8 flex-1 space-y-1">{navItems.map((item) => { const Icon = item.icon; return <button key={item.id} onClick={() => scrollTo(item.id)} className={`group flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left transition ${active === item.id ? "bg-[#163229] text-[#d8f393]" : "text-[#829a90] hover:bg-[#10241f] hover:text-[#d7e8d9]"}`}><span className="flex items-center gap-3"><Icon size={16} className={active === item.id ? "text-[#c8f169]" : "text-[#71887e]"} /><span className="text-xs font-medium">{item.label}</span></span>{item.badge ? <span className={`font-mono-ui rounded px-1.5 py-0.5 text-[9px] ${active === item.id ? "bg-[#c8f169] text-[#15240d]" : "bg-[#19342b] text-[#9bb9a4]"}`}>{item.badge}</span> : null}</button>; })}<div className="my-5 border-t border-[#173029]" />{[{ label: "Events", icon: CalendarDays }, { label: "Decision audit", icon: BookOpen }].map(({ label, icon: Icon }) => <button key={label} onClick={() => toast.info(`${label} view is queued for the API phase.`)} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-xs font-medium text-[#71877d] transition hover:bg-[#10241f] hover:text-[#d7e8d9]"><Icon size={16} className="text-[#607a70]" />{label}</button>)}</nav>
          <div className="rounded-xl border border-[#1c382f] bg-[#0e1d19] p-3"><div className="flex items-center gap-2"><span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#c8f169] opacity-50" /><span className="relative inline-flex h-2 w-2 rounded-full bg-[#c8f169]" /></span><span className="font-mono-ui text-[10px] text-[#b8cdaf]">PIPELINE LIVE</span></div><p className="mt-2 text-[10px] leading-relaxed text-[#70887d]">Signals appear after the local collector and engine have produced a snapshot.</p></div>
        </aside>
        {mobileOpen ? <button aria-label="Close navigation" onClick={() => setMobileOpen(false)} className="fixed inset-0 z-30 bg-black/50 lg:hidden" /> : null}

        <main className="relative min-w-0 flex-1">
          <header className="sticky top-0 z-20 border-b border-[#152b26] bg-[#07100f]/85 backdrop-blur-xl"><div className="flex h-[70px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-8"><div className="flex items-center gap-3"><button onClick={() => setMobileOpen(true)} className="rounded-lg border border-[#203d34] p-2 text-[#9bb0a5] hover:bg-[#12251f] lg:hidden"><Menu size={17} /></button><div><div className="font-mono-ui text-[9px] uppercase tracking-[0.2em] text-[#668176]">Workspace / {active}</div><div className="mt-1 flex items-center gap-2"><h1 className="font-display text-lg font-semibold tracking-tight text-[#eef6eb]">Market overview</h1><span className="hidden rounded-full border border-[#395032] bg-[#1a2b18] px-2 py-0.5 font-mono-ui text-[9px] text-[#bddd76] sm:inline-flex">{apiState === "connected" ? "LIVE PRICE / COMPUTED MODULES" : "LOCAL API OFFLINE"}</span></div></div></div><div className="flex items-center gap-2 sm:gap-4"><div className="hidden items-center gap-2 rounded-lg border border-[#1c382f] bg-[#0c1c18] px-3 py-2 text-[10px] text-[#88a196] md:flex"><Wifi size={13} className={apiState === "connected" ? "text-[#c8f169]" : "text-[#e5b55f]"} /> {apiState === "connected" ? "API connected" : apiState === "checking" ? "Checking API" : "API offline"}</div><button onClick={() => toast.info("Notifications will appear when alert rules are connected.")} className="relative rounded-lg border border-[#1c382f] p-2 text-[#8ea69b] hover:bg-[#12251f]"><Bell size={16} /><span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[#e5b55f]" /></button><div className="hidden h-8 w-8 items-center justify-center rounded-full border border-[#48634c] bg-[#23341f] font-display text-xs font-bold text-[#d8f49a] sm:flex">AK</div></div></div></header>

          <div className="mx-auto max-w-[1540px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
            <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><div className="font-mono-ui mb-2 text-[10px] uppercase tracking-[0.24em] text-[#789087]">Local analysis workspace</div><h2 className="font-display text-3xl font-semibold tracking-[-0.04em] text-[#f0f7ec] sm:text-4xl">Analyze any ticker<span className="text-[#c8f169]">.</span></h2><p className="mt-2 max-w-xl text-sm leading-relaxed text-[#849b91]">Select an instrument from your local database. Price data is shown only after the collector has fetched it.</p></div><div className="flex items-center gap-2"><div className="relative"><select value={instrument} onChange={(e) => { setInstrument(e.target.value); toast.success(`Analyzing ${e.target.value}`); }} className="appearance-none rounded-lg border border-[#26453a] bg-[#10211c] py-2.5 pl-3 pr-9 font-mono-ui text-xs text-[#d7e8d9] outline-none hover:border-[#51745c]"><option value="NIFTY">NIFTY</option>{instruments.filter((item) => item.symbol !== "NIFTY").map((item) => <option key={item.symbol} value={item.symbol}>{item.symbol}</option>)}</select><ChevronDown size={14} className="pointer-events-none absolute right-3 top-3 text-[#7d968a]" /></div><div className="flex items-center gap-1 rounded-lg border border-[#26453a] bg-[#10211c] px-2 py-1"><input value={newTicker} onChange={(e) => setNewTicker(e.target.value.toUpperCase())} placeholder="RELIANCE.NS" className="w-24 bg-transparent px-1 py-1 font-mono-ui text-[10px] text-[#d7e8d9] outline-none" /><button onClick={async () => { if (!newTicker.trim()) return; try { await addInstrument(newTicker.trim()); setInstrument(newTicker.trim()); setNewTicker(""); toast.success(`Added ${newTicker.trim()} — collecting now`); } catch { toast.error("Could not add ticker. Start the local API first."); } }} className="rounded bg-[#c8f169] px-2 py-1 font-mono-ui text-[10px] text-[#15230c]">Add</button></div><button onClick={() => toast.success("Workspace refreshed from the local API.")} className="flex items-center gap-2 rounded-lg border border-[#26453a] bg-[#10211c] px-3 py-2.5 font-mono-ui text-xs text-[#b9cec0] hover:border-[#51745c] hover:text-[#e4f2d9]"><RefreshCw size={14} /> <span className="hidden sm:inline">Refresh</span></button></div></div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><MetricCard label="Spot price" value={market ? market.close.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : "—"} sub={market ? `${instrument} · live collector bar` : "Awaiting live collector bar"} trend={market ? "LIVE" : "NO DATA"} icon={TrendingUp} /><MetricCard label="Signal confidence" value="—" sub="Awaiting computed signal" trend="N/A" icon={Gauge} /><MetricCard label="Expected move" value="—" sub="Awaiting feature snapshot" trend="N/A" icon={Activity} /><MetricCard label="System health" value={apiState === "connected" ? "API OK" : "—"} sub="See data health for freshness" trend={apiState === "connected" ? "Connected" : "Offline"} icon={ShieldCheck} /></div>

            <div className="mt-6 grid gap-5 xl:grid-cols-[1.15fr_.85fr]"><PriceChart market={market} history={history} symbol={instrument} /><SignalCard symbol={instrument} signal={signal} /></div>
            <div className="mt-5 grid gap-5 xl:grid-cols-[1.1fr_.9fr]"><OptionChain symbol={instrument} rows={optionRows} /><TradeCard /></div>
            <div className="mt-5 grid gap-5 xl:grid-cols-2"><ForecastCard symbol={instrument} forecast={forecast} /><BacktestCard /></div>
            <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_1.6fr]"><HealthRail apiState={apiState} historyCount={history.length} /><div className="glass-panel rounded-2xl border border-[#1d332f] p-5"><div className="flex items-start justify-between"><div><div className="font-mono-ui text-[10px] uppercase tracking-[0.18em] text-[#789087]">Design principle</div><h2 className="font-display mt-1 text-lg font-semibold text-[#edf5e9]">Explainability over noise</h2></div><Sparkles size={17} className="text-[#c8f169]" /></div><div className="mt-5 grid gap-4 md:grid-cols-3">{[['01', 'Collect facts', 'The collector stores validated market history — never decisions.'], ['02', 'Score evidence', 'Signals carry confidence, versions, and reason codes.'], ['03', 'Gate risk', 'Sizing and execution stay behind a deliberate risk layer.']].map(([num, title, text]) => <div key={num} className="border-l border-[#466142] pl-3"><div className="font-mono-ui text-[10px] text-[#c8f169]">{num}</div><div className="mt-1 text-xs font-semibold text-[#d7e7d9]">{title}</div><p className="mt-1 text-[11px] leading-relaxed text-[#789087]">{text}</p></div>)}</div></div></div>
            <footer className="flex flex-col gap-2 border-t border-[#152b26] py-6 text-[10px] text-[#637a70] sm:flex-row sm:items-center sm:justify-between"><span className="font-mono-ui">D-PREDICT / RESEARCH COCKPIT / V1.0.0</span><span className="flex items-center gap-1.5"><CircleHelp size={12} /> Read-only interface · no financial advice</span></footer>
          </div>
        </main>
      </div>
    </div>
  );
}
