import { Router } from "express";
import type { Pool, PoolClient } from "pg";

type Side = "BUY" | "SELL" | "HOLD";
type Quote = { close: number; timestamp: Date };

const ACCOUNT_ID = 1;
const MAX_QUANTITY = 1_000_000;
let paperSchemaPromise: Promise<void> | null = null;

function ensurePaperSchema(pool: Pool): Promise<void> {
  if (!paperSchemaPromise) paperSchemaPromise = pool.query(`
    create table if not exists paper_accounts (id smallint primary key default 1 check (id=1), starting_capital numeric(16,2) not null check (starting_capital>0), cash numeric(16,2) not null check (cash>=0), realized_pnl numeric(16,2) not null default 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create table if not exists paper_positions (account_id smallint not null references paper_accounts(id) on delete cascade, symbol text not null references instruments(symbol) on update cascade, quantity integer not null check (quantity>0), average_price numeric(14,4) not null check (average_price>0), realized_pnl numeric(16,2) not null default 0, current_price numeric(14,4), current_timestamp timestamptz, updated_at timestamptz not null default now(), primary key(account_id,symbol));
    create table if not exists paper_orders (id uuid primary key default gen_random_uuid(), account_id smallint not null references paper_accounts(id) on delete cascade, symbol text not null references instruments(symbol) on update cascade, side text not null check(side in ('BUY','SELL','HOLD')), quantity integer not null check(quantity>=0), fill_price numeric(14,4), notional numeric(16,2) not null default 0, fill_timestamp timestamptz, status text not null default 'FILLED' check(status in ('FILLED','REJECTED','RECORDED')), note text not null default '', rationale text not null default '', signal_snapshot jsonb not null default '{}'::jsonb, created_at timestamptz not null default now());
    create index if not exists idx_paper_orders_created on paper_orders(created_at desc);
    create index if not exists idx_paper_orders_symbol on paper_orders(symbol,created_at desc);
    create index if not exists idx_paper_positions_account on paper_positions(account_id);
  `).then(() => undefined);
  return paperSchemaPromise;
}

function validSymbol(value: unknown): string | null {
  const symbol = String(value ?? "").trim().toUpperCase();
  return /^[A-Z0-9._-]{1,32}$/.test(symbol) ? symbol : null;
}
function toMoney(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
}
function toQuantity(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= MAX_QUANTITY ? number : null;
}
async function latestQuote(client: Pool | PoolClient, symbol: string): Promise<Quote | null> {
  const result = await client.query(
    `select pb.close, pb.market_timestamp
       from price_bars pb
       join instruments i on i.instrument_id = pb.instrument_id
      where i.symbol=$1 and pb.timeframe='1d'
      order by pb.market_timestamp desc limit 1`,
    [symbol],
  );
  if (!result.rows.length) return null;
  return { close: Number(result.rows[0].close), timestamp: new Date(result.rows[0].market_timestamp) };
}
async function latestSignal(client: Pool | PoolClient, symbol: string): Promise<Record<string, unknown>> {
  const result = await client.query(
    `select s.direction, s.confidence, s.reason_codes, s.model_version, s.parameters, s.timestamp
       from signal_decisions s join instruments i on i.instrument_id=s.instrument_id
      where i.symbol=$1 order by s.timestamp desc limit 1`,
    [symbol],
  );
  if (!result.rows.length) return {};
  const row = result.rows[0];
  return { direction: row.direction, confidence: row.confidence == null ? null : Number(row.confidence), reasonCodes: row.reason_codes ?? [], modelVersion: row.model_version, parameters: row.parameters ?? {}, timestamp: row.timestamp };
}
function errorResponse(res: any, status: number, error: string, message?: string) {
  return res.status(status).json({ ok: false, error, ...(message ? { message } : {}) });
}

export function createPaperRouter(pool: Pool | null): Router {
  const router = Router();

  router.get("/state", async (_req, res) => {
    if (!pool) return errorResponse(res, 503, "DATABASE_NOT_CONFIGURED");
    try {
      await ensurePaperSchema(pool);
      const accountResult = await pool.query(`select id, starting_capital, cash, realized_pnl, created_at, updated_at from paper_accounts where id=$1`, [ACCOUNT_ID]);
      if (!accountResult.rows.length) return res.json({ ok: true, mode: "PAPER_RESEARCH", account: null, positions: [], orders: [], disclaimer: "Research simulation only. No broker or live order is connected." });
      const account = accountResult.rows[0];
      const positionsResult = await pool.query(`select symbol, quantity, average_price, realized_pnl, current_price, current_timestamp, updated_at from paper_positions where account_id=$1 order by symbol`, [ACCOUNT_ID]);
      const ordersResult = await pool.query(`select id, symbol, side, quantity, fill_price, notional, fill_timestamp, status, note, rationale, signal_snapshot, created_at from paper_orders where account_id=$1 order by created_at desc limit 100`, [ACCOUNT_ID]);
      let unrealizedPnl = 0;
      const positions = [];
      for (const row of positionsResult.rows) {
        const quote = await latestQuote(pool, row.symbol);
        const currentPrice = quote?.close ?? (row.current_price == null ? null : Number(row.current_price));
        const averagePrice = Number(row.average_price);
        const quantity = Number(row.quantity);
        const positionUnrealized = currentPrice == null ? null : (currentPrice - averagePrice) * quantity;
        if (positionUnrealized != null) unrealizedPnl += positionUnrealized;
        positions.push({ symbol: row.symbol, quantity, averagePrice, realizedPnl: Number(row.realized_pnl ?? 0), currentPrice, currentTimestamp: quote?.timestamp ?? row.current_timestamp, unrealizedPnl: positionUnrealized });
      }
      const startingCapital = Number(account.starting_capital);
      const cash = Number(account.cash);
      const equity = cash + positions.reduce((sum, position) => sum + (position.currentPrice == null ? position.averagePrice * position.quantity : position.currentPrice * position.quantity), 0);
      return res.json({ ok: true, mode: "PAPER_RESEARCH", account: { id: Number(account.id), startingCapital, cash, realizedPnl: Number(account.realized_pnl), unrealizedPnl, equity, returnPct: startingCapital ? (equity / startingCapital) - 1 : 0, openPositions: positions.length, updatedAt: account.updated_at }, positions, orders: ordersResult.rows.map(row => ({ id: row.id, symbol: row.symbol, side: row.side, quantity: Number(row.quantity), fillPrice: row.fill_price == null ? null : Number(row.fill_price), notional: Number(row.notional), fillTimestamp: row.fill_timestamp, status: row.status, note: row.note, rationale: row.rationale, signalSnapshot: row.signal_snapshot ?? {}, createdAt: row.created_at })), marketStatus: "LAST_DAILY_SESSION", disclaimer: "Research simulation only. Fills use the latest persisted daily close; no broker or live order is connected." });
    } catch (error) {
      return errorResponse(res, 500, "PAPER_STATE_FAILED", error instanceof Error ? error.message : "state_failed");
    }
  });

  router.post("/account", async (req, res) => {
    if (!pool) return errorResponse(res, 503, "DATABASE_NOT_CONFIGURED");
    const startingCapital = toMoney(req.body?.startingCapital);
    if (startingCapital == null || startingCapital <= 0 || startingCapital > 1_000_000_000) return errorResponse(res, 400, "INVALID_STARTING_CAPITAL", "Starting capital must be greater than zero.");
    try {
      await ensurePaperSchema(pool);
      const existing = await pool.query(`select starting_capital, cash from paper_accounts where id=$1`, [ACCOUNT_ID]);
      if (existing.rows.length) return errorResponse(res, 409, "PAPER_ACCOUNT_EXISTS", "Reset is intentionally unavailable while preserving the research ledger.");
      await pool.query(`insert into paper_accounts(id, starting_capital, cash) values($1,$2,$2)`, [ACCOUNT_ID, startingCapital]);
      return res.status(201).json({ ok: true, mode: "PAPER_RESEARCH", startingCapital, cash: startingCapital });
    } catch (error) {
      return errorResponse(res, 500, "PAPER_ACCOUNT_CREATE_FAILED", error instanceof Error ? error.message : "account_create_failed");
    }
  });

  router.post("/orders", async (req, res) => {
    if (!pool) return errorResponse(res, 503, "DATABASE_NOT_CONFIGURED");
    const symbol = validSymbol(req.body?.symbol);
    const side = String(req.body?.side ?? "").trim().toUpperCase() as Side;
    const quantity = toQuantity(req.body?.quantity);
    const note = String(req.body?.note ?? "").trim().slice(0, 500);
    if (!symbol) return errorResponse(res, 400, "INVALID_SYMBOL");
    if (!["BUY", "SELL", "HOLD"].includes(side)) return errorResponse(res, 400, "INVALID_SIDE");
    if (side !== "HOLD" && quantity == null) return errorResponse(res, 400, "INVALID_QUANTITY");
    try {
      await ensurePaperSchema(pool);
      const client = await pool.connect();
      try {
        await client.query("begin");
        const accountResult = await client.query(`select id, cash, realized_pnl from paper_accounts where id=$1 for update`, [ACCOUNT_ID]);
        if (!accountResult.rows.length) { await client.query("rollback"); return errorResponse(res, 409, "PAPER_ACCOUNT_NOT_INITIALIZED", "Create a virtual fund before placing a paper order."); }
        const quote = await latestQuote(client, symbol);
        if (!quote || !Number.isFinite(quote.close) || quote.close <= 0) { await client.query("rollback"); return errorResponse(res, 409, "NO_PERSISTED_QUOTE", "No persisted daily close is available for this instrument."); }
        const signalSnapshot = await latestSignal(client, symbol);
        const cash = Number(accountResult.rows[0].cash);
        const accountRealizedPnl = Number(accountResult.rows[0].realized_pnl ?? 0);
        const positionResult = await client.query(`select quantity, average_price, realized_pnl from paper_positions where account_id=$1 and symbol=$2 for update`, [ACCOUNT_ID, symbol]);
        const current = positionResult.rows[0] ?? { quantity: 0, average_price: 0, realized_pnl: 0 };
        const currentQuantity = Number(current.quantity);
        const currentAverage = Number(current.average_price);
        const orderQuantity = side === "HOLD" ? 0 : quantity as number;
        let nextCash = cash;
        let nextQuantity = currentQuantity;
        let nextAverage = currentAverage;
        let realizedPnl = Number(current.realized_pnl ?? 0);
        let notional = 0;
        if (side === "BUY") {
          notional = quote.close * orderQuantity;
          if (notional > cash) { await client.query("rollback"); return errorResponse(res, 409, "INSUFFICIENT_PAPER_CASH", `Required ${notional.toFixed(2)}, available ${cash.toFixed(2)}.`); }
          nextCash -= notional;
          nextQuantity += orderQuantity;
          nextAverage = ((currentQuantity * currentAverage) + notional) / nextQuantity;
        } else if (side === "SELL") {
          if (orderQuantity > currentQuantity) { await client.query("rollback"); return errorResponse(res, 409, "INSUFFICIENT_POSITION", `Cannot sell ${orderQuantity}; position is ${currentQuantity}.`); }
          notional = quote.close * orderQuantity;
          nextCash += notional;
          nextQuantity -= orderQuantity;
          realizedPnl += (quote.close - currentAverage) * orderQuantity;
          if (nextQuantity === 0) nextAverage = 0;
        }
        const order = await client.query(`insert into paper_orders(account_id,symbol,side,quantity,fill_price,notional,fill_timestamp,status,note,rationale,signal_snapshot) values($1,$2,$3,$4,$5,$6,$7,'FILLED',$8,$9,$10) returning id,created_at`, [ACCOUNT_ID, symbol, side, orderQuantity, side === "HOLD" ? quote.close : quote.close, notional, quote.timestamp, note, note || "Manual research action", JSON.stringify(signalSnapshot)]);
        if (nextQuantity === 0) await client.query(`delete from paper_positions where account_id=$1 and symbol=$2`, [ACCOUNT_ID, symbol]);
        else await client.query(`insert into paper_positions(account_id,symbol,quantity,average_price,realized_pnl,current_price,current_timestamp) values($1,$2,$3,$4,$5,$6,$7) on conflict(account_id,symbol) do update set quantity=excluded.quantity,average_price=excluded.average_price,realized_pnl=excluded.realized_pnl,current_price=excluded.current_price,current_timestamp=excluded.current_timestamp,updated_at=now()`, [ACCOUNT_ID, symbol, nextQuantity, nextAverage, realizedPnl, quote.close, quote.timestamp]);
        await client.query(`update paper_accounts set cash=$2, realized_pnl=$3, updated_at=now() where id=$1`, [ACCOUNT_ID, nextCash, accountRealizedPnl + (side === "SELL" ? (quote.close - currentAverage) * orderQuantity : 0)]);
        await client.query("commit");
        return res.status(201).json({ ok: true, mode: "PAPER_RESEARCH", order: { id: order.rows[0].id, symbol, side, quantity: orderQuantity, fillPrice: quote.close, fillTimestamp: quote.timestamp, notional, signalSnapshot }, cash: nextCash, quoteTimestamp: quote.timestamp, message: side === "HOLD" ? "HOLD recorded; no position or cash changed." : `${side} paper order filled from the latest persisted daily close.` });
      } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
    } catch (error) {
      return errorResponse(res, 500, "PAPER_ORDER_FAILED", error instanceof Error ? error.message : "order_failed");
    }
  });

  return router;
}
