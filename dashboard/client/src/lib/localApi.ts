const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:4100";

export type LocalHealth = { ok: boolean; database?: string; time?: string };
export type MarketOverview = { ok: true; symbol: string; timestamp: string; collectedAt?: string; open: number; high: number; low: number; close: number; volume: number | null; source?: string };
export type Instrument = { symbol: string; exchange: string; lotSize: number; isActive: boolean; name?: string | null; source?: string };
export type PriceBar = { timestamp: string; open: number; high: number; low: number; close: number; volume: number | null };
export type Signal = { id: string; symbol: string; timestamp: string; strategyVersion: string; modelVersion: string; direction: "BULLISH" | "BEARISH" | "NEUTRAL"; confidence: number; regime: string | null; reasonCodes: string[]; parameters: Record<string, unknown> };
export type OptionRow = { expiry_date: string; strike: number; option_type: "CE" | "PE"; timestamp: string; ltp: number | null; bid: number | null; ask: number | null; oi: number | null; oiChange: number | null; iv: number | null };
export type ForecastBand = { day: number; p10: number; p25: number; median: number; p75: number; p90: number };
export type Forecast = { symbol: string; spot: number; dailyVolatility: number; daysOfHistoryUsed: number; horizonDays: number; paths: number; probabilityAboveSpot: number; probabilityBelowSpot: number; bands: ForecastBand[] };

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`API returned ${response.status}`);
  return response.json() as Promise<T>;
}

export async function getLocalHealth(signal?: AbortSignal): Promise<LocalHealth> {
  return json<LocalHealth>(`${API_BASE}/health`, { signal });
}

export function localApiBaseUrl() { return API_BASE; }

export async function getMarketOverview(symbol = "NIFTY", signal?: AbortSignal): Promise<MarketOverview> {
  return json<MarketOverview>(`${API_BASE}/api/market/${encodeURIComponent(symbol)}/overview`, { signal });
}

export async function getLiveQuote(symbol = "NIFTY", signal?: AbortSignal): Promise<MarketOverview> {
  return json<MarketOverview>(`${API_BASE}/api/market/${encodeURIComponent(symbol)}/live`, { signal });
}

export async function getInstruments(signal?: AbortSignal): Promise<Instrument[]> {
  const payload = await json<{ instruments: Instrument[] }>(`${API_BASE}/api/instruments`, { signal });
  return payload.instruments;
}

export async function searchInstruments(query: string, signal?: AbortSignal): Promise<Instrument[]> {
  const payload = await json<{ instruments: Instrument[] }>(`${API_BASE}/api/instruments/discover?q=${encodeURIComponent(query)}`, { signal });
  return payload.instruments;
}

export async function addInstrument(symbol: string): Promise<Instrument> {
  const payload = await json<{ instrument: Instrument }>(`${API_BASE}/api/instruments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol }) });
  return payload.instrument;
}

export async function getMarketHistory(symbol: string, signal?: AbortSignal): Promise<PriceBar[]> {
  const payload = await json<{ rows: PriceBar[] }>(`${API_BASE}/api/market/${encodeURIComponent(symbol)}/history?limit=120`, { signal });
  return payload.rows;
}

export async function getLatestSignal(symbol: string, signal?: AbortSignal): Promise<Signal> {
  const payload = await json<{ signal: Signal }>(`${API_BASE}/api/signals/latest?symbol=${encodeURIComponent(symbol)}`, { signal });
  return payload.signal;
}

export async function getOptionChain(symbol: string, signal?: AbortSignal): Promise<OptionRow[]> {
  const payload = await json<{ rows: OptionRow[] }>(`${API_BASE}/api/options/chain?symbol=${encodeURIComponent(symbol)}`, { signal });
  return payload.rows;
}

export async function getForecast(symbol: string, signal?: AbortSignal): Promise<Forecast> {
  return json<Forecast>(`${API_BASE}/api/forecast?symbol=${encodeURIComponent(symbol)}&horizon=5`, { signal });
}
