export type OptionType = "CE" | "PE";
export type OptionLeg = {
  expiryDate: string;
  strike: number;
  optionType: OptionType;
  timestamp: string | Date;
  ltp: number | null;
  bid: number | null;
  ask: number | null;
  oi: number | null;
  oiChange: number | null;
  iv: number | null;
  volume?: number | null;
};

export type OptionAction = "BUY_CALL" | "BUY_PUT" | "CALL_VERTICAL" | "PUT_VERTICAL" | "WAIT" | "ABSTAIN";
export type OptionIntelligence = {
  ok: boolean;
  status: "ACTIONABLE" | "RESEARCH_ONLY" | "ABSTAIN" | "NO_CHAIN";
  symbol?: string;
  expiry: string | null;
  asOf: string | null;
  spot: number | null;
  metrics: {
    pcr: number | null;
    atmStrike: number | null;
    atmIv: number | null;
    ivSkewPutMinusCall: number | null;
    callWall: number | null;
    putWall: number | null;
    maxPain: number | null;
    averageSpreadPct: number | null;
    liquidityScore: number;
    freshnessSeconds: number | null;
  };
  recommendation: {
    action: OptionAction;
    direction: "BULLISH" | "BEARISH" | "NEUTRAL";
    confidence: number;
    rationale: string;
    evidence: string[];
    risks: string[];
    contract: { expiry: string; strike: number; optionType: OptionType; price: number; bid: number; ask: number } | null;
    hedge: { expiry: string; strike: number; optionType: OptionType; price: number; bid: number; ask: number } | null;
  };
  candidates: Array<{ expiry: string; strike: number; optionType: OptionType; ltp: number | null; bid: number | null; ask: number | null; oi: number; iv: number | null; spreadPct: number | null }>;
  gates: Record<string, boolean>;
  disclaimer: string;
};

function finite(value: unknown): number | null { const n = Number(value); return Number.isFinite(n) ? n : null; }
function dateOf(value: string | Date): Date | null { const d = value instanceof Date ? value : new Date(value); return Number.isFinite(d.getTime()) ? d : null; }
function round(value: number, places = 4) { const factor = 10 ** places; return Math.round(value * factor) / factor; }
function nearest(rows: OptionLeg[], spot: number): OptionLeg | null { return rows.reduce<OptionLeg | null>((best, row) => !best || Math.abs(row.strike - spot) < Math.abs(best.strike - spot) ? row : best, null); }
function validQuote(row: OptionLeg): boolean { return row.bid != null && row.ask != null && row.bid > 0 && row.ask >= row.bid; }

export function analyzeOptionChain(symbol: string, rawRows: OptionLeg[], spotInput: number | null, now = new Date()): OptionIntelligence {
  const rows = rawRows.filter(row => Number.isFinite(row.strike) && row.strike > 0 && (row.optionType === "CE" || row.optionType === "PE") && dateOf(row.expiryDate) && dateOf(row.timestamp));
  const disclaimer = "Research-only option evidence. This is not investment advice, does not predict with certainty, and never sends broker orders.";
  if (!rows.length) return { ok: false, status: "NO_CHAIN", expiry: null, asOf: null, spot: finite(spotInput), metrics: { pcr: null, atmStrike: null, atmIv: null, ivSkewPutMinusCall: null, callWall: null, putWall: null, maxPain: null, averageSpreadPct: null, liquidityScore: 0, freshnessSeconds: null }, recommendation: { action: "ABSTAIN", direction: "NEUTRAL", confidence: 0, rationale: "No persisted option-chain snapshot is available.", evidence: [], risks: ["The engine cannot identify a contract without real chain data."], contract: null, hedge: null }, candidates: [], gates: { chainAvailable: false, spotAvailable: spotInput != null }, disclaimer };
  const expiry = [...new Set(rows.map(row => row.expiryDate))].sort()[0];
  const chain = rows.filter(row => row.expiryDate === expiry);
  const spot = finite(spotInput);
  const asOf = chain.map(row => dateOf(row.timestamp)!).sort((a, b) => b.getTime() - a.getTime())[0];
  const freshnessSeconds = asOf ? Math.max(0, (now.getTime() - asOf.getTime()) / 1000) : null;
  const atmStrike = spot != null ? nearest(chain, spot)?.strike ?? null : null;
  const band = spot != null ? chain.filter(row => Math.abs(row.strike - spot) / spot <= 0.05) : chain;
  const ceOi = band.filter(row => row.optionType === "CE").reduce((sum, row) => sum + Math.max(0, row.oi ?? 0), 0);
  const peOi = band.filter(row => row.optionType === "PE").reduce((sum, row) => sum + Math.max(0, row.oi ?? 0), 0);
  const calls = chain.filter(row => row.optionType === "CE");
  const puts = chain.filter(row => row.optionType === "PE");
  const callWall = calls.reduce<OptionLeg | null>((best, row) => !best || (row.oi ?? 0) > (best.oi ?? 0) ? row : best, null)?.strike ?? null;
  const putWall = puts.reduce<OptionLeg | null>((best, row) => !best || (row.oi ?? 0) > (best.oi ?? 0) ? row : best, null)?.strike ?? null;
  const atmCall = atmStrike == null ? null : nearest(calls, atmStrike);
  const atmPut = atmStrike == null ? null : nearest(puts, atmStrike);
  const atmIv = finite(atmCall?.iv) != null && finite(atmPut?.iv) != null ? ((atmCall!.iv as number) + (atmPut!.iv as number)) / 2 : finite(atmCall?.iv ?? atmPut?.iv);
  const ivSkew = finite(atmPut?.iv) != null && finite(atmCall?.iv) != null ? (atmPut!.iv as number) - (atmCall!.iv as number) : null;
  const maxPain = spot == null ? null : [...new Set(chain.map(row => row.strike))].reduce((best, strike) => {
    const pain = chain.reduce((sum, row) => sum + (row.oi ?? 0) * (row.optionType === "CE" ? Math.max(0, strike - row.strike) : Math.max(0, row.strike - strike)), 0);
    const bestPain = best == null ? Infinity : best.pain;
    return pain < bestPain ? { strike, pain } : best;
  }, null as { strike: number; pain: number } | null)?.strike ?? null;
  const quoted = chain.filter(validQuote);
  const spreads = quoted.map(row => (row.ask! - row.bid!) / Math.max(row.ask!, 0.01)).filter(Number.isFinite);
  const averageSpreadPct = spreads.length ? spreads.reduce((a, b) => a + b, 0) / spreads.length : null;
  const liquidityScore = Math.min(1, quoted.length / Math.max(4, chain.length * 0.5)) * (averageSpreadPct == null ? 0 : Math.max(0, 1 - averageSpreadPct * 2));
  const candidates = chain.filter(row => spot != null && Math.abs(row.strike - spot) / spot <= 0.1 && validQuote(row)).map(row => ({ expiry, strike: row.strike, optionType: row.optionType, ltp: row.ltp, bid: row.bid, ask: row.ask, oi: Math.max(0, row.oi ?? 0), iv: row.iv, spreadPct: round((row.ask! - row.bid!) / Math.max(row.ask!, 0.01) * 100, 2) })).sort((a, b) => Math.abs(a.strike - (spot as number)) - Math.abs(b.strike - (spot as number)));
  const pcr = ceOi > 0 ? peOi / ceOi : null;
  const bullish = pcr != null && pcr >= 1.3 && (ivSkew == null || ivSkew <= 2);
  const bearish = pcr != null && pcr <= 0.7 && (ivSkew == null || ivSkew >= -2);
  const direction = bullish ? "BULLISH" : bearish ? "BEARISH" : "NEUTRAL";
  const preferred = candidates.find(row => row.optionType === (bullish ? "CE" : bearish ? "PE" : "CE")) ?? null;
  const hedge = preferred && spot != null ? candidates.find(row => row.optionType === preferred.optionType && (bullish ? row.strike > preferred.strike : row.strike < preferred.strike) && Math.abs(row.strike - preferred.strike) >= Math.max(1, spot * 0.01)) ?? null : null;
  const gates = { chainAvailable: true, spotAvailable: spot != null && spot > 0, quoteAvailable: candidates.length > 0, liquidity: liquidityScore >= 0.25, costCovered: preferred != null && ((preferred.ask! - preferred.bid!) / preferred.ask!) <= 0.15, freshForPaper: freshnessSeconds != null && freshnessSeconds <= 180, directionalEvidence: bullish || bearish };
  const actionable = Object.values(gates).every(Boolean);
  const action: OptionAction = actionable && preferred ? (bullish ? "BUY_CALL" : "BUY_PUT") : direction !== "NEUTRAL" && preferred && hedge ? (bullish ? "CALL_VERTICAL" : "PUT_VERTICAL") : gates.chainAvailable && gates.spotAvailable ? "WAIT" : "ABSTAIN";
  const evidence = [`PCR ${pcr == null ? "unavailable" : pcr.toFixed(2)} from the ±5% ATM OI band.`, `Call wall ${callWall ?? "unavailable"}; put wall ${putWall ?? "unavailable"}.`, `ATM IV ${atmIv == null ? "unavailable" : `${atmIv.toFixed(2)}%`}; put-minus-call skew ${ivSkew == null ? "unavailable" : `${ivSkew.toFixed(2)} vol points`}.`, `Max pain is ${maxPain ?? "unavailable"}; it is context, not a price target.`];
  const risks = [freshnessSeconds != null && freshnessSeconds > 180 ? "Quote is stale for a paper fill; no action button is enabled." : "Displayed chain may be closed-market data and can gap before the next session.", averageSpreadPct == null ? "Bid/ask quality is unavailable." : `Average quoted spread is ${(averageSpreadPct * 100).toFixed(1)}%; premium slippage can overwhelm a weak edge.`, "OI walls and PCR describe positioning evidence, not a guaranteed direction."];
  return { ok: true, status: actionable ? "ACTIONABLE" : action === "WAIT" ? "RESEARCH_ONLY" : "ABSTAIN", symbol, expiry, asOf: asOf?.toISOString() ?? null, spot, metrics: { pcr, atmStrike, atmIv, ivSkewPutMinusCall: ivSkew, callWall, putWall, maxPain, averageSpreadPct, liquidityScore: round(liquidityScore, 3), freshnessSeconds: freshnessSeconds == null ? null : round(freshnessSeconds, 1) }, recommendation: { action, direction, confidence: round(Math.min(1, (direction === "NEUTRAL" ? 0.35 : 0.55) + liquidityScore * 0.25 + (pcr != null ? 0.15 : 0)), 3), rationale: action === "WAIT" ? "The chain is available, but the directional and execution gates do not justify an action." : action === "ABSTAIN" ? "The engine is abstaining because required chain, spot, quote, or liquidity evidence is missing." : `${direction} positioning evidence clears the configured research gates; paper validation is required.`, evidence, risks, contract: preferred ? { expiry, strike: preferred.strike, optionType: preferred.optionType, price: preferred.ask!, bid: preferred.bid!, ask: preferred.ask! } : null, hedge: hedge ? { expiry, strike: hedge.strike, optionType: hedge.optionType, price: hedge.ask!, bid: hedge.bid!, ask: hedge.ask! } : null }, candidates: candidates.slice(0, 20), gates, disclaimer };
}
