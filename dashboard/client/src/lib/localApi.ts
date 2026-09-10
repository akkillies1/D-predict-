const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:4100";

export type LocalHealth = { ok: boolean; database?: string; time?: string };
export type MarketOverview = { ok: true; symbol: string; timestamp: string; open: number; high: number; low: number; close: number; volume: number | null };
export type Instrument = { symbol: string; exchange: string; lotSize: number; isActive: boolean };
export type PriceBar = { timestamp: string; open: number; high: number; low: number; close: number; volume: number | null };
export type Signal = { id: string; symbol: string; timestamp: string; strategyVersion: string; modelVersion: string; direction: "BULLISH" | "BEARISH" | "NEUTRAL"; confidence: number; regime: string | null; reasonCodes: string[]; parameters: Record<string, unknown> };
export type OptionRow = { expiry_date: string; strike: number; option_type: "CE" | "PE"; timestamp: string; ltp: number | null; bid: number | null; ask: number | null; oi: number | null; oiChange: number | null; iv: number | null };
export type ForecastBand = { day: number; p10: number; p25: number; median: number; p75: number; p90: number };
export type Forecast = { symbol: string; spot: number; dailyVolatility: number; daysOfHistoryUsed: number; horizonDays: number; paths: number; probabilityAboveSpot: number; probabilityBelowSpot: number; bands: ForecastBand[] };

export async function getLocalHealth(signal?: AbortSignal): Promise<LocalHealth> {
  const response = await fetch(`${API_BASE}/health`, { signal });
  if (!response.ok) throw new Error(`Local API returned ${response.status}`);
  return response.json() as Promise<LocalHealth>;
}

export function localApiBaseUrl() { return API_BASE; }

export async function getMarketOverview(symbol = "NIFTY", signal?: AbortSignal): Promise<MarketOverview> {
  const response = await fetch(`${API_BASE}/api/market/${encodeURIComponent(symbol)}/overview`, { signal });
  if (!response.ok) throw new Error(`Market API returned ${response.status}`);
  return response.json() as Promise<MarketOverview>;
}

export async function getInstruments(signal?: AbortSignal): Promise<Instrument[]> {
  const response = await fetch(`${API_BASE}/api/instruments`, { signal });
  if (!response.ok) throw new Error(`Instrument API returned ${response.status}`);
  const payload = await response.json() as { instruments: Instrument[] };
  return payload.instruments;
}

export async function addInstrument(symbol: string): Promise<Instrument> {
  const response = await fetch(`${API_BASE}/api/instruments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol }) });
  if (!response.ok) throw new Error(`Could not add ${symbol}`);
  const payload = await response.json() as { instrument: Instrument };
  return payload.instrument;
}

export async function getMarketHistory(symbol: string, signal?: AbortSignal): Promise<PriceBar[]> {
  const response = await fetch(`${API_BASE}/api/market/${encodeURIComponent(symbol)}/history?limit=120`, { signal });
  if (!response.ok) throw new Error(`History API returned ${response.status}`);
  const payload = await response.json() as { rows: PriceBar[] };
  return payload.rows;
}

export async function getLatestSignal(symbol: string, signal?: AbortSignal): Promise<Signal> {
  const response = await fetch(`${API_BASE}/api/signals/latest?symbol=${encodeURIComponent(symbol)}`, { signal });
  if (!response.ok) throw new Error(`Signal API returned ${response.status}`);
  const payload = await response.json() as { signal: Signal };
  return payload.signal;
}

export async function getOptionChain(symbol: string, signal?: AbortSignal): Promise<OptionRow[]> {
  const response = await fetch(`${API_BASE}/api/options/chain?symbol=${encodeURIComponent(symbol)}`, { signal });
  if (!response.ok) throw new Error(`Option API returned ${response.status}`);
  const payload = await response.json() as { rows: OptionRow[] };
  return payload.rows;
}

export async function getForecast(symbol: string, signal?: AbortSignal): Promise<Forecast> {
  const response = await fetch(`${API_BASE}/api/forecast?symbol=${encodeURIComponent(symbol)}&horizon=5`, { signal });
  if (!response.ok) throw new Error(`Forecast API returned ${response.status}`);
  return response.json() as Promise<Forecast>;
}
