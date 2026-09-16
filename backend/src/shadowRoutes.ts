import { Router } from "express";
import type { Pool } from "pg";

const MAX_OPTION_QUOTE_AGE_MS = Math.max(15_000, Number(process.env.SHADOW_MAX_QUOTE_AGE_SECONDS ?? 120) * 1000);

type OptionQuote = { timestamp: Date; ltp: number | null; bid: number | null; ask: number | null };

function configuredShadowCapital(): number | null {
  const value = Number(process.env.SHADOW_STARTING_CAPITAL);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function freshQuote(quote: OptionQuote, now = new Date()): boolean {
  const age = now.getTime() - quote.timestamp.getTime();
  return age >= 0 && age <= MAX_OPTION_QUOTE_AGE_MS;
}

function buyFill(quote: OptionQuote): number | null { return quote.ask ?? quote.ltp ?? quote.bid; }
function sellFill(quote: OptionQuote): number | null { return quote.bid ?? quote.ltp ?? quote.ask; }

async function latestOptionQuote(pool: Pool, contractId: string): Promise<OptionQuote | null> {
  const result = await pool.query(
    `select market_timestamp as timestamp, ltp, bid, ask
     from option_snapshots
     where contract_id = $1
     order by market_timestamp desc
     limit 1`, [contractId]
  );
  if (!result.rows.length) return null;
  const row = result.rows[0];
  return { timestamp: new Date(row.timestamp), ltp: row.ltp == null ? null : Number(row.ltp), bid: row.bid == null ? null : Number(row.bid), ask: row.ask == null ? null : Number(row.ask) };
}

function invalidOrderInput(body: any): string | null {
  const symbol = String(body?.symbol ?? "").trim().toUpperCase();
  const optionType = String(body?.optionType ?? "").trim().toUpperCase();
  const side = String(body?.side ?? "").trim().toUpperCase();
  const strike = Number(body?.strike);
  const lots = Number(body?.lots);
  if (!/^[A-Z0-9._-]{1,32}$/.test(symbol)) return "INVALID_SYMBOL";
  if (optionType !== "CE" && optionType !== "PE") return "INVALID_OPTION_TYPE";
  if (side !== "BUY" && side !== "SELL") return "INVALID_SIDE";
  if (!Number.isFinite(strike) || strike <= 0) return "INVALID_STRIKE";
  if (!Number.isInteger(lots) || lots <= 0) return "INVALID_LOTS";
  return null;
}

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
      const equity = await pool.query(`select timestamp, starting_capital, realized_pnl, unrealized_pnl, equity, peak_equity, drawdown, open_trades, closed_trades from shadow_equity_snapshots order by timestamp desc limit 1`);
      const closed = trades.rows.filter((r) => r.status === "CLOSED");
      const wins = closed.filter((r) => Number(r.realized_pnl ?? 0) > 0).length;
      const latest = equity.rows[0] ?? null;
      const configuredCapital = configuredShadowCapital();
      if (!latest && configuredCapital === null) return res.status(503).json({ ok: false, error: "SHADOW_CAPITAL_NOT_CONFIGURED" });
      const startingCapital = latest ? Number(latest.starting_capital) : configuredCapital as number;
      return res.json({
        ok: true, mode: "SHADOW",
        trades: trades.rows.map((r) => ({ id: r.id, symbol: r.symbol, expiryDate: r.expiry_date, strike: Number(r.strike), optionType: r.option_type, direction: r.direction, status: r.status, quantity: Number(r.quantity), lotSize: Number(r.lot_size), entryPrice: Number(r.entry_price), entryTimestamp: r.entry_timestamp, entryQuoteTimestamp: r.entry_quote_timestamp, stopLoss: Number(r.stop_loss), target: Number(r.target), currentPrice: r.current_price === null ? null : Number(r.current_price), currentQuoteTimestamp: r.current_quote_timestamp, unrealizedPnl: Number(r.unrealized_pnl ?? 0), realizedPnl: r.realized_pnl === null ? null : Number(r.realized_pnl), exitPrice: r.exit_price === null ? null : Number(r.exit_price), exitTimestamp: r.exit_timestamp, exitReason: r.exit_reason, signalDecisionId: r.signal_decision_id, tradeConstructionId: r.trade_construction_id })),
        summary: { startingCapital, realizedPnl: latest ? Number(latest.realized_pnl) : 0, unrealizedPnl: latest ? Number(latest.unrealized_pnl) : 0, equity: latest ? Number(latest.equity) : startingCapital, peakEquity: latest ? Number(latest.peak_equity) : startingCapital, drawdown: latest ? Number(latest.drawdown) : 0, openTrades: latest ? Number(latest.open_trades) : 0, closedTrades: latest ? Number(latest.closed_trades) : closed.length, winRate: closed.length ? wins / closed.length : null, latestSnapshot: latest?.timestamp ?? null },
      });
    } catch (error) { return res.status(500).json({ ok: false, error: "SHADOW_PORTFOLIO_QUERY_FAILED", message: error instanceof Error ? error.message : "query_failed" }); }
  });

  router.get("/trades", async (req, res) => {
    if (!pool) return res.status(503).json({ ok: false, error: "DATABASE_NOT_CONFIGURED" });
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100)));
    try {
      const result = await pool.query(`select st.*, i.symbol, oc.expiry_date, oc.strike, oc.option_type from shadow_trades st join option_contracts oc on oc.contract_id = st.contract_id join instruments i on i.instrument_id = oc.instrument_id order by st.entry_timestamp desc limit $1`, [limit]);
      return res.json({ ok: true, mode: "SHADOW", trades: result.rows });
    } catch (error) { return res.status(500).json({ ok: false, error: "SHADOW_TRADES_QUERY_FAILED", message: error instanceof Error ? error.message : "query_failed" }); }
  });

  router.post("/paper-orders", async (req, res) => {
    if (!pool) return res.status(503).json({ ok: false, error: "DATABASE_NOT_CONFIGURED" });
    const validationError = invalidOrderInput(req.body);
    if (validationError) return res.status(400).json({ ok: false, error: validationError });
    const symbol = String(req.body.symbol).trim().toUpperCase();
    const expiry = String(req.body.expiry ?? "").trim();
    const optionType = String(req.body.optionType).trim().toUpperCase();
    const side = String(req.body.side).trim().toUpperCase();
    const strike = Number(req.body.strike);
    const lots = Number(req.body.lots);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return res.status(400).json({ ok: false, error: "INVALID_EXPIRY" });
    try {
      const contractResult = await pool.query(`select oc.contract_id as "contractId", oc.expiry_date as "expiryDate", oc.strike, oc.option_type as "optionType", i.symbol, i.lot_size as "lotSize" from option_contracts oc join instruments i on i.instrument_id = oc.instrument_id where i.symbol = $1 and oc.expiry_date = $2::date and oc.strike = $3 and oc.option_type = $4 limit 1`, [symbol, expiry, strike, optionType]);
      if (!contractResult.rows.length) return res.status(404).json({ ok: false, error: "OPTION_CONTRACT_NOT_FOUND" });
      const contract = contractResult.rows[0];
      const now = new Date();
      if (new Date(contract.expiryDate).getTime() < Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) return res.status(409).json({ ok: false, error: "OPTION_CONTRACT_EXPIRED" });
      const quote = await latestOptionQuote(pool, contract.contractId);
      if (!quote || !freshQuote(quote, now)) return res.status(409).json({ ok: false, error: "OPTION_QUOTE_STALE", quoteTimestamp: quote?.timestamp ?? null, maxAgeSeconds: MAX_OPTION_QUOTE_AGE_MS / 1000 });
      const fill = side === "BUY" ? buyFill(quote) : sellFill(quote);
      if (fill == null || !Number.isFinite(fill) || fill <= 0) return res.status(409).json({ ok: false, error: "OPTION_QUOTE_NOT_EXECUTABLE", quoteTimestamp: quote.timestamp });
      const lotSize = Number(contract.lotSize);
      const quantity = lotSize * lots;
      const inserted = await pool.query(`insert into option_paper_trades (contract_id, symbol, expiry_date, strike, option_type, side, status, lots, lot_size, quantity, entry_price, entry_bid, entry_ask, entry_ltp, entry_quote_timestamp, current_price, current_quote_timestamp, unrealized_pnl) values ($1,$2,$3,$4,$5,$6,'OPEN',$7,$8,$9,$10,$11,$12,$13,$14,$10,$14,0) returning id, entry_timestamp`, [contract.contractId, symbol, contract.expiryDate, Number(contract.strike), optionType, side, lots, lotSize, quantity, fill, quote.bid, quote.ask, quote.ltp, quote.timestamp]);
      return res.status(201).json({ ok: true, mode: "PAPER", order: { id: inserted.rows[0].id, symbol, expiryDate: contract.expiryDate, strike: Number(contract.strike), optionType, side, lots, lotSize, quantity, entryPrice: fill, quoteTimestamp: quote.timestamp, bid: quote.bid, ask: quote.ask, ltp: quote.ltp, entryTimestamp: inserted.rows[0].entry_timestamp } });
    } catch (error) { return res.status(500).json({ ok: false, error: "OPTION_PAPER_ORDER_FAILED", message: error instanceof Error ? error.message : "order_failed" }); }
  });

  router.get("/paper-trades", async (_req, res) => {
    if (!pool) return res.status(503).json({ ok: false, error: "DATABASE_NOT_CONFIGURED" });
    try {
      const result = await pool.query(`select pt.*, i.symbol from option_paper_trades pt join option_contracts oc on oc.contract_id = pt.contract_id join instruments i on i.instrument_id = oc.instrument_id order by pt.entry_timestamp desc limit 500`);
      return res.json({ ok: true, mode: "PAPER", trades: result.rows });
    } catch (error) { return res.status(500).json({ ok: false, error: "OPTION_PAPER_TRADES_QUERY_FAILED", message: error instanceof Error ? error.message : "query_failed" }); }
  });

  router.post("/paper-trades/:id/close", async (req, res) => {
    if (!pool) return res.status(503).json({ ok: false, error: "DATABASE_NOT_CONFIGURED" });
    try {
      const tradeResult = await pool.query(`select * from option_paper_trades where id = $1 and status = 'OPEN'`, [req.params.id]);
      if (!tradeResult.rows.length) return res.status(404).json({ ok: false, error: "OPEN_PAPER_TRADE_NOT_FOUND" });
      const trade = tradeResult.rows[0];
      const quote = await latestOptionQuote(pool, trade.contract_id);
      const now = new Date();
      if (!quote || !freshQuote(quote, now)) return res.status(409).json({ ok: false, error: "OPTION_QUOTE_STALE", quoteTimestamp: quote?.timestamp ?? null, maxAgeSeconds: MAX_OPTION_QUOTE_AGE_MS / 1000 });
      const closePrice = trade.side === "BUY" ? sellFill(quote) : buyFill(quote);
      if (closePrice == null || !Number.isFinite(closePrice) || closePrice <= 0) return res.status(409).json({ ok: false, error: "OPTION_QUOTE_NOT_EXECUTABLE" });
      const quantity = Number(trade.quantity);
      const entryPrice = Number(trade.entry_price);
      const pnl = trade.side === "BUY" ? (closePrice - entryPrice) * quantity : (entryPrice - closePrice) * quantity;
      await pool.query(`update option_paper_trades set status='CLOSED', current_price=$2, current_quote_timestamp=$3, unrealized_pnl=0, realized_pnl=$4, exit_price=$2, exit_quote_timestamp=$3, exit_timestamp=now(), exit_reason='MANUAL', updated_at=now() where id=$1 and status='OPEN'`, [trade.id, closePrice, quote.timestamp, pnl]);
      return res.json({ ok: true, mode: "PAPER", tradeId: trade.id, exitPrice: closePrice, realizedPnl: pnl, quoteTimestamp: quote.timestamp });
    } catch (error) { return res.status(500).json({ ok: false, error: "OPTION_PAPER_CLOSE_FAILED", message: error instanceof Error ? error.message : "close_failed" }); }
  });

  return router;
}
