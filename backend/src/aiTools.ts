// Agent tools. Every number a tool returns comes from the local Postgres store
// or the local ML service — this file never computes a probability and never
// falls back to an example or placeholder value. When data is missing the tool
// says so; a failed tool is a failed tool.
// Four tools change app state (train, watchlist add/remove, alert ack). Each one
// is gated: aiAgent.ts will not execute it until the user approves that exact
// change in the dashboard, and it runs the same appActions.ts statements the
// dashboard itself uses.
import type { Pool } from "pg";
import { BACKTEST_STRATEGIES, runBacktest, type BacktestStrategy } from "./backtest.js";
import { computePredictionPerformance } from "./predictionStats.js";
import { runMarketScan } from "./marketScan.js";
import { fetchRecentAlerts, mapAlertRow } from "./alertFeed.js";
import {
  TRAIN_TIMEOUT_MS,
  acknowledgeAlertIds,
  addWatchlistItem,
  retrainSymbol,
  removeWatchlistItem,
  unreadAlertCount,
} from "./appActions.js";\nimport { analyzeOptionChain, type OptionType } from "./optionIntelligence.js";

/** Anything longer is cut and the cut is declared inside the payload. Sized so a
 * full 26-instrument coverage report fits without losing its tail. */
export const TOOL_RESULT_CHAR_CAP = 12_000;

const HORIZONS = ["1d", "3d", "5d"] as const;
const SYMBOL_PATTERN = /^[A-Z0-9._-]{1,32}$/;
const NO_DATABASE = "The local database is not running, so no stored market data can be read. Start D-Predict and ask again.";

export type MlCall = (path: string, init?: RequestInit, timeoutMs?: number) => Promise<{ status: number; body: any }>;
export type ToolEnv = { pool: Pool | null; mlFetch: MlCall };
export type ToolOutcome = { ok: boolean; summary: string; data: unknown };

export type ToolSpec = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

type ToolDefinition = {
  spec: ToolSpec;
  run: (env: ToolEnv, args: Record<string, unknown>) => Promise<ToolOutcome>;
  /** Write tools change app state and only run after the user approves them. */
  write?: boolean;
  /** Plain sentence naming exactly what will change, shown on the approval card. */
  describeWrite?: (args: Record<string, unknown>) => string;
};

const round = (value: unknown, places = 4): number | null => {
  const number = Number(value);
  return value == null || !Number.isFinite(number) ? null : Number(number.toFixed(places));
};

const std = (values: number[]): number => {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
};

const iso = (value: unknown): string | null => {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

function fail(code: string, message: string): ToolOutcome {
  return { ok: false, summary: `${code} — ${message}`, data: { error: code, message } };
}

function symbolOf(value: unknown): string | null {
  const symbol = String(value ?? "").trim().toUpperCase();
  return SYMBOL_PATTERN.test(symbol) ? symbol : null;
}

function intOf(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function horizonOf(value: unknown): string {
  const horizon = String(value ?? "1d").trim().toLowerCase();
  return (HORIZONS as readonly string[]).includes(horizon) ? horizon : "1d";
}

/** Daily closes for a symbol, newest last, with the age of the newest bar. */
async function loadDailyBars(pool: Pool, symbol: string, days: number) {
  const result = await pool.query(
    `select pb.market_timestamp, pb.close from price_bars pb
       join instruments i on i.instrument_id = pb.instrument_id
      where upper(i.symbol) = $1 and pb.timeframe = '1d'
      order by pb.market_timestamp desc limit $2`,
    [symbol, days],
  );
  const bars = result.rows
    .reverse()
    .map((row) => ({ timestamp: iso(row.market_timestamp), close: Number(row.close) }))
    .filter((bar): bar is { timestamp: string; close: number } => !!bar.timestamp && Number.isFinite(bar.close) && bar.close > 0);
  const lastTimestamp = bars.length ? bars[bars.length - 1].timestamp : null;
  const ageSeconds = lastTimestamp ? Math.max(0, (Date.now() - Date.parse(lastTimestamp)) / 1000) : null;
  return { bars, lastTimestamp, ageSeconds, fresh: ageSeconds != null && ageSeconds <= 172800 };
}

async function dailyHistoryTool(env: ToolEnv, args: Record<string, unknown>): Promise<ToolOutcome> {
  const symbol = symbolOf(args.symbol);
  if (!symbol) return fail("INVALID_SYMBOL", "Provide one stored symbol such as NIFTY or RELIANCE (1-32 characters).");
  if (!env.pool) return fail("DATABASE_UNAVAILABLE", NO_DATABASE);
  const days = intOf(args.days, 120, 5, 730);
  const { bars, lastTimestamp, ageSeconds, fresh } = await loadDailyBars(env.pool, symbol, days);
  if (!bars.length) return fail("NO_STORED_BARS", `${symbol} has no daily bars in this database. Nothing was simulated in its place.`);
  const closes = bars.map((bar) => bar.close);
  const returns = closes.slice(1).map((close, index) => close / closes[index] - 1);
  const first = closes[0];
  const last = closes[closes.length - 1];
  let peak = first;
  let maxDrawdown = 0;
  for (const close of closes) {
    peak = Math.max(peak, close);
    maxDrawdown = Math.min(maxDrawdown, close / peak - 1);
  }
  const data = {
    symbol,
    requestedDays: days,
    observations: bars.length,
    firstBar: bars[0].timestamp,
    lastBar: lastTimestamp,
    barAgeSeconds: round(ageSeconds, 0),
    dataStatus: fresh ? "FRESH" : "STALE",
    lastClose: round(last, 2),
    firstClose: round(first, 2),
    windowReturn: round(last / first - 1, 5),
    meanDailyReturn: returns.length ? round(returns.reduce((a, b) => a + b, 0) / returns.length, 6) : null,
    annualizedVolatility: returns.length > 1 ? round(std(returns) * Math.sqrt(252), 5) : null,
    maxDrawdownInWindow: round(maxDrawdown, 5),
    bestDay: returns.length ? round(Math.max(...returns), 5) : null,
    worstDay: returns.length ? round(Math.min(...returns), 5) : null,
    recentCloses: bars.slice(-15).map((bar) => ({ date: bar.timestamp.slice(0, 10), close: round(bar.close, 2) })),
  };
  return {
    ok: true,
    summary: `${symbol}: ${bars.length} stored daily bars, last close ₹${data.lastClose?.toLocaleString("en-IN")} (${data.lastBar?.slice(0, 10)}), ${(data.windowReturn! * 100).toFixed(2)}% over the window, annualized vol ${(data.annualizedVolatility! * 100).toFixed(1)}%, data ${data.dataStatus}.`,
    data,
  };
}

async function backtestTool(env: ToolEnv, args: Record<string, unknown>): Promise<ToolOutcome> {
  const symbol = symbolOf(args.symbol);
  if (!symbol) return fail("INVALID_SYMBOL", "Provide one stored symbol to backtest.");
  const strategy = String(args.strategy ?? "sma_trend").trim().toLowerCase();
  if (!(BACKTEST_STRATEGIES as readonly string[]).includes(strategy)) {
    return fail("INVALID_STRATEGY", `strategy must be one of: ${BACKTEST_STRATEGIES.join(", ")}.`);
  }
  const days = intOf(args.days, 365, 60, 1825);
  if (!env.pool) return fail("DATABASE_UNAVAILABLE", NO_DATABASE);
  const { bars } = await loadDailyBars(env.pool, symbol, days);
  const outcome = runBacktest(bars.map((bar) => ({ timestamp: bar.timestamp as string, close: bar.close })), strategy as BacktestStrategy);
  if (!outcome.ok) {
    return fail(outcome.error ?? "BACKTEST_FAILED", `${symbol} has ${outcome.bars} stored daily bars; this strategy needs ${outcome.requiredBars}. No synthetic bars were added.`);
  }
  const { equityCurve: _curve, tradeLog, ...metrics } = outcome;
  const data = {
    symbol,
    ...metrics,
    recentTrades: tradeLog.slice(-5).map((trade) => ({
      entry: trade.entryTimestamp.slice(0, 10),
      exit: trade.exitTimestamp.slice(0, 10),
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      netPnl: trade.netPnl,
      costs: trade.costs,
      exitReason: trade.exitReason,
    })),
    note: "Computed from stored real daily bars, next-bar execution, real charge model. Long-only; results are not a forward return forecast.",
  };
  return {
    ok: true,
    summary: `Backtest ${symbol} · ${strategy} · ${outcome.bars} bars: total ${round(outcome.totalReturn! * 100, 2)}%, ${outcome.trades} trades (win rate ${outcome.winRate == null ? "n/a" : `${round(outcome.winRate * 100, 1)}%`}), max drawdown ${round(outcome.maxDrawdown! * 100, 2)}%, costs ₹${outcome.totalCosts.toLocaleString("en-IN")}.`,
    data,
  };
}

/** Keeps the ML payload small and free of per-feature noise the model can misread. */
function forecastFields(body: Record<string, any>) {
  return {
    symbol: body.symbol ?? null,
    timestamp: iso(body.timestamp) ?? body.timestamp ?? null,
    horizon: body.horizon ?? null,
    modelVersion: body.model_version ?? null,
    modelStatus: body.model_status ?? null,
    dataStatus: body.data_status ?? null,
    prediction: body.prediction ?? null,
    probabilities: body.probabilities ?? null,
    metaProbability: round(body.meta_probability, 6),
    expectedReturn: round(body.expected_return, 6),
    confidence: round(body.confidence, 6),
    returnInterval: body.return_interval ?? null,
    calibrationStatus: body.calibration_status ?? null,
    predictionStatus: body.prediction_status ?? null,
    actionStatus: body.action_status ?? null,
    actionReasons: body.action_reasons ?? null,
    promotionChecks: body.promotion_checks ?? null,
    oosMetrics: body.oos_metrics ?? null,
  };
}

async function callMlForecast(env: ToolEnv, symbol: string, horizon: string) {
  const { status, body } = await env.mlFetch(
    "/predict",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbol, horizon }) },
    30_000,
  );
  if (status === 404 || status === 503) {
    const detail = body?.detail;
    const reason = typeof detail === "string" ? detail : (detail?.message ?? detail?.code ?? null);
    return { ok: false as const, code: status === 404 ? "NO_PREDICTION_HISTORY" : "MODEL_NOT_READY", reason: reason ?? "the model refused this symbol" };
  }
  if (status < 200 || status >= 300 || !body || body.ok === false) {
    return { ok: false as const, code: "ML_UPSTREAM_ERROR", reason: typeof body?.detail === "string" ? body.detail : `HTTP ${status}` };
  }
  return { ok: true as const, forecast: forecastFields(body) };
}

async function freshForecastTool(env: ToolEnv, args: Record<string, unknown>): Promise<ToolOutcome> {
  const symbol = symbolOf(args.symbol);
  if (!symbol) return fail("INVALID_SYMBOL", "Provide one symbol to ask the model about.");
  const horizon = horizonOf(args.horizon);
  const result = await callMlForecast(env, symbol, horizon);
  if (!result.ok) return fail(result.code, `${symbol} ${horizon}: no live prediction — ${result.reason}. The model was not asked again and nothing was substituted.`);
  const f = result.forecast;
  return {
    ok: true,
    summary: `Live ${symbol} ${horizon} from ${f.modelVersion ?? "the model"}: ${f.prediction}, expected return ${f.expectedReturn == null ? "n/a" : `${(f.expectedReturn * 100).toFixed(2)}%`}, ${f.calibrationStatus}, ${f.predictionStatus}.`,
    data: f,
  };
}

async function ledgerHistoryTool(env: ToolEnv, args: Record<string, unknown>): Promise<ToolOutcome> {
  const symbol = symbolOf(args.symbol);
  if (!symbol) return fail("INVALID_SYMBOL", "Provide one symbol whose ledger rows you want.");
  const limit = intOf(args.limit, 20, 1, 60);
  if (!env.pool) return fail("DATABASE_UNAVAILABLE", NO_DATABASE);
  const result = await env.pool.query(
    `select timestamp, horizon, model_version, expected_return, confidence, meta_probability, regime,
            outcome_class, outcome_return, evaluated_at,
            evidence->>'prediction' as predicted_class,
            evidence->>'calibrationStatus' as calibration_status,
            evidence->>'predictionStatus' as prediction_status,
            evidence->>'actionStatus' as action_status,
            evidence->'probabilities' as probabilities
       from prediction_ledger where upper(symbol) = $1 order by timestamp desc limit $2`,
    [symbol, limit],
  );
  if (!result.rows.length) return fail("NO_LEDGER_ROWS", `${symbol} has no stored prediction ledger rows. Nothing was back-filled from elsewhere.`);
  const rows = result.rows.map((row) => ({
    timestamp: iso(row.timestamp),
    horizon: row.horizon,
    modelVersion: row.model_version,
    predictedClass: row.predicted_class ?? null,
    probabilities: row.probabilities ?? null,
    expectedReturn: round(row.expected_return, 6),
    confidence: round(row.confidence, 6),
    metaProbability: round(row.meta_probability, 6),
    regime: row.regime ?? null,
    calibrationStatus: row.calibration_status ?? null,
    predictionStatus: row.prediction_status ?? null,
    actionStatus: row.action_status ?? null,
    outcomeClass: row.outcome_class ?? null,
    outcomeReturn: round(row.outcome_return, 6),
    evaluatedAt: iso(row.evaluated_at),
  }));
  const scored = rows.filter((row) => row.evaluatedAt);
  const hits = scored.filter((row) => row.outcomeClass && row.predictedClass === row.outcomeClass).length;
  return {
    ok: true,
    summary: `${symbol}: ${rows.length} ledger rows, newest ${rows[0]?.timestamp?.slice(0, 10)} (${rows[0]?.predictedClass ?? "no class"}); ${scored.length} scored, ${hits} correct, ${rows.length - scored.length} still pending.`,
    data: { symbol, rows, scoredCount: scored.length, correctCount: hits, pendingCount: rows.length - scored.length },
  };
}

/**
 * "Refinement" as scoped: ask the model again and report the gap against the
 * stored ledger row. Both numbers stay; the divergence is computed here in code
 * so the model cannot be the one doing arithmetic.
 */
async function compareForecastTool(env: ToolEnv, args: Record<string, unknown>): Promise<ToolOutcome> {
  const symbol = symbolOf(args.symbol);
  if (!symbol) return fail("INVALID_SYMBOL", "Provide one symbol to compare.");
  const horizon = horizonOf(args.horizon);
  if (!env.pool) return fail("DATABASE_UNAVAILABLE", NO_DATABASE);
  const [live, stored] = await Promise.all([
    callMlForecast(env, symbol, horizon),
    env.pool.query(
      `select timestamp, model_version, expected_return, confidence, outcome_class, outcome_return,
              evidence->>'prediction' as predicted_class,
              evidence->>'calibrationStatus' as calibration_status,
              evidence->>'predictionStatus' as prediction_status
         from prediction_ledger where upper(symbol) = $1 and horizon = $2 order by timestamp desc limit 1`,
      [symbol, horizon],
    ),
  ]);
  const ledger = stored.rows[0];
  const persisted = ledger
    ? {
        timestamp: iso(ledger.timestamp),
        modelVersion: ledger.model_version ?? null,
        predictedClass: ledger.predicted_class ?? null,
        expectedReturn: round(ledger.expected_return, 6),
        confidence: round(ledger.confidence, 6),
        calibrationStatus: ledger.calibration_status ?? null,
        predictionStatus: ledger.prediction_status ?? null,
        outcomeClass: ledger.outcome_class ?? null,
        outcomeReturn: round(ledger.outcome_return, 6),
      }
    : null;
  if (!live.ok) {
    return {
      ok: true,
      summary: `${symbol} ${horizon}: the model could not be re-asked (${live.code} — ${live.reason}). Only the stored ledger row is available.`,
      data: { symbol, horizon, liveForecast: null, storedPrediction: persisted, comparisonStatus: "LIVE_UNAVAILABLE", liveError: live.code, liveReason: live.reason },
    };
  }
  if (!persisted) {
    return {
      ok: true,
      summary: `${symbol} ${horizon}: a live forecast exists but no stored ledger row for this horizon, so there is nothing to compare against.`,
      data: { symbol, horizon, liveForecast: live.forecast, storedPrediction: null, comparisonStatus: "NO_STORED_ROW" },
    };
  }
  const directionChanged = live.forecast.prediction !== persisted.predictedClass;
  const expectedReturnDelta =
    live.forecast.expectedReturn != null && persisted.expectedReturn != null
      ? round(live.forecast.expectedReturn - persisted.expectedReturn, 6)
      : null;
  const confidenceDelta =
    live.forecast.confidence != null && persisted.confidence != null
      ? round(live.forecast.confidence - persisted.confidence, 6)
      : null;
  const modelChanged = live.forecast.modelVersion !== persisted.modelVersion;
  const materialReturn = expectedReturnDelta != null && Math.abs(expectedReturnDelta) >= 0.01;
  const status = directionChanged && materialReturn
    ? "CLASS_AND_RETURN_DIVERGED"
    : directionChanged
      ? "CLASS_DIFFERS"
      : materialReturn
        ? "MATERIAL_RETURN_DIVERGED"
        : "CONSISTENT";
  const pp = (value: number | null) => (value == null ? "n/a" : `${(value * 100).toFixed(2)}%`);
  const causes: string[] = [];
  if (directionChanged) causes.push(`direction flipped ${persisted.predictedClass ?? "n/a"} → ${live.forecast.prediction}`);
  if (materialReturn) causes.push(`expected return moved ${expectedReturnDelta! > 0 ? "+" : ""}${(expectedReturnDelta! * 100).toFixed(2)} pp`);
  // A new model version is a caveat on a matching answer, not a cause of divergence.
  const modelNote = modelChanged ? `model version changed ${persisted.modelVersion ?? "n/a"} → ${live.forecast.modelVersion ?? "n/a"}` : null;
  const detail = causes.length
    ? `${causes.join("; ")}${modelNote ? `; ${modelNote}` : ""}`
    : modelNote
      ? `same direction and within 1pp of the stored return, but ${modelNote}`
      : "same direction and within 1pp of the stored return";
  return {
    ok: true,
    summary: `${symbol} ${horizon}: live ${live.forecast.prediction} (${pp(live.forecast.expectedReturn)}) vs stored ${persisted.predictedClass ?? "n/a"} (${pp(persisted.expectedReturn)}) → ${status}${causes.length ? ` because ${detail}` : ` — ${detail}`}. Neither number was replaced.`,
    data: {
      symbol,
      horizon,
      liveForecast: live.forecast,
      storedPrediction: persisted,
      divergence: { directionChanged, expectedReturnDelta, confidenceDelta, modelVersionChanged: modelChanged },
      comparisonStatus: status,
      note: "The stored ledger row is the signal that was actually recorded at the time; the live forecast is a fresh run against today's stored bars. Both are kept and neither overwrites the other.",
    },
  };
}

async function predictionPerformanceTool(env: ToolEnv, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!env.pool) return fail("DATABASE_UNAVAILABLE", NO_DATABASE);
  const days = intOf(args.days, 90, 1, 1095);
  const result = await computePredictionPerformance(env.pool, days);
  const scored = result.metrics.scoredPredictions;
  if (!scored) return fail("NO_SCORED_PREDICTIONS", `No ledger rows in the last ${days} days have a realized outcome yet, so accuracy cannot be measured. Pending: ${result.metrics.pendingPredictions}.`);
  const pct = (value: number | null) => (value == null ? "n/a" : `${(value * 100).toFixed(1)}%`);
  return {
    ok: true,
    summary: `Ledger, last ${days}d: ${scored} scored predictions, accuracy ${pct(result.metrics.accuracy)}, directional ${pct(result.metrics.directionalAccuracy)}, log loss ${result.metrics.logLoss == null ? "n/a" : round(result.metrics.logLoss, 3)}, calibration error ${pct(result.metrics.calibrationError)}.`,
    data: result,
  };
}

async function recentAlertsTool(env: ToolEnv, args: Record<string, unknown>): Promise<ToolOutcome> {
  const limit = intOf(args.limit, 20, 1, 100);
  const symbol = args.symbol == null || String(args.symbol).trim() === "" ? null : symbolOf(args.symbol);
  if (args.symbol != null && String(args.symbol).trim() !== "" && !symbol) return fail("INVALID_SYMBOL", "Provide one symbol, or omit it for the whole radar.");
  if (!env.pool) return fail("DATABASE_UNAVAILABLE", NO_DATABASE);
  const rows = await fetchRecentAlerts(env.pool, limit, symbol);
  if (!rows.length) return fail("NO_ALERTS", `No radar alerts stored${symbol ? ` for ${symbol}` : ""}. The collector writes rows during NSE sessions; nothing was invented.`);
  const alerts = rows.map((row) => {
    const mapped = mapAlertRow(row);
    return { symbol: mapped.symbol, rule: mapped.rule, price: mapped.price, marketTimestamp: mapped.marketTimestamp, evidence: mapped.evidence, newToRadar: mapped.newToRadar, createdAt: mapped.createdAt };
  });
  const rules = alerts.reduce<Record<string, number>>((counts, alert) => ({ ...counts, [alert.rule]: (counts[alert.rule] ?? 0) + 1 }), {});
  return {
    ok: true,
    summary: `${alerts.length} radar rows${symbol ? ` for ${symbol}` : ""}: ${Object.entries(rules).map(([rule, count]) => `${rule} ×${count}`).join(", ")}.`,
    data: { alerts, ruleCounts: rules, disclaimer: "Closed-form rule flags over real stored bars. No ML model participates." },
  };
}

async function modelCoverageTool(env: ToolEnv, args: Record<string, unknown>): Promise<ToolOutcome> {
  const horizons = Array.isArray(args.horizons) ? args.horizons.map(String).join(",") : String(args.horizons ?? "").trim();
  const query = horizons ? `?horizons=${encodeURIComponent(horizons.slice(0, 32))}` : "";
  const { status, body } = await env.mlFetch(`/training/coverage${query}`, {}, 20_000);
  if (status < 200 || status >= 300 || !body) return fail("ML_COVERAGE_UNAVAILABLE", `The training service did not return coverage (HTTP ${status}). It may be starting up.`);
  const instruments = Array.isArray(body.instruments) ? body.instruments : Array.isArray(body.coverage) ? body.coverage : [];
  const ready = instruments.filter((entry: any) => entry.ready === true || entry.trained === true).length;
  return {
    ok: true,
    summary: instruments.length
      ? `Model coverage: ${ready}/${instruments.length} instrument-horizon bundles built${body.promotionReady || body.promotion_ready ? " · promotion-ready gate reported" : ""}.`
      : `Model coverage reported: ${JSON.stringify(body).slice(0, 200)}`,
    data: body,
  };
}

async function optionChainTool(env: ToolEnv, args: Record<string, unknown>): Promise<ToolOutcome> {
  const symbol = symbolOf(args.symbol);
  if (!symbol) return fail("INVALID_SYMBOL", "Provide NIFTY or BANKNIFTY (or another stored index symbol).");
  if (!env.pool) return fail("DATABASE_UNAVAILABLE", NO_DATABASE);
  const result = await env.pool.query(`select oc.expiry_date, oc.strike, oc.option_type, os.market_timestamp, os.ltp, os.bid, os.ask, os.oi, os.oi_change, os.iv, os.volume
    from option_snapshots os join option_contracts oc on oc.contract_id=os.contract_id join instruments i on i.instrument_id=oc.instrument_id
    where i.symbol=$1 and os.market_timestamp=(select max(os2.market_timestamp) from option_snapshots os2 join option_contracts oc2 on oc2.contract_id=os2.contract_id where oc2.instrument_id=oc.instrument_id)
    order by oc.expiry_date, oc.strike, oc.option_type`, [symbol]);
  if (!result.rows.length) return fail("NO_OPTION_CHAIN", `${symbol} has no persisted option-chain snapshot.`);
  const rows = result.rows.map(r => ({ expiryDate: String(r.expiry_date), strike: Number(r.strike), optionType: String(r.option_type) as OptionType, timestamp: new Date(r.market_timestamp), ltp: round(r.ltp,2), bid: round(r.bid,2), ask: round(r.ask,2), oi: round(r.oi,0), oiChange: round(r.oi_change,0), iv: round(r.iv,2), volume: round(r.volume,0) }));
  return { ok: true, summary: `${symbol}: ${rows.length} option contracts across ${new Set(rows.map(r=>r.expiryDate)).size} expiry snapshot(s).`, data: { symbol, rows } };
}

async function optionIntelligenceTool(env: ToolEnv, args: Record<string, unknown>): Promise<ToolOutcome> {
  const symbol = symbolOf(args.symbol);
  if (!symbol) return fail("INVALID_SYMBOL", "Provide the stored underlying symbol.");
  if (!env.pool) return fail("DATABASE_UNAVAILABLE", NO_DATABASE);
  const [spot, chain] = await Promise.all([
    env.pool.query(`select close from price_bars pb join instruments i on i.instrument_id=pb.instrument_id where i.symbol=$1 order by pb.market_timestamp desc limit 1`, [symbol]),
    env.pool.query(`select oc.expiry_date, oc.strike, oc.option_type, os.market_timestamp, os.ltp, os.bid, os.ask, os.oi, os.oi_change, os.iv, os.volume
      from option_snapshots os join option_contracts oc on oc.contract_id=os.contract_id join instruments i on i.instrument_id=oc.instrument_id
      where i.symbol=$1 and os.market_timestamp=(select max(os2.market_timestamp) from option_snapshots os2 join option_contracts oc2 on oc2.contract_id=os2.contract_id where oc2.instrument_id=oc.instrument_id)
      order by oc.expiry_date, oc.strike, oc.option_type`, [symbol]),
  ]);
  const rows = chain.rows.map(r => ({ expiryDate:String(r.expiry_date), strike:Number(r.strike), optionType:String(r.option_type) as OptionType, timestamp:new Date(r.market_timestamp), ltp:finite(r.ltp), bid:finite(r.bid), ask:finite(r.ask), oi:finite(r.oi), oiChange:finite(r.oi_change), iv:finite(r.iv), volume:finite(r.volume) }));
  const intelligence = analyzeOptionChain(symbol, rows, spot.rows.length ? finite(spot.rows[0].close) : null);
  return { ok: intelligence.ok, summary: `${symbol}: ${intelligence.status} · ${intelligence.recommendation.action} · ${intelligence.recommendation.direction} · confidence ${(intelligence.recommendation.confidence*100).toFixed(0)}%.`, data: intelligence };
}

function finite(value: unknown): number | null {
  const n = Number(value);
  return value == null || !Number.isFinite(n) ? null : n;
}

async function optionCandidateTool(env: ToolEnv, args: Record<string, unknown>): Promise<ToolOutcome> {
  const symbol = symbolOf(args.symbol);
  if (!symbol) return fail("INVALID_SYMBOL", "Provide the underlying symbol.");
  const intelligence = await optionIntelligenceTool(env, { symbol });
  if (!intelligence.ok) return intelligence;
  const data = intelligence.data as any;
  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  const preferred = data?.recommendation?.contract;
  if (!preferred) return fail("NO_OPTION_CANDIDATE", `${symbol}: no contract passed the current chain evidence gates.`);
  return { ok: true, summary: `${symbol}: candidate ${preferred.optionType} ${preferred.strike} ${preferred.expiry} at ask ₹${preferred.ask}; action ${data.recommendation.action}.`, data: { symbol, recommendation: data.recommendation, gates: data.gates, topCandidates: candidates.slice(0,10), spot: data.spot, expiry: data.expiry } };
}

async function optionPayoffTool(env: ToolEnv, args: Record<string, unknown>): Promise<ToolOutcome> {
  const optionType = String(args.optionType ?? "").toUpperCase();
  if (optionType !== "CE" && optionType !== "PE") return fail("INVALID_OPTION_TYPE", "optionType must be CE or PE.");
  const strike = Number(args.strike), premium = Number(args.premium), quantity = intOf(args.quantity, 1, 1, 1000000);
  if (!Number.isFinite(strike) || strike <= 0 || !Number.isFinite(premium) || premium < 0) return fail("INVALID_PAYOFF_INPUT", "Provide positive strike and non-negative premium.");
  const expirySpot = Number(args.expirySpot);
  if (!Number.isFinite(expirySpot) || expirySpot < 0) return fail("INVALID_EXPIRY_SPOT", "Provide expirySpot.");
  const intrinsic = optionType === "CE" ? Math.max(0, expirySpot-strike) : Math.max(0, strike-expirySpot);
  const gross = (intrinsic-premium)*quantity;
  return { ok:true, summary:`${optionType} ${strike}: expiry spot ₹${expirySpot} gives gross P&L ₹${gross.toFixed(2)} for ${quantity} units before costs.`, data:{optionType,strike,premium,expirySpot,quantity,intrinsic,grossPnl:gross,breakeven:optionType==="CE"?strike+premium:strike-premium} };
}

async function marketScanTool(env: ToolEnv, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!env.pool) return fail("DATABASE_UNAVAILABLE", NO_DATABASE);
  const limit = intOf(args.limit, 5, 1, 5);
  const roundTripCost = Math.min(0.05, Math.max(0, Number(process.env.SCANNER_ROUND_TRIP_COST ?? 0.002)));
  const scan = await runMarketScan(env.pool, { limit, roundTripCost });
  return {
    ok: true,
    summary: `Market scan: ${scan.picks.length} ranked picks from ${scan.picks.length + scan.excluded.length} tracked instruments (${scan.excluded.length} excluded), market ${scan.marketOpen ? "open" : "closed"}, assumed round-trip cost ${(roundTripCost * 100).toFixed(2)}%.`,
    data: scan,
  };
}

/** FastAPI puts the real reason in `detail`; keep it verbatim, add nothing. */
function mlDetail(body: Record<string, any>): string {
  const detail = body?.detail ?? body?.message ?? body?.error;
  if (detail && typeof detail === "object") return String((detail as Record<string, unknown>).message ?? JSON.stringify(detail)).slice(0, 200);
  return String(detail ?? "no reason reported by the ML service").slice(0, 200);
}

function idsOf(value: unknown): number[] {
  const list = Array.isArray(value) ? value : [value];
  const ids = list.map((entry) => Number(entry)).filter((entry) => Number.isInteger(entry) && entry > 0);
  return [...new Set(ids)].slice(0, 25);
}

/** Retrains one artifact through the app's own training action, then reports the
 * gate's own verdict. The numbers below are copied from the ML response, never
 * produced here. */
async function trainModelTool(env: ToolEnv, args: Record<string, unknown>): Promise<ToolOutcome> {
  const symbol = symbolOf(args.symbol);
  if (!symbol) return fail("INVALID_SYMBOL", "Name one stored symbol to train, such as NIFTY or RELIANCE.");
  const horizon = horizonOf(args.horizon);
  const startedAt = Date.now();
  const { status, body } = await retrainSymbol(env.mlFetch, symbol, horizon, TRAIN_TIMEOUT_MS);
  const seconds = round((Date.now() - startedAt) / 1000, 1);
  if (status === 409) return fail("TRAINING_IN_PROGRESS", `${mlDetail(body)} No artifact was replaced by this request.`);
  if (status === 404) return fail("INACTIVE_INSTRUMENT", `${symbol}: ${mlDetail(body)}. Nothing was trained.`);
  if (status >= 400 || !body || body.ok !== true) {
    return {
      ok: false,
      summary: `Training ${symbol} ${horizon} failed after ${seconds}s: ${status === 200 ? "the ML service reported an unsuccessful run" : `HTTP ${status} — ${mlDetail(body ?? {})}`}. This tool adds no metrics to a failed run.`,
      data: { symbol, horizon, httpStatus: status, detail: body?.detail ?? null, trainingRunId: body?.training_run_id ?? null, durationSeconds: seconds },
    };
  }
  const instrument = (body.instrument ?? {}) as Record<string, any>;
  const promotionReady = instrument.promotion_ready === true;
  const fields = {
    symbol,
    horizon,
    trainingRunId: body.training_run_id ?? null,
    runStatus: body.status ?? null,
    instrumentStatus: instrument.status ?? null,
    reason: instrument.reason ?? null,
    modelVersion: instrument.model_version ?? null,
    bars: instrument.bars ?? null,
    promotionReady,
    metaReady: instrument.meta_ready ?? null,
    oosAccuracy: instrument.oos_accuracy ?? null,
    oosMajorityBaseline: instrument.oos_majority_baseline ?? null,
    oosLogLoss: instrument.oos_log_loss ?? null,
    oosDirectionalAccuracy: instrument.oos_directional_accuracy ?? null,
    accuracyLiftCiLow: instrument.accuracy_lift_ci_low ?? null,
    calibrationVerified: instrument.calibration_verified ?? null,
    calibrationGap: instrument.calibration_gap ?? null,
    durationSeconds: seconds,
  };
  const metric = (value: unknown) => (value == null ? "n/a" : String(round(value, 4)));
  return {
    ok: true,
    summary:
      instrument.status === "TRAINED"
        ? `Trained ${symbol} ${horizon} on ${instrument.bars ?? "?"} bars in ${seconds}s: ${fields.modelVersion ?? "version n/a"}, OOS accuracy ${metric(fields.oosAccuracy)} vs majority baseline ${metric(fields.oosMajorityBaseline)}, log loss ${metric(fields.oosLogLoss)}, calibration verified ${String(fields.calibrationVerified)}. Promotion gate says ${promotionReady ? "PROMOTION_READY" : "NOT READY"}, so this artifact's signals ${promotionReady ? "may stop abstaining" : "keep abstaining"}.`
        : `Training ${symbol} ${horizon} returned without a trained artifact (${instrument.status ?? "no status"}${instrument.reason ? `, ${instrument.reason}` : ""}) after ${seconds}s. Nothing was measured to report.`,
    data: fields,
  };
}

async function watchlistAddTool(env: ToolEnv, args: Record<string, unknown>): Promise<ToolOutcome> {
  const symbol = symbolOf(args.symbol);
  if (!symbol) return fail("INVALID_SYMBOL", "Name one instrument to add, such as RELIANCE or SUZLON.NS.");
  if (!env.pool) return fail("DATABASE_UNAVAILABLE", NO_DATABASE);
  const note = args.note == null ? null : String(args.note).slice(0, 200);
  const already = await env.pool.query("select 1 as present from watchlist_items where symbol=$1", [symbol]);
  const wasListed = (already.rowCount ?? 0) > 0;
  const item = await addWatchlistItem(env.pool, symbol, note);
  return {
    ok: true,
    summary: wasListed
      ? `${symbol} was already on the watchlist at position ${item.position}; ${note ? "its note was replaced." : "nothing else changed."}`
      : `Added ${symbol} to the watchlist at position ${item.position}. The instrument row is active, so daily collection and the radar cover it from the next sweep.`,
    data: { ...item, wasAlreadyListed: wasListed },
  };
}

async function watchlistRemoveTool(env: ToolEnv, args: Record<string, unknown>): Promise<ToolOutcome> {
  const symbol = symbolOf(args.symbol);
  if (!symbol) return fail("INVALID_SYMBOL", "Name one watchlist symbol to remove.");
  if (!env.pool) return fail("DATABASE_UNAVAILABLE", NO_DATABASE);
  const removed = await removeWatchlistItem(env.pool, symbol);
  if (!removed) return fail("NOT_ON_WATCHLIST", `${symbol} is not on the watchlist, so nothing was removed.`);
  return {
    ok: true,
    summary: `Removed ${symbol} from the watchlist. Stored daily bars, ledger rows and the trained artifact were not deleted and stay in the database.`,
    data: { symbol, removed: true, barsRetained: true },
  };
}

async function acknowledgeAlertsTool(env: ToolEnv, args: Record<string, unknown>): Promise<ToolOutcome> {
  const ids = idsOf(args.ids);
  if (!ids.length) return fail("INVALID_ALERT_IDS", "Give the explicit alert ids to acknowledge, taken from recent_alerts. There is no acknowledge-everything option here.");
  if (!env.pool) return fail("DATABASE_UNAVAILABLE", NO_DATABASE);
  const acknowledged = await acknowledgeAlertIds(env.pool, ids);
  const unread = await unreadAlertCount(env.pool);
  const cleared = ids.length - acknowledged.length;
  return {
    ok: acknowledged.length > 0,
    summary: acknowledged.length
      ? `Acknowledged ${acknowledged.length} radar row(s) (${acknowledged.join(", ")}); ${cleared} of the ${ids.length} requested were already clear. ${unread} unread row(s) remain.`
      : `None of the requested ids (${ids.join(", ")}) were unread, so nothing changed. ${unread} unread row(s) remain.`,
    data: { requested: ids, acknowledgedIds: acknowledged, alreadyClearCount: cleared, unreadRemaining: unread },
  };
}

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const TOOLS: ToolDefinition[] = [
  {
    spec: {
      type: "function",
      function: {
        name: "price_history",
        description:
          "Read the stored real daily closes for one symbol and return coverage, freshness, window return, realized volatility and drawdown. Nothing is fetched live and nothing is simulated; stale data is reported as stale.",
        parameters: objectSchema({
          symbol: { type: "string", description: "Stored instrument symbol, e.g. NIFTY, BANKNIFTY, RELIANCE." },
          days: { type: "integer", description: "Trading days of history to read, 5-730. Default 120." },
        }, ["symbol"]),
      },
    },
    run: dailyHistoryTool,
  },
  {
    spec: {
      type: "function",
      function: {
        name: "run_backtest",
        description:
          "Run the real rule-based backtest engine over stored daily bars for one symbol: next-bar execution, Indian charge model, long-only. Returns measured return, CAGR, drawdown, Sharpe, trade count, win rate, profit factor and costs. This measures a closed-form rule, not the ML model.",
        parameters: objectSchema({
          symbol: { type: "string", description: "Stored instrument symbol." },
          strategy: { type: "string", enum: [...BACKTEST_STRATEGIES], description: "buy_hold, sma_trend (20-day) or vol_expansion. Default sma_trend." },
          days: { type: "integer", description: "Bars of history to test over, 60-1825. Default 365." },
        }, ["symbol"]),
      },
    },
    run: backtestTool,
  },
  {
    spec: {
      type: "function",
      function: {
        name: "fresh_forecast",
        description:
          "Ask the local ML service for a brand-new prediction for one symbol and horizon, straight from the trained artifact. Carries the honest status fields: calibration, promotion readiness and why the action gate abstains.",
        parameters: objectSchema({
          symbol: { type: "string", description: "Symbol to run inference for." },
          horizon: { type: "string", enum: [...HORIZONS], description: "Forecast horizon. Default 1d." },
        }, ["symbol"]),
      },
    },
    run: freshForecastTool,
  },
  {
    spec: {
      type: "function",
      function: {
        name: "ledger_history",
        description:
          "Read the newest stored prediction_ledger rows for one symbol: what the model said at the time, its expected return and confidence, and the realized outcome once the day closed. This is the audit trail.",
        parameters: objectSchema({
          symbol: { type: "string", description: "Symbol whose ledger rows to read." },
          limit: { type: "integer", description: "Rows to return, 1-60. Default 20." },
        }, ["symbol"]),
      },
    },
    run: ledgerHistoryTool,
  },
  {
    spec: {
      type: "function",
      function: {
        name: "compare_forecast",
        description:
          "Re-ask the model for one symbol and compare the fresh run against the newest stored ledger row, with the divergence (direction change, expected-return delta, confidence delta, model version change) computed by code. Use this to check whether a stored signal is out of date. It never overwrites the stored row.",
        parameters: objectSchema({
          symbol: { type: "string", description: "Symbol to compare." },
          horizon: { type: "string", enum: [...HORIZONS], description: "Horizon to compare; ledger rows exist mainly for 1d. Default 1d." },
        }, ["symbol"]),
      },
    },
    run: compareForecastTool,
  },
  {
    spec: {
      type: "function",
      function: {
        name: "prediction_performance",
        description:
          "Realized accuracy of the prediction ledger over a lookback window: accuracy, balanced accuracy, directional accuracy, log loss, Brier, calibration error and return MAE, overall and per horizon. The only honest answer to 'is the model actually working'.",
        parameters: objectSchema({ days: { type: "integer", description: "Lookback in days, 1-1095. Default 90." } }),
      },
    },
    run: predictionPerformanceTool,
  },
  {
    spec: {
      type: "function",
      function: {
        name: "recent_alerts",
        description:
          "Read the buy-alert radar rows written by the collector: closed-form rule triggers with their evidence numbers. Optionally filter to one symbol.",
        parameters: objectSchema({
          symbol: { type: "string", description: "Optional single symbol filter." },
          limit: { type: "integer", description: "Rows to return, 1-100. Default 20." },
        }),
      },
    },
    run: recentAlertsTool,
  },
  {
    spec: {
      type: "function",
      function: {
        name: "model_coverage",
        description:
          "Report which instruments and horizons have a trained model artifact built locally, and each bundle's promotion status. Explains why some symbols have no live prediction.",
        parameters: objectSchema({ horizons: { type: "string", description: 'Optional comma-separated horizon filter, e.g. "1d,3d".' } }),
      },
    },
    run: modelCoverageTool,
  },
  {
    spec: {
      type: "function",
      function: {
        name: "market_scan",
        description:
          "Run the stored-data market scanner over tracked equities, indices and ETFs and return its ranked picks with the reasons and data age behind each one. Research ranking, not advice.",
        parameters: objectSchema({ limit: { type: "integer", description: "Picks to return, 1-5. Default 5." } }),
      },
    },
    run: marketScanTool,
  },
  {
    spec: {
      type: "function",
      function: {
        name: "train_model",
        description:
          "Retrain the stored model artifact for ONE symbol and horizon against the bars already in this database, then report what the out-of-sample promotion gate actually measured: OOS accuracy against the majority baseline, log loss, calibration verification and whether the artifact is promotion ready. This is a write action: it replaces that single artifact and requires the user to approve it first. A signal can stop abstaining only because the gate said so, never because you decided it should.",
        parameters: objectSchema({
          symbol: { type: "string", description: "Active instrument to train, e.g. NIFTY or RELIANCE." },
          horizon: { type: "string", enum: [...HORIZONS], description: "Horizon to train. Default 1d." },
        }, ["symbol"]),
      },
    },
    write: true,
      describeWrite: (args) => {
        const symbol = symbolOf(args.symbol) ?? String(args.symbol ?? "?").slice(0, 32);
        return `Retrain the ${horizonOf(args.horizon)} model artifact for ${symbol}. If the run completes, that artifact is replaced on disk; every other symbol and horizon is untouched.`;
      },
    run: trainModelTool,
  },
  {
    spec: {
      type: "function",
      function: {
        name: "watchlist_add",
        description:
          "Add one instrument to the user's watchlist. If the symbol is not tracked yet this also activates its instrument row, so daily bars and the radar start covering it from the next sweep. Write action, needs approval.",
        parameters: objectSchema({
          symbol: { type: "string", description: "Instrument symbol to track, e.g. RELIANCE or SUZLON.NS." },
          note: { type: "string", description: "Optional short note stored beside the watchlist row." },
        }, ["symbol"]),
      },
    },
    write: true,
      describeWrite: (args) => {
        const symbol = symbolOf(args.symbol) ?? String(args.symbol ?? "?").slice(0, 32);
        const note = args.note == null ? "" : ` Note: "${String(args.note).slice(0, 120)}".`;
        return `Put ${symbol} on the watchlist${note} Collection and the radar will start covering it if it was not tracked before.`;
      },
    run: watchlistAddTool,
  },
  {
    spec: {
      type: "function",
      function: {
        name: "watchlist_remove",
        description:
          "Remove one symbol from the watchlist. It deletes only the watchlist row: stored daily bars, ledger history and the trained artifact stay put, so this is reversible by adding the symbol back. Write action, needs approval.",
        parameters: objectSchema({ symbol: { type: "string", description: "Watchlist symbol to remove." } }, ["symbol"]),
      },
    },
    write: true,
      describeWrite: (args) => `Take ${symbolOf(args.symbol) ?? String(args.symbol ?? "?").slice(0, 32)} off the watchlist. Stored price history and predictions are not deleted.`,
    run: watchlistRemoveTool,
  },
  {
    spec: {
      type: "function",
      function: {
        name: "acknowledge_alerts",
        description:
          "Mark specific radar alert rows as acknowledged by id, taking the ids from recent_alerts. There is no acknowledge-everything switch here, and no alert is deleted, so the audit trail stays readable. Write action, needs approval.",
        parameters: objectSchema({
          ids: { type: "array", items: { type: "integer" }, maxItems: 25, description: "Explicit alert ids from recent_alerts. 1-25 ids." },
        }, ["ids"]),
      },
    },
    write: true,
      describeWrite: (args) => {
        const ids = idsOf(args.ids);
        return ids.length
          ? `Mark ${ids.length} radar row(s) as acknowledged: ${ids.join(", ")}. Rows are kept, only the unread flag changes.`
          : "Acknowledge radar rows — no valid ids were supplied, so this cannot run.";
      },
    run: acknowledgeAlertsTool,
  },
];

export const AGENT_TOOL_NAMES = TOOLS.map((tool) => tool.spec.function.name);

export function isWriteTool(name: string): boolean {
  return TOOLS.find((tool) => tool.spec.function.name === name)?.write === true;
}

/** The exact change a write tool would make, or null for a read-only tool. */
export function describeAgentWrite(name: string, args: Record<string, unknown>): string | null {
  const tool = TOOLS.find((candidate) => candidate.spec.function.name === name);
  if (!tool?.write) return null;
  try {
    return tool.describeWrite?.(args ?? {}) ?? `Run ${name} with ${JSON.stringify(args ?? {}).slice(0, 160)}.`;
  } catch {
    return `Run ${name}. The tool could not describe the change, so review its arguments.`;
  }
}

export function agentToolSpecs(): ToolSpec[] {
  return TOOLS.map((tool) => tool.spec);
}

function cap(outcome: ToolOutcome): ToolOutcome {
  const serialized = JSON.stringify(outcome.data ?? null);
  if (serialized == null || serialized.length <= TOOL_RESULT_CHAR_CAP) return outcome;
  return {
    ...outcome,
    data: {
      truncated: true,
      originalChars: serialized.length,
      sentChars: TOOL_RESULT_CHAR_CAP,
      note: "The tool result was longer than the agent's per-result limit; the text below is the beginning of the real JSON and the rest was not sent.",
      excerpt: serialized.slice(0, TOOL_RESULT_CHAR_CAP),
    },
  };
}

/** Runs one agent tool by name with validated arguments. Unknown names fail loudly. */
export async function executeAgentTool(env: ToolEnv, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const tool = TOOLS.find((candidate) => candidate.spec.function.name === name);
  if (!tool) return fail("UNKNOWN_TOOL", `"${String(name).slice(0, 64)}" is not an available tool. Do not guess a result for it.`);
  try {
    return cap(await tool.run(env, args ?? {}));
  } catch (error) {
    const message = error instanceof Error ? error.message : "tool_failed";
    return fail("TOOL_FAILED", `${name} could not complete: ${message.slice(0, 240)}`);
  }
}

/** Parses a model-supplied JSON argument blob without executing anything exotic. */
export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  const text = String(raw ?? "").trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
