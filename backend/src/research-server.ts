import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import pg from "pg";
import { buildResearch, type ResearchArticle, type ResearchResult } from "./research.js";

const port = Number(process.env.RESEARCH_PORT ?? 4200);
const cacheSeconds = Math.max(15, Number(process.env.RESEARCH_CACHE_SECONDS ?? 60));
const localMaxAgeSeconds = Math.max(60, Number(process.env.RESEARCH_LOCAL_MAX_AGE_SECONDS ?? 86400));
const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(",").filter(Boolean) ?? true }));

const pool = process.env.DATABASE_URL ? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 }) : null;
let cached: { key: string; expiresAt: number; value: Awaited<ReturnType<typeof buildResearch>> } | null = null;

app.get("/health", (_req, res) => res.json({ ok: true, service: "research", time: new Date().toISOString() }));

async function persistResearch(value: Awaited<ReturnType<typeof buildResearch>>) {
  if (!pool) return;
  try {
    const client = await pool.connect();
    try {
      for (const article of value.articles) {
        const title = article.title.trim();
        const contentHash = crypto.createHash("sha256").update(`${value.symbol}|${article.url}|${title}`).digest("hex");
        await client.query(
          `insert into research_documents
             (symbol, published_at, source, source_url, title, event_type, stance, importance, content_hash, source_version, metadata)
           values ($1, coalesce($2::timestamptz, now()), $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
           on conflict (content_hash) do nothing`,
          [
            value.symbol,
            article.publishedAt,
            article.source,
            article.url,
            title,
            value.themes[0] ?? null,
            article.stance,
            article.sourceType === "official" ? "HIGH" : article.score === 0 ? "LOW" : "MEDIUM",
            contentHash,
            "research-v2",
            JSON.stringify({ sourceType: article.sourceType, domain: article.domain ?? null, score: article.score }),
          ],
        );
      }
    } finally {
      client.release();
    }
  } catch (error) {
    // Research remains available even when persistence is unavailable.
    console.warn("research persistence skipped:", error instanceof Error ? error.message : error);
  }
}

async function loadLocalResearch(symbol: string): Promise<ResearchResult | null> {
  if (!pool) return null;
  const result = await pool.query(`select title, source, source_url, published_at, stance, metadata, event_type, created_at from research_documents where upper(symbol)=upper($1) order by published_at desc limit 30`, [symbol]);
  if (!result.rows.length) return null;
  const newest = new Date(result.rows[0].created_at).getTime();
  if (!Number.isFinite(newest) || Date.now() - newest > localMaxAgeSeconds * 1000) return null;
  const articles: ResearchArticle[] = result.rows.map(row => {
    const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : {};
    const score = Number(metadata.score ?? 0);
    const articleStance = row.stance === "BULLISH" || row.stance === "BEARISH" ? row.stance : "NEUTRAL";
    const sourceType: ResearchArticle["sourceType"] = metadata.sourceType === "official" ? "official" : metadata.sourceType === "market" ? "market" : "news";
    return { title: row.title, url: row.source_url ?? "", source: row.source, publishedAt: row.published_at?.toISOString?.() ?? String(row.published_at), sourceType, score: Number.isFinite(score) ? score : 0, stance: articleStance };
  }).filter(article => article.url);
  if (!articles.length) return null;
  const bullish = articles.filter(article => article.stance === "BULLISH").length;
  const bearish = articles.filter(article => article.stance === "BEARISH").length;
  const directional = bullish + bearish;
  const score = articles.reduce((sum, article) => sum + article.score, 0) / articles.length;
  return {
    symbol, companyName: null, asOf: new Date().toISOString(),
    direction: Math.abs(score) < 0.18 || !directional ? "MIXED" : score > 0 ? "BULLISH" : "BEARISH",
    confidence: Number(Math.min(0.95, 0.3 + Math.abs(score) * 0.3 + (directional ? Math.max(bullish, bearish) / directional * 0.2 : 0)).toFixed(3)),
    evidenceScore: Math.min(100, 30 + articles.length * 2), agreement: directional ? Number((Math.max(bullish, bearish) / directional).toFixed(3)) : 0,
    articles, themes: result.rows.map(row => row.event_type).filter(Boolean).slice(0, 8), risks: [],
    publicDisclosureLinks: [{ label: "NSE corporate announcements", url: `https://www.nseindia.com/companies-listing/corporate-filings-announcements?symbol=${encodeURIComponent(symbol)}&tabIndex=equity` }, { label: "SEBI filings search", url: "https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListing=yes&sid=3&smid=11" }],
    disclaimer: "Research is served from locally persisted public-source documents. It is evidence, not trading advice.",
  };
}

app.get("/api/research/:symbol", async (req, res) => {
  const symbol = req.params.symbol.trim().toUpperCase();
  if (!/^[A-Z0-9.^_-]{1,32}$/.test(symbol)) return res.status(400).json({ ok: false, error: "INVALID_SYMBOL" });

  const now = Date.now();
  if (cached?.key === symbol && cached.expiresAt > now) return res.json({ ok: true, research: cached.value, cached: true });

  try {
    const local = await loadLocalResearch(symbol);
    if (local) { cached = { key: symbol, expiresAt: now + cacheSeconds * 1000, value: local }; return res.json({ ok: true, research: local, cached: true, source: "local" }); }
    const value = await buildResearch(symbol);
    await persistResearch(value);
    cached = { key: symbol, expiresAt: now + cacheSeconds * 1000, value };
    return res.json({ ok: true, research: value, cached: false });
  } catch (error) {
    return res.status(502).json({ ok: false, error: "RESEARCH_UNAVAILABLE", message: error instanceof Error ? error.message : "unknown" });
  }
});

const server = app.listen(port, "0.0.0.0", () => console.log(`D-predict research service listening on 0.0.0.0:${port}`));
const shutdown = async () => { server.close(); await pool?.end(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
