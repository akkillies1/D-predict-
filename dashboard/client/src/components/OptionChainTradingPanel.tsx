import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  SearchX,
  ShieldAlert,
  WifiOff,
  ArrowDownToLine,
  ArrowUpFromLine,
  BarChart3,
  Clock3,
  RefreshCw,
  ShoppingCart,
  X,
} from "lucide-react";
import {
  getOptionChain,
  discoverOptionInstruments,
  trackOptionUnderlying,
  getOptionPaperTrades,
  getOptionIntelligence,
  placeOptionPaperOrder,
  placeOptionPaperStrategy,
  closeOptionPaperTrade,
  getUnifiedPaperState,
  type OptionRow,
  type PaperOptionTrade,
  type OptionIntelligence,
} from "@/lib/localApi";
import { toast } from "sonner";

const money = (v: number | null) =>
  v == null || !Number.isFinite(v)
    ? "—"
    : `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const compact = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v)
    ? "—"
    : v.toLocaleString("en-IN", { maximumFractionDigits: 0 });

type UiError = { kind: "offline" | "permission" | "unavailable" | "unknown"; message: string };
function describeUiError(error: unknown): UiError {
  const value = error as { message?: unknown; status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  const message = typeof value?.message === "string" ? value.message : "The request could not be completed.";
  const status = Number(value?.status ?? value?.statusCode ?? value?.response?.status);
  if (!navigator.onLine || error instanceof TypeError && /fetch|network|connect/i.test(message)) return { kind: "offline", message: "Cannot reach the service. Check your connection and confirm the D-Predict local services are running." };
  if (status === 401 || status === 403 || /permission denied|forbidden|unauthori[sz]ed|access denied/i.test(message)) return { kind: "permission", message: "Access was denied. Check the account or service permissions, then retry." };
  if (status >= 500 || /service unavailable|failed to fetch|timed out|timeout|econnrefused/i.test(message)) return { kind: "unavailable", message: "The data service is unavailable or responding too slowly. Check service health and retry." };
  return { kind: "unknown", message };
}

function Quote({ row }: { row?: OptionRow }) {
  if (!row) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="min-w-[104px]">
      <div className="font-mono text-sm font-semibold tabular-nums">
        {money(row.ltp)}
      </div>
      <div className="mt-1 flex gap-2 font-mono text-[10px] tabular-nums text-muted-foreground">
        <span>B {money(row.bid)}</span>
        <span>A {money(row.ask)}</span>
      </div>
    </div>
  );
}
function TradeButtons({
  row,
  onTrade,
  busy,
}: {
  row?: OptionRow;
  onTrade: (row: OptionRow | undefined, side: "BUY" | "SELL") => void;
  busy: string | null;
}) {
  if (!row) return null;
  const base = `${row.option_type}-${row.strike}`;
  return (
    <div className="flex shrink-0 gap-1">
      <button
        onClick={() => onTrade(row, "BUY")}
        disabled={busy === `${base}-BUY`}
        className="rounded-md bg-emerald-500/15 px-2 py-1.5 text-[10px] font-bold text-emerald-400 ring-1 ring-inset ring-emerald-500/25 transition hover:bg-emerald-500/25 disabled:opacity-40"
      >
        BUY
      </button>
      <button
        onClick={() => onTrade(row, "SELL")}
        disabled={busy === `${base}-SELL`}
        className="rounded-md bg-rose-500/15 px-2 py-1.5 text-[10px] font-bold text-rose-400 ring-1 ring-inset ring-rose-500/25 transition hover:bg-rose-500/25 disabled:opacity-40"
      >
        SELL
      </button>
    </div>
  );
}

export default function OptionChainTradingPanel() {
  const [symbol, setSymbol] = useState(
    () => localStorage.getItem("dpredict:selected-symbol") || ""
  );
  const [search, setSearch] = useState(
    () => localStorage.getItem("dpredict:selected-symbol") || ""
  );
  const [discoveries, setDiscoveries] = useState<Awaited<ReturnType<typeof discoverOptionInstruments>>>([]);
  const [options, setOptions] = useState<OptionRow[]>([]);
  const [trades, setTrades] = useState<PaperOptionTrade[]>([]);
  const [intelligence, setIntelligence] = useState<OptionIntelligence | null>(null);
  const [unified, setUnified] = useState<Awaited<ReturnType<typeof getUnifiedPaperState>> | null>(null);
  const [expiry, setExpiry] = useState("");
  const [lots, setLots] = useState(1);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<{ kind: "offline" | "permission" | "unavailable" | "unknown"; message: string } | null>(null);
  const [slowLoading, setSlowLoading] = useState(false);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<{ kind: "offline" | "permission" | "unavailable" | "unknown"; message: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [closeReason, setCloseReason] = useState<"MANUAL" | "STOP_LOSS" | "TARGET" | "EXPIRY">("MANUAL");
  const refresh = useCallback(async () => {
    if (!symbol) { setOptions([]); setIntelligence(null); setLoadError(null); setLoading(false); return; }
    void trackOptionUnderlying({ symbol }).catch(() => undefined);
    setLoading(true);
    setLoadError(null);
    setSlowLoading(false);
    const slowTimer = window.setTimeout(() => setSlowLoading(true), 2500);
    try {
      const [chainResult, tradesResult, intelligenceResult, unifiedResult] = await Promise.allSettled([
        getOptionChain(symbol),
        getOptionPaperTrades(),
        getOptionIntelligence(symbol),
        getUnifiedPaperState(),
      ]);
      if (chainResult.status === "fulfilled") {
        const chain = chainResult.value;
        setOptions(chain);
        const expiries = Array.from(new Set(chain.map(row => row.expiry_date))).sort();
        setExpiry(current => current && expiries.includes(current) ? current : (expiries[0] ?? ""));
      } else {
        setOptions([]);
        setLoadError(describeUiError(chainResult.reason));
      }
      if (tradesResult.status === "fulfilled") setTrades(tradesResult.value);
      if (intelligenceResult.status === "fulfilled") setIntelligence(intelligenceResult.value);
      if (unifiedResult.status === "fulfilled") setUnified(unifiedResult.value);
    } finally {
      window.clearTimeout(slowTimer);
      setLoading(false);
      setSlowLoading(false);
    }
  }, [symbol]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const query = search.trim();
    setDiscoveries([]);
    setDiscoveryError(null);
    setDiscoveryLoading(false);
    if (!query) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setDiscoveryLoading(true);
      void discoverOptionInstruments(query, controller.signal)
        .then(results => { if (!controller.signal.aborted) setDiscoveries(results); })
        .catch(error => { if (!controller.signal.aborted) setDiscoveryError(describeUiError(error)); })
        .finally(() => { if (!controller.signal.aborted) setDiscoveryLoading(false); });
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [search]);
  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    const onSymbol = () =>
      setSymbol(localStorage.getItem("dpredict:selected-symbol") || "");
    window.addEventListener("dpredict:symbol", onSymbol);
    return () => window.removeEventListener("dpredict:symbol", onSymbol);
  }, []);
  const rows = useMemo(() => {
    const filtered = options.filter(row => row.expiry_date === expiry);
    return Array.from(new Set(filtered.map(row => row.strike)))
      .sort((a, b) => a - b)
      .map(strike => ({
        strike,
        ce: filtered.find(
          row => row.strike === strike && row.option_type === "CE"
        ),
        pe: filtered.find(
          row => row.strike === strike && row.option_type === "PE"
        ),
      }));
  }, [options, expiry]);
  async function trade(row: OptionRow | undefined, side: "BUY" | "SELL") {
    if (!row) return;
    const key = `${row.option_type}-${row.strike}-${side}`;
    setBusy(key);
    try {
      const result = await placeOptionPaperOrder({
        symbol,
        expiry: row.expiry_date,
        strike: row.strike,
        optionType: row.option_type,
        side,
        lots,
      });
      toast.success(
        `${side} ${symbol} ${row.option_type} ${row.strike} filled at ${money(result.entryPrice)}`
      );
      await refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Paper order rejected"
      );
    } finally {
      setBusy(null);
    }
  }
  async function executeRecommendation() {
    const recommendation = intelligence?.recommendation;
    if (!recommendation?.contract) return;
    const key = `MODEL-${recommendation.action}`;
    setBusy(key);
    try {
      if ((recommendation.action === "CALL_VERTICAL" || recommendation.action === "PUT_VERTICAL") && recommendation.hedge) {
        const primary = recommendation.contract;
        const hedge = recommendation.hedge;
        const primaryRow = options.find(r => r.expiry_date === primary.expiry && r.strike === primary.strike && r.option_type === primary.optionType);
        const hedgeRow = options.find(r => r.expiry_date === hedge.expiry && r.strike === hedge.strike && r.option_type === hedge.optionType);
        if (!primaryRow || !hedgeRow) throw new Error("One of the model-selected spread contracts is not in the current chain snapshot.");
        const result = await placeOptionPaperStrategy({
          symbol,
          strategy: recommendation.action,
          legs: [
            { expiry: primaryRow.expiry_date, strike: primaryRow.strike, optionType: primaryRow.option_type, side: "BUY", lots },
            { expiry: hedgeRow.expiry_date, strike: hedgeRow.strike, optionType: hedgeRow.option_type, side: "SELL", lots },
          ],
        });
        toast.success(`${recommendation.action.replace("_", " ")} opened · max loss ${money(result.strategy.maxLoss)}`);
      } else {
        const row = options.find(r => r.expiry_date === recommendation.contract!.expiry && r.strike === recommendation.contract!.strike && r.option_type === recommendation.contract!.optionType);
        if (!row) throw new Error("The recommended contract is not in the current chain snapshot.");
        const result = await placeOptionPaperOrder({ symbol, expiry: row.expiry_date, strike: row.strike, optionType: row.option_type, side: "BUY", lots });
        toast.success(`Model candidate filled at ${money(result.entryPrice)}`);
      }
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Model paper strategy rejected");
    } finally {
      setBusy(null);
    }
  }
  async function closeTrade(id: string) {
    setBusy(id);
    try {
      const result = await closeOptionPaperTrade(id, closeReason);
      toast.success(
        result.strategyId
          ? `Vertical spread closed (${result.legs?.length ?? 0} legs) · net P&L ${money(result.netPnl ?? result.realizedPnl)}`
          : `Position closed at ${money(result.exitPrice ?? null)} · net P&L ${money(result.netPnl ?? result.realizedPnl)}`
      );
      await refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Position close rejected"
      );
    } finally {
      setBusy(null);
    }
  }
  function repeatLastOptionTrade() {
    const last = trades[0];
    if (!last) return toast.info("No previous option paper trade to repeat.");
    const row = options.find(r => r.expiry_date === last.expiry_date && r.strike === Number(last.strike) && r.option_type === last.option_type);
    if (!row) return toast.error("The previous contract is not in the current chain snapshot.");
    void trade(row, last.side);
  }
  const openTrades = trades.filter(t => t.status === "OPEN");
  const visibleContracts = rows.reduce(
    (n, r) => n + (r.ce ? 1 : 0) + (r.pe ? 1 : 0),
    0
  );
  const unrealized = openTrades.reduce(
    (n, t) => n + Number(t.unrealized_pnl ?? 0),
    0
  );
  return (
    <section className="mx-auto w-full max-w-[1600px] px-4 pb-6 md:px-6">
      <div className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-2xl shadow-black/10">
        <div className="border-b border-border/70 bg-gradient-to-r from-background via-card to-background px-5 py-5 md:px-6">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                <span className="flex h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_10px_currentColor]" />{" "}
                Live derivatives
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <h2 className="text-2xl font-semibold tracking-tight">
                  Option Chain
                </h2>
                <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
                  PAPER ONLY
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Quote-backed paper fills from the latest persisted market snapshot. No
                broker order is sent. These manual contract actions are independent of the
                authoritative Decision Candidate and are not a recommendation. Open positions stay held until you close them.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value.toUpperCase())}
                  placeholder="Search underlying"
                  aria-label="Search underlying for option chain"
                  className="h-9 w-44 rounded-lg border border-border bg-background px-3 text-xs font-medium outline-none focus:ring-2 focus:ring-ring"
                />
                {search.trim() && (discoveryLoading || discoveryError || discoveries.length > 0 || !discoveryLoading) && (
                  <div className="absolute right-0 top-11 z-20 w-80 overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
                    {discoveryLoading && <div role="status" className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground"><RefreshCw size={13} className="animate-spin" />Searching stored instruments…</div>}
                    {!discoveryLoading && discoveryError && <div role="alert" className="flex items-start gap-2 px-3 py-3 text-xs text-rose-300"><AlertTriangle size={14} className="mt-0.5 shrink-0" /><span>{discoveryError.message}</span></div>}
                    {!discoveryLoading && !discoveryError && discoveries.length === 0 && <div className="flex items-start gap-2 px-3 py-3 text-xs text-muted-foreground"><SearchX size={14} className="mt-0.5 shrink-0" /><span>No matching stored instruments. Try a symbol or a longer search.</span></div>}
                    {!discoveryLoading && discoveries.slice(0, 8).map(item => (
                      <button
                        key={`${item.symbol}-${item.exchange}`}
                        onClick={() => {
                          const next = item.symbol.toUpperCase();
                          setSymbol(next);
                          setSearch(next);
                          localStorage.setItem("dpredict:selected-symbol", next);
                          setDiscoveries([]);
                          setDiscoveryError(null);
                        }}
                        className="flex w-full items-center justify-between px-3 py-2 text-left text-xs hover:bg-accent"
                      >
                        <span>
                          <span className="font-semibold">{item.symbol}</span>
                          <span className="ml-2 text-muted-foreground">{item.name ?? item.instrumentType ?? item.exchange}</span>
                        </span>
                        <span className={item.optionChain.available ? "text-emerald-400" : "text-muted-foreground"}>
                          {item.optionChain.available ? "CHAIN" : "NO CHAIN"}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {!symbol && <span className="text-[10px] font-medium text-amber-400">Search and select an underlying</span>}
              <select
                value={expiry}
                onChange={e => setExpiry(e.target.value)}
                className="h-9 rounded-lg border border-border bg-background px-3 text-xs font-medium outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">Expiry</option>
                {Array.from(new Set(options.map(row => row.expiry_date)))
                  .sort()
                  .map(item => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
              </select>
              <label className="flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-3 text-xs text-muted-foreground">
                Lots
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={lots}
                  onChange={e =>
                    setLots(Math.max(1, Number(e.target.value) || 1))
                  }
                  className="w-10 bg-transparent text-center font-mono font-semibold text-foreground outline-none"
                />
              </label>
              <button onClick={repeatLastOptionTrade} className="h-9 rounded-lg border border-border bg-background px-3 text-[10px] font-semibold transition hover:bg-accent">Repeat last</button>
              <button
                aria-label="Refresh option chain"
                title="Refresh"
                onClick={() => void refresh()}
                disabled={loading}
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-background transition hover:bg-accent disabled:opacity-50"
              >
                <RefreshCw
                  size={14}
                  className={loading ? "animate-spin" : ""}
                />
              </button>
            </div>
          </div>
        </div>
        {intelligence ? (
          <div className="border-b border-border/70 bg-background/40 px-5 py-5 md:px-6">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
              <div>
                <div className="mb-1 text-[9px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">D-PREDICT PREMIUM INTELLIGENCE</div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full px-2 py-1 text-[10px] font-bold ring-1 ring-inset ${intelligence.status === "ACTIONABLE" ? "bg-emerald-500/10 text-emerald-400 ring-emerald-500/20" : intelligence.status === "ABSTAIN" ? "bg-rose-500/10 text-rose-400 ring-rose-500/20" : "bg-amber-500/10 text-amber-400 ring-amber-500/20"}`}>{intelligence.status}</span>
                  <span className="font-mono text-xs font-semibold">{intelligence.recommendation.action}</span>
                  <span className="text-xs text-muted-foreground">{intelligence.recommendation.direction} · {(intelligence.recommendation.confidence * 100).toFixed(0)}% confidence</span>
                </div>
                <p className="mt-2 max-w-3xl text-xs leading-5 text-muted-foreground">{intelligence.recommendation.rationale}</p>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                {[["PCR", intelligence.metrics.pcr], ["ATM IV", intelligence.metrics.atmIv], ["LIQUIDITY", intelligence.metrics.liquidityScore]].map(([label, value]) => (
                  <div key={label} className="min-w-[82px] rounded-lg border border-border bg-card px-3 py-2">
                    <div className="text-[8px] uppercase tracking-wider text-muted-foreground">{label}</div>
                    <div className="mt-1 font-mono text-sm font-semibold">{value == null ? "—" : Number(value).toFixed(label === "LIQUIDITY" ? 0 : 2)}</div>
                  </div>
                ))}
              </div>
            </div>
            {intelligence.recommendation.contract ? (
              <div className="mt-4 flex flex-col gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <div className="text-[9px] uppercase tracking-wider text-muted-foreground">MODEL CANDIDATE · {intelligence.recommendation.contract.optionType}</div>
                  <div className="mt-1 font-mono text-base font-bold">{intelligence.recommendation.contract.strike.toLocaleString("en-IN")} · {money(intelligence.recommendation.contract.price)} · {intelligence.recommendation.contract.expiry}</div>
                  <div className="mt-1 text-[10px] text-muted-foreground">{intelligence.recommendation.hedge ? `Hedge: ${intelligence.recommendation.hedge.optionType} ${intelligence.recommendation.hedge.strike.toLocaleString("en-IN")} at ${money(intelligence.recommendation.hedge.price)}` : "No hedge contract selected."}</div>
                </div>
                <button
                  disabled={intelligence.status !== "ACTIONABLE"}
                  onClick={() => void executeRecommendation()}
                  className="rounded-lg bg-emerald-500 px-4 py-2 text-xs font-bold text-emerald-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  PAPER VALIDATE {intelligence.recommendation.action === "CALL_VERTICAL" || intelligence.recommendation.action === "PUT_VERTICAL" ? "STRATEGY" : "CANDIDATE"}
                </button>
              </div>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-muted-foreground">
              {intelligence.recommendation.evidence.slice(0, 4).map((item, index) => <span key={index} className="rounded-md border border-border bg-card px-2 py-1">{item}</span>)}
            </div>
          </div>
        ) : null}
        <div className="grid grid-cols-2 border-b border-border/70 md:grid-cols-5">
          <div className="border-r border-border/70 px-5 py-3">
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
              Expiry
            </div>
            <div className="mt-1 font-mono text-sm font-semibold">
              {expiry || "—"}
            </div>
          </div>
          <div className="border-r border-border/70 px-5 py-3">
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
              Contracts
            </div>
            <div className="mt-1 font-mono text-sm font-semibold">
              {visibleContracts}
            </div>
          </div>
          <div className="border-r border-border/70 px-5 py-3">
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
              Open positions
            </div>
            <div className="mt-1 font-mono text-sm font-semibold">
              {openTrades.length}
            </div>
          </div>
          <div className="border-r border-border/70 px-5 py-3">
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Unified cash</div>
            <div className="mt-1 font-mono text-sm font-semibold">{unified?.account ? money(unified.account.cash) : "—"}</div>
            <div className="mt-1 text-[9px] text-muted-foreground">shared paper account</div>
          </div>
          <div className="px-5 py-3">
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
              Unrealized P&L
            </div>
            <div
              className={`mt-1 font-mono text-sm font-semibold ${unrealized > 0 ? "text-emerald-400" : unrealized < 0 ? "text-rose-400" : ""}`}
            >
              {money(unrealized)}
            </div>
          </div>
        </div>
        {loading ? (
          <div role="status" className="flex min-h-[240px] flex-col items-center justify-center gap-3 p-8 text-center">
            <RefreshCw size={22} className="animate-spin text-muted-foreground" />
            <div className="text-sm font-semibold">{slowLoading ? "Still waiting for market data" : "Loading option chain"}</div>
            <div className="max-w-md text-xs text-muted-foreground">{slowLoading ? "This request is taking longer than expected. Check the local API and collector; do not treat old quotes as live." : "Fetching persisted contracts and paper positions…"}</div>
          </div>
        ) : loadError ? (
          <div role="alert" className="flex min-h-[240px] flex-col items-center justify-center gap-3 p-8 text-center">
            {loadError.kind === "offline" ? <WifiOff size={22} className="text-amber-400" /> : loadError.kind === "permission" ? <ShieldAlert size={22} className="text-rose-400" /> : <AlertTriangle size={22} className="text-amber-400" />}
            <div className="text-sm font-semibold">{loadError.kind === "offline" ? "Data service unreachable" : loadError.kind === "permission" ? "Permission denied" : loadError.kind === "unavailable" ? "Service unavailable" : "Could not load option chain"}</div>
            <div className="max-w-md text-xs text-muted-foreground">{loadError.message}</div>
            <button type="button" onClick={() => void refresh()} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-semibold hover:bg-accent"><RefreshCw size={13} />Retry</button>
          </div>
        ) : rows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1060px] text-xs">
              <thead>
                <tr className="border-b border-border/70 bg-muted/20 text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
                  <th colSpan={3} className="border-r border-border/70 px-4 py-2 text-center font-semibold text-emerald-400/90">CALLS · CE</th>
                  <th className="w-[100px] px-3 py-2 text-center font-semibold text-foreground">STRIKE</th>
                  <th colSpan={3} className="border-l border-border/70 px-4 py-2 text-center font-semibold text-rose-400/90">PUTS · PE</th>
                </tr>
                <tr className="border-b border-border/70 text-[9px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-3 py-2 text-right">LTP / B-A</th>
                  <th className="px-3 py-2 text-right">OI</th>
                  <th className="border-r border-border/70 px-3 py-2">TRADE</th>
                  <th className="px-3 py-2 text-center">PRICE</th>
                  <th className="border-l border-border/70 px-3 py-2 text-left">TRADE</th>
                  <th className="px-3 py-2 text-right">OI</th>
                  <th className="px-3 py-2">LTP / B-A</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ strike, ce, pe }) => (
                  <tr key={strike} className="group border-b border-border/50 transition hover:bg-muted/20">
                    <td className="px-3 py-2.5 text-right"><Quote row={ce} /></td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-muted-foreground">{compact(ce?.oi)}</td>
                    <td className="border-r border-border/70 px-3 py-2.5"><div className="flex justify-end"><TradeButtons row={ce} onTrade={trade} busy={busy} /></div></td>
                    <td className="px-3 py-2.5 text-center"><span className="inline-flex min-w-[72px] justify-center rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs font-bold tabular-nums shadow-sm group-hover:border-foreground/20">{strike.toLocaleString("en-IN")}</span></td>
                    <td className="border-l border-border/70 px-3 py-2.5"><TradeButtons row={pe} onTrade={trade} busy={busy} /></td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-muted-foreground">{compact(pe?.oi)}</td>
                    <td className="px-3 py-2.5"><Quote row={pe} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="flex min-h-[240px] flex-col items-center justify-center gap-3 p-8 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-muted/20">
              <BarChart3 size={20} className="text-muted-foreground" />
            </div>
            <div>
              <div className="text-sm font-semibold">{options.length > 0 ? "No contracts for this expiry" : "No option-chain data yet"}</div>
              <div className="mt-1 max-w-md text-xs text-muted-foreground">
                {options.length > 0
                  ? "The selected expiry has no stored contracts. Choose another expiry or refresh the chain."
                  : `No persisted option quotes are available for ${symbol}. The collector must store a quote-backed chain before contracts can be shown. This may be normal outside market hours.`}
              </div>
              <button type="button" onClick={() => void refresh()} className="mt-3 inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-semibold hover:bg-accent"><RefreshCw size={13} />Refresh data</button>
            </div>
          </div>
        )}
        <div className="border-t border-border/70 bg-muted/10 px-5 py-3 md:px-6">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[10px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <ArrowUpFromLine size={12} className="text-emerald-400" /> BUY
              fills at ask
            </span>
            <span className="inline-flex items-center gap-1.5">
              <ArrowDownToLine size={12} className="text-rose-400" /> SELL fills
              at bid
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Clock3 size={12} /> stale quotes rejected
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Activity size={12} /> refresh 15s
            </span>
          </div>
        </div>
        <div className="border-t border-border/70 px-5 py-5 md:px-6">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <ShoppingCart size={15} />
              <h3 className="text-sm font-semibold">Open paper positions</h3>
            </div>
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              {openTrades.length} active
            </span>
          </div>
          {openTrades.length ? (
            <div className="grid gap-2 md:grid-cols-2">
              {openTrades.map(trade => (
                <div
                  key={trade.id}
                  className="flex items-center justify-between gap-4 rounded-xl border border-border bg-background/60 p-3 transition hover:border-foreground/20"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${trade.side === "BUY" ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400"}`}
                      >
                        {trade.side}
                      </span>
                      <b className="text-xs">
                        {trade.symbol} {trade.option_type}{" "}
                        {Number(trade.strike).toLocaleString("en-IN")}
                      </b>
                    </div>
                    <div className="mt-1 text-[10px] text-muted-foreground">
                      {trade.expiry_date} · {trade.quantity} qty · entry{" "}
                      {money(trade.entry_price)} · now{" "}
                      {money(trade.current_price)}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span
                      className={`font-mono text-xs font-semibold tabular-nums ${Number(trade.unrealized_pnl) > 0 ? "text-emerald-400" : Number(trade.unrealized_pnl) < 0 ? "text-rose-400" : ""}`}
                    >
                      {money(trade.unrealized_pnl)}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <select value={closeReason} onChange={e => setCloseReason(e.target.value as typeof closeReason)} className="rounded-lg border border-border bg-background px-2 py-1.5 text-[9px] outline-none">
                        <option value="MANUAL">Manual</option>
                        <option value="STOP_LOSS">Stop loss</option>
                        <option value="TARGET">Target</option>
                        <option value="EXPIRY">Expiry</option>
                      </select>
                      <button
                        onClick={() => void closeTrade(trade.id)}
                        disabled={busy === trade.id}
                        className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-[10px] font-semibold transition hover:bg-accent disabled:opacity-40"
                      >
                        <X size={12} /> Close
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-border p-5 text-center text-xs text-muted-foreground">
              No open paper positions.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
