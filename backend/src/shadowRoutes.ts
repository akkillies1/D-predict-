import { Router, type Response } from "express";
import type { Pool } from "pg";

export function createShadowRouter(pool: Pool | null): Router {
  const router = Router();

  router.get("/portfolio", async (_req, res) => {
    if (!pool) return res.status(503).json({ ok: false, error: "DATABASE_NOT_CONFIGURED" });
    try {
      const trades = await pool.query(`
        select st.id, i.symbol, oc.expiry_date, oc.strike, oc.option_type,
               st.direction, st.status, st.quantity, st.lot_size,
               st.entry_price, st.entry_timestamp, st.entry_quote_timestamp,
               st.stop_loss, st.target, st.current_price, st.current_quote_timestamp,
               st.unrealized_pnl, st.realized_pnl, st.exit_price, st.exit_timestamp,
               st.exit_reason, st.signal_decision_id, st.trade_construction_id
        from shadow_trades st
        join option_contracts oc on oc.contract_id = st.contract_id
        join instruments i on i.instrument_id = oc.instrument_id
        order by st.entry_timestamp desc
        limit 200`);

      const equity = await pool.query(`
        select timestamp, starting_capital, realized_pnl, unrealized_pnl,
               equity, peak_equity, drawdown, open_trades, closed_trades
        from shadow_equity_snapshots
        order by timestamp desc limit 1`);

      const closed = trades.rows.filter((r) => r.status === "CLOSED");
      const wins = closed.filter((r) => Number(r.realized_pnl ?? 0) > 0).length;
      const latest = equity.rows[0] ?? null;
      return res.json({
        ok: true,
        mode: "SHADOW",
        trades: trades.rows.map((r) => ({
          id: r.id, symbol: r.symbol, expiryDate: r.expiry_date, strike: Number(r.strike),
          optionType: r.option_type, direction: r.direction, status: r.status,
          quantity: Number(r.quantity), lotSize: Number(r.lot_size),
          entryPrice: Number(r.entry_price), entryTimestamp: r.entry_timestamp,
          entryQuoteTimestamp: r.entry_quote_timestamp, stopLoss: Number(r.stop_loss),
          target: Number(r.target), currentPrice: r.current_price === null ? null : Number(r.current_price),
          currentQuoteTimestamp: r.current_quote_timestamp,
          unrealizedPnl: Number(r.unrealized_pnl ?? 0), realizedPnl: r.realized_pnl === null ? null : Number(r.realized_pnl),
          exitPrice: r.exit_price === null ? null : Number(r.exit_price),
          exitTimestamp: r.exit_timestamp, exitReason: r.exit_reason,
          signalDecisionId: r.signal_decision_id, tradeConstructionId: r.trade_construction_id,
        })),
        summary: {
          startingCapital: latest ? Number(latest.starting_capital) : Number(process.env.SHADOW_STARTING_CAPITAL ?? 100000),
          realizedPnl: latest ? Number(latest.realized_pnl) : 0,
          unrealizedPnl: latest ? Number(latest.unrealized_pnl) : 0,
          equity: latest ? Number(latest.equity) : Number(process.env.SHADOW_STARTING_CAPITAL ?? 100000),
          peakEquity: latest ? Number(latest.peak_equity) : Number(process.env.SHADOW_STARTING_CAPITAL ?? 100000),
          drawdown: latest ? Number(latest.drawdown) : 0,
          openTrades: latest ? Number(latest.open_trades) : 0,
          closedTrades: latest ? Number(latest.closed_trades) : closed.length,
          winRate: closed.length ? wins / closed.length : null,
          latestSnapshot: latest?.timestamp ?? null,
        },
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: "SHADOW_PORTFOLIO_QUERY_FAILED", message: error instanceof Error ? error.message : "query_failed" });
    }
  });

  router.get("/trades", async (req, res) => {
    if (!pool) return res.status(503).json({ ok: false, error: "DATABASE_NOT_CONFIGURED" });
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100)));
    try {
      const result = await pool.query(`
        select st.*, i.symbol, oc.expiry_date, oc.strike, oc.option_type
        from shadow_trades st
        join option_contracts oc on oc.contract_id = st.contract_id
        join instruments i on i.instrument_id = oc.instrument_id
        order by st.entry_timestamp desc limit $1`, [limit]);
      return res.json({ ok: true, mode: "SHADOW", trades: result.rows });
    } catch (error) {
      return res.status(500).json({ ok: false, error: "SHADOW_TRADES_QUERY_FAILED", message: error instanceof Error ? error.message : "query_failed" });
    }
  });

  return router;
}
