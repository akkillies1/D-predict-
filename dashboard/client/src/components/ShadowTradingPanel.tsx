import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

const API = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:4100";
const POLL_MS = 15_000;

type BlotterTrade = {
  id: string;
  source: "AUTO" | "MANUAL";
  symbol: string;
  contract: string;
  expiryDate: string;
  strike: number;
  optionType: string;
  side: string;
  direction: string | null;
  status: "OPEN" | "CLOSED";
  quantity: number;
  lotSize: number;
  lots: number | null;
  entryPrice: number;
  currentPrice: number | null;
  unrealizedPnl: number;
  realizedPnl: number | null;
  entryFees?: number;
  exitFees?: number | null;
  fees?: number;
  netPnl?: number;
  stopLoss: number | null;
  target: number | null;
  entryTimestamp: string;
  exitTimestamp: string | null;
  exitPrice: number | null;
  exitReason: string | null;
};

type Summary = {
  startingCapital: number;
  realizedPnl: number;
  unrealizedPnl: number;
  equity: number;
  peakEquity: number;
  drawdown: number;
  openTrades: number;
  closedTrades: number;
  winRate: number | null;
};

type Stats = {
  closed: {
    trades: number; wins: number; losses: number; winRate: number | null;
    totalPnl: number; grossProfit: number; grossLoss: number;
    profitFactor: number | null; expectancy: number | null;
    avgWin: number | null; avgLoss: number | null;
    largestWin: number | null; largestLoss: number | null; avgHoldHours: number | null;
  };
  open: { positions: number; unrealizedPnl: number };
  fees: { closed: number; open: number };
  exitReasons: { reason: string; trades: number; pnl: number }[];
  symbols: { symbol: string; trades: number; pnl: number }[];
  equity: { latest: number | null; startingCapital: number | null; maxDrawdown: number; maxDrawdownPct: number };
};

type CurvePoint = { timestamp: string; equity: number; realizedPnl: number; unrealizedPnl: number; openTrades: number; closedTrades: number };

type Detail = {
  trade: BlotterTrade & { entryBid: number | null; entryAsk: number | null; entryLtp: number | null };
  lineage: {
    signal: { timestamp: string; model_version: string; direction: string; confidence: number | null; regime: string | null; reason_codes: string[] | null } | null;
    construction: { timestamp: string; entry_low: number | null; entry_high: number | null; stop_loss: number | null; target: number | null; reason_codes: string[] | null } | null;
    prediction: { timestamp: string; model_version: string; market_probability: number | null; expected_return: number | null; confidence: number | null; regime: string | null } | null;
  };
  quotes: { timestamp: string; ltp: number | null; bid: number | null; ask: number | null }[];
};

const RANGE_OPTIONS = [
  { value: "1", label: "Today" },
  { value: "7", label: "7D" },
  { value: "30", label: "30D" },
  { value: "90", label: "90D" },
];

function money(value: number | null | undefined, signed = false) {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const text = `₹${abs.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  if (value < 0) return `-${text}`;
  return signed && value > 0 ? `+${text}` : text;
}
function pnlClass(value: number | null | undefined) {
  if (value == null || value === 0) return "text-muted-foreground";
  return value > 0 ? "text-emerald-400" : "text-rose-400";
}
function pct(value: number | null | undefined, digits = 1) {
  return value == null || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(digits)}%`;
}
function ts(value: string | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}
function tradePnl(t: BlotterTrade) {
  if (t.netPnl != null) return t.netPnl;
  return t.status === "OPEN" ? t.unrealizedPnl : (t.realizedPnl ?? 0);
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok || body.ok === false) throw new Error(body.message ?? body.error ?? `Request failed: ${url}`);
  return body as T;
}

function StatCard({ label, value, tone, sub }: { label: string; value: string; tone?: string; sub?: string }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={`mt-0.5 text-lg font-semibold tabular-nums ${tone ?? ""}`}>{value}</div>
        {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function KpiStrip({ summary, stats }: { summary: Summary | null; stats: Stats | null }) {
  const equity = summary?.equity ?? null;
  const capital = summary?.startingCapital ?? stats?.equity?.startingCapital ?? null;
  const returnPct = equity != null && capital ? (equity - capital) / capital : null;
  const realized = summary?.realizedPnl ?? 0;
  const unrealized = stats?.open?.unrealizedPnl ?? summary?.unrealizedPnl ?? 0;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
      <StatCard label="Equity" value={money(equity)} sub={returnPct == null ? undefined : `${returnPct >= 0 ? "+" : ""}${pct(returnPct)} on capital`} />
      <StatCard label="Realized P&L" value={money(realized, true)} tone={pnlClass(realized)} sub="net of fees" />
      <StatCard label="Open P&L" value={money(unrealized, true)} tone={pnlClass(unrealized)} />
      <StatCard label="Win rate" value={stats?.closed.winRate != null ? pct(stats.closed.winRate) : (summary?.winRate != null ? pct(summary.winRate) : "—")} sub={stats ? `${stats.closed.wins}W / ${stats.closed.losses}L` : undefined} />
      <StatCard label="Profit factor" value={stats?.closed.profitFactor != null ? stats.closed.profitFactor.toFixed(2) : "—"} sub={stats ? `${money(stats.closed.grossProfit)} / ${money(stats.closed.grossLoss)}` : undefined} />
      <StatCard label="Expectancy" value={money(stats?.closed.expectancy ?? null, true)} tone={pnlClass(stats?.closed.expectancy ?? 0)} sub="per closed trade" />
      <StatCard label="Max drawdown" value={stats ? money(stats.equity.maxDrawdown, true) : (summary ? money(-summary.drawdown, true) : "—")} tone={pnlClass(stats ? stats.equity.maxDrawdown : summary ? -summary.drawdown : 0)} />
      <StatCard label="Positions" value={String(stats?.open.positions ?? summary?.openTrades ?? 0)} sub={`${stats?.closed.trades ?? summary?.closedTrades ?? 0} closed`} />
    </div>
  );
}

function EquityChart({ points, baseline }: { points: CurvePoint[]; baseline: number | null }) {
  const data = useMemo(() => points.map((p) => ({ ...p, time: new Date(p.timestamp) })), [points]);
  const base = baseline ?? (data.length ? data[0].equity : 0);
  return (
    <Card>
      <CardContent className="p-4">
        <div className="mb-2 text-sm font-medium">Equity curve</div>
        <div className="h-56">
          {data.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">No equity snapshots yet — the engine records one per cycle once capital is configured.</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
                <defs>
                  <linearGradient id="shadowEquityFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-primary)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="var(--color-primary)" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="time" tickFormatter={(d: Date) => d.toLocaleString("en-IN", { day: "2-digit", month: "short" })} stroke="var(--muted-foreground)" fontSize={11} minTickGap={40} />
                <YAxis domain={["auto", "auto"]} tickFormatter={(v: number) => `₹${(v / 1000).toFixed(0)}k`} stroke="var(--muted-foreground)" fontSize={11} width={56} />
                <Tooltip
                  contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                  labelFormatter={(d: Date) => d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
                  formatter={(value: number) => [money(value), "Equity"]}
                />
                {base > 0 && <ReferenceLine y={base} stroke="var(--muted-foreground)" strokeDasharray="4 4" label={{ value: "start", fill: "var(--muted-foreground)", fontSize: 10, position: "insideTopLeft" }} />}
                <Area type="monotone" dataKey="equity" stroke="var(--primary)" strokeWidth={2} fill="url(#shadowEquityFill)" isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ReasonBadge({ reason }: { reason: string | null }) {
  const tone = reason === "PROFIT_TARGET" ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
    : reason === "PRICE_STOP" ? "bg-rose-500/15 text-rose-400 border-rose-500/30"
    : reason === "MANUAL" ? "bg-sky-500/15 text-sky-400 border-sky-500/30"
    : reason === "EXPIRY" || reason === "EXPIRY_SETTLED" ? "bg-amber-500/15 text-amber-400 border-amber-500/30"
    : "bg-muted text-muted-foreground border-border";
  return <Badge variant="outline" className={tone}>{reason ?? "—"}</Badge>;
}

function PositionsTable({ trades, onClose, busy }: { trades: BlotterTrade[]; onClose: (t: BlotterTrade) => void; busy: string | null }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-2 py-2">Contract</th><th className="px-2 py-2">Source</th><th className="px-2 py-2">Side</th>
            <th className="px-2 py-2 text-right">Qty</th><th className="px-2 py-2 text-right">Entry</th><th className="px-2 py-2 text-right">Mark</th>
            <th className="px-2 py-2 text-right">SL</th><th className="px-2 py-2 text-right">Target</th>
            <th className="px-2 py-2 text-right">Net P&L</th><th className="px-2 py-2">Opened</th><th className="px-2 py-2">Action</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => (
            <tr key={t.id} className="border-b last:border-0 hover:bg-muted/40">
              <td className="px-2 py-2.5 font-medium">{t.contract}<span className="ml-2 text-xs text-muted-foreground">{t.expiryDate ? `exp ${ts(t.expiryDate)}` : ""}</span></td>
              <td className="px-2 py-2.5"><Badge variant="outline" className={t.source === "AUTO" ? "border-primary/40 text-primary" : "border-sky-500/30 text-sky-400"}>{t.source === "AUTO" ? "ENGINE" : "MANUAL"}</Badge></td>
              <td className="px-2 py-2.5">{t.side}</td>
              <td className="px-2 py-2.5 text-right tabular-nums">{t.quantity}</td>
              <td className="px-2 py-2.5 text-right tabular-nums">{t.entryPrice.toFixed(2)}</td>
              <td className="px-2 py-2.5 text-right tabular-nums">{t.currentPrice == null ? "—" : t.currentPrice.toFixed(2)}</td>
              <td className="px-2 py-2.5 text-right tabular-nums text-muted-foreground">{t.stopLoss == null ? "—" : t.stopLoss.toFixed(2)}</td>
              <td className="px-2 py-2.5 text-right tabular-nums text-muted-foreground">{t.target == null ? "—" : t.target.toFixed(2)}</td>
              <td className={`px-2 py-2.5 text-right font-medium tabular-nums ${pnlClass(tradePnl(t))}`}>{money(tradePnl(t), true)}</td>
              <td className="px-2 py-2.5 text-xs text-muted-foreground">{ts(t.entryTimestamp)}</td>
              <td className="px-2 py-2.5">
                <Button size="sm" variant="outline" className="h-7 border-rose-500/30 text-[11px] text-rose-400 hover:bg-rose-500/10" disabled={busy === t.id} onClick={() => onClose(t)}>
                  {busy === t.id ? "Closing…" : "Close"}
                </Button>
              </td>
            </tr>
          ))}
          {!trades.length && <tr><td colSpan={11} className="px-2 py-10 text-center text-sm text-muted-foreground">No open positions. Engine entries appear automatically when a qualifying signal has a fresh option quote.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function LedgerTable({ trades, onOpen }: { trades: BlotterTrade[]; onOpen: (t: BlotterTrade) => void }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-2 py-2">Contract</th><th className="px-2 py-2">Source</th><th className="px-2 py-2">Status</th>
            <th className="px-2 py-2 text-right">Entry</th><th className="px-2 py-2 text-right">Exit</th>
            <th className="px-2 py-2 text-right">Net P&L</th><th className="px-2 py-2 text-right">Fees</th><th className="px-2 py-2">Exit reason</th><th className="px-2 py-2">Closed</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => (
            <tr key={t.id} className="cursor-pointer border-b last:border-0 hover:bg-muted/40" onClick={() => onOpen(t)}>
              <td className="px-2 py-2.5 font-medium">{t.contract}</td>
              <td className="px-2 py-2.5"><Badge variant="outline" className={t.source === "AUTO" ? "border-primary/40 text-primary" : "border-sky-500/30 text-sky-400"}>{t.source === "AUTO" ? "ENGINE" : "MANUAL"}</Badge></td>
              <td className="px-2 py-2.5"><Badge variant="outline" className={t.status === "OPEN" ? "border-amber-500/30 text-amber-400" : "border-border text-muted-foreground"}>{t.status}</Badge></td>
              <td className="px-2 py-2.5 text-right tabular-nums">{t.entryPrice.toFixed(2)}</td>
              <td className="px-2 py-2.5 text-right tabular-nums">{t.exitPrice == null ? "—" : t.exitPrice.toFixed(2)}</td>
              <td className={`px-2 py-2.5 text-right font-medium tabular-nums ${pnlClass(tradePnl(t))}`}>{money(tradePnl(t), true)}</td>
              <td className="px-2 py-2.5 text-right tabular-nums text-muted-foreground">{t.fees ? money(-t.fees) : "—"}</td>
              <td className="px-2 py-2.5"><ReasonBadge reason={t.exitReason} /></td>
              <td className="px-2 py-2.5 text-xs text-muted-foreground">{ts(t.exitTimestamp)}</td>
            </tr>
          ))}
          {!trades.length && <tr><td colSpan={9} className="px-2 py-10 text-center text-sm text-muted-foreground">No trades match the current filters.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function AnalyticsTab({ stats, days }: { stats: Stats | null; days: string }) {
  if (!stats) return <Card><CardContent className="p-6 text-sm text-muted-foreground">Loading analytics…</CardContent></Card>;
  const c = stats.closed;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardContent className="p-4">
          <div className="mb-2 text-sm font-medium">P&L by exit reason <span className="text-xs text-muted-foreground">(last {RANGE_OPTIONS.find(r => r.value === days)?.label ?? `${days}D`})</span></div>
          <div className="h-52">
            {stats.exitReasons.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">No closed trades in range.</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stats.exitReasons} layout="vertical" margin={{ left: 8, right: 24 }}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" tickFormatter={(v: number) => `₹${(v / 1000).toFixed(0)}k`} stroke="var(--muted-foreground)" fontSize={11} />
                  <YAxis type="category" dataKey="reason" width={110} stroke="var(--muted-foreground)" fontSize={11} />
                  <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} formatter={(value: number, _n, item) => [money(value, true), `${(item.payload as { trades: number }).trades} trades`]} />
                  <Bar dataKey="pnl" radius={3} isAnimationActive={false}>
                    {stats.exitReasons.map((r) => <Cell key={r.reason} fill={r.pnl >= 0 ? "var(--primary)" : "var(--destructive)"} />)}
                    <LabelList dataKey="trades" position="right" style={{ fontSize: 10, fill: "var(--muted-foreground)" }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-4">
          <div className="mb-2 text-sm font-medium">P&L by symbol</div>
          <div className="h-52">
            {stats.symbols.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">No closed trades in range.</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stats.symbols.slice(0, 10)} layout="vertical" margin={{ left: 8, right: 24 }}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" tickFormatter={(v: number) => `₹${(v / 1000).toFixed(0)}k`} stroke="var(--muted-foreground)" fontSize={11} />
                  <YAxis type="category" dataKey="symbol" width={110} stroke="var(--muted-foreground)" fontSize={11} />
                  <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} formatter={(value: number, _n, item) => [money(value, true), `${(item.payload as { trades: number }).trades} trades`]} />
                  <Bar dataKey="pnl" radius={3} isAnimationActive={false}>
                    {stats.symbols.slice(0, 10).map((s) => <Cell key={s.symbol} fill={s.pnl >= 0 ? "var(--primary)" : "var(--destructive)"} />)}
                    <LabelList dataKey="trades" position="right" style={{ fontSize: 10, fill: "var(--muted-foreground)" }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </CardContent>
      </Card>
      <Card className="lg:col-span-2">
        <CardContent className="p-4">
          <div className="mb-3 text-sm font-medium">Trade statistics <span className="text-xs text-muted-foreground">({c.trades} closed)</span></div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
            {([
              ["Gross profit", money(c.grossProfit)],
              ["Gross loss", money(-c.grossLoss)],
              ["Avg win", money(c.avgWin, true)],
              ["Avg loss", money(c.avgLoss, true)],
              ["Largest win", money(c.largestWin, true)],
              ["Largest loss", money(c.largestLoss, true)],
              ["Avg hold", c.avgHoldHours == null ? "—" : `${c.avgHoldHours.toFixed(1)} h`],
              ["Expectancy", money(c.expectancy, true)],
              ["Fees paid (closed)", money(-stats.fees.closed)],
              ["Fees on open", money(-stats.fees.open)],
            ] as [string, string][]).map(([k, v]) => (
              <div key={k} className="flex justify-between border-b border-border/50 py-1.5"><span className="text-muted-foreground">{k}</span><span className="font-medium tabular-nums">{v}</span></div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function LineageBlock({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="grid gap-1 text-sm">
        {rows.map(([k, v]) => <div key={k} className="flex justify-between gap-4"><span className="text-muted-foreground">{k}</span><span className="text-right font-medium">{v}</span></div>)}
      </div>
    </div>
  );
}

function DetailDialog({ tradeId, source, onClose }: { tradeId: string | null; source: "AUTO" | "MANUAL"; onClose: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDetail(null);
    setError(null);
    if (!tradeId) return;
    void getJson<Detail>(`${API}/api/shadow/trades/${tradeId}?source=${source}`)
      .then(setDetail)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load trade"));
  }, [tradeId, source]);

  const quoteData = detail?.quotes.map((q) => ({ time: new Date(q.timestamp), price: q.ltp ?? q.bid ?? q.ask })).filter((q) => q.price != null) ?? [];
  const t = detail?.trade;

  return (
    <Dialog open={tradeId != null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-base">{t ? `${t.contract} · ${t.side} ${t.quantity} lots×${t.lotSize}` : "Trade detail"}</DialogTitle>
        </DialogHeader>
        {error && <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">{error}</div>}
        {!error && !detail && <div className="py-8 text-center text-sm text-muted-foreground">Loading trade…</div>}
        {detail && t && (
          <div className="grid gap-3 text-sm">
            <div className="flex flex-wrap gap-2">
              <ReasonBadge reason={t.exitReason} />
              <Badge variant="outline" className="border-border">{t.status}</Badge>
              <Badge variant="outline" className={t.source === "AUTO" ? "border-primary/40 text-primary" : "border-sky-500/30 text-sky-400"}>{t.source === "AUTO" ? "ENGINE" : "MANUAL"}</Badge>
              <span className={`ml-auto font-semibold tabular-nums ${pnlClass(tradePnl(t))}`}>{money(tradePnl(t), true)}</span>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <StatCard label="Entry" value={t.entryPrice.toFixed(2)} sub={ts(t.entryTimestamp)} />
              <StatCard label={t.status === "OPEN" ? "Mark" : "Exit"} value={(t.status === "OPEN" ? t.currentPrice : t.exitPrice)?.toFixed(2) ?? "—"} sub={ts(t.status === "OPEN" ? null : t.exitTimestamp)} />
              <StatCard label="Bid / Ask at entry" value={t.entryBid != null && t.entryAsk != null ? `${t.entryBid.toFixed(2)} / ${t.entryAsk != null ? t.entryAsk.toFixed(2) : "—"}` : "—"} />
              <StatCard label="Fees (net)" value={t.fees ? money(-t.fees) : "—"} sub={`entry ${money(-(t.entryFees ?? 0))}${t.exitFees ? ` · exit ${money(-t.exitFees)}` : ""}`} />
            </div>
            {quoteData.length > 1 && (
              <div className="h-36 rounded-lg border p-2">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={quoteData} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
                    <XAxis dataKey="time" hide />
                    <YAxis domain={["auto", "auto"]} hide />
                    <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} labelFormatter={(d: Date) => d.toLocaleTimeString("en-IN")} formatter={(v: number) => [v.toFixed(2), "LTP"]} />
                    <Area type="monotone" dataKey="price" stroke="var(--primary)" strokeWidth={1.5} fill="none" isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
            {t.source === "AUTO" ? (
              <div className="grid gap-2">
                <LineageBlock title="ML prediction" rows={detail.lineage.prediction ? [
                  ["Model", detail.lineage.prediction.model_version],
                  ["Probability", detail.lineage.prediction.market_probability == null ? "—" : pct(Number(detail.lineage.prediction.market_probability))],
                  ["Expected return", detail.lineage.prediction.expected_return == null ? "—" : pct(Number(detail.lineage.prediction.expected_return), 2)],
                  ["Regime", detail.lineage.prediction.regime ?? "—"],
                  ["At", ts(detail.lineage.prediction.timestamp)],
                ] : [["Status", "No prediction row linked (pre-lineage data)"]]} />
                <LineageBlock title="Signal" rows={detail.lineage.signal ? [
                  ["Direction", detail.lineage.signal.direction],
                  ["Confidence", detail.lineage.signal.confidence == null ? "—" : pct(Number(detail.lineage.signal.confidence))],
                  ["Regime", detail.lineage.signal.regime ?? "—"],
                  ["Reasons", detail.lineage.signal.reason_codes?.join(", ") || "—"],
                  ["At", ts(detail.lineage.signal.timestamp)],
                ] : [["Status", "No signal linked"]]} />
                <LineageBlock title="Construction" rows={detail.lineage.construction ? [
                  ["Entry band", detail.lineage.construction.entry_low != null ? `${detail.lineage.construction.entry_low}–${detail.lineage.construction.entry_high}` : "—"],
                  ["Stop / Target", `${detail.lineage.construction.stop_loss ?? "—"} / ${detail.lineage.construction.target ?? "—"}`],
                  ["Reasons", detail.lineage.construction.reason_codes?.join(", ") || "—"],
                  ["At", ts(detail.lineage.construction.timestamp)],
                ] : [["Status", "No construction linked"]]} />
              </div>
            ) : (
              <LineageBlock title="Manual paper order" rows={[["Side", t.side], ["Expiry", String(t.expiryDate)], ["Opened", ts(t.entryTimestamp)]]} />
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function ShadowTradingPanel() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [trades, setTrades] = useState<BlotterTrade[]>([]);
  const [curve, setCurve] = useState<CurvePoint[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [range, setRange] = useState("30");
  const [detail, setDetail] = useState<{ id: string; source: "AUTO" | "MANUAL" } | null>(null);
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [sourceFilter, setSourceFilter] = useState("ALL");
  const [symbolFilter, setSymbolFilter] = useState("ALL");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const refresh = useCallback(async (days: string) => {
    try {
      const [portfolio, blotter, equity, statsBody] = await Promise.all([
        getJson<{ summary: Summary }>(`${API}/api/shadow/portfolio`),
        getJson<{ trades: BlotterTrade[] }>(`${API}/api/shadow/blotter`),
        getJson<{ points: CurvePoint[] }>(`${API}/api/shadow/equity-curve?days=${days}`),
        getJson<Stats>(`${API}/api/shadow/stats?days=${days}`),
      ]);
      setSummary(portfolio.summary);
      setTrades(blotter.trades);
      setCurve(equity.points);
      setStats(statsBody);
      setError(null);
      setUpdatedAt(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Shadow trading unavailable");
    }
  }, []);

  useEffect(() => {
    void refresh(range);
    const timer = window.setInterval(() => void refresh(range), POLL_MS);
    return () => window.clearInterval(timer);
  }, [range, refresh]);

  async function closeTrade(t: BlotterTrade) {
    setBusy(t.id);
    try {
      const url = t.source === "MANUAL" ? `${API}/api/shadow/paper-trades/${t.id}/close` : `${API}/api/shadow/trades/${t.id}/close`;
      const response = await fetch(url, { method: "POST" });
      const body = await response.json();
      if (!response.ok || body.ok === false) throw new Error(body.message ?? body.error ?? "Could not close trade");
      await refresh(range);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not close trade");
    } finally {
      setBusy(null);
    }
  }

  const openTrades = useMemo(() => trades.filter((t) => t.status === "OPEN"), [trades]);
  const symbols = useMemo(() => [...new Set(trades.map((t) => t.symbol))].sort(), [trades]);
  const ledgerTrades = useMemo(
    () => trades.filter((t) =>
      (statusFilter === "ALL" || t.status === statusFilter) &&
      (sourceFilter === "ALL" || t.source === sourceFilter) &&
      (symbolFilter === "ALL" || t.symbol === symbolFilter)),
    [trades, statusFilter, sourceFilter, symbolFilter]
  );

  return (
    <section className="mx-auto w-full max-w-7xl px-4 py-6">
      <div className="rounded-xl border bg-card p-4 shadow-sm sm:p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Live simulation · no broker orders</div>
            <h2 className="mt-1 text-2xl font-semibold">Paper Trading Desk</h2>
          </div>
          <div className="flex items-center gap-2">
            {updatedAt && <span className="hidden text-[11px] text-muted-foreground sm:inline">updated {updatedAt.toLocaleTimeString("en-IN")}</span>}
            <Badge variant="outline" className="border-amber-500/40 text-amber-400">SHADOW MODE</Badge>
          </div>
        </div>

        {error && <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">{error}</div>}

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">Range</span>
          {RANGE_OPTIONS.map((r) => (
            <Button key={r.value} size="sm" variant={range === r.value ? "default" : "outline"} className="h-7 px-3 text-xs" onClick={() => setRange(r.value)}>{r.label}</Button>
          ))}
        </div>

        <Tabs defaultValue="overview">
          <TabsList className="mb-4">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="positions">Positions <span className="ml-1 rounded bg-muted px-1.5 text-[10px] tabular-nums">{openTrades.length}</span></TabsTrigger>
            <TabsTrigger value="ledger">Ledger</TabsTrigger>
            <TabsTrigger value="analytics">Analytics</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-4">
            <KpiStrip summary={summary} stats={stats} />
            <EquityChart points={curve} baseline={stats?.equity?.startingCapital ?? summary?.startingCapital ?? null} />
            {curve.length === 0 && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300">
                The equity curve is built from engine snapshots. If it stays empty, the engine worker needs SHADOW_STARTING_CAPITAL configured. Manual paper orders below still track P&amp;L live.
              </div>
            )}
          </TabsContent>

          <TabsContent value="positions">
            <PositionsTable trades={openTrades} onClose={(t) => void closeTrade(t)} busy={busy} />
          </TabsContent>

          <TabsContent value="ledger" className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="h-8 w-32 text-xs"><SelectValue placeholder="Status" /></SelectTrigger>
                <SelectContent><SelectItem value="ALL">All statuses</SelectItem><SelectItem value="OPEN">Open</SelectItem><SelectItem value="CLOSED">Closed</SelectItem></SelectContent>
              </Select>
              <Select value={sourceFilter} onValueChange={setSourceFilter}>
                <SelectTrigger className="h-8 w-36 text-xs"><SelectValue placeholder="Source" /></SelectTrigger>
                <SelectContent><SelectItem value="ALL">All sources</SelectItem><SelectItem value="AUTO">Engine trades</SelectItem><SelectItem value="MANUAL">Manual orders</SelectItem></SelectContent>
              </Select>
              <Select value={symbolFilter} onValueChange={setSymbolFilter}>
                <SelectTrigger className="h-8 w-36 text-xs"><SelectValue placeholder="Symbol" /></SelectTrigger>
                <SelectContent><SelectItem value="ALL">All symbols</SelectItem>{symbols.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
              </Select>
              <span className="ml-auto self-center text-xs text-muted-foreground">{ledgerTrades.length} rows</span>
            </div>
            <LedgerTable trades={ledgerTrades} onOpen={(t) => setDetail({ id: t.id, source: t.source })} />
          </TabsContent>

          <TabsContent value="analytics">
            <AnalyticsTab stats={stats} days={range} />
          </TabsContent>
        </Tabs>
      </div>

      <DetailDialog tradeId={detail?.id ?? null} source={detail?.source ?? "AUTO"} onClose={() => setDetail(null)} />
    </section>
  );
}
