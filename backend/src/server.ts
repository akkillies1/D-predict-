import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pg from "pg";
import { buildCausalTradeThesis } from "./services/tradeThesis.js";

dotenv.config();

const { Pool } = pg;
const app = express();
const port = Number(process.env.PORT ?? 8787);
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false } }) : null;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

function iso(value: unknown): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function noDb(res: express.Response) {
  return res.status(503).json({ ok: false, error: "DATABASE_NOT_CONFIGURED" });
}

app.get("/health", (_req, res) => res.json({ ok: true }));

let thesisCache = new Map<string, { expiresAt: number; value: any }>();
app.get("/api/signals/latest", async (req, res) => {
  if (!pool) return noDb(res);
  const symbol = String(req.query.symbol ?? "NIFTY").toUpperCase();
  try {
    const result = await pool.query(`select s.id, i.symbol, s.timestamp, s.strategy_version, s.model_version, s.direction, s.confidence, s.regime, s.reason_codes, s.parameters from signal_decisions s join instruments i on i.instrument_id=s.instrument_id where i.symbol=$1 order by s.timestamp desc limit 1`, [symbol]);
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "NO_SIGNAL" });
    const row = result.rows[0];
    const baseSignal = { id: row.id, symbol: row.symbol, timestamp: iso(row.timestamp), strategyVersion: row.strategy_version, modelVersion: row.model_version, direction: row.direction, confidence: Number(row.confidence), regime: row.regime, reasonCodes: row.reason_codes ?? [], parameters: row.parameters ?? {} };
    const cached = thesisCache.get(symbol);
    let tradeThesis = cached && cached.expiresAt > Date.now() ? cached.value : null;
    if (!tradeThesis) {
      const price = await pool.query(`select close from price_bars pb join instruments i on i.instrument_id=pb.instrument_id where i.symbol=$1 and pb.timeframe='1m' order by pb.market_timestamp desc limit 1`, [symbol]);
      if (price.rows.length) {
        tradeThesis = await buildCausalTradeThesis(pool, { symbol: row.symbol, timestamp: row.timestamp, direction: row.direction, confidence: Number(row.confidence) }, Number(price.rows[0].close));
        thesisCache.set(symbol, { expiresAt: Date.now() + 30000, value: tradeThesis });
      }
    }
    return res.json({ ok: true, signal: { ...baseSignal, tradeThesis } });
  } catch (error) { return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "query_failed" }); }
});

function numberOrNull(value: unknown): number | null { const n = Number(value); return Number.isFinite(n) ? n : null; }
function clampScore(value: number): number { return Math.max(0, Math.min(100, Math.round(value))); }

app.post("/api/ipo/analyze", async (req, res) => {
  const input = req.body ?? {};
  const companyName = String(input.companyName ?? "").trim();
  if (!companyName) return res.status(400).json({ ok: false, error: "COMPANY_NAME_REQUIRED" });
  const revenue = numberOrNull(input.revenue);
  const ebitda = numberOrNull(input.ebitda);
  const pat = numberOrNull(input.pat);
  const issuePrice = numberOrNull(input.issuePrice);
  const postIssueShares = numberOrNull(input.postIssueShares);
  const freshIssue = numberOrNull(input.freshIssue);
  const ofS = numberOrNull(input.ofs);
  const debt = numberOrNull(input.debt);
  const cash = numberOrNull(input.cash);
  const roe = numberOrNull(input.roe);
  const roce = numberOrNull(input.roce);
  const pe = issuePrice !== null && postIssueShares && pat && pat > 0 ? (issuePrice * postIssueShares) / pat : null;
  const enterpriseValue = issuePrice !== null && postIssueShares ? issuePrice * postIssueShares + (debt ?? 0) - (cash ?? 0) : null;
  const evEbitda = enterpriseValue !== null && ebitda && ebitda > 0 ? enterpriseValue / ebitda : null;
  const revenueGrowth = numberOrNull(input.revenueGrowth);
  const ebitdaMargin = revenue !== null && revenue !== 0 && ebitda !== null ? ebitda / revenue : null;
  const profitMargin = revenue !== null && revenue !== 0 && pat !== null ? pat / revenue : null;
  const freshRatio = (freshIssue !== null && issuePrice !== null && postIssueShares) ? (freshIssue * issuePrice) / (issuePrice * postIssueShares) : null;
  let valuationScore = 50;
  if (pe !== null) valuationScore += pe < 20 ? 20 : pe < 30 ? 10 : pe < 45 ? 0 : -15;
  if (evEbitda !== null) valuationScore += evEbitda < 15 ? 10 : evEbitda < 25 ? 0 : -10;
  let businessScore = 50;
  if (revenueGrowth !== null) businessScore += revenueGrowth > 20 ? 20 : revenueGrowth > 10 ? 10 : revenueGrowth < 0 ? -15 : 0;
  if (ebitdaMargin !== null) businessScore += ebitdaMargin > 0.2 ? 15 : ebitdaMargin > 0.1 ? 5 : ebitdaMargin < 0 ? -15 : 0;
  if (profitMargin !== null) businessScore += profitMargin > 0.1 ? 10 : profitMargin < 0 ? -15 : 0;
  if (roe !== null) businessScore += roe > 15 ? 10 : roe < 8 ? -5 : 0;
  if (roce !== null) businessScore += roce > 15 ? 10 : roce < 8 ? -5 : 0;
  const structureScore = freshRatio === null ? 50 : clampScore(freshRatio * 100 + 40);
  const score = clampScore(0.45 * valuationScore + 0.4 * businessScore + 0.15 * structureScore);
  const verdict = score >= 70 ? "ATTRACTIVE" : score >= 55 ? "WATCH" : "CAUTION";
  const risks: string[] = [];
  if (ofS !== null && freshIssue !== null && ofS > freshIssue * 2) risks.push("Large OFS relative to fresh issue: proceeds may primarily benefit selling shareholders rather than the company.");
  if (revenueGrowth !== null && revenueGrowth < 0) risks.push("Revenue growth is negative on the supplied period.");
  if (ebitdaMargin !== null && ebitdaMargin < 0) risks.push("EBITDA is negative on the supplied period.");
  if (pat !== null && pat < 0) risks.push("The company is loss-making on the supplied period.");
  if (debt !== null && cash !== null && pat !== null && pat > 0 && debt / pat > 5) risks.push("Debt is high relative to supplied annual profit.");
  if (risks.length === 0) risks.push("No major quantitative warning triggered; qualitative prospectus risks still require review.");
  const analysis = { score, verdict, valuationScore: clampScore(valuationScore), businessScore: clampScore(businessScore), structureScore, metrics: { pe, enterpriseValue, evEbitda, ebitdaMargin, profitMargin, freshIssueRatio: freshRatio }, risks, methodology: "ipo-analysis-v1", disclaimer: "Screening model only. It does not replace prospectus review, peer valuation, anchor/allocation data or independent investment advice." };
  if (pool) {
    await pool.query(`insert into ipo_analysis_runs (company_name, symbol, analysis_version, inputs, analysis, source_urls) values ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb)`, [companyName, input.symbol ? String(input.symbol).toUpperCase() : null, "ipo-analysis-v1", JSON.stringify(input), JSON.stringify(analysis), JSON.stringify(Array.isArray(input.sourceUrls) ? input.sourceUrls : [])]);
  }
  return res.json({ ok: true, companyName, analysis });
});

app.get("/api/options/chain", async (req, res) => {
  if (!pool) return noDb(res);
  const symbol = String(req.query.symbol ?? "NIFTY").toUpperCase();
  return res.status(501).json({ ok: false, error: "NOT_IMPLEMENTED", symbol });
});

app.listen(port, () => console.log(`D-predict backend listening on ${port}`));
