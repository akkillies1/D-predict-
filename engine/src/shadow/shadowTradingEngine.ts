import { pool } from "../db.js";

const STARTING_CAPITAL = Number(process.env.SHADOW_STARTING_CAPITAL ?? 100000);
const MAX_QUOTE_AGE_MS = Math.max(15_000, Number(process.env.SHADOW_MAX_QUOTE_AGE_SECONDS ?? 120) * 1000);
const LOTS = Math.max(1, Math.floor(Number(process.env.SHADOW_LOTS ?? 1)));
const NEW_DECISION_WINDOW_MS = Math.max(30_000, Number(process.env.SHADOW_DECISION_WINDOW_SECONDS ?? 180) * 1000);

type Quote = { timestamp: Date; ltp: number | null; bid: number | null; ask: number | null };

type Construction = {
  id: string;
  signalId: string;
  contractId: string;
  direction: "BULLISH" | "BEARISH";
  entryLow: number | null;
  entryHigh: number | null;
  stopLoss: number;
  target: number;
  expiryDate: string;
  strike: number;
  optionType: "CE" | "PE";
  symbol: string;
  lotSize: number;
  signalTimestamp: Date;
};

function buyFill(quote: Quote): number | null {
  return quote.ask ?? quote.ltp ?? (quote.bid !== null ? quote.bid : null);
}

function sellMark(quote: Quote): number | null {
  return quote.bid ?? quote.ltp ?? (quote.ask !== null ? quote.ask : null);
}

function quoteIsFresh(quote: Quote, now: Date): boolean {
  return now.getTime() - quote.timestamp.getTime() <= MAX_QUOTE_AGE_MS;
}

async function latestQuote(contractId: string): Promise<Quote | null> {
  const result = await pool.query(
    `select market_timestamp as timestamp, ltp, bid, ask
     from option_snapshots
     where contract_id = $1
     order by market_timestamp desc
     limit 1`,
    [contractId]
  );
  if (!result.rows.length) return null;
  const row = result.rows[0];
  return {
    timestamp: new Date(row.timestamp),
    ltp: row.ltp === null ? null : Number(row.ltp),
    bid: row.bid === null ? null : Number(row.bid),
    ask: row.ask === null ? null : Number(row.ask),
  };
}

async function loadNewConstructions(): Promise<Construction[]> {
  const since = new Date(Date.now() - NEW_DECISION_WINDOW_MS);
  const result = await pool.query(
    `select tc.id,
            tc.signal_decision_id as "signalId",
            tc.contract_id as "contractId",
            s.direction,
            tc.entry_low as "entryLow",
            tc.entry_high as "entryHigh",
            tc.stop_loss as "stopLoss",
            tc.target,
            oc.expiry_date as "expiryDate",
            oc.strike,
            oc.option_type as "optionType",
            i.symbol,
            i.lot_size as "lotSize",
            s.timestamp as "signalTimestamp"
     from trade_construction_decisions tc
     join signal_decisions s on s.id = tc.signal_decision_id
     join option_contracts oc on oc.contract_id = tc.contract_id
     join instruments i on i.instrument_id = oc.instrument_id
     where tc.contract_id is not null
       and tc.created_at >= $1
       and s.direction in ('BULLISH','BEARISH')
       and not exists (select 1 from shadow_trades st where st.trade_construction_id = tc.id)
     order by tc.created_at asc`,
    [since]
  );
  return result.rows.map((r) => ({
    id: r.id,
    signalId: r.signalId,
    contractId: r.contractId,
    direction: r.direction,
    entryLow: r.entryLow === null ? null : Number(r.entryLow),
    entryHigh: r.entryHigh === null ? null : Number(r.entryHigh),
    stopLoss: Number(r.stopLoss),
    target: Number(r.target),
    expiryDate: String(r.expiryDate),
    strike: Number(r.strike),
    optionType: r.optionType,
    symbol: r.symbol,
    lotSize: Number(r.lotSize),
    signalTimestamp: new Date(r.signalTimestamp),
  }));
}

async function openShadowTrade(trade: Construction, now: Date): Promise<void> {
  const quote = await latestQuote(trade.contractId);
  if (!quote || !quoteIsFresh(quote, now)) {
    console.log(`[shadow] ${trade.symbol} construction=${trade.id}: no fresh option quote; waiting`);
    return;
  }

  const entryPrice = buyFill(quote);
  if (entryPrice === null || entryPrice <= 0) {
    console.log(`[shadow] ${trade.symbol} construction=${trade.id}: invalid entry quote; waiting`);
    return;
  }

  const quantity = trade.lotSize * LOTS;
  await pool.query(
    `insert into shadow_trades (
       trade_construction_id, signal_decision_id, contract_id, status, direction,
       quantity, lot_size, entry_price, entry_bid, entry_ask, entry_ltp,
       entry_timestamp, entry_quote_timestamp, stop_loss, target, expiry_date,
       current_price, current_quote_timestamp, unrealized_pnl, entry_metadata
     ) values ($1,$2,$3,'OPEN',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$7,$12,0,$16::jsonb)
     on conflict (trade_construction_id) do nothing`,
    [
      trade.id,
      trade.signalId,
      trade.contractId,
      trade.direction,
      quantity,
      trade.lotSize,
      entryPrice,
      quote.bid,
      quote.ask,
      quote.ltp,
      now,
      quote.timestamp,
      trade.stopLoss,
      trade.target,
      trade.expiryDate,
      JSON.stringify({
        mode: "SHADOW",
        fillModel: "ASK_ON_ENTRY_BID_ON_EXIT",
        lots: LOTS,
        symbol: trade.symbol,
        strike: trade.strike,
        optionType: trade.optionType,
        signalTimestamp: trade.signalTimestamp.toISOString(),
        constructionEntryLow: trade.entryLow,
        constructionEntryHigh: trade.entryHigh,
      }),
    ]
  );

  console.log(`[shadow] OPEN ${trade.symbol} ${trade.optionType} ${trade.strike} qty=${quantity} entry=${entryPrice.toFixed(2)} SL=${trade.stopLoss.toFixed(2)} target=${trade.target.toFixed(2)}`);
}

async function updateOpenTrades(now: Date): Promise<void> {
  const result = await pool.query(
    `select st.id, st.contract_id as "contractId", st.quantity, st.entry_price as "entryPrice",
            st.stop_loss as "stopLoss", st.target, st.expiry_date as "expiryDate"
     from shadow_trades st
     where st.status = 'OPEN'
     order by st.entry_timestamp asc`
  );

  for (const row of result.rows) {
    const quote = await latestQuote(row.contractId);
    if (!quote || !quoteIsFresh(quote, now)) continue;
    const mark = sellMark(quote);
    if (mark === null || mark <= 0) continue;

    const quantity = Number(row.quantity);
    const entryPrice = Number(row.entryPrice);
    const stopLoss = Number(row.stopLoss);
    const target = Number(row.target);
    const pnl = (mark - entryPrice) * quantity;
    let exitReason: string | null = null;
    if (mark <= stopLoss) exitReason = "PRICE_STOP";
    else if (mark >= target) exitReason = "PROFIT_TARGET";
    else if (now.toISOString().slice(0, 10) >= String(row.expiryDate)) exitReason = "EXPIRY";

    if (exitReason) {
      await pool.query(
        `update shadow_trades
         set status='CLOSED', current_price=$2, current_quote_timestamp=$3,
             unrealized_pnl=0, realized_pnl=$4, exit_price=$2,
             exit_timestamp=$3, exit_reason=$5, exit_metadata=$6::jsonb, updated_at=now()
         where id=$1 and status='OPEN'`,
        [row.id, mark, quote.timestamp, pnl, exitReason, JSON.stringify({ fillModel: "BID_ON_EXIT" })]
      );
      console.log(`[shadow] CLOSE id=${row.id} reason=${exitReason} exit=${mark.toFixed(2)} pnl=${pnl.toFixed(2)}`);
    } else {
      await pool.query(
        `update shadow_trades
         set current_price=$2, current_quote_timestamp=$3, unrealized_pnl=$4, updated_at=now()
         where id=$1 and status='OPEN'`,
        [row.id, mark, quote.timestamp, pnl]
      );
    }
  }
}

async function snapshotEquity(now: Date): Promise<void> {
  const result = await pool.query(
    `select
       coalesce(sum(case when status='CLOSED' then realized_pnl else 0 end),0) as realized,
       coalesce(sum(case when status='OPEN' then unrealized_pnl else 0 end),0) as unrealized,
       count(*) filter (where status='OPEN')::int as open_trades,
       count(*) filter (where status='CLOSED')::int as closed_trades
     from shadow_trades`
  );
  const row = result.rows[0];
  const realized = Number(row.realized);
  const unrealized = Number(row.unrealized);
  const equity = STARTING_CAPITAL + realized + unrealized;
  const peakResult = await pool.query(`select coalesce(max(peak_equity), $1) as peak from shadow_equity_snapshots`, [STARTING_CAPITAL]);
  const peak = Math.max(STARTING_CAPITAL, Number(peakResult.rows[0].peak), equity);
  const drawdown = equity - peak;
  await pool.query(
    `insert into shadow_equity_snapshots
       (timestamp, starting_capital, realized_pnl, unrealized_pnl, equity, peak_equity, drawdown, open_trades, closed_trades)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (timestamp) do update set
       realized_pnl=excluded.realized_pnl, unrealized_pnl=excluded.unrealized_pnl,
       equity=excluded.equity, peak_equity=excluded.peak_equity, drawdown=excluded.drawdown,
       open_trades=excluded.open_trades, closed_trades=excluded.closed_trades`,
    [now, STARTING_CAPITAL, realized, unrealized, equity, peak, drawdown, Number(row.open_trades), Number(row.closed_trades)]
  );
}

export async function runShadowTradingEngine(): Promise<void> {
  const now = new Date();
  await updateOpenTrades(now);
  const newConstructions = await loadNewConstructions();
  for (const trade of newConstructions) await openShadowTrade(trade, now);
  await updateOpenTrades(now);
  await snapshotEquity(now);
}
