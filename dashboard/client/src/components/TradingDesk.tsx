import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowDownRight, ArrowUpRight, Download, Plus, RefreshCw, Search, ShieldAlert, Trash2, Wallet, X } from "lucide-react";
import { toast } from "sonner";
import {
  addInstrument,
  cancelPaperOrder,
  createPaperAccount,
  depositPaperFunds,
  getLiveQuote,
  getPaperEstimate,
  getPaperState,
  paperExportUrl,
  paperLiveUrl,
  placePaperOrder,
  resetPaperAccount,
  searchInstruments,
} from "@/lib/localApi";
import type { ChargeBreakdown, LiveMessage, MarketOverview, PaperOrder, PaperProduct, PaperState, OrderType } from "@/lib/localApi";

const money = (value?: number | null) => value == null ? "—" : `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
const num = (value?: number | null) => value == null ? "—" : value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
const pct = (value?: number | null) => value == null ? "—" : `${(value * 100).toFixed(2)}%`;
const tone = (value: number) => value > 0 ? "text-[#c8f169]" : value < 0 ? "text-[#ff9d91]" : "text-[#9fb4a8]";

type Tab = "POSITIONS" | "HOLDINGS" | "ORDER_BOOK" | "TRADE_BOOK";

export default function TradingDesk() {
  const [state, setState] = useState<PaperState | null>(null);
  const [busy, setBusy] = useState(false);
  const [capital, setCapital] = useState("1000000");
  const [fundAmount, setFundAmount] = useState("");
  const [showFunds, setShowFunds] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const [symbol, setSymbol] = useState(() => localStorage.getItem("dpredict:selected-symbol") || "TCS.NS");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ symbol: string; name?: string | null }[]>([]);
  const [quote, setQuote] = useState<MarketOverview | null>(null);

  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [product, setProduct] = useState<PaperProduct>("CNC");
  const [orderType, setOrderType] = useState<OrderType>("MARKET");
  const [quantity, setQuantity] = useState("400");
  const [limitPrice, setLimitPrice] = useState("");
  const [estimate, setEstimate] = useState<ChargeBreakdown | null>(null);
  const [tab, setTab] = useState<Tab>("POSITIONS");

  const requestId = useRef(0);
  const socketRef = useRef<WebSocket | null>(null);
  const symbolRef = useRef(symbol);
  const orderTypeRef = useRef(orderType);
  symbolRef.current = symbol;
  orderTypeRef.current = orderType;
  const [connected, setConnected] = useState(false);

  const refresh = useCallback(async () => {
    try { setState(await getPaperState()); } catch (error) { toast.error(error instanceof Error ? error.message : "Paper state unavailable"); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Live updates arrive over a WebSocket (server pushes state + watched quotes). Orders
  // are matched against the live market server-side, so a fill surfaces the moment the
  // market moves. If the socket drops we fall back to polling until it reconnects.
  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnect: number | undefined;
    let fallback: number | undefined;
    let closed = false;

    const startFallback = () => {
      if (fallback) return;
      fallback = window.setInterval(async () => {
        void refresh();
        try { const q = await getLiveQuote(symbolRef.current); setQuote(q); if (orderTypeRef.current === "MARKET" && q?.close != null) setLimitPrice(String(q.close)); } catch { /* keep last quote */ }
      }, 6000);
    };
    const stopFallback = () => { if (fallback) { window.clearInterval(fallback); fallback = undefined; } };

    const connect = () => {
      if (closed) return;
      try { socket = new WebSocket(paperLiveUrl()); } catch { startFallback(); return; }
      socketRef.current = socket;
      socket.onopen = () => { setConnected(true); stopFallback(); socket?.send(JSON.stringify({ type: "watch", symbol: symbolRef.current })); };
      socket.onmessage = (event) => {
        let message: LiveMessage; try { message = JSON.parse(event.data) as LiveMessage; } catch { return; }
        if (message.type === "state") setState((message as Extract<LiveMessage, { type: "state" }>).state);
        else if (message.type === "quote") {
          const envelope = message as Extract<LiveMessage, { type: "quote" }>;
          if (envelope.symbol === symbolRef.current) { setQuote(envelope.quote); if (orderTypeRef.current === "MARKET" && envelope.quote?.close != null) setLimitPrice(String(envelope.quote.close)); }
        }
      };
      const onDown = () => { setConnected(false); startFallback(); if (!closed) reconnect = window.setTimeout(connect, 4000); };
      socket.onclose = onDown;
      socket.onerror = () => { socket?.close(); };
    };
    connect();

    return () => { closed = true; if (reconnect) window.clearTimeout(reconnect); stopFallback(); socket?.close(); socketRef.current = null; };
  }, [refresh]);

  useEffect(() => { const socket = socketRef.current; if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "watch", symbol })); }, [symbol]);

  const refPrice = orderType === "LIMIT" ? Number(limitPrice) : (quote?.close ?? 0);
  useEffect(() => {
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty <= 0 || !Number.isFinite(refPrice) || refPrice <= 0) { setEstimate(null); return; }
    let cancelled = false;
    const t = window.setTimeout(async () => { try { const e = await getPaperEstimate({ side, product, quantity: qty, price: refPrice }); if (!cancelled) setEstimate(e.charges); } catch { if (!cancelled) setEstimate(null); } }, 250);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [side, product, quantity, refPrice]);

  const runSearch = useCallback(async (value: string) => {
    setQuery(value);
    if (value.trim().length < 2) { setResults([]); return; }
    try { const found = await searchInstruments(value.trim()); setResults(found.slice(0, 8).map(i => ({ symbol: i.symbol, name: i.name }))); }
    catch { setResults([]); }
  }, []);

  const chooseInstrument = useCallback(async (value: string) => {
    const target = value.trim().toUpperCase();
    setSymbol(target); setResults([]); setQuery(target);
    localStorage.setItem("dpredict:selected-symbol", target);
    window.dispatchEvent(new Event("dpredict:symbol"));
    try { await getLiveQuote(target); }
    catch { try { await addInstrument(target); toast.success(`${target} added — data collection begins shortly.`); } catch { /* ignore */ } }
  }, []);

  const initialize = async () => {
    const fund = Number(capital);
    if (!Number.isFinite(fund) || fund <= 0) return toast.error("Enter a positive starting fund.");
    setBusy(true);
    try { await createPaperAccount(fund); await refresh(); toast.success("Research fund opened."); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Could not open fund."); }
    finally { setBusy(false); }
  };

  const addFunds = async () => {
    const amount = Number(fundAmount);
    if (!Number.isFinite(amount) || amount <= 0) return toast.error("Enter a positive amount to add.");
    setBusy(true);
    try { await depositPaperFunds(amount); await refresh(); setFundAmount(""); setShowFunds(false); toast.success(`${money(amount)} added to your fund.`); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Could not add funds."); }
    finally { setBusy(false); }
  };

  const clearLedger = async () => {
    if (!confirmReset) { setConfirmReset(true); window.setTimeout(() => setConfirmReset(false), 4000); return; }
    setBusy(true);
    try { await resetPaperAccount("trades"); await refresh(); setConfirmReset(false); toast.success("Ledger cleared. Fund and starting capital kept."); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Could not clear ledger."); }
    finally { setBusy(false); }
  };

  const place = async () => {
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty <= 0) return toast.error("Quantity must be a positive whole number.");
    if (orderType === "LIMIT" && !(Number(limitPrice) > 0)) return toast.error("Enter a limit price.");
    setBusy(true);
    try {
      const result = await placePaperOrder({ symbol, side, product, quantity: qty, orderType, limitPrice: orderType === "LIMIT" ? Number(limitPrice) : undefined });
      toast.success(result.message);
      await refresh();
    } catch (error) { toast.error(error instanceof Error ? error.message : "Order failed."); }
    finally { setBusy(false); }
  };

  const quickSell = (row: PaperOrder | { symbol: string; product: PaperProduct; quantity: number }) => {
    setSymbol(row.symbol); setSide("SELL"); setProduct(row.product); setQuantity(String(row.quantity));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const cancel = async (id: string) => {
    try { await cancelPaperOrder(id); await refresh(); toast.success("Order cancelled."); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Cancel failed."); }
  };

  const positions = useMemo(() => state?.positions.filter(p => p.section === "POSITIONS") ?? [], [state]);
  const holdings = useMemo(() => state?.positions.filter(p => p.section === "HOLDINGS") ?? [], [state]);
  const openOrders = useMemo(() => state?.orders.filter(o => o.status === "OPEN") ?? [], [state]);
  const book = state?.orders ?? [];

  const account = state?.account;

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 py-5 text-[#d7e8d9]">
      {!account ? (
        <div className="rounded-2xl border border-[#29463b] bg-[#0b1714] p-8 text-center">
          <h2 className="font-display text-xl font-semibold">Open a research fund</h2>
          <p className="mx-auto mt-2 max-w-md text-xs text-[#789087]">Virtual funds only. Orders fill from real persisted prices and never reach a broker. No demo trades are preloaded.</p>
          <div className="mx-auto mt-5 flex max-w-sm items-end gap-3">
            <label className="block flex-1 text-left text-xs text-[#9fb4a8]">Starting capital<input value={capital} onChange={e => setCapital(e.target.value)} inputMode="decimal" className="mt-2 w-full rounded-lg border border-[#345346] bg-[#09130f] px-3 py-2 font-mono-ui text-sm outline-none focus:border-[#c8f169]" /></label>
            <button disabled={busy} onClick={() => void initialize()} className="rounded-lg border border-[#476238] bg-[#17301f] px-4 py-2 text-xs font-semibold text-[#c8f169] disabled:opacity-50">{busy ? "Opening…" : "Open fund"}</button>
          </div>
        </div>
      ) : (
        <>
          {/* Toolbar: add funds + clear ledger */}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#789087]">
              <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono-ui text-[10px] uppercase tracking-[0.1em] ${state?.marketLive ? "border-[#476238] text-[#c8f169]" : "border-[#5a432a] text-[#c8b582]"}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${state?.marketLive ? "bg-[#c8f169]" : "bg-[#e5b55f]"}`} />
                {state?.marketLive ? "Market live" : "Market closed"}
              </span>
              <span className="inline-flex items-center gap-1 text-[10px] text-[#5c736a]">
                <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-[#c8f169]" : "bg-[#ff9d91]"}`} />
                {connected ? "live feed" : "reconnecting…"}
              </span>
              <span className="hidden sm:inline">Orders fill only on live ticks · placed after hours, they queue until the market reopens.</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {showFunds ? (
                <div className="flex items-center gap-1">
                  <div className="relative">
                    <Wallet size={12} className="absolute left-2 top-2.5 text-[#5c736a]" />
                    <input autoFocus value={fundAmount} onChange={e => setFundAmount(e.target.value)} onKeyDown={e => { if (e.key === "Enter") void addFunds(); if (e.key === "Escape") { setShowFunds(false); setFundAmount(""); } }} inputMode="decimal" placeholder="Amount" className="w-28 rounded-lg border border-[#345346] bg-[#09130f] py-1.5 pl-7 pr-2 font-mono-ui text-xs outline-none focus:border-[#c8f169]" />
                  </div>
                  <button disabled={busy} onClick={() => void addFunds()} className="rounded-lg border border-[#476238] bg-[#17301f] px-2.5 py-1.5 text-[11px] font-semibold text-[#c8f169] disabled:opacity-50">Add</button>
                  <button onClick={() => { setShowFunds(false); setFundAmount(""); }} className="rounded-lg border border-[#1d332f] p-1.5 text-[#789087] hover:bg-[#142a25]"><X size={12} /></button>
                </div>
              ) : (
                <button onClick={() => setShowFunds(true)} className="inline-flex items-center gap-1 rounded-lg border border-[#345346] px-2.5 py-1.5 text-[11px] font-semibold text-[#c8f169] hover:bg-[#142a25]"><Plus size={12} /> Add funds</button>
              )}
              <button disabled={busy} onClick={() => void clearLedger()} className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold disabled:opacity-50 ${confirmReset ? "border-[#633d38] bg-[#291817] text-[#ff9d91]" : "border-[#345346] text-[#9fb4a8] hover:bg-[#142a25]"}`}><Trash2 size={12} /> {confirmReset ? "Confirm clear?" : "Clear ledger"}</button>
            </div>
          </div>

          {/* Account summary */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {[
              ["Equity", money(account.equity), "live 1-min mark"],
              ["Available cash", money(account.cash), "uninvested"],
              ["Return", <span className={tone(account.returnPct)}>{pct(account.returnPct)}</span>, "net of charges"],
              ["Realized P&L", <span className={tone(account.realizedPnl)}>{money(account.realizedPnl)}</span>, "closed (net)"],
              ["Unrealized P&L", <span className={tone(account.unrealizedPnl)}>{money(account.unrealizedPnl)}</span>, "open (net)"],
              ["Charges paid", money(account.totalCosts), "brokerage+govt"],
            ].map(([label, value, sub]) => (
              <div key={String(label)} className="rounded-xl border border-[#1d332f] bg-[#09130f] p-3">
                <div className="text-[10px] uppercase tracking-[0.14em] text-[#789087]">{label}</div>
                <div className="mt-1 font-mono-ui text-base font-semibold">{value}</div>
                <div className="text-[9px] text-[#5c736a]">{sub}</div>
              </div>
            ))}
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_1.15fr]">
            {/* Left: instrument + order slip */}
            <div className="rounded-2xl border border-[#1d332f] bg-[#0b1714] p-4">
              <div className="relative">
                <Search size={14} className="absolute left-3 top-3 text-[#5c736a]" />
                <input value={query} onChange={e => void runSearch(e.target.value)} placeholder="Search instrument to trade (e.g. TCS, INFY, RELIANCE)" className="w-full rounded-lg border border-[#345346] bg-[#09130f] py-2 pl-9 pr-3 text-sm outline-none focus:border-[#c8f169]" />
                {results.length > 0 && (
                  <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-[#345346] bg-[#0b1714] shadow-xl">
                    {results.map(r => <button key={r.symbol} onClick={() => void chooseInstrument(r.symbol)} className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-[#142a25]"><span className="font-mono-ui font-semibold">{r.symbol}</span><span className="text-[10px] text-[#789087]">{r.name ?? ""}</span></button>)}
                  </div>
                )}
              </div>

              <div className="mt-4 flex items-start justify-between">
                <div>
                  <div className="font-mono-ui text-lg font-semibold">{symbol}</div>
                  <div className="text-[10px] text-[#789087]">{quote?.status === "LIVE" ? "live 1-min bar" : quote?.status === "CACHED" ? "recent bar" : quote?.status === "STALE" ? "stale — market may be closed" : "awaiting data"}</div>
                </div>
                <div className="text-right">
                  <div className="font-mono-ui text-xl font-semibold">{num(quote?.close)}</div>
                  {quote?.changePercent != null && <div className={`text-[11px] ${tone(quote.change ?? 0)}`}><span>{quote.changePercent >= 0 ? "+" : ""}{(quote.changePercent).toFixed(2)}%</span></div>}
                </div>
              </div>

              {/* BUY / SELL */}
              <div className="mt-4 grid grid-cols-2 gap-2">
                <button onClick={() => setSide("BUY")} className={`rounded-lg border py-2 text-sm font-semibold ${side === "BUY" ? "border-[#476238] bg-[#17301f] text-[#c8f169]" : "border-[#1d332f] text-[#789087]"}`}>BUY</button>
                <button onClick={() => setSide("SELL")} className={`rounded-lg border py-2 text-sm font-semibold ${side === "SELL" ? "border-[#633d38] bg-[#291817] text-[#ff9d91]" : "border-[#1d332f] text-[#789087]"}`}>SELL</button>
              </div>

              {/* product */}
              <div className="mt-3">
                <div className="text-[10px] uppercase tracking-[0.14em] text-[#789087]">Product</div>
                <div className="mt-1 flex gap-2">
                  {(["CNC", "MIS", "NRML"] as PaperProduct[]).map(p => <button key={p} onClick={() => setProduct(p)} className={`flex-1 rounded-lg border py-1.5 text-xs font-semibold ${product === p ? "border-[#c8f169] bg-[#142a25] text-[#c8f169]" : "border-[#1d332f] text-[#9fb4a8]"}`}>{p}</button>)}
                </div>
                <div className="mt-1 text-[9px] text-[#5c736a]">{product === "CNC" ? "Delivery · becomes a Holding · 0 brokerage" : product === "MIS" ? "Intraday · auto squared-off at daily close" : "Carry-forward position"}</div>
              </div>

              {/* order type + qty + price */}
              <div className="mt-3 grid grid-cols-2 gap-3">
                <label className="text-[10px] uppercase tracking-[0.14em] text-[#789087]">Type
                  <select value={orderType} onChange={e => setOrderType(e.target.value as OrderType)} className="mt-1 w-full rounded-lg border border-[#345346] bg-[#09130f] px-2 py-2 text-xs text-[#d7e8d9] outline-none">
                    <option value="MARKET">Market</option><option value="LIMIT">Limit</option>
                  </select>
                </label>
                <label className="text-[10px] uppercase tracking-[0.14em] text-[#789087]">Quantity
                  <input value={quantity} onChange={e => setQuantity(e.target.value)} inputMode="numeric" className="mt-1 w-full rounded-lg border border-[#345346] bg-[#09130f] px-2 py-2 font-mono-ui text-sm text-[#d7e8d9] outline-none" />
                </label>
              </div>
              {orderType === "LIMIT" && (
                <label className="mt-3 block text-[10px] uppercase tracking-[0.14em] text-[#789087]">Limit price
                  <input value={limitPrice} onChange={e => setLimitPrice(e.target.value)} inputMode="decimal" className="mt-1 w-full rounded-lg border border-[#345346] bg-[#09130f] px-2 py-2 font-mono-ui text-sm text-[#d7e8d9] outline-none" />
                </label>
              )}

              {/* estimate */}
              <div className="mt-4 rounded-xl border border-[#1d332f] bg-[#09130f] p-3 text-[11px]">
                <div className="mb-2 text-[10px] uppercase tracking-[0.14em] text-[#789087]">Order estimate · {num(refPrice)} × {quantity || "0"}</div>
                {!estimate ? <div className="text-[#5c736a]">Enter a valid quantity and price to see charges.</div> : (
                  <div className="space-y-1">
                    <Row k="Gross value" v={money(refPrice * (Number(quantity) || 0))} />
                    <Row k="Brokerage" v={money(estimate.brokerage)} />
                    <Row k="STT" v={money(estimate.stt)} />
                    <Row k="Exchange txn" v={money(estimate.exchange)} />
                    <Row k="SEBI" v={money(estimate.sebi)} />
                    <Row k="Stamp duty" v={money(estimate.stamp)} />
                    <Row k="GST" v={money(estimate.gst)} />
                    <div className="my-1 border-t border-[#1d332f]" />
                    <Row k="Total charges" v={money(estimate.total)} strong />
                    <Row k={side === "BUY" ? "Net debit" : "Net credit"} v={money(side === "BUY" ? refPrice * (Number(quantity) || 0) + estimate.total : refPrice * (Number(quantity) || 0) - estimate.total)} strong />
                  </div>
                )}
              </div>

              <button disabled={busy || !estimate} onClick={() => void place()} className={`mt-4 w-full rounded-lg py-2.5 text-sm font-semibold text-[#08120f] transition-transform active:scale-[.99] disabled:opacity-50 ${side === "BUY" ? "bg-[#c8f169]" : "bg-[#ff9d91]"}`}>{busy ? "Placing…" : `${side} ${product} ${orderType} · ${symbol}`}</button>
              <div className="mt-2 flex items-center gap-1 text-[9px] leading-relaxed text-[#5c736a]"><ShieldAlert size={11} className="shrink-0" /> Full cash is debited for every product (no leverage) so the ledger stays honest. Fills use real persisted data.</div>
            </div>

            {/* Right: tabs */}
            <div className="rounded-2xl border border-[#1d332f] bg-[#0b1714] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap gap-1">
                  {([["POSITIONS", positions.length], ["HOLDINGS", holdings.length], ["ORDER_BOOK", openOrders.length], ["TRADE_BOOK", book.length]] as [Tab, number][]).map(([key, count]) => (
                    <button key={key} onClick={() => setTab(key)} className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${tab === key ? "bg-[#142a25] text-[#c8f169]" : "text-[#9fb4a8] hover:bg-accent"}`}>{key.replace("_", " ")} <span className="ml-1 text-[9px] text-[#5c736a]">{count}</span></button>
                  ))}
                </div>
                <div className="flex gap-1">
                  <a href={paperExportUrl(3650)} download className="inline-flex items-center gap-1 rounded-lg border border-[#345346] px-2 py-1.5 text-[10px] text-[#c8f169] hover:bg-[#142a25]"><Download size={11} /> CSV</a>
                  <button onClick={() => void refresh()} className="rounded-lg border border-[#345346] p-1.5 text-[#c8f169] hover:bg-[#142a25]"><RefreshCw size={12} /></button>
                </div>
              </div>

              <div className="mt-3 overflow-x-auto">
                {(tab === "POSITIONS" || tab === "HOLDINGS") ? (
                  <PositionTable rows={tab === "POSITIONS" ? positions : holdings} empty={tab === "POSITIONS" ? "No open intraday positions." : "No holdings yet."} onSell={quickSell} />
                ) : tab === "ORDER_BOOK" ? (
                  <OrderBook rows={openOrders} onCancel={cancel} />
                ) : (
                  <TradeBook rows={book} />
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return <div className="flex justify-between"><span className={strong ? "text-[#d7e8d9]" : "text-[#9fb4a8]"}>{k}</span><span className={`font-mono-ui ${strong ? "font-semibold text-[#d7e8d9]" : "text-[#c8b582]"}`}>{v}</span></div>;
}

type PosRow = { symbol: string; product: PaperProduct; quantity: number; averagePrice: number; currentPrice: number | null; unrealizedPnl: number | null };
function PositionTable({ rows, empty, onSell }: { rows: PosRow[]; empty: string; onSell: (r: PosRow) => void }) {
  if (!rows.length) return <div className="py-10 text-center text-xs text-[#5c736a]">{empty}</div>;
  return (
    <table className="w-full text-left text-xs">
      <thead className="text-[10px] uppercase tracking-[0.1em] text-[#5c736a]"><tr><th className="py-2">Instrument</th><th>Qty</th><th>Avg</th><th>LTP</th><th>P&L %</th><th>Net P&L</th><th></th></tr></thead>
      <tbody>
        {rows.map(r => {
          const pnlPct = r.currentPrice != null && r.averagePrice ? (r.currentPrice - r.averagePrice) / r.averagePrice : null;
          return (
            <tr key={`${r.symbol}-${r.product}`} className="border-t border-[#1d332f]">
              <td className="py-2"><span className="font-mono-ui font-semibold">{r.symbol}</span><span className="ml-2 rounded bg-[#142a25] px-1.5 py-0.5 text-[9px] text-[#8fb6ff]">{r.product}</span></td>
              <td>{r.quantity}</td><td>{num(r.averagePrice)}</td><td>{num(r.currentPrice)}</td>
              <td className={tone(pnlPct ?? 0)}>{pct(pnlPct)}</td>
              <td className={tone(r.unrealizedPnl ?? 0)}>{money(r.unrealizedPnl)}</td>
              <td className="text-right"><button onClick={() => onSell(r)} className="rounded border border-[#633d38] px-2 py-1 text-[10px] text-[#ff9d91] hover:bg-[#291817]">Sell</button></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function OrderBook({ rows, onCancel }: { rows: PaperOrder[]; onCancel: (id: string) => void }) {
  if (!rows.length) return <div className="py-10 text-center text-xs text-[#5c736a]">No pending or resting orders.</div>;
  return (
    <table className="w-full text-left text-xs">
      <thead className="text-[10px] uppercase tracking-[0.1em] text-[#5c736a]"><tr><th className="py-2">Instrument</th><th>Side</th><th>Qty</th><th>Type · limit</th><th>Placed</th><th></th></tr></thead>
      <tbody>{rows.map(o => <tr key={o.id} className="border-t border-[#1d332f]"><td className="py-2 font-mono-ui font-semibold">{o.symbol}<span className="ml-2 text-[9px] text-[#8fb6ff]">{o.product}</span><span className="ml-1.5 rounded bg-[#211b10] px-1.5 py-0.5 text-[8px] uppercase text-[#e5b55f]">{o.orderType === "MARKET" ? "pending" : "resting"}</span></td><td className={o.side === "BUY" ? "text-[#c8f169]" : "text-[#ff9d91]"}>{o.side}</td><td>{o.quantity}</td><td className="text-[#9fb4a8]">{o.orderType === "MARKET" ? "Market" : num(o.limitPrice)}</td><td className="text-[#5c736a]">{new Date(o.createdAt).toLocaleTimeString("en-IN")}</td><td className="text-right"><button onClick={() => void onCancel(o.id)} className="inline-flex items-center gap-1 rounded border border-[#345346] px-2 py-1 text-[10px] text-[#9fb4a8] hover:bg-[#142a25]"><X size={11} /> Cancel</button></td></tr>)}</tbody>
    </table>
  );
}

function TradeBook({ rows }: { rows: PaperOrder[] }) {
  if (!rows.length) return <div className="py-10 text-center text-xs text-[#5c736a]"><Activity size={16} className="mx-auto mb-2 opacity-50" />No trades yet. Place your first paper order.</div>;
  return (
    <table className="w-full text-left text-xs">
      <thead className="text-[10px] uppercase tracking-[0.1em] text-[#5c736a]"><tr><th className="py-2">Time</th><th>Instrument</th><th>Side</th><th>Qty</th><th>Fill</th><th>Charges</th><th>Net P&L</th><th>Status</th></tr></thead>
      <tbody>{rows.map(o => <tr key={o.id} className="border-t border-[#1d332f]"><td className="py-2 text-[#5c736a]">{new Date(o.createdAt).toLocaleString("en-IN", { hour12: false, month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</td><td className="font-mono-ui font-semibold">{o.symbol}<span className="ml-2 text-[9px] text-[#8fb6ff]">{o.product}</span></td><td className={o.side === "BUY" ? "text-[#c8f169]" : o.side === "SELL" ? "text-[#ff9d91]" : "text-[#e5b55f]"}>{o.side}</td><td>{o.quantity}</td><td>{num(o.fillPrice)}</td><td className="text-[#c8b582]">{money(Number(o.costs?.total ?? 0))}</td><td className={tone(o.realizedPnl)}>{o.realizedPnl ? money(o.realizedPnl) : "—"}</td><td><span className={`rounded px-1.5 py-0.5 text-[9px] ${o.status === "FILLED" ? "bg-[#142a25] text-[#c8f169]" : o.status === "OPEN" ? "bg-[#211b10] text-[#e5b55f]" : "bg-[#1a1a1a] text-[#789087]"}`}>{o.status}</span></td></tr>)}</tbody>
    </table>
  );
}
