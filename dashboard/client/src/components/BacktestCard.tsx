import { useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { getBacktest, type BacktestResult, type BacktestStrategy } from "@/lib/localApi";

const STRATEGIES: Array<{ key: BacktestStrategy; label: string; hint: string }> = [
  { key: "sma_trend", label: "SMA TREND", hint: "Long while close > its 20-day mean; decisions use data through the previous bar and trade at the next close." },
  { key: "vol_expansion", label: "VOL EXPANSION", hint: "Long while 10-day realized vol exceeds 60-day — the feature family with the most stable panel IC in training/diagnose_edge.py." },
  { key: "buy_hold", label: "BUY & HOLD", hint: "Benchmark: one round trip, net of the live charge engine." },
];

export default function BacktestCard({ symbol, className = "" }: { symbol: string; className?: string }) {
  const [strategy, setStrategy] = useState<BacktestStrategy>("sma_trend");
  const [days, setDays] = useState(365);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "empty">("loading");
  useEffect(() => {
    const controller = new AbortController();
    setState("loading");
    getBacktest(symbol, strategy, days, controller.signal)
      .then((payload) => { setResult(payload); setState(payload ? "ready" : "empty"); })
      .catch(() => { setResult(null); setState("empty"); });
    return () => controller.abort();
  }, [symbol, strategy, days]);
  const points = useMemo(() => {
    const curve = result?.equityCurve ?? [];
    const step = Math.max(1, Math.ceil(curve.length / 160));
    return curve.filter((_, index) => index % step === 0 || index === curve.length - 1).map((point) => ({ ...point, label: new Date(point.timestamp).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) }));
  }, [result]);
  const holdReturn = result ? result.equityCurve[result.equityCurve.length - 1].buyHold / result.initialCapital - 1 : 0;
  const money = (value: number) => value.toLocaleString("en-IN", { maximumFractionDigits: 0 });
  const percent = (value: number) => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
  const metric = (label: string, value: string, tone = "text-[#e2eee3]") => (
    <div className="rounded-lg border border-[#1c382f] bg-[#0b1815] p-2">
      <div className="font-mono-ui text-[9px] text-[#71877d]">{label}</div>
      <div className={`font-display mt-1 text-sm ${tone}`}>{value}</div>
    </div>
  );
  return (
    <div id="backtest" className={`scroll-mt-24 rounded-2xl border border-[#1d332f] p-5 ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-mono-ui text-[10px] uppercase tracking-[0.18em] text-[#789087]">Evidence / rules</div>
          <h2 className="font-display mt-1 text-lg font-semibold text-[#edf5e9]">Backtest pulse</h2>
          <p className="mt-1 text-xs text-[#71877d]">{symbol} · {result ? `${result.bars} daily bars` : "stored daily bars"} · long-only, net of charges</p>
        </div>
        <span className={`font-mono-ui rounded-md border px-2 py-1 text-[10px] ${result ? "border-[#46603d] bg-[#20301c] text-[#c8f169]" : "border-[#4e4226] bg-[#211d12] text-[#e5b55f]"}`}>{result ? "RULE ENGINE" : state === "loading" ? "RUNNING" : "NO DATA"}</span>
      </div>
      <div className="mt-4 mb-3 flex flex-wrap items-center gap-1.5">
        {STRATEGIES.map((item) => (
          <button key={item.key} type="button" title={item.hint} aria-pressed={strategy === item.key} onClick={() => setStrategy(item.key)} className={`font-mono-ui rounded-full border px-2.5 py-1 text-[9px] tracking-[.1em] transition-all ${strategy === item.key ? "border-[#46603d] bg-[#20301c] text-[#c8f169]" : "border-[#1a2a24] text-[#4f6459] hover:border-[#29463b]"}`}>{item.label}</button>
        ))}
        <span className="mx-1 h-3 w-px bg-[#1d332f]" />
        {[180, 365, 730].map((window) => (
          <button key={window} type="button" aria-pressed={days === window} onClick={() => setDays(window)} className={`font-mono-ui rounded-full border px-2.5 py-1 text-[9px] tracking-[.1em] ${days === window ? "border-[#46603d] bg-[#20301c] text-[#c8f169]" : "border-[#1a2a24] text-[#4f6459] hover:border-[#29463b]"}`}>{window}d</button>
        ))}
      </div>
      {result ? (
        <>
          <div className="h-[190px] min-w-0 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={points} margin={{ top: 8, right: 4, left: -14, bottom: 0 }}>
                <CartesianGrid stroke="#18302a" strokeDasharray="3 5" vertical={false} />
                <XAxis dataKey="label" tick={{ fill: "#70867c", fontSize: 10, fontFamily: "DM Mono" }} axisLine={false} tickLine={false} minTickGap={48} />
                <YAxis domain={["auto", "auto"]} tick={{ fill: "#70867c", fontSize: 10, fontFamily: "DM Mono" }} axisLine={false} tickLine={false} tickFormatter={(value) => `${(value / 1000).toFixed(0)}k`} />
                <Tooltip contentStyle={{ background: "#10211c", border: "1px solid #2b4b3d", borderRadius: 10, fontFamily: "DM Mono", fontSize: 11 }} formatter={(value: number, name: string) => [`₹${money(value)}`, name]} />
                <Area type="monotone" dataKey="buyHold" stroke="#8fa69a" strokeWidth={1} strokeDasharray="3 4" fill="none" name="BUY & HOLD" />
                <Area type="monotone" dataKey="equity" stroke="#c8f169" strokeWidth={2} fill="none" name="STRATEGY" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center xl:grid-cols-6">
            {metric("NET RETURN", percent(result.totalReturn), result.totalReturn >= 0 ? "text-[#c8f169]" : "text-[#ff9d91]")}
            {metric("VS HOLD", percent(result.totalReturn - holdReturn), result.totalReturn - holdReturn >= 0 ? "text-[#c8f169]" : "text-[#ff9d91]")}
            {metric("MAX DD", `-${(result.maxDrawdown * 100).toFixed(1)}%`, "text-[#e5b55f]")}
            {metric("WIN RATE", result.winRate == null ? "—" : `${(result.winRate * 100).toFixed(0)}%`)}
            {metric("PROFIT FACT", result.profitFactor == null ? "—" : result.profitFactor.toFixed(2))}
            {metric("COSTS", `₹${money(result.totalCosts)}`, "text-[#d0aa63]")}
          </div>
          <p className="mt-3 text-[9px] leading-relaxed text-[#5f7869]">Signals act on the next close — never the bar that produced them. {STRATEGIES.find((item) => item.key === strategy)?.hint} No ML model participates: every artifact currently fails the OOS promotion gate, so model-signal replay joins this card only once one passes. Results are rules replayed over stored history, not live tracking.</p>
        </>
      ) : (
        <div className="flex h-[190px] items-center justify-center rounded-xl border border-dashed border-[#315045] text-center">
          <div>
            <p className="mt-3 text-sm text-[#b7c7bd]">{state === "loading" ? "Running rules over stored bars…" : "No backtest results"}</p>
            <p className="mt-1 text-xs text-[#789087]">{state === "loading" ? "Long-only equity rules, net of live charge rates." : "Needs at least 62 stored daily bars for this instrument."}</p>
          </div>
        </div>
      )}
    </div>
  );
}
