import { Router } from "express";
import type { Pool, PoolClient } from "pg";

type Side = "BUY" | "SELL" | "HOLD";
type Product = "CNC" | "MIS" | "NRML";
type OrderType = "MARKET" | "LIMIT";
type Quote = { close: number; timestamp: Date };

const ACCOUNT_ID = 1;
const MAX_QUANTITY = 1_000_000;
// Broker margin is shown as information only; the paper ledger always debits full
// notional + charges so simulated leverage can never manufacture "free" profit.
const MIS_MARGIN_RATE = 0.2;
// A fill is only valid against a genuinely live market. The collector writes a new
// 1-minute bar while the exchange session is producing data and stops when it is not,
// so "a 1-minute bar no older than this window" is the market-open signal. Default 3
// minutes tolerates one skipped collector poll; there is no hardcoded clock or holiday.
const LIVE_WINDOW_SECONDS = Math.max(30, Number(process.env.PAPER_LIVE_WINDOW_SECONDS ?? 180));
let paperSchemaPromise: Promise<void> | null = null;

export type ChargeBreakdown = {
  brokerage: number; stt: number; exchange: number; sebi: number; stamp: number; gst: number; total: number;
};

// Indian NSE equity charges, Zerodha-style. Delivery (CNC) has zero brokerage and
// higher STT/stamp; intraday (MIS/NRML) has flat-capped brokerage and lower STT.
export function computeCharges(side: "BUY" | "SELL", product: Product, quantity: number, price: number): ChargeBreakdown {
  const turnover = Math.max(0, quantity) * Math.max(0, price);
  const delivery = product === "CNC";
  const brokerage = delivery ? 0 : Math.min(turnover * 0.0003, 20);
  const stt = turnover * (delivery ? 0.001 : 0.00025);
  const exchange = turnover * 0.0000297;
  const sebi = turnover * 0.000001;
  const stamp = side === "BUY" ? turnover * (delivery ? 0.00015 : 0.00003) : 0;
  const gst = (brokerage + exchange + sebi) * 0.18;
  const total = brokerage + stt + exchange + sebi + stamp + gst;
  const round = (value: number) => Math.round(value * 100) / 100;
  return { brokerage: round(brokerage), stt: round(stt), exchange: round(exchange), sebi: round(sebi), stamp: round(stamp), gst: round(gst), total: round(total) };
}

function marginInfo(product: Product, gross: number, charges: number): number {
  const round = (value: number) => Math.round(value * 100) / 100;
  return product === "MIS" ? round(gross * MIS_MARGIN_RATE + charges) : round(gross + charges);
}

function ensurePaperSchema(pool: Pool): Promise<void> {
  if (!paperSchemaPromise) paperSchemaPromise = pool.query(`
    create table if not exists paper_accounts (id smallint primary key default 1 check (id=1), starting_capital numeric(16,2) not null check (starting_capital>0), cash numeric(16,2) not null check (cash>=0), realized_pnl numeric(16,2) not null default 0, total_costs numeric(16,2) not null default 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create table if not exists paper_positions (account_id smallint not null references paper_accounts(id) on delete cascade, symbol text not null references instruments(symbol) on update cascade, product text not null default 'CNC' check (product in ('CNC','MIS','NRML')), quantity integer not null check (quantity>0), average_price numeric(14,4) not null check (average_price>0), cost_net numeric(18,2) not null default 0, realized_pnl numeric(16,2) not null default 0, current_price numeric(14,4), mark_timestamp timestamptz, entered_on date not null default current_date, updated_at timestamptz not null default now(), primary key(account_id,symbol,product));
    create table if not exists paper_orders (id uuid primary key default gen_random_uuid(), account_id smallint not null references paper_accounts(id) on delete cascade, symbol text not null references instruments(symbol) on update cascade, product text not null default 'CNC' check (product in ('CNC','MIS','NRML')), side text not null check(side in ('BUY','SELL','HOLD')), order_type text not null default 'MARKET' check(order_type in ('MARKET','LIMIT')), quantity integer not null check(quantity>=0), limit_price numeric(14,4), fill_price numeric(14,4), notional numeric(16,2) not null default 0, gross_amount numeric(16,2) not null default 0, net_amount numeric(16,2) not null default 0, costs jsonb not null default '{}'::jsonb, realized_pnl numeric(16,2) not null default 0, fill_timestamp timestamptz, status text not null default 'FILLED' check(status in ('FILLED','REJECTED','RECORDED','OPEN','CANCELLED')), note text not null default '', rationale text not null default '', signal_snapshot jsonb not null default '{}'::jsonb, created_at timestamptz not null default now());
    alter table paper_orders add column if not exists product text not null default 'CNC';
    alter table paper_orders add column if not exists order_type text not null default 'MARKET';
    alter table paper_orders add column if not exists limit_price numeric(14,4);
    alter table paper_orders add column if not exists gross_amount numeric(16,2) not null default 0;
    alter table paper_orders add column if not exists net_amount numeric(16,2) not null default 0;
    alter table paper_orders add column if not exists costs jsonb not null default '{}'::jsonb;
    alter table paper_orders add column if not exists realized_pnl numeric(16,2) not null default 0;
    alter table paper_positions add column if not exists product text not null default 'CNC';
    alter table paper_positions add column if not exists cost_net numeric(18,2) not null default 0;
    alter table paper_positions add column if not exists entered_on date not null default current_date;
    alter table paper_accounts add column if not exists total_costs numeric(16,2) not null default 0;
    do $$ begin
      if exists (select 1 from pg_constraint where conname='paper_orders_status_check') then
        alter table paper_orders drop constraint paper_orders_status_check;
      end if;
      alter table paper_orders add constraint paper_orders_status_check check (status in ('FILLED','REJECTED','RECORDED','OPEN','CANCELLED'));
    end $$;
    do $$ begin
      if exists (select 1 from pg_constraint where conname='paper_positions_pkey') then
        alter table paper_positions drop constraint paper_positions_pkey;
      end if;
      alter table paper_positions add constraint paper_positions_pkey primary key (account_id, symbol, product);
    end $$;
    create index if not exists idx_paper_orders_created on paper_orders(created_at desc);
    create index if not exists idx_paper_orders_symbol on paper_orders(symbol,created_at desc);
    create index if not exists idx_paper_orders_open on paper_orders(account_id,status) where status='OPEN';
    create index if not exists idx_paper_positions_account on paper_positions(account_id);
  `).then(() => undefined);
  return paperSchemaPromise;
}

function validSymbol(value: unknown): string | null {
  const symbol = String(value ?? "").trim().toUpperCase();
  return /^[A-Z0-9._-]{1,32}$/.test(symbol) ? symbol : null;
}
function validProduct(value: unknown): Product {
  const product = String(value ?? "").trim().toUpperCase();
  return product === "MIS" || product === "NRML" || product === "CNC" ? product : "CNC";
}
function validOrderType(value: unknown): OrderType {
  return String(value ?? "").trim().toUpperCase() === "LIMIT" ? "LIMIT" : "MARKET";
}
function toMoney(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
}
function toPrice(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number * 10000) / 10000 : null;
}
function toQuantity(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= MAX_QUANTITY ? number : null;
}
// Newest bar of any timeframe: a fresh 1-minute close during market hours, else the
// last daily close. Never fabricates a price when none is persisted.
async function bestQuote(client: Pool | PoolClient, symbol: string): Promise<Quote | null> {
  const result = await client.query(
    `select pb.close, pb.market_timestamp
       from price_bars pb
       join instruments i on i.instrument_id = pb.instrument_id
      where i.symbol=$1
      order by pb.market_timestamp desc limit 1`,
    [symbol],
  );
  if (!result.rows.length) return null;
  return { close: Number(result.rows[0].close), timestamp: new Date(result.rows[0].market_timestamp) };
}
// A tradeable live price: the newest 1-MINUTE bar that is still within the freshness
// window. Returns null when the market is closed / the feed has stopped, so callers can
// queue an order instead of fabricating a fill from a stale daily close.
async function liveMarketPrice(client: Pool | PoolClient, symbol: string): Promise<Quote | null> {
  const result = await client.query(
    `select pb.close, pb.market_timestamp
       from price_bars pb
       join instruments i on i.instrument_id = pb.instrument_id
      where i.symbol=$1 and pb.timeframe='1m'
        and pb.market_timestamp >= now() - make_interval(secs => $2)
      order by pb.market_timestamp desc limit 1`,
    [symbol, LIVE_WINDOW_SECONDS],
  );
  if (!result.rows.length) return null;
  const close = Number(result.rows[0].close);
  if (!Number.isFinite(close) || close <= 0) return null;
  return { close, timestamp: new Date(result.rows[0].market_timestamp) };
}
// Best-effort live quote for UI display (does not gate fills): newest bar of any
// timeframe plus a market status derived purely from its age.
export async function symbolQuote(pool: Pool, symbol: string): Promise<Record<string, unknown>> {
  const result = await pool.query(
    `with ranked as (
       select pb.close, pb.open, pb.high, pb.low, pb.volume, pb.market_timestamp, pb.source,
              lag(pb.close) over (partition by pb.instrument_id order by pb.market_timestamp) as previous_close
         from price_bars pb join instruments i on i.instrument_id = pb.instrument_id
        where i.symbol=$1 order by pb.market_timestamp desc limit 2)
     select * from ranked order by market_timestamp desc limit 1`,
    [symbol],
  );
  if (!result.rows.length) return { ok: false, symbol, close: null, status: "OFFLINE" };
  const row = result.rows[0];
  const close = Number(row.close);
  const previousClose = row.previous_close == null ? null : Number(row.previous_close);
  const change = previousClose == null ? null : close - previousClose;
  const age = Date.now() - Date.parse(new Date(row.market_timestamp).toISOString());
  const status = age <= LIVE_WINDOW_SECONDS * 1000 ? "LIVE" : age <= 300000 ? "CACHED" : "STALE";
  return {
    ok: true, symbol, close, timestamp: new Date(row.market_timestamp).toISOString(),
    open: row.open == null ? null : Number(row.open), high: row.high == null ? null : Number(row.high),
    low: row.low == null ? null : Number(row.low), volume: row.volume == null ? null : Number(row.volume),
    previousClose, change, changePercent: change != null && previousClose ? (change / previousClose) * 100 : null, status,
  };
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

// Apply a fill to cash + positions for a BUY or SELL. Assumes an account row is locked
// by the caller and returns the executed economics. Throws with a code on a guard failure.
async function applyFill(client: PoolClient, args: { symbol: string; product: Product; side: "BUY" | "SELL"; quantity: number; fill: number; fillTimestamp: Date; note: string; orderType: OrderType; }): Promise<{ charges: ChargeBreakdown; gross: number; net: number; realized: number; cash: number }> {
  const { symbol, product, side, quantity, fill, fillTimestamp } = args;
  const charges = computeCharges(side, product, quantity, fill);
  const gross = Math.round(fill * quantity * 100) / 100;
  const account = await client.query(`select cash from paper_accounts where id=$1 for update`, [ACCOUNT_ID]);
  const cash = Number(account.rows[0].cash);
  const position = await client.query(`select quantity, average_price, cost_net, realized_pnl from paper_positions where account_id=$1 and symbol=$2 and product=$3 for update`, [ACCOUNT_ID, symbol, product]);
  const current = position.rows[0] ?? { quantity: 0, average_price: 0, cost_net: 0, realized_pnl: 0 };
  const currentQty = Number(current.quantity);
  const currentAvg = Number(current.average_price);
  const currentCostNet = Number(current.cost_net ?? gross);
  let nextCash = cash;
  let realized = 0;
  let net = 0;
  if (side === "BUY") {
    net = Math.round((gross + charges.total) * 100) / 100;
    if (net > cash) { const err: any = new Error(`Required ${net.toFixed(2)}, available ${cash.toFixed(2)}.`); err.code = "INSUFFICIENT_PAPER_CASH"; throw err; }
    nextCash = Math.round((cash - net) * 100) / 100;
    const nextQty = currentQty + quantity;
    const nextAvg = Math.round((((currentQty * currentAvg) + gross) / nextQty) * 10000) / 10000;
    const nextCostNet = Math.round((currentCostNet + net) * 100) / 100;
    await client.query(`insert into paper_positions(account_id,symbol,product,quantity,average_price,cost_net,realized_pnl,current_price,mark_timestamp,entered_on) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date) on conflict(account_id,symbol,product) do update set quantity=excluded.quantity,average_price=excluded.average_price,cost_net=excluded.cost_net,current_price=excluded.current_price,mark_timestamp=excluded.mark_timestamp,entered_on=least(paper_positions.entered_on, excluded.entered_on),updated_at=now()`, [ACCOUNT_ID, symbol, product, nextQty, nextAvg, nextCostNet, Number(current.realized_pnl ?? 0), fill, fillTimestamp, fillTimestamp.toISOString().slice(0, 10)]);
  } else {
    if (quantity > currentQty) { const err: any = new Error(`Cannot sell ${quantity}; open ${product} ${symbol} position is ${currentQty}.`); err.code = "INSUFFICIENT_POSITION"; throw err; }
    net = Math.round((gross - charges.total) * 100) / 100;
    const costForSold = currentQty ? Math.round((currentCostNet * (quantity / currentQty)) * 100) / 100 : 0;
    realized = Math.round((net - costForSold) * 100) / 100;
    nextCash = Math.round((cash + net) * 100) / 100;
    const nextQty = currentQty - quantity;
    if (nextQty === 0) {
      await client.query(`delete from paper_positions where account_id=$1 and symbol=$2 and product=$3`, [ACCOUNT_ID, symbol, product]);
    } else {
      const nextCostNet = Math.round((currentCostNet - costForSold) * 100) / 100;
      await client.query(`update paper_positions set quantity=$4, cost_net=$5, realized_pnl=realized_pnl+$6, current_price=$7, mark_timestamp=$8, updated_at=now() where account_id=$1 and symbol=$2 and product=$3`, [ACCOUNT_ID, symbol, product, nextQty, nextCostNet, realized, fill, fillTimestamp]);
    }
    await client.query(`update paper_accounts set realized_pnl=realized_pnl+$2 where id=$1`, [ACCOUNT_ID, realized]);
  }
  await client.query(`update paper_accounts set cash=$2, total_costs=total_costs+$3, updated_at=now() where id=$1`, [ACCOUNT_ID, nextCash, charges.total]);
  return { charges, gross, net, realized, cash: nextCash };
}

// Advance every resting order against the LIVE market only. An order moves to FILLED
// solely when a fresh 1-minute price exists (market open); a marketable LIMIT crosses the
// live tick and a pending MARKET fills at it. When the feed is not live, orders stay OPEN —
// an after-hours order is queued and fills when the market reopens and its trigger is met.
// Returns true if any order or MIS position changed state (so the caller can push an update).
export async function matchRestingOrders(pool: Pool): Promise<boolean> {
  await ensurePaperSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`select 1 from paper_accounts where id=$1 for update`, [ACCOUNT_ID]);
    let changed = false;
    const openOrders = await client.query(`select id, symbol, product, side, quantity, order_type, limit_price from paper_orders where account_id=$1 and status='OPEN' order by created_at asc for update`, [ACCOUNT_ID]);
    for (const order of openOrders.rows) {
      const live = await liveMarketPrice(client, order.symbol);
      if (!live) continue; // market not live for this instrument — keep it queued/resting
      if (order.order_type === "LIMIT") {
        const limit = Number(order.limit_price);
        const marketable = order.side === "BUY" ? live.close <= limit : live.close >= limit;
        if (!marketable) continue;
      }
      try {
        const result = await applyFill(client, { symbol: order.symbol, product: order.product, side: order.side, quantity: Number(order.quantity), fill: live.close, fillTimestamp: live.timestamp, note: order.order_type === "MARKET" ? "Market order filled on live tick" : "Limit order crossed on live tick", orderType: order.order_type });
        await client.query(`update paper_orders set status='FILLED', fill_price=$2, notional=$3, gross_amount=$3, net_amount=$4, costs=$5::jsonb, realized_pnl=$6, fill_timestamp=$7 where id=$1`, [order.id, live.close, result.gross, result.net, JSON.stringify(result.charges), result.realized, live.timestamp]);
        changed = true;
      } catch (error) {
        const code = (error as any)?.code;
        if (code === "INSUFFICIENT_PAPER_CASH" || code === "INSUFFICIENT_POSITION") {
          await client.query(`update paper_orders set status='REJECTED', note=$2 where id=$1`, [order.id, `Rejected on live tick: ${(error as Error).message}`]);
          changed = true;
        } else throw error;
      }
    }
    // MIS is intraday: a position opened on an earlier session is squared off — but only
    // against a LIVE 1-minute tick, never a stale daily close, consistent with every fill.
    const misPositions = await client.query(`select symbol, quantity, to_char(entered_on,'YYYY-MM-DD') as entered_on from paper_positions where account_id=$1 and product='MIS'`, [ACCOUNT_ID]);
    for (const position of misPositions.rows) {
      const live = await liveMarketPrice(client, position.symbol);
      if (!live) continue; // no live market → hold the position rather than fabricating an exit
      const enteredOn = String(position.entered_on);
      const sessionDate = live.timestamp.toISOString().slice(0, 10);
      if (enteredOn < sessionDate) {
        const result = await applyFill(client, { symbol: position.symbol, product: "MIS", side: "SELL", quantity: Number(position.quantity), fill: live.close, fillTimestamp: live.timestamp, note: "Auto square-off (MIS intraday) on live tick", orderType: "MARKET" });
        await client.query(`insert into paper_orders(account_id,symbol,product,side,order_type,quantity,fill_price,notional,gross_amount,net_amount,costs,realized_pnl,fill_timestamp,status,note,rationale,signal_snapshot) values($1,$2,'MIS','SELL','MARKET',$3,$4,$5,$5,$6,$7::jsonb,$8,$9,'FILLED',$10,$10,'{}'::jsonb)`, [ACCOUNT_ID, position.symbol, Number(position.quantity), live.close, result.gross, result.net, JSON.stringify(result.charges), result.realized, live.timestamp, "MIS auto squared off on live tick"]);
        changed = true;
      }
    }
    await client.query("commit");
    return changed;
  } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
}

// Canonical paper-desk snapshot (account + live-marked positions + orders). Read-only:
// advancing resting orders is the scheduler's job (see liveHub), never a side effect of a
// GET, so merely viewing the desk cannot execute trades.
export async function buildPaperState(pool: Pool): Promise<Record<string, unknown>> {
  const accountResult = await pool.query(`select id, starting_capital, cash, realized_pnl, total_costs, created_at, updated_at from paper_accounts where id=$1`, [ACCOUNT_ID]);
  if (!accountResult.rows.length) return { ok: true, mode: "PAPER_RESEARCH", account: null, positions: [], orders: [], marketLive: false, disclaimer: "Research simulation only. No broker or live order is connected." };
  const account = accountResult.rows[0];
  const positionsResult = await pool.query(`select symbol, product, quantity, average_price, cost_net, realized_pnl, current_price, mark_timestamp, entered_on from paper_positions where account_id=$1 order by product, symbol`, [ACCOUNT_ID]);
  const ordersResult = await pool.query(`select id, symbol, product, side, order_type, quantity, limit_price, fill_price, notional, gross_amount, net_amount, costs, realized_pnl, fill_timestamp, status, note, rationale, signal_snapshot, created_at from paper_orders where account_id=$1 order by created_at desc limit 200`, [ACCOUNT_ID]);
  let unrealizedPnl = 0;
  let marketLive = false;
  const positions = [];
  for (const row of positionsResult.rows) {
    const quote = await bestQuote(pool, row.symbol);
    const currentPrice = quote?.close ?? (row.current_price == null ? null : Number(row.current_price));
    if (quote && (Date.now() - quote.timestamp.getTime()) <= LIVE_WINDOW_SECONDS * 1000) marketLive = true;
    const quantity = Number(row.quantity);
    const costNet = Number(row.cost_net ?? 0);
    const positionUnrealized = currentPrice == null ? null : Math.round((currentPrice * quantity - costNet) * 100) / 100;
    if (positionUnrealized != null) unrealizedPnl += positionUnrealized;
    positions.push({ symbol: row.symbol, product: row.product, section: row.product === "CNC" ? "HOLDINGS" : "POSITIONS", quantity, averagePrice: Number(row.average_price), costNet, realizedPnl: Number(row.realized_pnl ?? 0), currentPrice, currentTimestamp: quote?.timestamp ?? row.mark_timestamp, unrealizedPnl: positionUnrealized });
  }
  // If there is no portfolio yet, decide "live" from any resting order's instrument feed.
  if (!positions.length) {
    const watched = ordersResult.rows.filter(row => row.status === "OPEN").map(row => row.symbol);
    for (const symbol of watched) { const live = await liveMarketPrice(pool, symbol); if (live) { marketLive = true; break; } }
  }
  const startingCapital = Number(account.starting_capital);
  const cash = Number(account.cash);
  const equity = Math.round((cash + positions.reduce((sum, position) => sum + (position.currentPrice == null ? position.costNet : position.currentPrice * position.quantity), 0)) * 100) / 100;
  return { ok: true, mode: "PAPER_RESEARCH", marketLive, account: { id: Number(account.id), startingCapital, cash, realizedPnl: Number(account.realized_pnl), totalCosts: Number(account.total_costs ?? 0), unrealizedPnl: Math.round(unrealizedPnl * 100) / 100, equity, returnPct: startingCapital ? (equity / startingCapital) - 1 : 0, openPositions: positions.length, updatedAt: account.updated_at }, positions, orders: ordersResult.rows.map(row => ({ id: row.id, symbol: row.symbol, product: row.product, side: row.side, orderType: row.order_type, quantity: Number(row.quantity), limitPrice: row.limit_price == null ? null : Number(row.limit_price), fillPrice: row.fill_price == null ? null : Number(row.fill_price), notional: Number(row.notional), grossAmount: Number(row.gross_amount), netAmount: Number(row.net_amount), costs: row.costs ?? {}, realizedPnl: Number(row.realized_pnl ?? 0), fillTimestamp: row.fill_timestamp, status: row.status, note: row.note, rationale: row.rationale, signalSnapshot: row.signal_snapshot ?? {}, createdAt: row.created_at })), marketStatus: "LIVE_1M_ONLY_FOR_FILLS", disclaimer: "Research simulation only. Orders fill exclusively against live 1-minute market data; an order placed while the market feed is closed stays queued and executes when the market reopens and its price trigger is met. No broker or live order is connected." };
}

export function createPaperRouter(pool: Pool | null): Router {
  const router = Router();

  router.get("/state", async (_req, res) => {
    if (!pool) return errorResponse(res, 503, "DATABASE_NOT_CONFIGURED");
    try {
      return res.json(await buildPaperState(pool));
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

  router.post("/deposit", async (req, res) => {
    if (!pool) return errorResponse(res, 503, "DATABASE_NOT_CONFIGURED");
    const amount = toMoney(req.body?.amount);
    if (amount == null || amount <= 0 || amount > 1_000_000_000) return errorResponse(res, 400, "INVALID_DEPOSIT", "Deposit must be a positive amount.");
    try {
      await ensurePaperSchema(pool);
      const result = await pool.query(`update paper_accounts set starting_capital=starting_capital+$2, cash=cash+$2, updated_at=now() where id=$1 returning starting_capital, cash`, [ACCOUNT_ID, amount]);
      if (!result.rows.length) return errorResponse(res, 409, "PAPER_ACCOUNT_NOT_INITIALIZED", "Create a virtual fund before adding money.");
      return res.json({ ok: true, mode: "PAPER_RESEARCH", deposited: amount, startingCapital: Number(result.rows[0].starting_capital), cash: Number(result.rows[0].cash) });
    } catch (error) {
      return errorResponse(res, 500, "PAPER_DEPOSIT_FAILED", error instanceof Error ? error.message : "deposit_failed");
    }
  });

  // Clear the research ledger. "trades" wipes orders + open positions and restores cash to
  // the starting fund; "all" also removes the account so a fresh fund can be opened.
  router.post("/reset", async (req, res) => {
    if (!pool) return errorResponse(res, 503, "DATABASE_NOT_CONFIGURED");
    const mode = String(req.body?.mode ?? "trades").trim().toLowerCase() === "all" ? "all" : "trades";
    try {
      await ensurePaperSchema(pool);
      const client = await pool.connect();
      try {
        await client.query("begin");
        if (mode === "all") {
          await client.query(`delete from paper_orders where account_id=$1`, [ACCOUNT_ID]);
          await client.query(`delete from paper_positions where account_id=$1`, [ACCOUNT_ID]);
          await client.query(`delete from paper_accounts where id=$1`, [ACCOUNT_ID]);
        } else {
          const account = await client.query(`select starting_capital from paper_accounts where id=$1 for update`, [ACCOUNT_ID]);
          if (!account.rows.length) { await client.query("rollback"); return errorResponse(res, 409, "PAPER_ACCOUNT_NOT_INITIALIZED"); }
          await client.query(`delete from paper_orders where account_id=$1`, [ACCOUNT_ID]);
          await client.query(`delete from paper_positions where account_id=$1`, [ACCOUNT_ID]);
          await client.query(`update paper_accounts set cash=starting_capital, realized_pnl=0, total_costs=0, updated_at=now() where id=$1`, [ACCOUNT_ID]);
        }
        await client.query("commit");
      } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
      return res.json({ ok: true, mode: "PAPER_RESEARCH", reset: mode });
    } catch (error) {
      return errorResponse(res, 500, "PAPER_RESET_FAILED", error instanceof Error ? error.message : "reset_failed");
    }
  });

  router.post("/estimate", async (req, res) => {
    const product = validProduct(req.body?.product);
    const side = String(req.body?.side ?? "").trim().toUpperCase();
    const quantity = toQuantity(req.body?.quantity);
    const price = toPrice(req.body?.price);
    if (side !== "BUY" && side !== "SELL") return errorResponse(res, 400, "INVALID_SIDE");
    if (quantity == null || price == null) return res.json({ ok: true, charges: computeCharges(side as "BUY" | "SELL", product, 0, 0), gross: 0, net: 0, margin: 0 });
    const charges = computeCharges(side as "BUY" | "SELL", product, quantity, price);
    const gross = Math.round(price * quantity * 100) / 100;
    const net = side === "BUY" ? Math.round((gross + charges.total) * 100) / 100 : Math.round((gross - charges.total) * 100) / 100;
    return res.json({ ok: true, charges, gross, net, margin: marginInfo(product, gross, charges.total) });
  });

  router.post("/orders", async (req, res) => {
    if (!pool) return errorResponse(res, 503, "DATABASE_NOT_CONFIGURED");
    const symbol = validSymbol(req.body?.symbol);
    const side = String(req.body?.side ?? "").trim().toUpperCase() as Side;
    const product = validProduct(req.body?.product);
    const orderType = validOrderType(req.body?.order_type ?? req.body?.orderType);
    const limitPrice = toPrice(req.body?.limitPrice ?? req.body?.limit_price);
    const quantity = toQuantity(req.body?.quantity);
    const note = String(req.body?.note ?? "").trim().slice(0, 500);
    if (!symbol) return errorResponse(res, 400, "INVALID_SYMBOL");
    if (!["BUY", "SELL", "HOLD"].includes(side)) return errorResponse(res, 400, "INVALID_SIDE");
    if (side !== "HOLD" && quantity == null) return errorResponse(res, 400, "INVALID_QUANTITY");
    if (orderType === "LIMIT" && side !== "HOLD" && limitPrice == null) return errorResponse(res, 400, "INVALID_LIMIT_PRICE", "A limit order requires a positive price.");
    try {
      await ensurePaperSchema(pool);
      const client = await pool.connect();
      try {
        await client.query("begin");
        const accountResult = await client.query(`select cash from paper_accounts where id=$1 for update`, [ACCOUNT_ID]);
        if (!accountResult.rows.length) { await client.query("rollback"); return errorResponse(res, 409, "PAPER_ACCOUNT_NOT_INITIALIZED", "Create a virtual fund before placing a paper order."); }
        const signalSnapshot = await latestSignal(client, symbol);

        if (side === "HOLD") {
          const order = await client.query(`insert into paper_orders(account_id,symbol,product,side,order_type,quantity,status,note,rationale,signal_snapshot) values($1,$2,$3,'HOLD','MARKET',0,'RECORDED',$4,$5,$6) returning id,created_at`, [ACCOUNT_ID, symbol, product, note, note || "Manual research action", JSON.stringify(signalSnapshot)]);
          await client.query("commit");
          return res.status(201).json({ ok: true, mode: "PAPER_RESEARCH", order: { id: order.rows[0].id, symbol, product, side, orderType: "MARKET", quantity: 0, status: "RECORDED" }, cash: Number(accountResult.rows[0].cash), message: "HOLD recorded; no position or cash changed." });
        }

        // A resting/queued LIMIT BUY has a known worst-case cost, so reject it up front
        // rather than letting it rest and fail only when the tick finally crosses.
        if (orderType === "LIMIT" && side === "BUY") {
          const limitGross = Math.round((limitPrice as number) * (quantity as number) * 100) / 100;
          const limitNet = Math.round((limitGross + computeCharges("BUY", product, quantity as number, limitPrice as number).total) * 100) / 100;
          if (limitNet > Number(accountResult.rows[0].cash)) { await client.query("rollback"); return errorResponse(res, 409, "INSUFFICIENT_PAPER_CASH", `This limit buy needs about \u20b9${limitNet.toFixed(2)} but only \u20b9${Number(accountResult.rows[0].cash).toFixed(2)} is available.`); }
        }

        const live = await liveMarketPrice(client, symbol);

        // No live 1-minute feed for this instrument → the market is not open. Never fill on a
        // stale close; queue the order (MARKET pending / LIMIT resting) for the matcher to
        // execute once live data resumes and the trigger is met.
        if (!live) {
          const order = await client.query(`insert into paper_orders(account_id,symbol,product,side,order_type,quantity,limit_price,status,note,rationale,signal_snapshot) values($1,$2,$3,$4,$5,$6,$7,'OPEN',$8,$9,$10) returning id,created_at`, [ACCOUNT_ID, symbol, product, side, orderType, quantity, orderType === "LIMIT" ? limitPrice : null, note, note || (orderType === "LIMIT" ? "Resting limit order" : "Queued market order"), JSON.stringify(signalSnapshot)]);
          await client.query("commit");
          return res.status(201).json({ ok: true, mode: "PAPER_RESEARCH", queued: true, order: { id: order.rows[0].id, symbol, product, side, orderType, quantity, limitPrice, status: "OPEN" }, cash: Number(accountResult.rows[0].cash), message: `Markets are closed for ${symbol} (no live tick). Your ${orderType === "LIMIT" ? `limit ${side} at ${limitPrice?.toFixed(2)}` : `${side} market`} order is queued and will execute when the market reopens and the trigger is met.` });
        }

        if (orderType === "LIMIT") {
          const marketable = side === "BUY" ? (limitPrice as number) >= live.close : (limitPrice as number) <= live.close;
          if (!marketable) {
            const order = await client.query(`insert into paper_orders(account_id,symbol,product,side,order_type,quantity,limit_price,status,note,rationale,signal_snapshot) values($1,$2,$3,$4,'LIMIT',$5,$6,'OPEN',$7,$8,$9) returning id,created_at`, [ACCOUNT_ID, symbol, product, side, quantity, limitPrice, note, note || "Resting limit order", JSON.stringify(signalSnapshot)]);
            await client.query("commit");
            return res.status(201).json({ ok: true, mode: "PAPER_RESEARCH", order: { id: order.rows[0].id, symbol, product, side, orderType: "LIMIT", quantity, limitPrice, status: "OPEN", marketPrice: live.close }, cash: Number(accountResult.rows[0].cash), message: `Limit ${side} resting at ${limitPrice?.toFixed(2)} (market ${live.close.toFixed(2)}); will fill when a live tick crosses it.` });
          }
        }

        const result = await applyFill(client, { symbol, product, side: side as "BUY" | "SELL", quantity: quantity as number, fill: live.close, fillTimestamp: live.timestamp, note, orderType });
        const order = await client.query(`insert into paper_orders(account_id,symbol,product,side,order_type,quantity,limit_price,fill_price,notional,gross_amount,net_amount,costs,realized_pnl,fill_timestamp,status,note,rationale,signal_snapshot) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11::jsonb,$12,$13,'FILLED',$14,$15,$16) returning id,created_at`, [ACCOUNT_ID, symbol, product, side, orderType, quantity, orderType === "LIMIT" ? limitPrice : null, live.close, result.gross, result.net, JSON.stringify(result.charges), result.realized, live.timestamp, note, note || (side === "BUY" ? "Paper buy" : "Paper sell"), JSON.stringify(signalSnapshot)]);
        await client.query("commit");
        return res.status(201).json({ ok: true, mode: "PAPER_RESEARCH", order: { id: order.rows[0].id, symbol, product, side, orderType, quantity, fillPrice: live.close, gross: result.gross, charges: result.charges, net: result.net, realizedPnl: result.realized, status: "FILLED", signalSnapshot }, cash: result.cash, quoteTimestamp: live.timestamp, message: `${side} ${product} ${orderType} filled at ${live.close.toFixed(2)} (live); charges ₹${result.charges.total.toFixed(2)}.` });
      } catch (error) { await client.query("rollback"); const code = (error as any)?.code; if (code === "INSUFFICIENT_PAPER_CASH" || code === "INSUFFICIENT_POSITION") return errorResponse(res, 409, code, (error as Error).message); throw error; } finally { client.release(); }
    } catch (error) {
      return errorResponse(res, 500, "PAPER_ORDER_FAILED", error instanceof Error ? error.message : "order_failed");
    }
  });

  router.post("/orders/:id/cancel", async (req, res) => {
    if (!pool) return errorResponse(res, 503, "DATABASE_NOT_CONFIGURED");
    try {
      await ensurePaperSchema(pool);
      const result = await pool.query(`update paper_orders set status='CANCELLED' where id=$1 and account_id=$2 and status='OPEN' returning id`, [req.params.id, ACCOUNT_ID]);
      if (!result.rows.length) return errorResponse(res, 409, "CANCEL_FAILED", "Only a resting (OPEN) order can be cancelled.");
      return res.json({ ok: true, id: result.rows[0].id, status: "CANCELLED" });
    } catch (error) { return errorResponse(res, 500, "PAPER_CANCEL_FAILED", error instanceof Error ? error.message : "cancel_failed"); }
  });

  router.get("/analytics", async (req, res) => {
    if (!pool) return errorResponse(res, 503, "DATABASE_NOT_CONFIGURED");
    const days = Math.max(1, Math.min(3650, Math.round(Number(req.query.days) || 90)));
    try {
      await ensurePaperSchema(pool);
      const since = new Date(Date.now() - days * 86_400_000);
      const [summary, bySymbol, byAction, byModelDirection] = await Promise.all([
        pool.query(`select count(*)::int as actions, count(*) filter (where side in ('BUY','SELL') and status='FILLED')::int as trades, count(*) filter (where realized_pnl>0)::int as winning_trades, coalesce(sum(realized_pnl),0) as realized_pnl, coalesce(sum(gross_amount),0) as notional, coalesce(sum((costs->>'total')::numeric),0) as costs from paper_orders where account_id=$1 and created_at >= $2`, [ACCOUNT_ID, since]),
        pool.query(`select symbol, count(*)::int as actions, count(*) filter (where side='BUY')::int as buys, count(*) filter (where side='SELL')::int as sells, coalesce(sum(realized_pnl),0) as realized_pnl, coalesce(sum(gross_amount),0) as notional from paper_orders where account_id=$1 and status='FILLED' and created_at >= $2 group by symbol order by realized_pnl desc, symbol`, [ACCOUNT_ID, since]),
        pool.query(`select side, count(*)::int as actions, coalesce(sum(realized_pnl),0) as realized_pnl, coalesce(avg(nullif(realized_pnl,0)),0) as average_closed_pnl from paper_orders where account_id=$1 and status='FILLED' and created_at >= $2 group by side order by side`, [ACCOUNT_ID, since]),
        pool.query(`select coalesce(signal_snapshot->>'direction','UNKNOWN') as direction, count(*)::int as actions, coalesce(sum(realized_pnl),0) as realized_pnl, count(*) filter (where realized_pnl>0)::int as winning_trades from paper_orders where account_id=$1 and status='FILLED' and created_at >= $2 group by 1 order by realized_pnl desc, direction`, [ACCOUNT_ID, since]),
      ]);
      const row = summary.rows[0];
      return res.json({ ok: true, periodDays: days, since, summary: { actions: Number(row.actions), trades: Number(row.trades), winningTrades: Number(row.winning_trades), winRate: Number(row.trades) ? Number(row.winning_trades) / Number(row.trades) : null, realizedPnl: Number(row.realized_pnl), notional: Number(row.notional), costs: Number(row.costs ?? 0) }, bySymbol: bySymbol.rows.map(item => ({ symbol: item.symbol, actions: Number(item.actions), buys: Number(item.buys), sells: Number(item.sells), realizedPnl: Number(item.realized_pnl), notional: Number(item.notional) })), byAction: byAction.rows.map(item => ({ side: item.side, actions: Number(item.actions), realizedPnl: Number(item.realized_pnl), averageClosedPnl: Number(item.average_closed_pnl) })), byModelDirection: byModelDirection.rows.map(item => ({ direction: item.direction, actions: Number(item.actions), realizedPnl: Number(item.realized_pnl), winningTrades: Number(item.winning_trades) })), disclaimer: "Attribution is descriptive, not proof of predictive skill. Realized P&L is net of modeled charges. HOLD actions and unclosed positions are not treated as wins or losses." });
    } catch (error) { return errorResponse(res, 500, "PAPER_ANALYTICS_FAILED", error instanceof Error ? error.message : "analytics_failed"); }
  });

  router.get("/export.csv", async (req, res) => {
    if (!pool) return errorResponse(res, 503, "DATABASE_NOT_CONFIGURED");
    const days = Math.max(1, Math.min(3650, Math.round(Number(req.query.days) || 3650)));
    const csvCell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    try {
      await ensurePaperSchema(pool);
      const since = new Date(Date.now() - days * 86_400_000);
      const result = await pool.query(`select id, created_at, symbol, product, side, order_type, quantity, fill_price, gross_amount, (costs->>'total') as costs, net_amount, realized_pnl, status from paper_orders where account_id=$1 and created_at >= $2 order by created_at asc`, [ACCOUNT_ID, since]);
      const headers = ["id", "created_at", "symbol", "product", "side", "order_type", "quantity", "fill_price", "gross_amount", "charges", "net_amount", "realized_pnl", "status"];
      const lines = [headers.join(","), ...result.rows.map(row => [row.id, row.created_at, row.symbol, row.product, row.side, row.order_type, row.quantity, row.fill_price, row.gross_amount, row.costs, row.net_amount, row.realized_pnl, row.status].map(csvCell).join(","))];
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="dpredict-paper-trades-${days}d.csv"`);
      return res.send(`${lines.join("\n")}\n`);
    } catch (error) { return errorResponse(res, 500, "PAPER_EXPORT_FAILED", error instanceof Error ? error.message : "export_failed"); }
  });

  return router;
}
