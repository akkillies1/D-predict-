export type RealizedClass = "DOWN" | "FLAT" | "UP";

export function horizonDays(value: string): number | null {
  const match = /^(\d+)d$/i.exec(String(value).trim());
  if (!match) return null;
  const days = Number(match[1]);
  return Number.isInteger(days) && days >= 1 && days <= 30 ? days : null;
}

export function classifyRealizedReturn(value: number, threshold = 0.001): RealizedClass {
  if (!Number.isFinite(value)) throw new Error("realized return must be finite");
  if (!Number.isFinite(threshold) || threshold < 0) throw new Error("threshold must be non-negative");
  if (value > threshold) return "UP";
  if (value < -threshold) return "DOWN";
  return "FLAT";
}
