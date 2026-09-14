import { useCallback, useEffect, useState } from "react";
import { Activity, BarChart3, RefreshCw, Wifi, WifiOff, Zap, Target } from "lucide-react";
import { addInstrument, getLatestSignal, getLiveQuote, getLocalHealth, getMarketHistory, getMarketOverview, getOptionChain, type MarketOverview, type OptionRow, type PriceBar, type Signal, type TradeTarget, type TargetTiming } from "@/lib/localApi";
import LiveTickerSearch from "@/components/LiveTickerSearch";
import { toast } from "sonner";

const optionSymbols = new Set(["NIFTY", "BANKNIFTY"]);

function formatDuration(seconds?: number) {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const total = Math.max(0, Math.round(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function Timing({ timing }: { timing?: TargetTiming }) {
  if (!timing || timing.status === "UNCALIBRATED") return <span className="text-[#8e7851]">ETA pending calibration</span>;
  return <span>{formatDuration(timing.p50Seconds)} <span className="text-[#70887d]">({formatDuration(timing.p25Seconds)}–{formatDuration(timing.p75Seconds)})</span></span>;
}

function TargetCard({ target, index }: { target: TradeTarget; index: number }) {
  return <div className="rounded-lg border border-[#263f36] bg-[#0a1512] p-3">
    <div className="flex items-center justify-between font-mono-ui text-[9px] tracking-[.12em] text-[#70887d]"><span>TARGET {index + 1}</span><span>{(target.probability * 100).toFixed(0)}%</span></div>
    <div className="mt-1 font-display text-xl font-semibold">₹{target.price.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</div>
    <div className="mt-2 flex justify-between gap-2 font-mono-ui text-[10px]"><span>ETA</span><Timing timing={target.timing}/></div>
  </div>;
}

export default function Terminal() {
  const [symbol, setSymbol] = useState("NIFTY");
  const [market, setMarket] = useState<MarketOverview | null>(null);
  const [history, setHistory] = useState<PriceBar[]>([]);
  const [signal, setSignal] = useState<Signal | null>(null);
  const [options, setOptions] = useState<OptionRow[]>([]);
  const [connected, setConnected] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const [dataSource, setDataSource] = useState<string>("waiting");

  const selectSymbol = useCallback(async (nextSymbol: string) => {
    const normalized = nextSymbol.trim().toUpperCase();
    if (!normalized) return;
    setSymbol(normalized);
    try { await addInstrument(normalized); toast.success(`${normalized} activated for local collection`); }
    catch { toast.error(`Could not activate ${normalized}. Is the local API/database running?`); }
  }, []);

  const refresh = useCallback(async (full = true) => {
    setRefreshing(true);
    try {
      const health = await getLocalHealth(); setConnected(health.ok);
      const [live, stored, bars, latestSignal] = await Promise.allSettled([getLiveQuote(symbol), getMarketOverview(symbol), getMarketHistory(symbol), getLatestSignal(symbol)]);
      const liveQuote = live.status === "fulfilled" ? live.value : null;
      const storedQuote = stored.status === "fulfilled" ? stored.value : null;
      setMarket(liveQuote ?? storedQuote);
      setDataSource(liveQuote ? liveQuote.source ?? "yahoo-live" : storedQuote ? storedQuote.source ?? "collector" : "no data");
      setHistory(bars.status === "fulfilled" ? bars.value : []);
      setSignal(latestSignal.status === "fulfilled" ? latestSignal.value : null);
      if (full && optionSymbols.has(symbol)) setOptions(await getOptionChain(symbol)); else if (!optionSymbols.has(symbol)) setOptions([]);
      setLastUpdate(new Date().toISOString());
    } catch { setConnected(false); }
    finally { setRefreshing(false); }
  }, [symbol]);

  useEffect(() => { void refresh(true); }, [refresh]);
  useEffect(() => { const timer = window.setInterval(() => void refresh(false), 3000); return () => window.clearInterval(timer); }, [refresh]);
  useEffect(() => { const timer = window.setInterval(() => void refresh(true), 15000); return () => window.clearInterval(timer); }, [refresh]);

  const latest = history[history.length - 1];
  const strikes = Array.from(new Set(options.map((row) => row.strike))).sort((a, b) => a - b);
  const atm = market && strikes.length ? strikes.reduce((best, strike) => Math.abs(strike - market.close) < Math.abs(best - market.close) ? strike : best, strikes[0]) : null;
  const rowFor = (strike: number, type: "CE" | "PE") => options.find((row) => row.strike === strike && row.option_type === type);
  const thesis = signal?.tradeThesis;

  return <div className="min-h-screen bg-[#07100f] text-[#eaf4e9]">
    <header className="sticky top-0 z-30 border-b border-[#173029] bg-[#07100f]/95 backdrop-blur-xl"><div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-3 px-4 py-3 lg:px-8"><div className="mr-2 flex items-center gap-2"><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#c8f169] text-[#11210b]"><Activity size={18}/></span><b className="font-display">d—predict</b></div><LiveTickerSearch value={symbol} onChange={selectSymbol}/><div className="ml-auto flex items-center gap-2 font-mono-ui text-[10px]"><span className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${connected ? "border-[#3d5b38] bg-[#142419] text-[#c8f169]" : "border-[#5a4328] bg-[#21180e] text-[#e5b55f]"}`}>{connected ? <Wifi size={12}/> : <WifiOff size={12}/>} {connected ? "LOCAL LIVE" : "OFFLINE"}</span><button onClick={() => void refresh(true)} disabled={refreshing} aria-label="Refresh market" className="rounded-lg border border-[#26453a] p-2 text-[#a8bdb2] hover:bg-[#12251f] disabled:opacity-50"><RefreshCw size={14} className={refreshing ? "animate-spin" : ""}/></button></div></div></header>
    <main className="mx-auto max-w-[1600px] space-y-5 px-4 py-5 lg:px-8">
      <section className="grid gap-4 md:grid-cols-4">{[["SPOT", market?.close.toLocaleString("en-IN", { maximumFractionDigits: 2 }) ?? "—", market ? "LIVE" : "NO DATA"],["OPEN", market?.open?.toLocaleString("en-IN", { maximumFractionDigits: 2 }) ?? "—", dataSource],["SIGNAL", signal?.direction ?? "—", signal ? `${Math.round(signal.confidence * 100)}%` : "NO SIGNAL"],["UPDATED", lastUpdate ? new Date(lastUpdate).toLocaleTimeString("en-IN") : "—", latest ? "collector" : "waiting"]].map(([label,value,sub]) => <div key={label} className="rounded-xl border border-[#1d332f] bg-[#0b1714] p-4"><div className="font-mono-ui text-[9px] tracking-[.18em] text-[#70887d]">{label}</div><div className="mt-2 font-display text-2xl font-semibold">{value}</div><div className="mt-1 truncate font-mono-ui text-[10px] text-[#879d93]">{sub}</div></div>)}</section>

      <section className="rounded-xl border border-[#1d332f] bg-[#0b1714] p-5">
        <div className="mb-4 flex items-center justify-between"><div><div className="font-mono-ui text-[9px] tracking-[.18em] text-[#70887d]">TRADE THESIS</div><h2 className="font-display text-xl font-semibold">Price targets & time-to-target</h2></div><Target size={17} className="text-[#c8f169]"/></div>
        {thesis ? <>
          <div className="grid gap-3 md:grid-cols-4">
            <div className="rounded-lg border border-[#263f36] bg-[#0a1512] p-3"><div className="font-mono-ui text-[9px] text-[#70887d]">ENTRY</div><div className="mt-1 font-display text-xl">{thesis.entryPrice != null ? `₹${thesis.entryPrice.toLocaleString("en-IN", { maximumFractionDigits: 2 })}` : "—"}</div></div>
            <div className="rounded-lg border border-[#263f36] bg-[#0a1512] p-3"><div className="font-mono-ui text-[9px] text-[#70887d]">EXPECTED MOVE</div><div className="mt-1 font-display text-xl">{thesis.expectedReturn != null ? `${(thesis.expectedReturn * 100).toFixed(2)}%` : "—"}</div></div>
            <div className="rounded-lg border border-[#263f36] bg-[#0a1512] p-3"><div className="font-mono-ui text-[9px] text-[#70887d]">PROBABILITY</div><div className="mt-1 font-display text-xl">{thesis.probability != null ? `${(thesis.probability * 100).toFixed(1)}%` : "—"}</div></div>
            <div className="rounded-lg border border-[#263f36] bg-[#0a1512] p-3"><div className="font-mono-ui text-[9px] text-[#70887d]">HORIZON</div><div className="mt-1 font-display text-xl">{thesis.horizon ?? "—"}</div></div>
          </div>
          {thesis.targets?.length ? <div className="mt-3 grid gap-3 md:grid-cols-3">{thesis.targets.map((target, index) => <TargetCard key={`${target.price}-${index}`} target={target} index={index}/>)}</div> : <div className="mt-3 rounded-lg border border-dashed border-[#315045] p-4 text-sm text-[#8e7851]">Targets are not yet persisted in the live signal payload.</div>}
          {thesis.stop ? <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#59342e] bg-[#1a100f] p-3"><div><div className="font-mono-ui text-[9px] text-[#a87a70]">STOP LOSS</div><div className="font-display text-lg">₹{thesis.stop.price.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</div></div><div className="font-mono-ui text-[10px] text-[#b99b92]">Probability {(thesis.stop.probability != null ? thesis.stop.probability * 100 : 0).toFixed(0)}% · ETA <Timing timing={thesis.stop.timing}/></div><div className="font-mono-ui text-[10px] text-[#b99b92]">R/R {thesis.riskRewardToTarget1?.toFixed(2) ?? "—"}</div></div> : null}
          <div className="mt-3 font-mono-ui text-[9px] text-[#597369]">Distribution: {thesis.distributionStatus ?? "—"} · Thesis: {thesis.tradeThesisVersion ?? "—"}</div>
        </> : <div className="rounded-lg border border-dashed border-[#315045] p-6 text-center text-sm text-[#8e7851]">No persisted trade thesis for {symbol}. The dashboard is wired for target price, probability and ETA data, but it will not invent a target when the signal producer has not supplied one.</div>}
      </section>

      <section className="grid gap-5 xl:grid-cols-[1.5fr_.5fr]"><div className="rounded-xl border border-[#1d332f] bg-[#0b1714] p-5"><div className="mb-4 flex items-center justify-between"><div><div className="font-mono-ui text-[9px] tracking-[.18em] text-[#70887d]">MARKET / 1 MINUTE</div><h2 className="font-display text-xl font-semibold">{symbol}</h2></div><span className="font-mono-ui text-[10px] text-[#c8f169]">{history.length} bars</span></div><div className="h-64 overflow-hidden rounded-lg border border-[#173029] bg-[#08110f] p-3"><div className="flex h-full items-end gap-1">{history.map((bar,index) => { const values=history.map(item=>item.close); const min=Math.min(...values); const max=Math.max(...values); const height=max===min?50:((bar.close-min)/(max-min))*85+8; return <div key={`${bar.timestamp}-${index}`} title={`${new Date(bar.timestamp).toLocaleTimeString("en-IN")} ${bar.close}`} className="flex-1 rounded-t bg-[#87ad5b] opacity-80" style={{height:`${height}%`}}/>; })}</div></div><div className="mt-3 flex justify-between font-mono-ui text-[10px] text-[#71877d]"><span>{history[0] ? new Date(history[0].timestamp).toLocaleTimeString("en-IN") : "—"}</span><span>{latest ? new Date(latest.timestamp).toLocaleTimeString("en-IN") : "—"}</span></div><div className="mt-2 font-mono-ui text-[9px] text-[#597369]">quote source: {dataSource}</div></div><div className="rounded-xl border border-[#1d332f] bg-[#0b1714] p-5"><div className="flex items-center gap-2"><Zap size={15} className="text-[#c8f169]"/><span className="font-mono-ui text-[10px] tracking-[.16em] text-[#70887d]">SIGNAL</span></div>{signal ? <><div className={`mt-5 font-display text-3xl font-bold ${signal.direction === "BEARISH" ? "text-[#ff9d91]" : signal.direction === "BULLISH" ? "text-[#d7f883]" : "text-[#e5b55f]"}`}>{signal.direction}</div><div className="mt-2 text-sm text-[#9bb0a5]">Confidence {(signal.confidence*100).toFixed(1)}%</div><div className="mt-5 space-y-2">{signal.reasonCodes.map(reason=><div key={reason} className="rounded-lg border border-[#1d332f] px-3 py-2 text-xs text-[#b9c8bd]">{reason}</div>)}</div></> : <div className="mt-8 text-sm text-[#a68f62]">No stored signal for {symbol}.</div>}</div></section>
      <section className="rounded-xl border border-[#1d332f] bg-[#0b1714] p-5"><div className="mb-4 flex items-center justify-between"><div><div className="font-mono-ui text-[9px] tracking-[.18em] text-[#70887d]">DERIVATIVES</div><h2 className="font-display text-xl font-semibold">Option chain</h2></div><BarChart3 size={17} className="text-[#789087]"/></div>{optionSymbols.has(symbol)&&options.length?<div className="overflow-x-auto"><table className="w-full min-w-[700px] text-xs"><thead><tr className="border-y border-[#1d332f] text-left font-mono-ui text-[9px] uppercase tracking-wider text-[#71877d]"><th className="px-3 py-3">CE LTP</th><th className="px-3 py-3">CE OI</th><th className="px-3 py-3 text-center">STRIKE</th><th className="px-3 py-3">PE OI</th><th className="px-3 py-3">PE LTP</th><th className="px-3 py-3">IV</th></tr></thead><tbody>{strikes.slice(Math.max(0,(atm?strikes.indexOf(atm):0)-7),(atm?strikes.indexOf(atm):0)+8).map(strike=>{const ce=rowFor(strike,"CE");const pe=rowFor(strike,"PE");return <tr key={strike} className={`border-b border-[#142821] ${strike===atm?"bg-[#14251c]":""}`}><td className="px-3 py-2.5 font-mono-ui">{ce?.ltp??"—"}</td><td className="px-3 py-2.5 font-mono-ui text-[#849b91]">{ce?.oi??"—"}</td><td className="px-3 py-2.5 text-center font-mono-ui font-semibold text-[#d8e9d8]">{strike.toLocaleString("en-IN")}{strike===atm?" · ATM":""}</td><td className="px-3 py-2.5 font-mono-ui text-[#849b91]">{pe?.oi??"—"}</td><td className="px-3 py-2.5 font-mono-ui">{pe?.ltp??"—"}</td><td className="px-3 py-2.5 font-mono-ui text-[#849b91]">{ce?.iv??pe?.iv??"—"}</td></tr>})}</tbody></table></div>:<div className="rounded-lg border border-dashed border-[#315045] p-8 text-center text-sm text-[#789087]">{optionSymbols.has(symbol)?"Waiting for live option snapshots…":"Option chain is available for NIFTY and BANKNIFTY."}</div>}</section>
    </main>
  </div>;
}
