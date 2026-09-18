export function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function formatConfidence(value: number): string {
  return `${Math.round(clampConfidence(value) * 100)}%`;
}

export function formatIndianNumber(value: number, decimals = 2): string {
  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

export function chooseInitialSymbol(storedSymbol: string | null, instruments: Array<{ symbol: string; isActive: boolean; observations?: number }>): string {
  const stored = storedSymbol?.trim().toUpperCase();
  const active = instruments.filter((instrument) => instrument.isActive);
  if (stored && active.some((instrument) => instrument.symbol === stored && (instrument.observations ?? 0) > 0)) return stored;
  return active.find((instrument) => (instrument.observations ?? 0) > 0)?.symbol ?? active[0]?.symbol ?? stored ?? "NIFTY";
}
