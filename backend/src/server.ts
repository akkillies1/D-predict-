import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "node:path";
import pg from "pg";
import { buildCausalTradeThesis } from "./tradeThesis.js";
import { createShadowRouter } from "./shadowRoutes.js";
import { createPaperRouter } from "./paperRoutes.js";
import { attachLiveHub } from "./liveHub.js";
import { runMarketScan } from "./marketScan.js";
import { BACKTEST_STRATEGIES, runBacktest, type BacktestStrategy } from "./backtest.js";
import { computePredictionPerformance } from "./predictionStats.js";
import { mlFetch } from "./mlProxy.js";
import { TRAIN_TIMEOUT_MS, acknowledgeAllAlerts, addWatchlistItem, retrainSymbol, removeWatchlistItem } from "./appActions.js";
import { fetchRecentAlerts, mapAlertRow } from "./alertFeed.js";
import { createAiRouter } from "./aiRoutes.js";
import { analyzeOptionChain } from "./optionIntelligence.js";
import { getUpdateStatus } from "./updateService.js";
import { ensureOptionContractMetadata } from "./dbMigrations.js";

// Resolve runtime configuration from every supported local launch context.
// Docker supplies DATABASE_URL explicitly; direct Windows launches must also see
// the persisted installer configuration instead of silently creating a
// database-less API process.
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
dotenv.config({ path: path.resolve(process.cwd(), "../.env") });
dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });
const localStateEnv = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "D-Predict", ".env")
  : null;
if (!process.env.DATABASE_URL && localStateEnv) {
  dotenv.config({ path: localStateEnv });
}
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
function noDb(res: express.Response) { return res.status(503).json({ ok: false, error: "DATABASE_NOT_CONFIGURED", message: "PostgreSQL is required to activate and persist instruments." }); }
function unavailable(res: express.Response, error: string, extra: Record<string, unknown> = {}) { return res.status(200).json({ ok: false, error, ...extra }); }

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

app.get("/ready", async (_req, res) => {
  const result: Record<string, unknown> = { ok: false, service: "market-api", database: "unavailable", marketData: "unavailable", instruments: 0, dailyBars: 0, latestMarketTimestamp: null, timestamp: new Date().toISOString() };
  if (!pool) return res.status(503).json(result);
  try {
    await pool.query("select 1");
    const counts = await pool.query(`select
      (select count(*)::int from instruments where is_active=true) as instruments,
      (select count(*)::int from price_bars where timeframe='1d') as daily_bars,
      (select max(market_timestamp) from price_bars where timeframe='1d') as latest_market_timestamp,
      (select count(*)::int from signal_decisions where timestamp >= now() - interval '7 days') as recent_signals`);
    const row = counts.rows[0];
    const instruments = Number(row.instruments ?? 0);
    const dailyBars = Number(row.daily_bars ?? 0);
    const latestMarketTimestamp = iso(row.latest_market_timestamp);
    const ready = instruments > 0 && dailyBars > 0 && latestMarketTimestamp !== null;
    return res.status(ready ? 200 : 503).json({ ...result, ok: ready, database: "healthy", marketData: ready ? "available" : "awaiting_collector", instruments, dailyBars, latestMarketTimestamp, recentSignals: Number(row.recent_signals ?? 0) });
  } catch (error) {
    return res.status(503).json({ ...result, message: error instanceof Error ? error.message : "database_unavailable" });
  }
});

app.get("/api/predictions/performance", async (req, res) => {
  if (!pool) return noDb(res);
  const requestedDays = Number(req.query.days ?? 30);
  const days = Number.isFinite(requestedDays) ? Math.min(365, Math.max(1, Math.floor(requestedDays))) : 30;
  try {
    return res.json(await computePredictionPerformance(pool, days));
  } catch (error) {
    return res.status(500).json({ ok: false, error: "PREDICTION_PERFORMANCE_FAILED", message: error instanceof Error ? error.message : "query_failed" });
  }
});

app.get("/api/predictions/live", async (req, res) => {
  const symbol = String(req.query.symbol ?? "").trim().toUpperCase();
  const horizon = String(req.query.horizon ?? "1d").trim().toLowerCase();
  if (!symbol || symbol.length > 32) return res.status(400).json({ ok: false, error: "INVALID_SYMBOL" });
  if (!["1d", "3d", "5d"].includes(horizon)) return res.status(400).json({ ok: false, error: "INVALID_HORIZON", supportedHorizons: ["1d", "3d", "5d"] });
  const base = (process.env.ML_INFERENCE_URL ?? "http://ml:4300").replace(/\/$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(process.env.ML_INFERENCE_TIMEOUT_MS ?? 15000)));
  try {
    const response = await fetch(`${base}/predict`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbol, horizon }), signal: controller.signal });
    const body = await response.json().catch(() => ({ detail: "ML_INVALID_RESPONSE" }));
    // A model that abstains, has no trained bundle, or a symbol with no daily
    // history is an expected "no live prediction" outcome — not an outage. ML
    // signals these as 404 (no history) / 503 (bundle not ready). Report them as
    // a normal empty result (HTTP 200, ok:false) carrying the real reason so the
    // browser stops logging a failed resource on every poll, while genuine
    // failures (4xx contract violations, 5xx, ML unreachable) stay non-2xx.
    if (response.status === 404 || response.status === 503) {
      const reason = typeof body?.detail === "string" ? body.detail : (body?.detail?.message ?? null);
      return res.json({ ok: false, status: "NO_LIVE_PREDICTION", error: response.status === 404 ? "NO_PREDICTION_HISTORY" : "MODEL_NOT_READY", reason, symbol, horizon });
    }
    // Propagate any other upstream status instead of masking it behind HTTP 200,
    // and guarantee an honest `ok` so the client never renders a broken body.
    if (!response.ok) return res.status(response.status).json({ ...body, ok: false, error: body?.error ?? "ML_UPSTREAM_ERROR" });
    return res.json({ ...body, ok: true });
  } catch (error) {
    return res.status(503).json({ ok: false, error: "ML_INFERENCE_UNAVAILABLE", message: error instanceof Error ? error.message : "inference_unavailable" });
  } finally {
    clearTimeout(timeout);
  }
});

app.get("/api/training/coverage", async (req, res) => {
  const horizons = String(req.query.horizons ?? "").trim();
  const query = horizons ? `?horizons=${encodeURIComponent(horizons)}` : "";
  try {
    const { body } = await mlFetch(`/training/coverage${query}`);
    return res.status(200).json(body);
  } catch (error) {
    return res.status(200).json({ ok: false, error: "ML_COVERAGE_UNAVAILABLE", message: error instanceof Error ? error.message : "coverage_unavailable" });
  }
});

// Training runs are long (fitting the whole active universe); allow several minutes.

app.post("/api/training/run", async (req, res) => {
  const trigger = ["AUTO_NEW_DATA", "SCHEDULED", "MANUAL"].includes(String(req.body?.trigger)) ? req.body.trigger : "MANUAL";
  const payload = { trigger, horizons: req.body?.horizons ?? null, force_symbols: req.body?.forceSymbols ?? null };
  try {
    const { body } = await mlFetch("/train/auto", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }, TRAIN_TIMEOUT_MS);
    return res.status(200).json(body);
  } catch (error) {
    return res.status(200).json({ ok: false, error: "ML_TRAINING_UNAVAILABLE", message: error instanceof Error ? error.message : "training_unavailable" });
  }
});

app.post("/api/training/retrain-stale", async (req, res) => {
  try {
    const { body } = await mlFetch("/train/stale", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ horizons: req.body?.horizons ?? null }) }, TRAIN_TIMEOUT_MS);
    return res.status(200).json(body);
  } catch (error) {
    return res.status(200).json({ ok: false, error: "ML_TRAINING_UNAVAILABLE", message: error instanceof Error ? error.message : "training_unavailable" });
  }
});

app.post("/api/training/:symbol/retrain", async (req, res) => {
  const symbol = String(req.params.symbol ?? "").trim().toUpperCase();
  const horizon = String(req.query.horizon ?? req.body?.horizon ?? "1d").trim().toLowerCase();
  if (!symbol || symbol.length > 32) return res.status(400).json({ ok: false, error: "INVALID_SYMBOL" });
  try {
    const { body } = await retrainSymbol(mlFetch, symbol, horizon, TRAIN_TIMEOUT_MS);
    return res.status(200).json(body);
  } catch (error) {
    return res.status(200).json({ ok: false, error: "ML_TRAINING_UNAVAILABLE", message: error instanceof Error ? error.message : "training_unavailable" });
  }
});

app.get("/api/instruments", async (_req, res) => {
  if (!pool) return noDb(res);
  try {
    const result = await pool.query(`select i.symbol, i.exchange, i.lot_size, i.is_active, i.name, i.provider_symbol, i.instrument_type, i.canonical_source as source, count(pb.id)::int as observations, max(pb.market_timestamp) as last_market_timestamp, max(pb.collected_at) as last_collected_at from instruments i left join price_bars pb on pb.instrument_id=i.instrument_id and pb.timeframe='1d' group by i.instrument_id order by i.is_active desc, i.symbol`);
    return res.json({ ok: true, instruments: result.rows.map((row) => ({ symbol: row.symbol, exchange: row.exchange, lotSize: row.lot_size, isActive: row.is_active, name: row.name, providerSymbol: row.provider_symbol, instrumentType: row.instrument_type, source: row.source, observations: Number(row.observations), lastMarketTimestamp: iso(row.last_market_timestamp), lastCollectedAt: iso(row.last_collected_at) })) });
  } catch (error) { return res.status(500).json({ ok: false, error: "INSTRUMENT_QUERY_FAILED", message: error instanceof Error ? error.message : "query_failed" }); }
});

app.get("/api/instruments/discover", async (req, res) => {
  const query = String(req.query.q ?? "").trim();
  if (query.length < 1) return res.json({ ok: true, instruments: [] });
  let local: Array<Record<string, unknown>> = [];
  if (pool) {
    try {
      const result = await pool.query(`select symbol, exchange, lot_size, is_active, name, provider_symbol, instrument_type, canonical_source as source from instruments where upper(symbol) like $1 or upper(coalesce(name,'')) like $1 or exists (select 1 from unnest(aliases) alias where upper(alias) like $1) order by case when upper(symbol) = upper($2) then 0 when upper(symbol) like upper($2) || '%' then 1 else 2 end, symbol limit 25`, [`%${query.toUpperCase()}%`, query]);
      local = result.rows.map((row) => ({ symbol: row.symbol, exchange: row.exchange, lotSize: row.lot_size, isActive: row.is_active, name: row.name, providerSymbol: row.provider_symbol, instrumentType: row.instrument_type, source: row.source }));
    } catch (error) {
      console.warn("local instrument discovery skipped:", error instanceof Error ? error.message : error);
    }
  }
  // The provider lookup is best-effort: a transient network/parse failure must
  // never turn a valid request into a 500 or discard the local matches we found.
  // It is also time-boxed — a stalled name resolution would otherwise keep the
  // awaited fetch pending forever and withhold the local matches the user can act on.
  let online: Array<Record<string, unknown>> = [];
  try {
    const response = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=20&newsCount=0`, { headers: { "User-Agent": "D-Predict/2.0" }, signal: AbortSignal.timeout(2500) });
    if (response.ok) {
      const payload = await response.json() as { quotes?: Array<{ symbol?: string; exchange?: string; quoteType?: string; shortname?: string; longname?: string; exchDisp?: string }> };
      online = (payload.quotes ?? []).filter((quote) => quote.symbol && ["EQUITY", "ETF", "INDEX", "MUTUALFUND"].includes(quote.quoteType ?? "")).sort((left, right) => { const rank = (quote: typeof left) => /\.(NS|BO)$/i.test(quote.symbol ?? "") || /\b(NSE|BSE|India)\b/i.test(`${quote.exchange} ${quote.exchDisp}`) ? 0 : 1; return rank(left) - rank(right); }).map((quote) => ({ symbol: quote.symbol!.toUpperCase(), exchange: quote.exchDisp ?? quote.exchange ?? "", lotSize: null, isActive: local.some((item) => item.symbol === quote.symbol!.toUpperCase() && item.isActive), name: quote.longname ?? quote.shortname ?? quote.symbol, providerSymbol: quote.symbol, instrumentType: quote.quoteType, source: "yahoo" }));
    }
  } catch (error) {
    console.warn("online instrument discovery skipped:", error instanceof Error ? error.message : error);
  }
  const merged = [...local, ...online.filter((item) => !local.some((existing) => existing.symbol === item.symbol))];
  return res.json({ ok: true, instruments: merged.slice(0, 25) });
});

app.get("/api/options/discover", async (req, res) => {
  if (!pool) return noDb(res);
  const query = String(req.query.q ?? "").trim();
  if (query.length < 1) return res.json({ ok: true, query, instruments: [] });
  try {
    const result = await pool.query(`
      select i.symbol, i.exchange, i.name, i.provider_symbol, i.instrument_type,
             i.is_active, i.lot_size,
             max(os.market_timestamp) as latest_option_timestamp,
             count(oc.contract_id)::int as contracts
      from instruments i
      left join option_contracts oc on oc.instrument_id = i.instrument_id
      left join option_snapshots os on os.contract_id = oc.contract_id
      where upper(i.symbol) like $1
         or upper(coalesce(i.name, '')) like $1
         or exists (select 1 from unnest(i.aliases) alias where upper(alias) like $1)
      group by i.instrument_id
      order by case when upper(i.symbol) = upper($2) then 0
                    when upper(i.symbol) like upper($2) || '%' then 1
                    else 2 end, i.symbol
      limit 25
    `, [`%${query.toUpperCase()}%`, query]);
    return res.json({
      ok: true,
      query,
      instruments: result.rows.map(row => ({
        symbol: row.symbol,
        exchange: row.exchange,
        name: row.name,
        providerSymbol: row.provider_symbol,
        instrumentType: row.instrument_type,
        isActive: row.is_active,
        lotSize: row.lot_size == null ? null : Number(row.lot_size),
        optionChain: {
          available: Number(row.contracts) > 0 && row.latest_option_timestamp != null,
          contracts: Number(row.contracts),
          latestTimestamp: iso(row.latest_option_timestamp),
        },
      })),
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: "OPTION_DISCOVERY_FAILED", message: error instanceof Error ? error.message : "query_failed" });
  }
});

app.post("/api/options/track", async (req, res) => {
  if (!pool) return noDb(res);
  const symbol = symbolParam(req.body?.symbol);
  if (invalidSymbol(symbol)) return res.status(400).json({ ok: false, error: "INVALID_SYMBOL" });
  const providerSymbol = String(req.body?.providerSymbol ?? symbol).trim().toUpperCase();
  const exchange = String(req.body?.exchange ?? (providerSymbol.endsWith(".BO") ? "BSE" : "NSE")).trim().toUpperCase();
  const name = req.body?.name == null ? null : String(req.body.name).trim() || null;
  const instrumentType = String(req.body?.instrumentType ?? "EQUITY").trim().toUpperCase();
  try {
    const result = await pool.query(
      `insert into instruments (symbol, exchange, lot_size, is_active, name, provider_symbol, instrument_type, canonical_source)
       values ($1, $2, 1, true, $3, $4, $5, 'search')
       on conflict (symbol) do update set
         is_active = true,
         name = coalesce(excluded.name, instruments.name),
         provider_symbol = coalesce(excluded.provider_symbol, instruments.provider_symbol),
         instrument_type = coalesce(excluded.instrument_type, instruments.instrument_type),
         exchange = coalesce(excluded.exchange, instruments.exchange)
       returning symbol, exchange, name, provider_symbol, instrument_type, lot_size`,
      [symbol, exchange, name, providerSymbol, instrumentType],
    );
    const row = result.rows[0];
    return res.json({
      ok: true,
      symbol: row.symbol,
      tracking: true,
      providerSymbol: row.provider_symbol,
      instrumentType: row.instrument_type,
      underlyingLotSize: row.lot_size == null ? null : Number(row.lot_size),
      message: "Underlying activated for configured option-chain providers. Option contract lot size is resolved separately from contract metadata.",
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: "OPTION_TRACK_FAILED", message: error instanceof Error ? error.message : "update_failed" });
  }
});

app.get("/api/options/chain", async (req, res) => {
  if (!pool) return noDb(res);
  const symbol = String(req.query.symbol ?? "").trim().toUpperCase();
  if (!symbol) return res.json({ ok: true, symbol: null, rows: [], status: "UNDERLYING_REQUIRED" });
  try {
    const result = await pool.query(`select oc.expiry_date, oc.strike, oc.option_type, oc.lot_size, os.source, os.market_timestamp, os.ltp, os.bid, os.ask, os.oi, os.oi_change, os.iv from option_snapshots os join option_contracts oc on oc.contract_id=os.contract_id join instruments i on i.instrument_id=oc.instrument_id where i.symbol=$1 and os.market_timestamp=(select max(os2.market_timestamp) from option_snapshots os2 join option_contracts oc2 on oc2.contract_id=os2.contract_id where oc2.instrument_id=oc.instrument_id) order by oc.expiry_date, oc.strike, oc.option_type`, [symbol]);
    if (!result.rows.length) return res.json({ ok: true, symbol, rows: [] });
    return res.json({ ok: true, symbol, rows: result.rows.map((row) => ({ expiry_date: row.expiry_date, strike: finite(row.strike), option_type: row.option_type, timestamp: iso(row.market_timestamp), ltp: finite(row.ltp), bid: finite(row.bid), ask: finite(row.ask), oi: finite(row.oi), oiChange: finite(row.oi_change), iv: finite(row.iv), source: row.source ?? null, lot_size: row.lot_size == null ? null : Number(row.lot_size) })) });
  } catch (error) { return res.status(500).json({ ok: false, error: "OPTION_QUERY_FAILED", message: error instanceof Error ? error.message : "query_failed" }); }
});

app.get("/api/options/intelligence", async (req, res) => {
  if (!pool) return noDb(res);
  const symbol = String(req.query.symbol ?? "").trim().toUpperCase();
  if (!symbol) return res.json({ ok: false, status: "ABSTAIN", error: "UNDERLYING_REQUIRED", symbol: null });
  if (invalidSymbol(symbol)) return res.status(400).json({ ok: false, error: "INVALID_SYMBOL" });
  try {
    const spotResult = await pool.query(`select pb.close from price_bars pb join instruments i on i.instrument_id=pb.instrument_id where i.symbol=$1 order by pb.market_timestamp desc limit 1`, [symbol]);
    const chainResult = await pool.query(`select oc.expiry_date, oc.strike, oc.option_type, oc.lot_size, os.market_timestamp, os.ltp, os.bid, os.ask, os.oi, os.oi_change, os.iv, os.volume from option_snapshots os join option_contracts oc on oc.contract_id=os.contract_id join instruments i on i.instrument_id=oc.instrument_id where i.symbol=$1 and os.market_timestamp=(select max(os2.market_timestamp) from option_snapshots os2 join option_contracts oc2 on oc2.contract_id=os2.contract_id where oc2.instrument_id=oc.instrument_id) order by oc.expiry_date, oc.strike, oc.option_type`, [symbol]);
    const rows = chainResult.rows.map((row) => ({ expiryDate: String(row.expiry_date), strike: Number(row.strike), optionType: row.option_type as "CE" | "PE", timestamp: new Date(row.market_timestamp), ltp: finite(row.ltp), bid: finite(row.bid), ask: finite(row.ask), oi: finite(row.oi), oiChange: finite(row.oi_change), iv: finite(row.iv), volume: finite(row.volume), lotSize: row.lot_size == null ? null : Math.max(1, Number(row.lot_size)) }));
    return res.json(analyzeOptionChain(symbol, rows, spotResult.rows.length ? finite(spotResult.rows[0].close) : null));
  } catch (error) { return res.status(500).json({ ok: false, error: "OPTION_INTELLIGENCE_FAILED", message: error instanceof Error ? error.message : "query_failed" }); }
});

app.use("/api/shadow", createShadowRouter(pool));
app.use("/api/paper", createPaperRouter(pool));
// Optional bring-your-own-key assistant; loopback-only, key never leaves as-is.
app.use("/api/ai", createAiRouter(pool));
// Runtime database status is intentionally read-only. The host installer owns
// configuration; this endpoint exposes the state already supplied to the API container.
app.get("/api/system/database", async (_req, res) => {
  const modeValue = String(process.env.DATABASE_MODE ?? "").trim();
  const mode = modeValue === "local_postgres" || modeValue === "supabase_cloud" || modeValue === "supabase_self_hosted" ? modeValue : null;
  const configured = Boolean(mode && process.env.DATABASE_URL);
  if (!configured) {
    return res.json({
      ok: true,
      configured: false,
      healthy: false,
      mode,
      dataRoot: process.env.D_PREDICT_DATA_DIR ?? null,
      configPath: process.env.DPREDICT_CONFIG_PATH ?? null,
      error: "DATABASE_NOT_CONFIGURED",
    });
  }
  try {
    await pool?.query("select 1");
    return res.json({
      ok: true,
      configured: true,
      healthy: true,
      mode,
      dataRoot: mode === "local_postgres" ? (process.env.D_PREDICT_DATA_DIR ?? null) : null,
      configPath: process.env.DPREDICT_CONFIG_PATH ?? null,
      error: null,
    });
  } catch (error) {
    return res.json({
      ok: true,
      configured: true,
      healthy: false,
      mode,
      dataRoot: mode === "local_postgres" ? (process.env.D_PREDICT_DATA_DIR ?? null) : null,
      configPath: process.env.DPREDICT_CONFIG_PATH ?? null,
      error: error instanceof Error ? error.message : "DATABASE_UNHEALTHY",
    });
  }
});

// The API runs inside Docker and cannot directly open a Windows PowerShell
// window. The browser therefore receives a host protocol URI; the installer
// registers dpredict-database:// to launch database-setup.ps1 on Windows.
app.post("/api/system/database/setup", (_req, res) => {
  return res.json({
    ok: true,
    launchUrl: "dpredict-database://open",
    message: "Opening the native D-Predict database setup window.",
  });
});

// Read-only: reports whether a newer public release exists. Applying an update
// is a host-side action the api container cannot perform.
app.get("/api/updates/status", async (_req, res) => {
  try {
    return res.json(await getUpdateStatus());
  } catch (error) { return res.status(500).json({ ok: false, error: "UPDATE_CHECK_FAILED", message: error instanceof Error ? error.message : "check_failed" }); }
});

function normalCdf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const magnitude = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * magnitude);
  const polynomial = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-magnitude * magnitude);
  return 0.5 * (1 + sign * polynomial);
}

app.get("/api/forecast", async (req, res) => {
  if (!pool) return noDb(res);
  const symbol = symbolParam(req.query.symbol);
  const horizonDays = Math.min(30, Math.max(1, Number(req.query.horizon ?? 5)));
  try {
    const result = await pool.query(`select pb.close from price_bars pb join instruments i on i.instrument_id=pb.instrument_id where i.symbol=$1 and pb.timeframe='1d' order by pb.market_timestamp desc limit 250`, [symbol]);
    const closes = result.rows.map((row) => Number(row.close)).filter(Number.isFinite).reverse();
    if (closes.length < 20) return unavailable(res, "INSUFFICIENT_HISTORY", { symbol, daysOfHistoryUsed: closes.length, requiredHistory: 20 });
    const returns = closes.slice(1).map((value, index) => Math.log(value / closes[index]));
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, returns.length - 1);
    const volatility = Math.sqrt(variance);
    const spot = closes[closes.length - 1];
    const expectedReturn = Math.exp(mean * horizonDays) - 1;
    const scale = volatility * Math.sqrt(horizonDays);
    const expectedValue = spot * Math.exp(mean * horizonDays);
    const p10 = spot * Math.exp(mean * horizonDays - 1.2816 * scale);
    const p90 = spot * Math.exp(mean * horizonDays + 1.2816 * scale);
    const probabilityAboveSpot = 1 - normalCdf(-mean * Math.sqrt(horizonDays) / Math.max(volatility, 1e-9));
    const probabilityBelowSpot = 1 - probabilityAboveSpot;
    const directionalEdge = Math.abs(expectedReturn) >= Math.max(0.005, volatility * Math.sqrt(horizonDays) * 0.15);
    const direction = directionalEdge && probabilityAboveSpot >= 0.55 ? "LONG" : directionalEdge && probabilityBelowSpot >= 0.55 ? "SHORT" : "FLAT";
    const strategy = direction === "FLAT" ? "WAIT" : "STAGED_ENTRY";
    const rationale = direction === "FLAT"
      ? "The historical drift is not large enough relative to the forecast range; preserve capital and wait for a better edge."
      : `${direction === "LONG" ? "Positive" : "Negative"} historical drift clears the volatility-adjusted edge threshold, but the distribution remains uncertain; use staged entry rather than a full-size position.`;
    const actionSuggestions = direction === "FLAT"
      ? ["Do not open a new directional position from this forecast alone.", "Wait for a stronger edge or a narrower forecast range.", "Re-check data freshness and evidence before changing the decision."]
      : ["Use staged entry; do not deploy full size at once.", "Re-check the quote and signal before each tranche.", "Exit the thesis if price closes beyond the invalidation boundary."];
    return res.json({ ok: true, symbol, spot, dailyVolatility: volatility, daysOfHistoryUsed: closes.length, horizonDays, paths: 0, probabilityAboveSpot, probabilityBelowSpot, expectedValue, expectedReturn, forecastRange: { low: p10, high: p90 }, bands: Array.from({ length: horizonDays }, (_, index) => { const day = index + 1; const dayScale = volatility * Math.sqrt(day); return { day, p10: spot * Math.exp(mean * day - 1.2816 * dayScale), p25: spot * Math.exp(mean * day - 0.6745 * dayScale), median: spot * Math.exp(mean * day), p75: spot * Math.exp(mean * day + 0.6745 * dayScale), p90: spot * Math.exp(mean * day + 1.2816 * dayScale) }; }), strategy: { direction, action: strategy, rationale, positionSizing: direction === "FLAT" ? "0% until edge improves" : "Risk no more than 0.5% of capital; scale in 25% / 25% / 50%", invalidation: `Invalidate if price closes beyond the ${direction === "LONG" ? "lower" : "upper"} forecast boundary or the next data refresh materially changes the distribution.` }, actionSuggestions, status: "STATISTICAL_BASELINE", limitations: ["Uses historical daily log returns, not a causal fundamental model.", "Forecast uncertainty widens with horizon and does not account for gaps, news or liquidity.", "Expected value is a distribution median, not a guaranteed price."] });
  } catch (error) { return res.status(500).json({ ok: false, error: "FORECAST_FAILED", message: error instanceof Error ? error.message : "query_failed" }); }
});
app.get("/api/market/scan", async (req, res) => {
  if (!pool) return noDb(res);
  const limit = Math.min(5, Math.max(1, Number(req.query.limit ?? 5)));
  const roundTripCost = Number(process.env.SCANNER_ROUND_TRIP_COST ?? 0.002);
  try {
    return res.json(await runMarketScan(pool, { limit, roundTripCost }));
  } catch (error) { return res.status(500).json({ ok: false, error: "MARKET_SCAN_FAILED", message: error instanceof Error ? error.message : "query_failed" }); }
});

app.get("/api/alerts", async (req, res) => {
  if (!pool) return noDb(res);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
  const symbol = req.query.symbol == null ? null : symbolParam(req.query.symbol);
  if (symbol && invalidSymbol(symbol)) return res.status(400).json({ ok: false, error: "INVALID_SYMBOL" });
  try {
    const [rows, unread] = await Promise.all([
      fetchRecentAlerts(pool, limit, symbol),
      pool.query("select count(*)::int as count from buy_alerts where acknowledged = false"),
    ]);
    return res.json({
      ok: true,
      alerts: rows.map(mapAlertRow),
      unreadCount: Number(unread.rows[0]?.count ?? 0),
      disclaimer: "Rule-evidence flags from closed-form screens over real daily bars (collector radar), not investment advice. No ML model participates: every artifact currently fails the OOS promotion gate.",
    });
  } catch (error) { return res.status(500).json({ ok: false, error: "ALERTS_QUERY_FAILED", message: error instanceof Error ? error.message : "query_failed" }); }
});

app.post("/api/alerts/ack-all", async (_req, res) => {
  if (!pool) return noDb(res);
  try {
    const acknowledged = await acknowledgeAllAlerts(pool);
    return res.json({ ok: true, acknowledged });
  } catch (error) { return res.status(500).json({ ok: false, error: "ALERT_ACK_FAILED", message: error instanceof Error ? error.message : "update_failed" }); }
});

app.post("/api/alerts/:id/ack", async (req, res) => {
  if (!pool) return noDb(res);
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "INVALID_ALERT_ID" });
  try {
    const result = await pool.query("update buy_alerts set acknowledged = true where id = $1 returning id", [id]);
    if (result.rowCount === 0) return res.status(404).json({ ok: false, error: "ALERT_NOT_FOUND", id });
    return res.json({ ok: true, id });
  } catch (error) { return res.status(500).json({ ok: false, error: "ALERT_ACK_FAILED", message: error instanceof Error ? error.message : "update_failed" }); }
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

await ensureOptionContractMetadata(pool!);
const server = app.listen(port, "0.0.0.0", () => console.log(`D-predict backend listening on ${port}`));
attachLiveHub(server, pool);
const shutdown = async () => { server.close(); await pool?.end(); process.exit(0); };
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
export { app };
