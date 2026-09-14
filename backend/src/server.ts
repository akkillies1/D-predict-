import "dotenv/config";
import express from "express";
import cors from "cors";
import { Pool } from "pg";
import { classifyFreshness, normalizeQuote } from "./marketDataContract.js";

const port = Number(process.env.API_PORT ?? 4100);
const databaseUrl = process.env.DATABASE_URL;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 10 }) : null;
const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(",").filter(Boolean) ?? true }));
app.use(express.json({ limit: "256kb" }));

const YAHOO_SEARCH = "https://query1.finance.yahoo.com/v1/finance/search";
const YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart";
const YAHOO_HEADERS = { "User-Agent": "Mozilla/5.0 D-predict/1.0" };
const iso = (value: unknown) => value instanceof Date ? value.toISOString() : value;
const noDb = (res: express.Response) => res.status(503).json({ ok: false, error: "DATABASE_UNAVAILABLE", message: "Configure DATABASE_URL and start PostgreSQL." });
const yahooSymbol = (symbol: string) => ({ NIFTY: "^NSEI", BANKNIFTY: "^NSEBANK" } as Record<string, string>)[symbol] ?? symbol;

const fetchJson = async (url: string, signal?: AbortSignal) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(url, { signal: controller.signal, headers: YAHOO_HEADERS });
    if (!response.ok) throw new Error(`Yahoo returned ${response.status}`);
    return await response.json() as any;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
};

const normaliseYahooQuote = (quote: any) => {
  const symbol = String(quote?.symbol ?? "").trim().toUpperCase();
  if (!symbol) return null;
  const exchange = String(quote?.exchange ?? quote?.exchDisp ?? "").trim().toUpperCase();
  const name = String(quote?.longname ?? quote?.shortname ?? symbol).trim();
  const isIndian = /\.(NS|BO)$/i.test(symbol) || /NIFTY|BANKNIFTY/i.test(symbol) || symbol === "^NSEI" || symbol === "^NSEBANK";
  if (!isIndian) return null;
  const lotSize = Number.isInteger(Number(quote?.lotSize)) && Number(quote.lotSize) > 0 ? Number(quote.lotSize) : 1;
  return { symbol, exchange: exchange || (symbol.endsWith(".BO") ? "BSE" : "NSE"), lotSize, isActive: true, name, source: "yahoo" };
};

app.get("/health", async (_req, res) => {
  if (!pool) return res.status(503).json({ ok: false, database: "not_configured" });
  try { await pool.query("select 1"); return res.json({ ok: true, database: "connected", time: new Date().toISOString() }); }
  catch (error) { return res.status(503).json({ ok: false, database: "unavailable", error: error instanceof Error ? error.message : "unknown" }); }
});

app.get("/api/data-health", async (_req, res) => {
  if (!pool) return noDb(res);
  try {
    const result = await pool.query(`select (select max(market_timestamp) from price_bars) as latest_price, (select max(option_snapshots.market_timestamp) from option_snapshots) as latest_option, (select count(*)::int from instruments where is_active) as active_instruments`);
    const row = result.rows[0];
    return res.json({ ok: true, latestPrice: iso(row.latest_price), latestOption: iso(row.latest_option), activeInstruments: row.active_instruments });
  } catch (error) { return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "query_failed" }); }
});

app.get("/api/instruments", async (_req, res) => {
  if (!pool) return noDb(res);
  try {
    const result = await pool.query(`select symbol, exchange, lot_size as "lotSize", is_active as "isActive", name from instruments order by symbol limit 1000`);
    return res.json({ ok: true, instruments: result.rows });
  } catch (error) { return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "query_failed" }); }
});

app.get("/api/instruments/search", async (req, res) => {
  if (!pool) return noDb(res);
  const query = String(req.query.q ?? "").trim().toUpperCase();
  if (!query) return res.json({ ok: true, instruments: [] });
  try {
    const result = await pool.query(`select symbol, exchange, lot_size as "lotSize", is_active as "isActive", name, 'local' as source from instruments where is_active and (upper(symbol) like $1 or upper(coalesce(name,'')) like $1 or upper(symbol) like $2 or upper(coalesce(name,'')) like $2) order by case when upper(symbol) = $3 then 0 when upper(symbol) like $1 then 1 when upper(coalesce(name,'')) like $1 then 2 else 3 end, symbol limit 20`, [`${query}%`, `%${query}%`, query]);
    return res.json({ ok: true, instruments: result.rows });
  } catch (error) { return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "query_failed" }); }
});

app.get("/api/instruments/discover", async (req, res) => {
  if (!pool) return noDb(res);
  const query = String(req.query.q ?? "").trim();
  if (query.length < 1) return res.json({ ok: true, instruments: [] });
  const upper = query.toUpperCase();
  try {
    const local = await pool.query(`select symbol, exchange, lot_size as "lotSize", is_active as "isActive", name, 'local' as source from instruments where is_active and (upper(symbol) like $1 or upper(coalesce(name,'')) like $1 or upper(symbol) like $2 or upper(coalesce(name,'')) like $2) order by case when upper(symbol) = $3 then 0 when upper(symbol) like $1 then 1 when upper(coalesce(name,'')) like $1 then 2 else 3 end, symbol limit 20`, [`${upper}%`, `%${upper}%`, upper]);
    const localRows = local.rows;
    if (query.length < 2 || localRows.length >= 10) return res.json({ ok: true, instruments: localRows.slice(0, 20) });
    let remoteRows: any[] = [];
    try {
      const payload = await fetchJson(`${YAHOO_SEARCH}?q=${encodeURIComponent(query)}&quotesCount=20&newsCount=0`);
      const seen = new Set<string>();
      remoteRows = Array.isArray(payload?.quotes) ? payload.quotes.map(normaliseYahooQuote).filter(Boolean).filter((item: any) => {
        if (seen.has(item.symbol)) return false;
        seen.add(item.symbol);
        return true;
      }) : [];
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return res.status(504).json({ ok: false, error: "DISCOVERY_TIMEOUT" });
    }
    const seen = new Set(localRows.map(row => row.symbol));
    const merged = [...localRows];
    for (const row of remoteRows) if (!seen.has(row.symbol)) { seen.add(row.symbol); merged.push(row); }
    return res.json({ ok: true, instruments: merged.slice(0, 20) });
  } catch (error) { return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "discovery_failed" }); }
});

app.post("/api/instruments", async (req, res) => {
  if (!pool) return noDb(res);
  const symbol = String(req.body?.symbol ?? "").trim().toUpperCase();
  const exchange = String(req.body?.exchange ?? (symbol.endsWith(".BO") ? "BSE" : "NSE")).trim().toUpperCase();
  const requestedLotSize = Number(req.body?.lotSize ?? 1);
  const lotSize = Number.isInteger(requestedLotSize) && requestedLotSize > 0 ? requestedLotSize : 1;
  const name = String(req.body?.name ?? "").trim().slice(0, 200) || null;
  if (!/^[A-Z0-9._^:-]{1,32}$/.test(symbol)) return res.status(400).json({ ok: false, error: "INVALID_INSTRUMENT" });
  try {
    const result = await pool.query(`insert into instruments (symbol, exchange, lot_size, name) values ($1, $2, $3, $4) on conflict (symbol) do update set is_active = true, exchange = excluded.exchange, lot_size = case when instruments.lot_size > 1 and excluded.lot_size = 1 then instruments.lot_size else excluded.lot_size end, name = coalesce(excluded.name, instruments.name) returning symbol, exchange, lot_size as "lotSize", is_active as "isActive", name`, [symbol, exchange, lotSize, name]);
    return res.status(201).json({ ok: true, instrument: result.rows[0], message: "Instrument activated. The collector will pick it up on its next poll." });
  } catch (error) { return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "query_failed" }); }
});

app.get("/api/market/:symbol/live", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const payload = await fetchJson(`${YAHOO_CHART}/${encodeURIComponent(yahooSymbol(symbol))}?interval=1m&range=1d`);
    const result = payload?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta) return res.status(404).json({ ok: false, error: "NO_LIVE_QUOTE" });
    const close = Number(meta.regularMarketPrice ?? meta.chartPreviousClose);
    if (!Number.isFinite(close)) return res.status(404).json({ ok: false, error: "NO_LIVE_QUOTE" });
    const previousClose = Number(meta.previousClose ?? meta.chartPreviousClose);
    const marketTime = meta.regularMarketTime ? new Date(Number(meta.regularMarketTime) * 1000).toISOString() : new Date().toISOString();
    const quote = normalizeQuote({
      symbol,
      timestamp: marketTime,
      collectedAt: new Date().toISOString(),
      close,
      previousClose: Number.isFinite(previousClose) ? previousClose : null,
      volume: meta.regularMarketVolume == null ? null : Number(meta.regularMarketVolume),
      source: "yahoo-live",
      status: classifyFreshness(marketTime),
    });
    return res.json({ ok: true, ...quote });
  } catch (error) { return res.status(502).json({ ok: false, error: error instanceof Error ? error.message : "upstream_failed" }); }
});

app.get("/api/market/:symbol/overview", async (req, res) => {
  if (!pool) return noDb(res);
  const symbol = req.params.symbol.toUpperCase();
  try {
    const result = await pool.query(`select i.symbol, pb.market_timestamp, pb.collected_at, pb.open, pb.high, pb.low, pb.close, pb.volume, pb.source from instruments i left join lateral (select market_timestamp, collected_at, open, high, low, close, volume, source from price_bars where instrument_id=i.instrument_id and timeframe='1m' order by market_timestamp desc limit 1) pb on true where i.symbol=$1 limit 1`, [symbol]);
    if (!result.rows.length || !result.rows[0].market_timestamp) return res.status(404).json({ ok: false, error: "NO_MARKET_DATA" });
    const row = result.rows[0];
    const quote = normalizeQuote({ symbol: row.symbol, timestamp: iso(row.market_timestamp) as string, collectedAt: iso(row.collected_at) as string, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: row.volume === null ? null : Number(row.volume), source: row.source, status: classifyFreshness(iso(row.market_timestamp) as string) });
    return res.json({ ok: true, ...quote });
  } catch (error) { return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "query_failed" }); }
});

app.get("/api/market/:symbol/history", async (req, res) => {
  if (!pool) return noDb(res);
  const symbol = req.params.symbol.toUpperCase();
  const parsed = Number(req.query.limit ?? 120);
  const limit = Number.isFinite(parsed) ? Math.min(500, Math.max(10, Math.floor(parsed))) : 120;
  try {
    const result = await pool.query(`select pb.market_timestamp, pb.open, pb.high, pb.low, pb.close, pb.volume from price_bars pb join instruments i on i.instrument_id=pb.instrument_id where i.symbol=$1 and pb.timeframe='1m' order by pb.market_timestamp desc limit $2`, [symbol, limit]);
    return res.json({ ok: true, symbol, rows: result.rows.reverse().map(row => ({ timestamp: iso(row.market_timestamp), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: row.volume === null ? null : Number(row.volume) })) });
  } catch (error) { return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "query_failed" }); }
});

app.get("/api/signals/latest", async (req, res) => {
  if (!pool) return noDb(res);
  const symbol = String(req.query.symbol ?? "NIFTY").toUpperCase();
  try {
    const result = await pool.query(`select s.id, i.symbol, s.timestamp, s.strategy_version, s.model_version, s.direction, s.confidence, s.regime, s.reason_codes, s.parameters from signal_decisions s join instruments i on i.instrument_id=s.instrument_id where i.symbol=$1 order by s.timestamp desc limit 1`, [symbol]);
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "NO_SIGNAL" });
    const row = result.rows[0]; return res.json({ ok: true, signal: { id: row.id, symbol: row.symbol, timestamp: iso(row.timestamp), strategyVersion: row.strategy_version, modelVersion: row.model_version, direction: row.direction, confidence: Number(row.confidence), regime: row.regime, reasonCodes: row.reason_codes ?? [], parameters: row.parameters ?? {} } });
  } catch (error) { return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "query_failed" }); }
});

app.get("/api/options/chain", async (req, res) => {
  if (!pool) return noDb(res);
  const symbol = String(req.query.symbol ?? "NIFTY").toUpperCase();
  try {
    const result = await pool.query(`with instrument as (select instrument_id from instruments where symbol=$1), expiry as (select min(expiry_date) expiry_date from option_contracts where instrument_id=(select instrument_id from instrument) and expiry_date >= current_date), latest as (select distinct on (os.contract_id) os.contract_id, os.market_timestamp, os.ltp, os.bid, os.ask, os.oi, os.oi_change, os.iv from option_snapshots os order by os.contract_id, os.market_timestamp desc) select oc.expiry_date, oc.strike, oc.option_type, latest.market_timestamp, latest.ltp, latest.bid, latest.ask, latest.oi, latest.oi_change, latest.iv from option_contracts oc join instrument i on i.instrument_id=oc.instrument_id join expiry e on e.expiry_date=oc.expiry_date join latest on latest.contract_id=oc.contract_id order by oc.strike, oc.option_type limit 500`, [symbol]);
    return res.json({ ok: true, symbol, rows: result.rows.map(row => ({ ...row, strike: Number(row.strike), ltp: row.ltp === null ? null : Number(row.ltp), bid: row.bid === null ? null : Number(row.bid), ask: row.ask === null ? null : Number(row.ask), oi: row.oi === null ? null : Number(row.oi), oiChange: row.oi_change === null ? null : Number(row.oi_change), iv: row.iv === null ? null : Number(row.iv), timestamp: iso(row.market_timestamp) })) });
  } catch (error) { return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "query_failed" }); }
});

app.get("/api/forecast", async (req, res) => {
  if (!pool) return noDb(res);
  const symbol = String(req.query.symbol ?? "NIFTY").toUpperCase();
  const horizonDays = Math.min(10, Math.max(1, Number(req.query.horizon ?? 5)));
  try {
    const result = await pool.query(`select date(pb.market_timestamp at time zone 'Asia/Kolkata') as trading_day, (array_agg(pb.close order by pb.market_timestamp desc))[1] as close from price_bars pb join instruments i on i.instrument_id=pb.instrument_id where i.symbol=$1 group by 1 order by 1 desc limit 60`, [symbol]);
    const closes = result.rows.reverse().map(row => Number(row.close)).filter(Number.isFinite);
    if (closes.length < 5) return res.status(404).json({ ok: false, error: "INSUFFICIENT_HISTORY", daysOfHistoryUsed: closes.length, required: 5 });
    const returns = closes.slice(1).map((close, index) => Math.log(close / closes[index]));
    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, returns.length - 1);
    const dailyVolatility = Math.sqrt(variance);
    const spot = closes[closes.length - 1];
    const paths = 1000;
    const bands = [{ day: 0, p10: spot, p25: spot, median: spot, p75: spot, p90: spot }];
    let terminalPrices: number[] = [];
    const quantile = (values: number[], probability: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(probability * (sorted.length - 1)))]; };
    for (let day = 1; day <= horizonDays; day += 1) {
      const prices = Array.from({ length: paths }, () => { let price = spot; for (let step = 0; step < day; step += 1) { const u = Math.max(Number.EPSILON, Math.random()); const v = Math.max(Number.EPSILON, Math.random()); const gaussian = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); price *= Math.exp(dailyVolatility * gaussian); } return price; });
      terminalPrices = prices;
      bands.push({ day, p10: quantile(prices, 0.1), p25: quantile(prices, 0.25), median: quantile(prices, 0.5), p75: quantile(prices, 0.75), p90: quantile(prices, 0.9) });
    }
    const above = terminalPrices.filter(price => price > spot).length / terminalPrices.length;
    return res.json({ ok: true, symbol, spot, dailyVolatility, daysOfHistoryUsed: closes.length, horizonDays, paths, probabilityAboveSpot: above, probabilityBelowSpot: 1 - above, bands });
  } catch (error) { return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "query_failed" }); }
});

const server = app.listen(port, "0.0.0.0", () => console.log(`D-predict local API listening on 0.0.0.0:${port}`));
const shutdown = async () => { server.close(); await pool?.end(); };
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
