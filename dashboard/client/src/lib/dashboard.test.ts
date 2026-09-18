import { describe, expect, it } from "vitest";
import { chooseInitialSymbol, clampConfidence, formatConfidence, formatIndianNumber } from "./dashboard";

describe("dashboard helpers", () => {
  it("clamps confidence to the supported 0..1 range", () => {
    expect(clampConfidence(-0.4)).toBe(0);
    expect(clampConfidence(0.82)).toBe(0.82);
    expect(clampConfidence(1.8)).toBe(1);
    expect(clampConfidence(Number.NaN)).toBe(0);
  });

  it("formats confidence as an operator-facing percentage", () => {
    expect(formatConfidence(0.823)).toBe("82%");
    expect(formatConfidence(1.2)).toBe("100%");
  });

  it("formats market values using Indian digit grouping", () => {
    expect(formatIndianNumber(25108.4)).toBe("25,108.40");
    expect(formatIndianNumber(112, 0)).toBe("112");
  });

  it("selects a data-backed active instrument without hard-coded symbols", () => {
    expect(chooseInitialSymbol("SBI", [
      { symbol: "SBI", isActive: true, observations: 0 },
      { symbol: "ACME", isActive: true, observations: 12 },
    ])).toBe("ACME");
    expect(chooseInitialSymbol("ACME", [{ symbol: "ACME", isActive: true, observations: 12 }])).toBe("ACME");
  });
});
