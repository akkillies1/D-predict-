import { useEffect, useState } from "react";
import { Activity, Bookmark, RefreshCw, Trash2 } from "lucide-react";
import { addToWatchlist, getCoverage, getPerformance, getWatchlist, removeFromWatchlist } from "@/lib/localApi";
import type { Coverage, Performance, WatchlistItem } from "@/lib/localApi";
import { toast } from "sonner";

const periods = ["1D", "5D", "1W", "1M", "3M", "6M", "1Y", "2Y", "3Y", "5Y"];
const money = (value?: number | null) => value == null ? "—" : value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
const pct = (value?: number) => value == null ? "—" : `${(value * 100).toFixed(2)}%`;

export default function Research20Panel() {
  const [symbol, setSymbol] = useState(() => localStorage.getItem("dpredict:selected-symbol") || "NIFTY");
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [performance, setPerformance] = useState<Performance | null>(null);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [period, setPeriod] = useState("1M");
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    try { const [watch, perf, cover] = await Promise.all([getWatchlist(), getPerformance(symbol, period), getCoverage(symbol)]); setItems(watch); setPerformance(perf); setCoverage(cover); }
    catch (error) { toast.error(error instanceof Error ? error.message : "2.0 research data unavailable"); }
    finally { setBusy(false); }
  };
  useEffect(() => { void refresh(); }, [symbol, period]);
  useEffect(() => { const onSymbol = () => setSymbol(localStorage.getItem("dpredict:selected-symbol") || "NIFTY"); window.addEventListener("dpredict:symbol", onSymbol); return () => window.removeEventListener("dpredict:symbol", onSymbol); }, []);
  const add = async () => { try { await addToWatchlist(symbol); await refresh(); toast.success(`${symbol} added to watchlist`); } catch (error) { toast.error(error instanceof Error ? error.message : "Could not save watchlist"); } };
  const remove = async (value: string) => { try { await removeFromWatchlist(value); setItems((current) => current.filter((item) => item.symbol !== value)); } catch (error) { toast.error(error instanceof Error ? error.message : "Could not remove watchlist item"); } };
  const metrics = performance?.metrics;
  return <section className="mx-auto mb-6 grid w-full max-w-[1400px] gap-4 px-4 lg:grid-cols-[1fr_1.4fr]">
    <div className="rounded-2xl border border-border bg-card/60 p-5 shadow-sm"><div className="mb-4 flex items-center justify-between"><div><div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">D-Predict 2.0</div><h2 className="mt-1 text-lg font-semibold">My Watchlist</h2></div><button className="rounded-lg border border-border p-2 hover:bg-accent disabled:opacity-50" onClick={() => void refresh()} disabled={busy} aria-label="Refresh 2.0 data"><RefreshCw size={14} className={busy ? "animate-spin" : ""}/></button></div><div className="mb-4 flex items-center justify-between rounded-xl border border-dashed border-border p-3"><span className="text-xs text-muted-foreground">Persisted locally in PostgreSQL</span><button onClick={() => void add()} className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground"><Bookmark size={13}/> Add {symbol}</button></div>{items.length ? <div className="space-y-2">{items.map((item) => <div key={item.symbol} className="flex items-center justify-between rounded-xl border border-border/70 px-3 py-2.5"><div><b className="font-mono text-sm">{item.symbol}</b><div className="text-[10px] text-muted-foreground">{item.status === "AVAILABLE" ? `Last ${money(item.price)}` : "No persisted quote"}</div></div><button onClick={() => void remove(item.symbol)} className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" aria-label={`Remove ${item.symbol}`}><Trash2 size={14}/></button></div>)}</div> : <div className="rounded-xl border border-dashed border-border p-6 text-center text-xs text-muted-foreground">No saved instruments yet. Search a symbol and add it here.</div>}</div>
    <div className="rounded-2xl border border-border bg-card/60 p-5 shadow-sm"><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Actual persisted bars · {symbol}</div><h2 className="mt-1 text-lg font-semibold">Performance evidence</h2></div><div className="flex flex-wrap gap-1">{periods.map((value) => <button key={value} onClick={() => setPeriod(value)} className={`rounded-md px-2 py-1 text-[10px] font-semibold ${period === value ? "bg-primary text-primary-foreground" : "border border-border text-muted-foreground hover:bg-accent"}`}>{value}</button>)}</div></div>{coverage && <div className="mb-4 flex flex-wrap gap-3 text-[10px] text-muted-foreground"><span>Data: <b className={coverage.status === "FRESH" ? "text-emerald-400" : "text-amber-400"}>{coverage.status}</b></span><span>{coverage.observations} observations</span><span>Through {coverage.lastTimestamp ? new Date(coverage.lastTimestamp).toLocaleDateString() : "—"}</span></div>}{metrics?.status === "OK" ? <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{[["Return", pct(metrics.percentageReturn)], ["CAGR", pct(metrics.cagr)], ["Volatility", pct(metrics.volatility)], ["Max drawdown", pct(metrics.maxDrawdown)], ["Best day", pct(metrics.bestDay)], ["Worst day", pct(metrics.worstDay)], ["Positive days", pct(metrics.positiveDayRatio)], ["Observations", String(metrics.observations)]].map(([label, value]) => <div key={label} className="rounded-xl border border-border/70 p-3"><div className="text-[10px] text-muted-foreground">{label}</div><div className="mt-1 font-mono text-sm font-semibold">{value}</div></div>)}</div> : <div className="flex min-h-[150px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-center text-xs text-muted-foreground"><Activity size={18}/><span>{metrics?.status === "INSUFFICIENT_DATA" ? "Insufficient persisted data for this period." : "No persisted data for this period."}</span></div>}<p className="mt-4 text-[10px] text-muted-foreground">Metrics are calculated from stored market bars only. No synthetic prices or assumed coverage are used.</p></div>
  </section>;
}
