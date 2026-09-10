const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:4100";

export type LocalHealth = { ok: boolean; database?: string; time?: string };
export type MarketOverview = { ok: true; symbol: string; timestamp: string; open: number; high: number; low: number; close: number; volume: number | null };
export type Instrument = { symbol: string; exchange: string; lotSize: number; isActive: boolean };
export type PriceBar = { timestamp: string; open: number; high: number; low: number; close: number; volume: number | null };

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
