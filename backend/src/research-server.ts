import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import pg from "pg";
import { buildResearch } from "./research.js";

const port = Number(process.env.RESEARCH_PORT ?? 4200);
const cacheSeconds = Math.max(15, Number(process.env.RESEARCH_CACHE_SECONDS ?? 60));
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

app.get("/api/research/:symbol", async (req, res) => {
  const symbol = req.params.symbol.trim().toUpperCase();
  if (!/^[A-Z0-9.^_-]{1,32}$/.test(symbol)) return res.status(400).json({ ok: false, error: "INVALID_SYMBOL" });

  const now = Date.now();
  if (cached?.key === symbol && cached.expiresAt > now) return res.json({ ok: true, research: cached.value, cached: true });

  try {
    const value = await buildResearch(symbol);
    await persistResearch(value);
    cached = { key: symbol, expiresAt: now + cacheSeconds * 1000, value };
    return res.json({ ok: true, research: value, cached: false });
  } catch (error) {
    return res.status(502).json({ ok: false, error: "RESEARCH_UNAVAILABLE", message: error instanceof Error ? error.message : "unknown" });
  }
});

const server = app.listen(port, "127.0.0.1", () => console.log(`D-predict research service listening on 127.0.0.1:${port}`));
const shutdown = async () => { server.close(); await pool?.end(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
