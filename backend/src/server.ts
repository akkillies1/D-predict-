import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pg from "pg";
import { buildCausalTradeThesis } from "./tradeThesis.js";
import { createShadowRouter } from "./shadowRoutes.js";

dotenv.config();
const { Pool } = pg;
const app = express();
const port = Number(process.env.API_PORT ?? 4100);
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: 5, ssl: process.env.DATABASE_SSL === "false" ? false : undefined }) : null;
app.use(cors());
app.use(express.json({ limit: "2mb" }));

function iso(value: unknown): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function finite(value: unknown): number | null { const n = Number(value); return value == null || !Number.isFinite(n) ? null : n; }
function symbolParam(value: unknown): string { return String(value ?? "NIFTY").trim().toUpperCase(); }
function invalidSymbol(symbol: string): boolean { return !/^[A-Z0-9._-]{1,32}$/.test(symbol); }
function noDb(res: express.Response) { return res.status(503).json({ ok: false, error: "DATABASE_NOT_CONFIGURED" }); }
function unavailable(res: express.Response, error: string, extra: Record<string, unknown> = {}) { return res.status(404).json({ ok: false, error, ...extra }); }

app.get("/health", async (_req, res) => {
  const result: Record<string, unknown> = { ok: true, service: "market-api", database: pool ? "configured" : "not_configured", marketData: "unavailable", timestamp: new Date().toISOString() };
  if (!pool) return res.status(503).json({ ...result, ok: false });
  try {
    await pool.query("select 1");
    const count = await pool.query("select count(*)::int as count from price_bars");
    result.database = "healthy";
    result.marketData = count.rows[0].count > 0 ? "available" : "unavailable";
    return res.json(result);
  } catch (error) {
    return res.status(503).json({ ...result, ok: false, database: "unhealthy", message: error instanceof Error ? error.message : "database_unavailable" });
  }
});

app.get("/api/instruments", async (_req, res) => {
  if (!pool) return noDb(res);
  try {
    const result = await pool.query(`select symbol, exchange, lot_size, is_active, name, canonical_source as source from instruments order by is_active desc, symbol`);
    return res.json({ ok: true, instruments: result.rows.map((row) => ({ symbol: row.symbol, exchange: row.exchange, lotSize: row.lot_size, isActive: row.is_active, name: row.name, source: row.source })) });
  } catch (error) { return res.status(500).json({ ok: false, error: "INSTRUMENT_QUERY_FAILED", message: error instanceof Error ? error.message : "query_failed" }); }
});

app.get("/api/instruments/discover", async (req, res) => {
  if (!pool) return noDb(res);
  const query = String(req.query.q ?? "").trim();
  if (query.length < 1) return res.json({ ok: true, instruments: [] });
  try {
    const result = await pool.query(`select symbol, exchange, lot_size, is_active, name, canonical_source as source from instruments where upper(symbol) like $1 or upper(coalesce(name,'')) like $1 or exists (select 1 from unnest(aliases) alias where upper(alias) like $1) order by case when upper(symbol) = upper($2) then 0 when upper(symbol) like upper($2) || '%' then 1 else 2 end, symbol limit 25`, [`%${query.toUpperCase()}%`, query]);
    return res.json({ ok: true, instruments: result.rows.map((row) => ({ symbol: row.symbol, exchange: row.exchange, lotSize: row.lot_size, isActive: row.is_active, name: row.name, source: row.source })) });
  } catch (error) { return res.status(500).json({ ok: false, error: "INSTRUMENT_DISCOVERY_FAILED", message: error instanceof Error ? error.message : "query_failed" }); }
});

app.post("/api/instruments", async (req, res) => {
  if (!pool) return noDb(res);
  const symbol = symbolParam(req.body?.symbol);
  const exchange = String(req.body?.exchange ?? (symbol.endsWith(".BO") ? "BSE" : "NSE")).toUpperCase();
  const name = req.body?.name == null ? null : String(req.body.name).trim() || null;
  const lotSize = Math.max(1, Math.floor(Number(req.body?.lotSize ?? 1)));
  if (invalidSymbol(symbol) || !Number.isFinite(lotSize)) return res.status(400).json({ ok: false, error: "INVALID_INSTRUMENT" });
  try {
    const result = await pool.query(`insert into instruments (symbol, exchange, lot_size, name, provider_symbol, canonical_source) values ($1,$2,$3,$4,$1,'user') on conflict (symbol) do update set name=coalesce(excluded.name,instruments.name), exchange=excluded.exchange, lot_size=excluded.lot_size returning symbol, exchange, lot_size, is_active, name, canonical_source as source`, [symbol, exchange, lotSize, name]);
    const row = result.rows[0];
    return res.status(201).json({ ok: true, instrument: { symbol: row.symbol, exchange: row.exchange, lotSize: row.lot_size, isActive: row.is_active, name: row.name, source: row.source } });
  } catch (error) { return res.status(500).json({ ok: false, error: "INSTRUMENT_CREATE_FAILED", message: error instanceof Error ? error.message : "query_failed" }); }
});

async function latestQuote(symbol: string) {
  if (!pool) return null;
  const result = await pool.query(`with ranked as (select pb.*, lag(pb.close) over (partition by pb.instrument_id order by pb.market_timestamp) as previous_close from price_bars pb join instruments i on i.instrument_id=pb.instrument_id where i.symbol=$1 order by pb.market_timestamp desc limit 2) select * from ranked order by market_timestamp desc limit 1`, [symbol]);
  if (!result.rows.length) return null;
  const row = result.rows[0];
  return { symbol, timestamp: iso(row.market_timestamp), collectedAt: iso(row.collected_at), open: finite(row.open), high: finite(row.high), low: finite(row.low), close: finite(row.close), volume: finite(row.volume), previousClose: finite(row.previous_close), source: row.source };
}

async function marketResponse(symbol: string, res: express.Response) {
  if (!pool) return noDb(res);
  if (invalidSymbol(symbol)) return res.status(400).json({ ok: false, error: "INVALID_SYMBOL" });
  try {
    const quote = await latestQuote(symbol);
    if (!quote || quote.close == null) return unavailable(res, "NO_MARKET_DATA", { symbol });
    const age = Date.now() - Date.parse(quote.timestamp ?? "");
    const status = age <= 60000 ? "LIVE" : age <= 300000 ? "CACHED" : "STALE";
    const change = quote.previousClose == null ? null : quote.close - quote.previousClose;
    return res.json({ ok: true, ...quote, change, changePercent: change != null && quote.previousClose ? (change / quote.previousClose) * 100 : null, status });
  } catch (error) { return res.status(500).json({ ok: false, error: "MARKET_QUERY_FAILED", message: error instanceof Error ? error.message : "query_failed" }); }
}
app.get("/api/market/:symbol/live", (req, res) => marketResponse(symbolParam(req.params.symbol), res));
app.get("/api/market/:symbol/overview", (req, res) => marketResponse(symbolParam(req.params.symbol), res));
app.get("/api/market/:symbol/history", async (req, res) => {
  if (!pool) return noDb(res);
  const symbol = symbolParam(req.params.symbol); const limit = Math.min(1000, Math.max(1, Number(req.query.limit ?? 120)));
  try {
    const result = await pool.query(`select pb.market_timestamp, pb.open, pb.high, pb.low, pb.close, pb.volume from price_bars pb join instruments i on i.instrument_id=pb.instrument_id where i.symbol=$1 order by pb.market_timestamp desc limit $2`, [symbol, limit]);
    if (!result.rows.length) return unavailable(res, "NO_MARKET_DATA", { symbol });
    return res.json({ ok: true, symbol, rows: result.rows.reverse().map((row) => ({ timestamp: iso(row.market_timestamp), open: finite(row.open), high: finite(row.high), low: finite(row.low), close: finite(row.close), volume: finite(row.volume) })) });
  } catch (error) { return res.status(500).json({ ok: false, error: "HISTORY_QUERY_FAILED", message: error instanceof Error ? error.message : "query_failed" }); }
});

const PERIOD_DAYS: Record<string, number> = { "1D": 1, "5D": 5, "1W": 7, "1M": 30, "3M": 90, "6M": 180, "1Y": 365, "2Y": 730, "3Y": 1095, "5Y": 1825 };
function requestedDays(value: unknown): number | null { const key = String(value ?? "1M").toUpperCase(); return PERIOD_DAYS[key] ?? (Number.isFinite(Number(value)) ? Math.max(1, Math.min(3650, Number(value))) : null); }
function performanceMetrics(rows: Array<{ timestamp: string; close: number }>) {
  if (rows.length < 2) return { observations: rows.length, status: "INSUFFICIENT_DATA" };
  const first = rows[0].close, last = rows[rows.length - 1].close;
  const dailyReturns = rows.slice(1).map((row, index) => row.close / rows[index].close - 1).filter(Number.isFinite);
  const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const variance = dailyReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, dailyReturns.length - 1);
  let peak = first, maxDrawdown = 0; for (const row of rows) { peak = Math.max(peak, row.close); maxDrawdown = Math.min(maxDrawdown, row.close / peak - 1); }
  return { observations: rows.length, status: "OK", startingPrice: first, endingPrice: last, absoluteReturn: last - first, percentageReturn: last / first - 1, cagr: Math.pow(last / first, 252 / Math.max(1, dailyReturns.length)) - 1, volatility: Math.sqrt(variance) * Math.sqrt(252), maxDrawdown, bestDay: Math.max(...dailyReturns), worstDay: Math.min(...dailyReturns), positiveDayRatio: dailyReturns.filter((value) => value > 0).length / dailyReturns.length };
}
app.get("/api/market/:symbol/coverage", async (req, res) => {
  if (!pool) return noDb(res); const symbol = symbolParam(req.params.symbol); const timeframe = String(req.query.timeframe ?? "1d");
  try { const result = await pool.query(`select count(*)::int as observations, min(pb.market_timestamp) as first_timestamp, max(pb.market_timestamp) as last_timestamp, max(pb.collected_at) as last_collected_at, max(pb.source) as source from price_bars pb join instruments i on i.instrument_id=pb.instrument_id where i.symbol=$1 and pb.timeframe=$2`, [symbol, timeframe]); const row = result.rows[0]; const observations = Number(row.observations); const lastTimestamp = iso(row.last_timestamp); const ageSeconds = lastTimestamp ? Math.max(0, (Date.now() - Date.parse(lastTimestamp)) / 1000) : null; const status = !observations ? "NO_DATA" : ageSeconds != null && ageSeconds <= (timeframe === "1d" ? 172800 : 900) ? "FRESH" : "STALE"; return res.json({ ok: true, symbol, timeframe, status, observations, firstTimestamp: iso(row.first_timestamp), lastTimestamp, lastCollectedAt: iso(row.last_collected_at), source: row.source ?? null, ageSeconds }); }
  catch (error) { return res.status(500).json({ ok: false, error: "COVERAGE_QUERY_FAILED", message: error instanceof Error ? error.message : "query_failed" }); }
});
app.get("/api/market/:symbol/performance", async (req, res) => {
  if (!pool) return noDb(res); const symbol = symbolParam(req.params.symbol); const days = requestedDays(req.query.period); const timeframe = String(req.query.timeframe ?? "1d"); if (!days) return res.status(400).json({ ok: false, error: "INVALID_PERIOD" });
  try { const result = await pool.query(`select pb.market_timestamp, pb.close from price_bars pb join instruments i on i.instrument_id=pb.instrument_id where i.symbol=$1 and pb.timeframe=$2 and pb.market_timestamp >= now() - ($3::text || ' days')::interval order by pb.market_timestamp asc`, [symbol, timeframe, days]); const rows = result.rows.map((row) => ({ timestamp: iso(row.market_timestamp) as string, close: Number(row.close) })).filter((row) => row.timestamp && Number.isFinite(row.close)); return res.json({ ok: true, symbol, period: String(req.query.period ?? `${days}D`).toUpperCase(), timeframe, requestedDays: days, availableDays: rows.length, coverage: Math.min(1, rows.length / Math.max(2, days)), metrics: performanceMetrics(rows), rows }); }
  catch (error) { return res.status(500).json({ ok: false, error: "PERFORMANCE_QUERY_FAILED", message: error instanceof Error ? error.message : "query_failed" }); }
});
app.get("/api/watchlist", async (_req, res) => { if (!pool) return noDb(res); try { const result = await pool.query(`select w.symbol, w.position, w.note, w.created_at, q.close, q.market_timestamp from watchlist_items w left join lateral (select pb.close, pb.market_timestamp from price_bars pb join instruments i on i.instrument_id=pb.instrument_id where i.symbol=w.symbol order by pb.market_timestamp desc limit 1) q on true order by w.position, w.created_at`); return res.json({ ok: true, items: result.rows.map((row) => ({ symbol: row.symbol, position: row.position, note: row.note, price: finite(row.close), timestamp: iso(row.market_timestamp), status: row.close == null ? "NO_DATA" : "AVAILABLE" })) }); } catch (error) { return res.status(500).json({ ok: false, error: "WATCHLIST_QUERY_FAILED", message: error instanceof Error ? error.message : "query_failed" }); } });
app.post("/api/watchlist", async (req, res) => { if (!pool) return noDb(res); const symbol = symbolParam(req.body?.symbol); if (invalidSymbol(symbol)) return res.status(400).json({ ok: false, error: "INVALID_SYMBOL" }); try { const result = await pool.query(`with instrument as (select symbol from instruments where symbol=$1 and is_active=true), next_position as (select coalesce(max(position),-1)+1 as value from watchlist_items) insert into watchlist_items(symbol,position,note) select instrument.symbol,next_position.value,$2 from instrument,next_position on conflict(symbol) do update set note=coalesce(excluded.note,watchlist_items.note),updated_at=now() returning symbol,position,note`, [symbol, req.body?.note == null ? null : String(req.body.note)]); if (!result.rows.length) return res.status(404).json({ ok: false, error: "INSTRUMENT_NOT_FOUND", symbol }); return res.status(201).json({ ok: true, item: result.rows[0] }); } catch (error) { return res.status(500).json({ ok: false, error: "WATCHLIST_ADD_FAILED", message: error instanceof Error ? error.message : "query_failed" }); } });
app.delete("/api/watchlist/:symbol", async (req, res) => { if (!pool) return noDb(res); try { const result = await pool.query("delete from watchlist_items where symbol=$1", [symbolParam(req.params.symbol)]); return res.json({ ok: true, removed: result.rowCount === 1 }); } catch (error) { return res.status(500).json({ ok: false, error: "WATCHLIST_REMOVE_FAILED", message: error instanceof Error ? error.message : "query_failed" }); } });

let thesisCache = new Map<string, { expiresAt: number; value: any }>();
app.get("/api/signals/latest", async (req, res) => {
  if (!pool) return noDb(res);
  const symbol = symbolParam(req.query.symbol);
  try {
    const result = await pool.query(`select s.id, i.symbol, s.timestamp, s.strategy_version, s.model_version, s.direction, s.confidence, s.regime, s.reason_codes, s.parameters from signal_decisions s join instruments i on i.instrument_id=s.instrument_id where i.symbol=$1 order by s.timestamp desc limit 1`, [symbol]);
    if (!result.rows.length) return unavailable(res, "NO_SIGNAL", { symbol });
    const row = result.rows[0]; const cached = thesisCache.get(symbol); let tradeThesis = cached && cached.expiresAt > Date.now() ? cached.value : null;
    if (!tradeThesis) { const price = await pool.query(`select close from price_bars pb join instruments i on i.instrument_id=pb.instrument_id where i.symbol=$1 order by pb.market_timestamp desc limit 1`, [symbol]); if (price.rows.length) { tradeThesis = await buildCausalTradeThesis(pool, { symbol: row.symbol, timestamp: row.timestamp, direction: row.direction, confidence: Number(row.confidence) }, Number(price.rows[0].close)); thesisCache.set(symbol, { expiresAt: Date.now() + 30000, value: tradeThesis }); } }
    return res.json({ ok: true, signal: { id: row.id, symbol: row.symbol, timestamp: iso(row.timestamp), strategyVersion: row.strategy_version, modelVersion: row.model_version, direction: row.direction, confidence: Number(row.confidence), regime: row.regime, reasonCodes: row.reason_codes ?? [], parameters: row.parameters ?? {}, tradeThesis } });
  } catch (error) { return res.status(500).json({ ok: false, error: "SIGNAL_QUERY_FAILED", message: error instanceof Error ? error.message : "query_failed" }); }
});

app.get("/api/options/chain", async (req, res) => {
  if (!pool) return noDb(res);
  const symbol = symbolParam(req.query.symbol);
  try {
    const result = await pool.query(`select oc.expiry_date, oc.strike, oc.option_type, os.market_timestamp, os.ltp, os.bid, os.ask, os.oi, os.oi_change, os.iv from option_snapshots os join option_contracts oc on oc.contract_id=os.contract_id join instruments i on i.instrument_id=oc.instrument_id where i.symbol=$1 and os.market_timestamp=(select max(os2.market_timestamp) from option_snapshots os2 join option_contracts oc2 on oc2.contract_id=os2.contract_id where oc2.instrument_id=oc.instrument_id) order by oc.expiry_date, oc.strike, oc.option_type`, [symbol]);
    if (!result.rows.length) return res.json({ ok: true, symbol, rows: [] });
    return res.json({ ok: true, symbol, rows: result.rows.map((row) => ({ expiry_date: row.expiry_date, strike: finite(row.strike), option_type: row.option_type, timestamp: iso(row.market_timestamp), ltp: finite(row.ltp), bid: finite(row.bid), ask: finite(row.ask), oi: finite(row.oi), oiChange: finite(row.oi_change), iv: finite(row.iv) })) });
  } catch (error) { return res.status(500).json({ ok: false, error: "OPTION_QUERY_FAILED", message: error instanceof Error ? error.message : "query_failed" }); }
});

app.use("/api/shadow", createShadowRouter(pool));

app.get("/api/forecast", async (req, res) => {
  if (!pool) return noDb(res);
  const symbol = symbolParam(req.query.symbol); const horizonDays = Math.min(30, Math.max(1, Number(req.query.horizon ?? 5)));
  try {
    const result = await pool.query(`select pb.close from price_bars pb join instruments i on i.instrument_id=pb.instrument_id where i.symbol=$1 order by pb.market_timestamp desc limit 60`, [symbol]);
    const closes = result.rows.map((row) => Number(row.close)).filter(Number.isFinite).reverse();
    if (closes.length < 5) return unavailable(res, "INSUFFICIENT_HISTORY", { symbol, daysOfHistoryUsed: closes.length });
    const returns = closes.slice(1).map((value, index) => Math.log(value / closes[index])); const mean = returns.reduce((a, b) => a + b, 0) / returns.length; const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, returns.length - 1); const volatility = Math.sqrt(variance); const spot = closes[closes.length - 1];
    const bands = Array.from({ length: horizonDays }, (_, index) => { const day = index + 1; const scale = volatility * Math.sqrt(day); return { day, p10: spot * Math.exp(mean * day - 1.2816 * scale), p25: spot * Math.exp(mean * day - 0.6745 * scale), median: spot * Math.exp(mean * day), p75: spot * Math.exp(mean * day + 0.6745 * scale), p90: spot * Math.exp(mean * day + 1.2816 * scale) }; });
    return res.json({ ok: true, symbol, spot, dailyVolatility: volatility, daysOfHistoryUsed: closes.length, horizonDays, paths: 0, probabilityAboveSpot: 0.5, probabilityBelowSpot: 0.5, bands, status: "STATISTICAL_BASELINE" });
  } catch (error) { return res.status(500).json({ ok: false, error: "FORECAST_FAILED", message: error instanceof Error ? error.message : "query_failed" }); }
});

function numberOrNull(value: unknown): number | null { const n = Number(value); return Number.isFinite(n) ? n : null; }
function clampScore(value: number): number { return Math.max(0, Math.min(100, Math.round(value))); }
app.post("/api/ipo/analyze", async (req, res) => {
  const input = req.body ?? {}; const companyName = String(input.companyName ?? "").trim(); if (!companyName) return res.status(400).json({ ok: false, error: "COMPANY_NAME_REQUIRED" });
  const revenue = numberOrNull(input.revenue), ebitda = numberOrNull(input.ebitda), pat = numberOrNull(input.pat), issuePrice = numberOrNull(input.issuePrice), postIssueShares = numberOrNull(input.postIssueShares), freshIssue = numberOrNull(input.freshIssue), ofS = numberOrNull(input.ofs), debt = numberOrNull(input.debt), cash = numberOrNull(input.cash), roe = numberOrNull(input.roe), roce = numberOrNull(input.roce), revenueGrowth = numberOrNull(input.revenueGrowth);
  const pe = issuePrice !== null && postIssueShares && pat && pat > 0 ? (issuePrice * postIssueShares) / pat : null; const enterpriseValue = issuePrice !== null && postIssueShares ? issuePrice * postIssueShares + (debt ?? 0) - (cash ?? 0) : null; const evEbitda = enterpriseValue !== null && ebitda && ebitda > 0 ? enterpriseValue / ebitda : null; const ebitdaMargin = revenue !== null && revenue !== 0 && ebitda !== null ? ebitda / revenue : null; const profitMargin = revenue !== null && revenue !== 0 && pat !== null ? pat / revenue : null; const freshRatio = freshIssue !== null && issuePrice !== null && postIssueShares ? freshIssue / postIssueShares : null;
  let valuationScore = 50; if (pe !== null) valuationScore += pe < 20 ? 20 : pe < 30 ? 10 : pe < 45 ? 0 : -15; if (evEbitda !== null) valuationScore += evEbitda < 15 ? 10 : evEbitda < 25 ? 0 : -10; let businessScore = 50; if (revenueGrowth !== null) businessScore += revenueGrowth > 20 ? 20 : revenueGrowth > 10 ? 10 : revenueGrowth < 0 ? -15 : 0; if (ebitdaMargin !== null) businessScore += ebitdaMargin > 0.2 ? 15 : ebitdaMargin > 0.1 ? 5 : ebitdaMargin < 0 ? -15 : 0; if (profitMargin !== null) businessScore += profitMargin > 0.1 ? 10 : profitMargin < 0 ? -15 : 0; if (roe !== null) businessScore += roe > 15 ? 10 : roe < 8 ? -5 : 0; if (roce !== null) businessScore += roce > 15 ? 10 : roce < 8 ? -5 : 0; const structureScore = freshRatio === null ? 50 : clampScore(freshRatio * 100 + 40); const score = clampScore(0.45 * valuationScore + 0.4 * businessScore + 0.15 * structureScore); const risks: string[] = []; if (ofS !== null && freshIssue !== null && ofS > freshIssue * 2) risks.push("Large OFS relative to fresh issue."); if (revenueGrowth !== null && revenueGrowth < 0) risks.push("Revenue growth is negative on the supplied period."); if (pat !== null && pat < 0) risks.push("The company is loss-making on the supplied period."); if (!risks.length) risks.push("No major quantitative warning triggered; qualitative prospectus risks still require review."); const analysis = { score, verdict: score >= 70 ? "ATTRACTIVE" : score >= 55 ? "WATCH" : "CAUTION", valuationScore: clampScore(valuationScore), businessScore: clampScore(businessScore), structureScore, metrics: { pe, enterpriseValue, evEbitda, ebitdaMargin, profitMargin, freshIssueRatio: freshRatio }, risks, methodology: "ipo-analysis-v1", disclaimer: "Screening model only. It does not replace prospectus review, peer valuation, anchor/allocation data or independent investment advice." };
  if (pool) await pool.query(`insert into ipo_analysis_runs (company_name, symbol, analysis_version, inputs, analysis, source_urls) values ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb)`, [companyName, input.symbol ? String(input.symbol).toUpperCase() : null, "ipo-analysis-v1", JSON.stringify(input), JSON.stringify(analysis), JSON.stringify(Array.isArray(input.sourceUrls) ? input.sourceUrls : [])]);
  return res.json({ ok: true, companyName, analysis });
});

const server = app.listen(port, "0.0.0.0", () => console.log(`D-predict backend listening on ${port}`));
const shutdown = async () => { server.close(); await pool?.end(); process.exit(0); };
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
export { app };
