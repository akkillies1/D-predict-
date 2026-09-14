import "dotenv/config";
import express from "express";
import cors from "cors";
import { buildResearch } from "./research.js";

const port = Number(process.env.RESEARCH_PORT ?? 4200);
const cacheSeconds = Math.max(15, Number(process.env.RESEARCH_CACHE_SECONDS ?? 60));
const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(",").filter(Boolean) ?? true }));

let cached: { key: string; expiresAt: number; value: Awaited<ReturnType<typeof buildResearch>> } | null = null;

app.get("/health", (_req, res) => res.json({ ok: true, service: "research", time: new Date().toISOString() }));

app.get("/api/research/:symbol", async (req, res) => {
  const symbol = req.params.symbol.trim().toUpperCase();
  if (!/^[A-Z0-9.^_-]{1,32}$/.test(symbol)) return res.status(400).json({ ok: false, error: "INVALID_SYMBOL" });

  const now = Date.now();
  if (cached?.key === symbol && cached.expiresAt > now) return res.json({ ok: true, research: cached.value, cached: true });

  try {
    const value = await buildResearch(symbol);
    cached = { key: symbol, expiresAt: now + cacheSeconds * 1000, value };
    return res.json({ ok: true, research: value, cached: false });
  } catch (error) {
    return res.status(502).json({ ok: false, error: "RESEARCH_UNAVAILABLE", message: error instanceof Error ? error.message : "unknown" });
  }
});

app.listen(port, "127.0.0.1", () => console.log(`D-predict research service listening on 127.0.0.1:${port}`));
