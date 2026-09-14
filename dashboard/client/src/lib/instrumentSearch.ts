import type { Instrument } from "./localApi";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:4100";

export async function searchInstruments(query: string, signal?: AbortSignal): Promise<Instrument[]> {
  const response = await fetch(`${API_BASE}/api/instruments/search?q=${encodeURIComponent(query)}`, { signal });
  if (!response.ok) throw new Error(`Instrument search returned ${response.status}`);
  return (await response.json() as { instruments: Instrument[] }).instruments;
}
