export type MarketDataStatus = "LIVE" | "CACHED" | "STALE" | "OFFLINE";

export interface MarketQuote {
  symbol: string;
  timestamp: string;
  collectedAt: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  previousClose: number | null;
  change: number | null;
  changePercent: number | null;
  source: string;
  status: MarketDataStatus;
}

export function normalizeQuote(input: {
  symbol: string;
  timestamp?: string;
  collectedAt?: string;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close?: number | null;
  volume?: number | null;
  previousClose?: number | null;
  source?: string;
  status?: MarketDataStatus;
}): MarketQuote {
  const close = finite(input.close);
  const previousClose = finite(input.previousClose);
  const change = close !== null && previousClose !== null ? close - previousClose : null;
  const changePercent = change !== null && previousClose !== null && previousClose !== 0
    ? (change / previousClose) * 100
    : null;

  return {
    symbol: input.symbol.trim().toUpperCase(),
    timestamp: input.timestamp ?? new Date().toISOString(),
    collectedAt: input.collectedAt ?? new Date().toISOString(),
    open: finite(input.open),
    high: finite(input.high),
    low: finite(input.low),
    close,
    volume: finite(input.volume),
    previousClose,
    change,
    changePercent,
    source: input.source ?? "unknown",
    status: input.status ?? "LIVE",
  };
}

export function classifyFreshness(timestamp: string, now = Date.now()): MarketDataStatus {
  const ageMs = now - Date.parse(timestamp);
  if (!Number.isFinite(ageMs) || ageMs < 0) return "OFFLINE";
  if (ageMs <= 60_000) return "LIVE";
  if (ageMs <= 5 * 60_000) return "CACHED";
  return "STALE";
}

function finite(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(Number(value)) ? Number(value) : null;
}
