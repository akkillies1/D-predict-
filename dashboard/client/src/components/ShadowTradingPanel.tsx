import { useEffect, useState } from "react";

const API = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:4100";

type Trade = {
  id: string;
  symbol: string;
  expiryDate: string;
  strike: number;
  optionType: string;
  direction: string;
  status: string;
  quantity: number;
  entryPrice: number;
  currentPrice: number | null;
  stopLoss: number;
  target: number;
  unrealizedPnl: number;
  realizedPnl: number | null;
  exitReason: string | null;
  entryTimestamp: string;
};

type Portfolio = {
  summary: {
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
  trades: Trade[];
};

function money(value: number | null) {
  if (value == null) return "—";
  return `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

export default function ShadowTradingPanel() {
  const [data, setData] = useState<Portfolio | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function refresh() {
    try {
      const response = await fetch(`${API}/api/shadow/portfolio`);
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error ?? "Shadow trading unavailable");
      setData(body);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Shadow trading unavailable");
    }
  }

  async function closeTrade(id: string) {
    setBusy(id);
    try {
      const response = await fetch(`${API}/api/shadow/trades/${encodeURIComponent(id)}/close`, { method: "POST" });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.message ?? body.error ?? "Could not close shadow trade");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not close shadow trade");
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <section className="mx-auto w-full max-w-7xl px-4 py-6">
      <div className="rounded-xl border bg-card p-6 shadow-sm">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Live simulation</div>
            <h2 className="mt-1 text-2xl font-semibold">Shadow Trading</h2>
            <p className="mt-1 text-sm text-muted-foreground">D-Predict signals are simulated against live option quotes. No broker orders are sent.</p>
          </div>
          <div className="rounded-full border px-3 py-1 text-xs font-medium">SHADOW MODE</div>
        </div>

        {error ? <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">{error}</div> : data ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
              {[
                ["Equity", money(data.summary.equity)],
                ["Realized P&L", money(data.summary.realizedPnl)],
                ["Unrealized P&L", money(data.summary.unrealizedPnl)],
                ["Drawdown", money(data.summary.drawdown)],
                ["Open", String(data.summary.openTrades)],
                ["Win rate", data.summary.winRate == null ? "—" : `${(data.summary.winRate * 100).toFixed(1)}%`],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border p-3">
                  <div className="text-xs text-muted-foreground">{label}</div>
                  <div className="mt-1 text-lg font-semibold">{value}</div>
                </div>
              ))}
            </div>

            <div className="mt-6 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs text-muted-foreground">
                  <tr><th className="px-2 py-2">Contract</th><th className="px-2 py-2">Status</th><th className="px-2 py-2">Entry</th><th className="px-2 py-2">Current</th><th className="px-2 py-2">SL</th><th className="px-2 py-2">Target</th><th className="px-2 py-2">P&L</th><th className="px-2 py-2">Exit</th><th className="px-2 py-2">Action</th></tr>
                </thead>
                <tbody>
                  {data.trades.map((trade) => {
                    const pnl = trade.status === "OPEN" ? trade.unrealizedPnl : (trade.realizedPnl ?? 0);
                    return <tr key={trade.id} className="border-b last:border-0">
                      <td className="px-2 py-3 font-medium">{trade.symbol} {trade.strike} {trade.optionType}</td>
                      <td className="px-2 py-3">{trade.status}</td>
                      <td className="px-2 py-3">{trade.entryPrice.toFixed(2)}</td>
                      <td className="px-2 py-3">{trade.currentPrice == null ? "—" : trade.currentPrice.toFixed(2)}</td>
                      <td className="px-2 py-3">{trade.stopLoss.toFixed(2)}</td>
                      <td className="px-2 py-3">{trade.target.toFixed(2)}</td>
                      <td className="px-2 py-3">{money(pnl)}</td>
                      <td className="px-2 py-3">{trade.exitReason ?? "—"}</td>
                      <td className="px-2 py-3">{trade.status === "OPEN" ? <button onClick={() => void closeTrade(trade.id)} disabled={busy === trade.id} className="rounded-md border border-rose-500/30 px-2 py-1 text-[10px] font-semibold text-rose-400 hover:bg-rose-500/10 disabled:opacity-50">{busy === trade.id ? "Closing..." : "SELL / CLOSE"}</button> : <span className="text-xs text-muted-foreground">—</span>}</td>
                    </tr>;
                  })}
                  {!data.trades.length && <tr><td colSpan={9} className="px-2 py-8 text-center text-muted-foreground">No shadow trades yet. Entries are created automatically when a qualifying signal has a fresh option quote. Use the Option Chain paper panel above to place a manual BUY or SELL test order.</td></tr>}
                </tbody>
              </table>
            </div>
          </>
        ) : <div className="py-8 text-center text-muted-foreground">Loading shadow trading…</div>}
      </div>
    </section>
  );
}
