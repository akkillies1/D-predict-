import { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3, RefreshCw, ShoppingCart, X } from "lucide-react";
import { getOptionChain, getOptionPaperTrades, placeOptionPaperOrder, closeOptionPaperTrade, type OptionRow, type PaperOptionTrade } from "@/lib/localApi";
import { toast } from "sonner";

const symbols = ["NIFTY", "BANKNIFTY"] as const;

function money(value: number | null) {
  return value == null || !Number.isFinite(value) ? "—" : `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function QuoteCell({ row }: { row: OptionRow | undefined }) {
  if (!row) return <span className="text-muted-foreground">—</span>;
  return <div className="space-y-0.5"><div>{money(row.ltp)}</div><div className="text-[9px] text-muted-foreground">B {money(row.bid)} · A {money(row.ask)}</div></div>;
}

export default function OptionChainTradingPanel() {
  const [symbol, setSymbol] = useState<(typeof symbols)[number]>("NIFTY");
  const [options, setOptions] = useState<OptionRow[]>([]);
  const [trades, setTrades] = useState<PaperOptionTrade[]>([]);
  const [expiry, setExpiry] = useState<string>("");
  const [lots, setLots] = useState(1);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [chain, paperTrades] = await Promise.all([getOptionChain(symbol), getOptionPaperTrades()]);
      setOptions(chain);
      setTrades(paperTrades);
      const expiries = Array.from(new Set(chain.map((row) => row.expiry_date))).sort();
      setExpiry((current) => current && expiries.includes(current) ? current : expiries[0] ?? "");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load live option chain");
    } finally { setLoading(false); }
  }, [symbol]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { const timer = window.setInterval(() => void refresh(), 15000); return () => window.clearInterval(timer); }, [refresh]);

  const rows = useMemo(() => {
    const filtered = options.filter((row) => row.expiry_date === expiry);
    return Array.from(new Set(filtered.map((row) => row.strike))).sort((a, b) => a - b).map((strike) => ({
      strike,
      ce: filtered.find((row) => row.strike === strike && row.option_type === "CE"),
      pe: filtered.find((row) => row.strike === strike && row.option_type === "PE"),
    }));
  }, [options, expiry]);

  async function trade(row: OptionRow | undefined, side: "BUY" | "SELL") {
    if (!row) return;
    const key = `${row.option_type}-${row.strike}-${side}`;
    setBusy(key);
    try {
      const result = await placeOptionPaperOrder({ symbol, expiry: row.expiry_date, strike: row.strike, optionType: row.option_type, side, lots });
      toast.success(`${side} ${symbol} ${row.option_type} ${row.strike} filled at ${money(result.entryPrice)}`);
      await refresh();
    } catch (error) { toast.error(error instanceof Error ? error.message : "Paper order rejected"); }
    finally { setBusy(null); }
  }

  async function closeTrade(id: string) {
    setBusy(id);
    try {
      const result = await closeOptionPaperTrade(id);
      toast.success(`Position closed at ${money(result.exitPrice)} · P&L ${money(result.realizedPnl)}`);
      await refresh();
    } catch (error) { toast.error(error instanceof Error ? error.message : "Position close rejected"); }
    finally { setBusy(null); }
  }

  const openTrades = trades.filter((trade) => trade.status === "OPEN");

  return <section className="rounded-xl border border-border bg-card p-5">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div><div className="text-[9px] font-mono uppercase tracking-[.18em] text-muted-foreground">DERIVATIVES / PAPER EXECUTION</div><h2 className="text-xl font-semibold">Live Option Chain Trading</h2><p className="mt-1 text-xs text-muted-foreground">Orders are filled only from the latest persisted option quote. No broker order is sent.</p></div>
      <div className="flex items-center gap-2"><select value={symbol} onChange={(event) => setSymbol(event.target.value as (typeof symbols)[number])} className="rounded-md border border-border bg-background px-2 py-2 text-sm">{symbols.map((item) => <option key={item}>{item}</option>)}</select><select value={expiry} onChange={(event) => setExpiry(event.target.value)} className="rounded-md border border-border bg-background px-2 py-2 text-sm"><option value="">Expiry</option>{Array.from(new Set(options.map((row) => row.expiry_date))).sort().map((item) => <option key={item} value={item}>{item}</option>)}</select><label className="flex items-center gap-1 text-xs">Lots<input type="number" min={1} step={1} value={lots} onChange={(event) => setLots(Math.max(1, Number(event.target.value) || 1))} className="w-16 rounded-md border border-border bg-background px-2 py-2 text-sm"/></label><button onClick={() => void refresh()} disabled={loading} className="rounded-md border border-border p-2"><RefreshCw size={15} className={loading ? "animate-spin" : ""}/></button></div>
    </div>

    {rows.length ? <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-xs"><thead><tr className="border-y border-border text-left text-[9px] uppercase tracking-wider text-muted-foreground"><th className="px-2 py-3">CE</th><th className="px-2 py-3">CE OI</th><th className="px-2 py-3 text-center">STRIKE</th><th className="px-2 py-3">PE</th><th className="px-2 py-3">PE OI</th></tr></thead><tbody>{rows.map(({ strike, ce, pe }) => <tr key={strike} className="border-b border-border/60"><td className="px-2 py-2"><div className="flex items-center gap-2"><QuoteCell row={ce}/><button onClick={() => void trade(ce, "BUY")} disabled={!ce || busy === `CE-${strike}-BUY`} className="rounded bg-emerald-600 px-2 py-1 text-[10px] font-semibold text-white disabled:opacity-40">BUY</button><button onClick={() => void trade(ce, "SELL")} disabled={!ce || busy === `CE-${strike}-SELL`} className="rounded bg-red-600 px-2 py-1 text-[10px] font-semibold text-white disabled:opacity-40">SELL</button></div></td><td className="px-2 py-2">{ce?.oi?.toLocaleString("en-IN") ?? "—"}</td><td className="px-2 py-2 text-center font-semibold">{strike.toLocaleString("en-IN")}</td><td className="px-2 py-2"><div className="flex items-center gap-2"><QuoteCell row={pe}/><button onClick={() => void trade(pe, "BUY")} disabled={!pe || busy === `PE-${strike}-BUY`} className="rounded bg-emerald-600 px-2 py-1 text-[10px] font-semibold text-white disabled:opacity-40">BUY</button><button onClick={() => void trade(pe, "SELL")} disabled={!pe || busy === `PE-${strike}-SELL`} className="rounded bg-red-600 px-2 py-1 text-[10px] font-semibold text-white disabled:opacity-40">SELL</button></div></td><td className="px-2 py-2">{pe?.oi?.toLocaleString("en-IN") ?? "—"}</td></tr>)}</tbody></table></div> : <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No live option-chain data is available for the selected symbol and expiry.</div>}

    <div className="mt-5"><div className="mb-2 flex items-center gap-2 text-sm font-semibold"><ShoppingCart size={15}/> Open paper positions</div>{openTrades.length ? <div className="space-y-2">{openTrades.map((trade) => <div key={trade.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3 text-xs"><div><b>{trade.side} {trade.symbol} {trade.option_type} {Number(trade.strike).toLocaleString("en-IN")}</b><span className="ml-2 text-muted-foreground">{trade.expiry_date} · {trade.quantity} qty · entry {money(trade.entry_price)}</span></div><div className="flex items-center gap-3"><span>P&L {money(trade.unrealized_pnl)}</span><button onClick={() => void closeTrade(trade.id)} disabled={busy === trade.id} className="inline-flex items-center gap-1 rounded border border-border px-2 py-1"><X size={12}/> Close</button></div></div>)}</div> : <div className="text-xs text-muted-foreground">No open paper positions.</div>}</div>

    <div className="mt-4 flex items-center gap-2 text-[10px] text-muted-foreground"><BarChart3 size={13}/> Fill model: BUY at ask / SELL at bid; close uses the opposite side. Quotes older than the configured freshness window are rejected.</div>
  </section>;
}
