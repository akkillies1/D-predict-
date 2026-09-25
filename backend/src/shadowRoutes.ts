import { Router } from "express";
import type { Pool } from "pg";

const MAX_QUOTE_AGE_MS = Math.max(15_000, Number(process.env.SHADOW_MAX_QUOTE_AGE_SECONDS ?? 120) * 1000);
// Mirrors the engine fee model: flat per executed order plus ad-valorem on premium turnover.
const FEE_FIXED_PER_ORDER = Math.max(0, Number(process.env.SHADOW_FEE_FIXED_PER_ORDER ?? 20));
const FEE_BPS_PER_SIDE = Math.max(0, Number(process.env.SHADOW_FEE_BPS_PER_SIDE ?? 15));
function feesForSide(price: number, quantity: number): number { return Math.round((FEE_FIXED_PER_ORDER + (price * quantity * FEE_BPS_PER_SIDE) / 10_000) * 100) / 100; }
type Quote = { timestamp: Date; ltp: number | null; bid: number | null; ask: number | null };
function configuredShadowCapital(): number | null { const n = Number(process.env.SHADOW_STARTING_CAPITAL); return Number.isFinite(n) && n > 0 ? n : null; }
function istParts(now = new Date()) { const parts = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false }).formatToParts(now); const get = (type: string) => parts.find(p => p.type === type)?.value ?? ""; return { weekday: get("weekday"), hour: Number(get("hour")), minute: Number(get("minute")) }; }
function regularMarketOpenNow(now = new Date()): boolean { const p = istParts(now); const weekday = !["Sat", "Sun"].includes(p.weekday); const minutes = p.hour * 60 + p.minute; return weekday && minutes >= 9 * 60 + 15 && minutes < 15 * 60 + 30; }
function marketOpenNow(_now = new Date()): boolean { return true; }
function fresh(q: Quote, now = new Date()): boolean { const age = now.getTime() - q.timestamp.getTime(); return !regularMarketOpenNow(now) || (age >= 0 && age <= MAX_QUOTE_AGE_MS); }
function buyFill(q: Quote): number | null { return q.ask != null && Number.isFinite(q.ask) && q.ask > 0 ? q.ask : null; }
function sellFill(q: Quote): number | null { return q.bid != null && Number.isFinite(q.bid) && q.bid > 0 ? q.bid : null; }
async function latestQuote(pool: Pool, contractId: string): Promise<Quote | null> { const r = await pool.query(`select market_timestamp as timestamp,ltp,bid,ask from option_snapshots where contract_id=$1 order by market_timestamp desc limit 1`,[contractId]); if(!r.rows.length)return null; const x=r.rows[0]; return {timestamp:new Date(x.timestamp),ltp:x.ltp==null?null:Number(x.ltp),bid:x.bid==null?null:Number(x.bid),ask:x.ask==null?null:Number(x.ask)}; }
let paperSchemaPromise: Promise<void> | null = null;
function ensurePaperSchema(pool: Pool): Promise<void> {
  if (!paperSchemaPromise) paperSchemaPromise = pool.query(`create table if not exists option_paper_trades (id uuid primary key default gen_random_uuid(),contract_id uuid not null references option_contracts(contract_id),symbol text not null,expiry_date date not null,strike numeric(12,4) not null,option_type text not null check(option_type in ('CE','PE')),side text not null check(side in ('BUY','SELL')),status text not null default 'OPEN' check(status in ('OPEN','CLOSED')),lots integer not null check(lots>0),lot_size integer not null check(lot_size>0),quantity integer not null check(quantity>0),entry_price numeric(12,4) not null,entry_bid numeric(12,4),entry_ask numeric(12,4),entry_ltp numeric(12,4),entry_quote_timestamp timestamptz not null,entry_timestamp timestamptz not null default now(),current_price numeric(12,4),current_quote_timestamp timestamptz,unrealized_pnl numeric(14,2) not null default 0,realized_pnl numeric(14,2),exit_price numeric(12,4),exit_quote_timestamp timestamptz,exit_timestamp timestamptz,exit_reason text,entry_fees numeric(14,2) not null default 0,exit_fees numeric(14,2),created_at timestamptz not null default now(),updated_at timestamptz not null default now()); alter table option_paper_trades add column if not exists entry_fees numeric(14,2) not null default 0; alter table option_paper_trades add column if not exists exit_fees numeric(14,2); create index if not exists idx_option_paper_status on option_paper_trades(status,entry_timestamp desc); create index if not exists idx_option_paper_contract on option_paper_trades(contract_id,status);`).then(()=>undefined); return paperSchemaPromise;
}
function validateOrder(body: any): string | null { const symbol=String(body?.symbol??"").trim().toUpperCase(),type=String(body?.optionType??"").trim().toUpperCase(),side=String(body?.side??"").trim().toUpperCase(),strike=Number(body?.strike),lots=Number(body?.lots); if(!/^[A-Z0-9._-]{1,32}$/.test(symbol))return"INVALID_SYMBOL"; if(type!=="CE"&&type!=="PE")return"INVALID_OPTION_TYPE"; if(side!=="BUY"&&side!=="SELL")return"INVALID_SIDE"; if(!Number.isFinite(strike)||strike<=0)return"INVALID_STRIKE"; if(!Number.isInteger(lots)||lots<=0)return"INVALID_LOTS"; return null; }

function mapShadowBlotterRow(r: any) {
  const mapped = {
    id: r.id, source: "AUTO", symbol: r.symbol, contract: `${r.symbol} ${Number(r.strike)} ${r.option_type}`,
    expiryDate: r.expiry_date, strike: Number(r.strike), optionType: r.option_type,
    side: "BUY", direction: r.direction, status: r.status,
    quantity: Number(r.quantity), lotSize: Number(r.lot_size), lots: Number(r.lot_size) ? Number(r.quantity) / Number(r.lot_size) : null,
    entryPrice: Number(r.entry_price), currentPrice: r.current_price == null ? null : Number(r.current_price),
    unrealizedPnl: Number(r.unrealized_pnl ?? 0), realizedPnl: r.realized_pnl == null ? null : Number(r.realized_pnl),
    stopLoss: Number(r.stop_loss), target: Number(r.target),
    entryTimestamp: r.entry_timestamp, exitTimestamp: r.exit_timestamp,
    exitPrice: r.exit_price == null ? null : Number(r.exit_price), exitReason: r.exit_reason,
    signalDecisionId: r.signal_decision_id, tradeConstructionId: r.trade_construction_id,
  };
  return withFees(mapped, r);
}
function mapPaperBlotterRow(r: any) {
  const mapped = {
    id: r.id, source: "MANUAL", symbol: r.symbol, contract: `${r.symbol} ${Number(r.strike)} ${r.option_type}`,
    expiryDate: r.expiry_date, strike: Number(r.strike), optionType: r.option_type,
    side: r.side, direction: null, status: r.status,
    quantity: Number(r.quantity), lotSize: Number(r.lot_size), lots: Number(r.lots),
    entryPrice: Number(r.entry_price), currentPrice: r.current_price == null ? null : Number(r.current_price),
    unrealizedPnl: Number(r.unrealized_pnl ?? 0), realizedPnl: r.realized_pnl == null ? null : Number(r.realized_pnl),
    stopLoss: null, target: null,
    entryTimestamp: r.entry_timestamp, exitTimestamp: r.exit_timestamp,
    exitPrice: r.exit_price == null ? null : Number(r.exit_price), exitReason: r.exit_reason,
    signalDecisionId: null, tradeConstructionId: null,
  };
  return withFees(mapped, r);
}
function withFees<T extends { status: string; realizedPnl: number | null; unrealizedPnl: number }>(mapped: T, r: any) {
  const entryFees = Number(r.entry_fees ?? 0);
  const exitFees = mapped.status === "CLOSED" && r.exit_fees != null ? Number(r.exit_fees) : null;
  const gross = mapped.status === "CLOSED" ? (mapped.realizedPnl ?? 0) : mapped.unrealizedPnl;
  return { ...mapped, entryFees, exitFees, fees: entryFees + (exitFees ?? 0), netPnl: gross - entryFees - (exitFees ?? 0) };
}
function tradePnl(r: { realized_pnl: unknown; unrealized_pnl: unknown; entry_fees?: unknown; exit_fees?: unknown; status: string }): number {
  const gross = r.status === "CLOSED" ? Number(r.realized_pnl ?? 0) : Number(r.unrealized_pnl ?? 0);
  return gross - Number(r.entry_fees ?? 0) - (r.status === "CLOSED" ? Number(r.exit_fees ?? 0) : 0);
}

async function buildEquityCurve(pool: Pool, days: number) {
  const rows = await pool.query(
    `select timestamp,starting_capital,realized_pnl,unrealized_pnl,equity,peak_equity,drawdown,open_trades,closed_trades
     from shadow_equity_snapshots where timestamp >= now() - ($1 || ' days')::interval order by timestamp asc limit 5000`,
    [String(days)]
  );
  const points = rows.rows.map((r) => ({
    timestamp: r.timestamp, startingCapital: Number(r.starting_capital), realizedPnl: Number(r.realized_pnl),
    unrealizedPnl: Number(r.unrealized_pnl), equity: Number(r.equity), openTrades: Number(r.open_trades), closedTrades: Number(r.closed_trades),
  }));
  let peak = -Infinity, maxDrawdown = 0, maxDrawdownPct = 0;
  for (const p of points) {
    peak = Math.max(peak, p.equity);
    const dd = p.equity - peak;
    if (dd < maxDrawdown) {
      maxDrawdown = dd;
      maxDrawdownPct = peak > 0 ? dd / peak : 0;
    }
  }
  // Downsample to <=200 points for smooth chart rendering on long-running sims.
  const stride = Math.max(1, Math.ceil(points.length / 200));
  const sampled = points.filter((_, i) => i % stride === 0 || i === points.length - 1);
  return { points: sampled, maxDrawdown, maxDrawdownPct };
}

export function createShadowRouter(pool: Pool | null): Router {
  const router=Router();
  router.get("/portfolio",async(_req,res)=>{if(!pool)return res.status(503).json({ok:false,error:"DATABASE_NOT_CONFIGURED"});try{const trades=await pool.query(`select st.id,i.symbol,oc.expiry_date,oc.strike,oc.option_type,st.direction,st.status,st.quantity,st.lot_size,st.entry_price,st.entry_timestamp,st.entry_quote_timestamp,st.stop_loss,st.target,st.current_price,st.current_quote_timestamp,st.unrealized_pnl,st.realized_pnl,st.entry_fees,st.exit_fees,st.exit_price,st.exit_timestamp,st.exit_reason,st.signal_decision_id,st.trade_construction_id from shadow_trades st join option_contracts oc on oc.contract_id=st.contract_id join instruments i on i.instrument_id=oc.instrument_id order by st.entry_timestamp desc limit 200`);const equity=await pool.query(`select timestamp,starting_capital,realized_pnl,unrealized_pnl,equity,peak_equity,drawdown,open_trades,closed_trades from shadow_equity_snapshots order by timestamp desc limit 1`);const closed=trades.rows.filter(r=>r.status==="CLOSED"),wins=closed.filter(r=>(Number(r.realized_pnl??0)-Number(r.entry_fees??0)-Number(r.exit_fees??0))>0).length,latest=equity.rows[0]??null,capital=configuredShadowCapital();if(!latest&&capital===null)return res.status(503).json({ok:false,error:"SHADOW_CAPITAL_NOT_CONFIGURED"});const startingCapital=latest?Number(latest.starting_capital):capital as number;return res.json({ok:true,mode:"SHADOW",trades:trades.rows.map(r=>({id:r.id,symbol:r.symbol,expiryDate:r.expiry_date,strike:Number(r.strike),optionType:r.option_type,direction:r.direction,status:r.status,quantity:Number(r.quantity),lotSize:Number(r.lot_size),entryPrice:Number(r.entry_price),entryTimestamp:r.entry_timestamp,entryQuoteTimestamp:r.entry_quote_timestamp,stopLoss:Number(r.stop_loss),target:Number(r.target),currentPrice:r.current_price==null?null:Number(r.current_price),currentQuoteTimestamp:r.current_quote_timestamp,unrealizedPnl:Number(r.unrealized_pnl??0),realizedPnl:r.realized_pnl==null?null:Number(r.realized_pnl),entryFees:Number(r.entry_fees??0),exitFees:r.exit_fees==null?null:Number(r.exit_fees),exitPrice:r.exit_price==null?null:Number(r.exit_price),exitTimestamp:r.exit_timestamp,exitReason:r.exit_reason,signalDecisionId:r.signal_decision_id,tradeConstructionId:r.trade_construction_id})),summary:{startingCapital,realizedPnl:latest?Number(latest.realized_pnl):0,unrealizedPnl:latest?Number(latest.unrealized_pnl):0,equity:latest?Number(latest.equity):startingCapital,peakEquity:latest?Number(latest.peak_equity):startingCapital,drawdown:latest?Number(latest.drawdown):0,openTrades:latest?Number(latest.open_trades):0,closedTrades:latest?Number(latest.closed_trades):closed.length,winRate:closed.length?wins/closed.length:null,latestSnapshot:latest?.timestamp??null}});}catch(e){return res.status(500).json({ok:false,error:"SHADOW_PORTFOLIO_QUERY_FAILED",message:e instanceof Error?e.message:"query_failed"});}});
  router.get("/trades",async(req,res)=>{if(!pool)return res.status(503).json({ok:false,error:"DATABASE_NOT_CONFIGURED"});const limit=Math.min(500,Math.max(1,Number(req.query.limit??100)));try{const r=await pool.query(`select st.*,i.symbol,oc.expiry_date,oc.strike,oc.option_type from shadow_trades st join option_contracts oc on oc.contract_id=st.contract_id join instruments i on i.instrument_id=oc.instrument_id order by st.entry_timestamp desc limit $1`,[limit]);return res.json({ok:true,mode:"SHADOW",trades:r.rows});}catch(e){return res.status(500).json({ok:false,error:"SHADOW_TRADES_QUERY_FAILED",message:e instanceof Error?e.message:"query_failed"});}});
  router.post("/paper-orders",async(req,res)=>{if(!pool)return res.status(503).json({ok:false,error:"DATABASE_NOT_CONFIGURED"});const bad=validateOrder(req.body);if(bad)return res.status(400).json({ok:false,error:bad});const symbol=String(req.body.symbol).trim().toUpperCase(),expiry=String(req.body.expiry??"").trim(),optionType=String(req.body.optionType).trim().toUpperCase(),side=String(req.body.side).trim().toUpperCase(),strike=Number(req.body.strike),lots=Number(req.body.lots);if(!/^\d{4}-\d{2}-\d{2}$/.test(expiry))return res.status(400).json({ok:false,error:"INVALID_EXPIRY"});if(!marketOpenNow())return res.status(409).json({ok:false,error:"MARKET_CLOSED",message:"Market is closed. The latest session data remains available for display; new paper orders require the live session."});try{await ensurePaperSchema(pool);const cr=await pool.query(`select oc.contract_id as "contractId",oc.expiry_date as "expiryDate",oc.strike,oc.option_type as "optionType",i.symbol,i.lot_size as "lotSize" from option_contracts oc join instruments i on i.instrument_id=oc.instrument_id where i.symbol=$1 and oc.expiry_date=$2::date and oc.strike=$3 and oc.option_type=$4 limit 1`,[symbol,expiry,strike,optionType]);if(!cr.rows.length)return res.status(404).json({ok:false,error:"OPTION_CONTRACT_NOT_FOUND"});const c=cr.rows[0],now=new Date();if(new Date(c.expiryDate).getTime()<Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()))return res.status(409).json({ok:false,error:"OPTION_CONTRACT_EXPIRED"});const q=await latestQuote(pool,c.contractId);if(!q||!fresh(q,now))return res.status(409).json({ok:false,error:"OPTION_QUOTE_STALE",quoteTimestamp:q?.timestamp??null,maxAgeSeconds:MAX_QUOTE_AGE_MS/1000});const fill=side==="BUY"?buyFill(q):sellFill(q);if(fill==null)return res.status(409).json({ok:false,error:side==="BUY"?"OPTION_ASK_UNAVAILABLE":"OPTION_BID_UNAVAILABLE",quoteTimestamp:q.timestamp});const lotSize=Number(c.lotSize),quantity=lotSize*lots,entryFees=feesForSide(fill,quantity),ins=await pool.query(`insert into option_paper_trades (contract_id,symbol,expiry_date,strike,option_type,side,status,lots,lot_size,quantity,entry_price,entry_bid,entry_ask,entry_ltp,entry_quote_timestamp,current_price,current_quote_timestamp,unrealized_pnl,entry_fees) values ($1,$2,$3,$4,$5,$6,'OPEN',$7,$8,$9,$10,$11,$12,$13,$14,$10,$14,0,$15) returning id,entry_timestamp`,[c.contractId,symbol,c.expiryDate,Number(c.strike),optionType,side,lots,lotSize,quantity,fill,q.bid,q.ask,q.ltp,q.timestamp,entryFees]);return res.status(201).json({ok:true,mode:"PAPER",order:{id:ins.rows[0].id,symbol,expiryDate:c.expiryDate,strike:Number(c.strike),optionType,side,lots,lotSize,quantity,entryPrice:fill,entryFees,quoteTimestamp:q.timestamp,bid:q.bid,ask:q.ask,ltp:q.ltp,entryTimestamp:ins.rows[0].entry_timestamp}});}catch(e){return res.status(500).json({ok:false,error:"OPTION_PAPER_ORDER_FAILED",message:e instanceof Error?e.message:"order_failed"});}});
  router.get("/paper-trades",async(_req,res)=>{if(!pool)return res.status(503).json({ok:false,error:"DATABASE_NOT_CONFIGURED"});try{await ensurePaperSchema(pool);const r=await pool.query(`select pt.*,oc.contract_id,i.symbol from option_paper_trades pt join option_contracts oc on oc.contract_id=pt.contract_id join instruments i on i.instrument_id=oc.instrument_id order by pt.entry_timestamp desc limit 500`);const now=new Date(),isOpen=marketOpenNow(),trades=[];for(const row of r.rows){let current=row.current_price==null?null:Number(row.current_price),currentTs=row.current_quote_timestamp,unrealized=Number(row.unrealized_pnl??0);if(row.status==='OPEN'){const q=await latestQuote(pool,row.contract_id);const usable=q&&(isOpen?fresh(q,now):true);if(usable){current=row.side==='BUY'?sellFill(q):buyFill(q);currentTs=q.timestamp;if(current!=null)unrealized=row.side==='BUY'?(current-Number(row.entry_price))*Number(row.quantity):(Number(row.entry_price)-current)*Number(row.quantity);}}trades.push({...row,current_price:current,current_quote_timestamp:currentTs,unrealized_pnl:unrealized});}return res.json({ok:true,mode:"PAPER",marketStatus:isOpen?"OPEN":"CLOSED",trades});}catch(e){console.error("paper trades query failed",e);return res.status(500).json({ok:false,error:"OPTION_PAPER_TRADES_QUERY_FAILED",message:e instanceof Error?e.message:"query_failed"});}});
  router.post("/paper-trades/:id/close",async(req,res)=>{if(!pool)return res.status(503).json({ok:false,error:"DATABASE_NOT_CONFIGURED"});try{await ensurePaperSchema(pool);if(!marketOpenNow())return res.status(409).json({ok:false,error:"MARKET_CLOSED",message:"Market is closed. The latest session data is available, but positions can only be closed during the live session."});const tr=await pool.query(`select * from option_paper_trades where id=$1 and status='OPEN'`,[req.params.id]);if(!tr.rows.length)return res.status(404).json({ok:false,error:"OPEN_PAPER_TRADE_NOT_FOUND"});const t=tr.rows[0],now=new Date(),q=await latestQuote(pool,t.contract_id);if(!q||!fresh(q,now))return res.status(409).json({ok:false,error:"OPTION_QUOTE_STALE",quoteTimestamp:q?.timestamp??null,maxAgeSeconds:MAX_QUOTE_AGE_MS/1000});const exit=t.side==='BUY'?sellFill(q):buyFill(q);if(exit==null)return res.status(409).json({ok:false,error:t.side==='BUY'?"OPTION_BID_UNAVAILABLE":"OPTION_ASK_UNAVAILABLE",quoteTimestamp:q.timestamp});const qty=Number(t.quantity),entry=Number(t.entry_price),pnl=t.side==='BUY'?(exit-entry)*qty:(entry-exit)*qty,exitFees=feesForSide(exit,qty);await pool.query(`update option_paper_trades set status='CLOSED',current_price=$2,current_quote_timestamp=$3,unrealized_pnl=0,realized_pnl=$4,exit_price=$2,exit_quote_timestamp=$3,exit_timestamp=now(),exit_reason='MANUAL',exit_fees=$5,updated_at=now() where id=$1 and status='OPEN'`,[t.id,exit,q.timestamp,pnl,exitFees]);return res.json({ok:true,mode:"PAPER",tradeId:t.id,exitPrice:exit,realizedPnl:pnl,exitFees,netPnl:pnl-Number(t.entry_fees??0)-exitFees,quoteTimestamp:q.timestamp});}catch(e){return res.status(500).json({ok:false,error:"OPTION_PAPER_CLOSE_FAILED",message:e instanceof Error?e.message:"close_failed"});}});
  router.post("/trades/:id/close", async (req, res) => { if (!pool) return res.status(503).json({ ok: false, error: "DATABASE_NOT_CONFIGURED" }); try { const result = await pool.query(`select st.*, oc.contract_id, oc.option_type from shadow_trades st join option_contracts oc on oc.contract_id=st.contract_id where st.id=$1 and st.status='OPEN'`, [req.params.id]); if (!result.rows.length) return res.status(404).json({ ok: false, error: "OPEN_SHADOW_TRADE_NOT_FOUND" }); const trade = result.rows[0]; const quote = await latestQuote(pool, trade.contract_id); if (!quote || !fresh(quote)) return res.status(409).json({ ok: false, error: "OPTION_QUOTE_STALE", quoteTimestamp: quote?.timestamp ?? null, maxAgeSeconds: MAX_QUOTE_AGE_MS / 1000 }); const exitPrice = sellFill(quote); if (exitPrice == null) return res.status(409).json({ ok: false, error: "OPTION_BID_UNAVAILABLE", quoteTimestamp: quote.timestamp }); const entryPrice = Number(trade.entry_price); const quantity = Number(trade.quantity); const realizedPnl = (exitPrice - entryPrice) * quantity; const exitFees = feesForSide(exitPrice, quantity); await pool.query(`update shadow_trades set status='CLOSED', current_price=$2, current_quote_timestamp=$3, unrealized_pnl=0, realized_pnl=$4, exit_price=$2, exit_timestamp=now(), exit_reason='MANUAL', exit_fees=$5, exit_metadata=jsonb_build_object('source','dashboard','action','SELL'), updated_at=now() where id=$1 and status='OPEN'`, [trade.id, exitPrice, quote.timestamp, realizedPnl, exitFees]); return res.json({ ok: true, tradeId: trade.id, exitPrice, realizedPnl, exitFees, netPnl: realizedPnl - Number(trade.entry_fees ?? 0) - exitFees, exitReason: "MANUAL" }); } catch (error) { return res.status(500).json({ ok: false, error: "SHADOW_CLOSE_FAILED", message: error instanceof Error ? error.message : "close_failed" }); } });
  router.get("/equity-curve", async (req, res) => {
    if (!pool) return res.status(503).json({ ok: false, error: "DATABASE_NOT_CONFIGURED" });
    const days = Math.min(365, Math.max(1, Number(req.query.days ?? 30)));
    try { return res.json({ ok: true, mode: "SHADOW", days, ...(await buildEquityCurve(pool, days)) }); }
    catch (e) { return res.status(500).json({ ok: false, error: "SHADOW_EQUITY_CURVE_FAILED", message: e instanceof Error ? e.message : "query_failed" }); }
  });

  router.get("/blotter", async (req, res) => {
    if (!pool) return res.status(503).json({ ok: false, error: "DATABASE_NOT_CONFIGURED" });
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit ?? 500)));
    try {
      await ensurePaperSchema(pool);
      const [shadow, paper] = await Promise.all([
        pool.query(`select st.id, st.status, st.direction, st.quantity, st.lot_size, st.entry_price, st.stop_loss, st.target, st.current_price, st.unrealized_pnl, st.realized_pnl, st.entry_fees, st.exit_fees, st.exit_price, st.exit_timestamp, st.exit_reason, st.entry_timestamp, st.signal_decision_id, st.trade_construction_id, oc.expiry_date, oc.strike, oc.option_type, i.symbol
          from shadow_trades st join option_contracts oc on oc.contract_id = st.contract_id join instruments i on i.instrument_id = oc.instrument_id
          order by st.entry_timestamp desc limit $1`, [limit]),
        pool.query(`select pt.*, oc.contract_id, i.symbol
          from option_paper_trades pt join option_contracts oc on oc.contract_id = pt.contract_id join instruments i on i.instrument_id = oc.instrument_id
          order by pt.entry_timestamp desc limit $1`, [limit]),
      ]);
      const trades = [...shadow.rows.map(mapShadowBlotterRow), ...paper.rows.map(mapPaperBlotterRow)].sort((a, b) => new Date(b.entryTimestamp).getTime() - new Date(a.entryTimestamp).getTime());
      return res.json({ ok: true, mode: "SHADOW", trades });
    } catch (e) { return res.status(500).json({ ok: false, error: "SHADOW_BLOTTER_QUERY_FAILED", message: e instanceof Error ? e.message : "query_failed" }); }
  });

  router.get("/stats", async (req, res) => {
    if (!pool) return res.status(503).json({ ok: false, error: "DATABASE_NOT_CONFIGURED" });
    const days = Math.min(365, Math.max(1, Number(req.query.days ?? 90)));
    try {
      await ensurePaperSchema(pool);
      const since = new Date(Date.now() - days * 86_400_000);
      const [closedShadow, closedPaper, openShadow, openPaper] = await Promise.all([
        pool.query(`select st.status, st.realized_pnl, st.unrealized_pnl, st.entry_fees, st.exit_fees, st.exit_reason, i.symbol, st.entry_timestamp, st.exit_timestamp from shadow_trades st join option_contracts oc on oc.contract_id = st.contract_id join instruments i on i.instrument_id = oc.instrument_id where st.status = 'CLOSED' and st.exit_timestamp >= $1`, [since]),
        pool.query(`select pt.status, pt.realized_pnl, pt.unrealized_pnl, pt.entry_fees, pt.exit_fees, pt.exit_reason, pt.symbol, pt.entry_timestamp, pt.exit_timestamp from option_paper_trades pt where pt.status = 'CLOSED' and pt.exit_timestamp >= $1`, [since]),
        pool.query(`select st.status, st.unrealized_pnl, st.entry_fees, i.symbol from shadow_trades st join option_contracts oc on oc.contract_id = st.contract_id join instruments i on i.instrument_id = oc.instrument_id where st.status = 'OPEN'`),
        pool.query(`select pt.status, pt.unrealized_pnl, pt.entry_fees, pt.symbol from option_paper_trades pt where pt.status = 'OPEN'`),
      ]);
      const closed = [...closedShadow.rows, ...closedPaper.rows];
      const wins = closed.filter((r) => tradePnl(r) > 0), losses = closed.filter((r) => tradePnl(r) <= 0);
      const grossProfit = wins.reduce((s, r) => s + tradePnl(r), 0), grossLoss = Math.abs(losses.reduce((s, r) => s + tradePnl(r), 0));
      const total = closed.reduce((s, r) => s + tradePnl(r), 0);
      const holdingHours = closed.filter((r) => r.entry_timestamp && r.exit_timestamp).map((r) => (new Date(r.exit_timestamp).getTime() - new Date(r.entry_timestamp).getTime()) / 3_600_000);
      const byReason = new Map<string, { trades: number; pnl: number }>();
      for (const r of closed) { const k = r.exit_reason ?? "UNKNOWN"; const cur = byReason.get(k) ?? { trades: 0, pnl: 0 }; cur.trades += 1; cur.pnl += tradePnl(r); byReason.set(k, cur); }
      const bySymbol = new Map<string, { trades: number; pnl: number }>();
      for (const r of closed) { const cur = bySymbol.get(r.symbol) ?? { trades: 0, pnl: 0 }; cur.trades += 1; cur.pnl += tradePnl(r); bySymbol.set(r.symbol, cur); }
      const openRows = [...openShadow.rows, ...openPaper.rows];
      const curve = await buildEquityCurve(pool, days);
      return res.json({
        ok: true, mode: "SHADOW", days,
        closed: {
          trades: closed.length, wins: wins.length, losses: losses.length,
          winRate: closed.length ? wins.length / closed.length : null,
          totalPnl: total, grossProfit, grossLoss,
          profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
          expectancy: closed.length ? total / closed.length : null,
          avgWin: wins.length ? grossProfit / wins.length : null,
          avgLoss: losses.length ? -grossLoss / losses.length : null,
          largestWin: closed.length ? Math.max(...closed.map(tradePnl)) : null,
          largestLoss: closed.length ? Math.min(...closed.map(tradePnl)) : null,
          avgHoldHours: holdingHours.length ? holdingHours.reduce((s, h) => s + h, 0) / holdingHours.length : null,
        },
        open: {
          positions: openRows.length,
          unrealizedPnl: openRows.reduce((s, r) => s + tradePnl(r), 0),
        },
        fees: {
          closed: closed.reduce((s, r) => s + Number(r.entry_fees ?? 0) + Number(r.exit_fees ?? 0), 0),
          open: openRows.reduce((s, r) => s + Number(r.entry_fees ?? 0), 0),
        },
        exitReasons: [...byReason.entries()].map(([reason, v]) => ({ reason, ...v })).sort((a, b) => b.pnl - a.pnl),
        symbols: [...bySymbol.entries()].map(([symbol, v]) => ({ symbol, ...v })).sort((a, b) => b.pnl - a.pnl),
        equity: {
          latest: curve.points.length ? curve.points[curve.points.length - 1].equity : null,
          startingCapital: curve.points.length ? curve.points[curve.points.length - 1].startingCapital : configuredShadowCapital(),
          maxDrawdown: curve.maxDrawdown, maxDrawdownPct: curve.maxDrawdownPct,
        },
      });
    } catch (e) { return res.status(500).json({ ok: false, error: "SHADOW_STATS_QUERY_FAILED", message: e instanceof Error ? e.message : "query_failed" }); }
  });

  router.get("/trades/:id", async (req, res) => {
    if (!pool) return res.status(503).json({ ok: false, error: "DATABASE_NOT_CONFIGURED" });
    const source = String(req.query.source ?? "AUTO").toUpperCase();
    const tradeId = req.params.id;
    if (!/^[0-9a-fA-F-]{36}$/.test(tradeId)) return res.status(400).json({ ok: false, error: "INVALID_TRADE_ID" });
    try {
      await ensurePaperSchema(pool);
      if (source === "MANUAL") {
        const r = await pool.query(`select * from option_paper_trades where id = $1`, [tradeId]);
        if (!r.rows.length) return res.status(404).json({ ok: false, error: "PAPER_TRADE_NOT_FOUND" });
        return res.json({ ok: true, mode: "SHADOW", source, trade: mapPaperBlotterRow(r.rows[0]), quotes: [] });
      }
      const t = await pool.query(`select st.*, oc.expiry_date, oc.strike, oc.option_type, i.symbol, i.instrument_id as "instrumentId"
        from shadow_trades st join option_contracts oc on oc.contract_id = st.contract_id join instruments i on i.instrument_id = oc.instrument_id
        where st.id = $1`, [tradeId]);
      if (!t.rows.length) return res.status(404).json({ ok: false, error: "SHADOW_TRADE_NOT_FOUND" });
      const row = t.rows[0];
      const [sigRow, construction, prediction, quotes] = await Promise.all([
        row.signal_decision_id ? pool.query(`select id, timestamp, strategy_version, model_version, direction, confidence, regime, reason_codes, parameters, input_snapshot_id from signal_decisions where id = $1`, [row.signal_decision_id]).then((q) => q.rows[0] ?? null) : Promise.resolve(null),
        row.trade_construction_id ? pool.query(`select id, timestamp, strategy_version, entry_low, entry_high, stop_loss, target, expected_move, required_expiry_days, reason_codes, parameters from trade_construction_decisions where id = $1`, [row.trade_construction_id]).then((q) => q.rows[0] ?? null) : Promise.resolve(null),
        // The ML prediction that led to this trade: the latest ledger row for the
        // symbol at or before the signal timestamp (resolved after the queries run).
        Promise.resolve(null),
        pool.query(`select market_timestamp as timestamp, ltp, bid, ask from option_snapshots where contract_id = $1::uuid and market_timestamp between $2::timestamptz - interval '2 hours' and coalesce($3::timestamptz, now()) order by market_timestamp asc limit 800`, [row.contract_id, row.entry_timestamp, row.exit_timestamp]).then((q) => q.rows.map((x) => ({ timestamp: x.timestamp, ltp: x.ltp == null ? null : Number(x.ltp), bid: x.bid == null ? null : Number(x.bid), ask: x.ask == null ? null : Number(x.ask) }))),
      ]);
      const signalAt = sigRow?.timestamp ?? row.entry_timestamp;
      const predictionRow = prediction ?? (await (pool.query(`select id, timestamp, horizon, model_version, market_probability, expected_return, confidence, regime, evidence, input_snapshot from prediction_ledger where symbol = $1 and timestamp <= $2 order by timestamp desc limit 1`, [row.symbol, signalAt]))).rows[0] ?? null;
      return res.json({
        ok: true, mode: "SHADOW", source,
        trade: { ...mapShadowBlotterRow(row), entryBid: row.entry_bid == null ? null : Number(row.entry_bid), entryAsk: row.entry_ask == null ? null : Number(row.entry_ask), entryLtp: row.entry_ltp == null ? null : Number(row.entry_ltp), entryMetadata: row.entry_metadata, exitMetadata: row.exit_metadata },
        lineage: {
          signal: sigRow ? { ...sigRow, confidence: sigRow.confidence == null ? null : Number(sigRow.confidence), parameters: sigRow.parameters } : null,
          construction, prediction: predictionRow,
        },
        quotes,
      });
    } catch (e) { return res.status(500).json({ ok: false, error: "SHADOW_TRADE_DETAIL_FAILED", message: e instanceof Error ? e.message : "query_failed" }); }
  });

  return router;
}
