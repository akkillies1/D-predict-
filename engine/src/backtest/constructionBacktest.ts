import { pool } from "../db.js";
import { config } from "../config.js";
import { determineTradeOutcome, PremiumPoint } from "./tradeOutcome.js";

interface ConstructedTrade {
  id: string;
  timestamp: Date;
  contractId: string;
  entryPremium: number;
  stopLoss: number;
  target: number;
  requiredExpiryDays: number;
  reasonCodes: string[];
}

interface ConstructionBacktestResult {
  totalConstructed: number;   // real trades only (contract_id is not null)
  evaluable: number;          // had a contract AND a future snapshot to score against
  winRate: number;
  avgReturnPct: number;
  expectancyPct: number;
  slHitCount: number;
  targetHitCount: number;
  neitherHitCount: number; // terminal snapshot fell between SL and target — approximation limit, see README
}

async function loadConstructedTrades(strategyVersion: string): Promise<ConstructedTrade[]> {
  const res = await pool.query(
    `select id, timestamp, contract_id as "contractId",
            (parameters->>'entryPremium')::numeric as "entryPremium",
            stop_loss as "stopLoss", target, required_expiry_days as "requiredExpiryDays",
            reason_codes as "reasonCodes"
     from trade_construction_decisions
     where strategy_version = $1 and contract_id is not null
     order by timestamp asc`,
    [strategyVersion]
  );
  return res.rows.map((r) => ({
    id: r.id,
    timestamp: new Date(r.timestamp),
    contractId: r.contractId,
    entryPremium: Number(r.entryPremium),
    stopLoss: Number(r.stopLoss),
    target: Number(r.target),
    requiredExpiryDays: Number(r.requiredExpiryDays),
    reasonCodes: r.reasonCodes ?? [],
  }));
}

/** Full premium path for a contract between entry and a horizon end,
 * ordered chronologically, feeding determineTradeOutcome for real
 * SL/target-crossing detection instead of a single terminal read. */
async function getPremiumPath(contractId: string, from: Date, to: Date): Promise<PremiumPoint[]> {
  const res = await pool.query(
    `select market_timestamp as timestamp, ltp from option_snapshots
     where contract_id = $1 and market_timestamp >= $2 and market_timestamp <= $3 and ltp is not null
     order by market_timestamp asc`,
    [contractId, from, to]
  );
  return res.rows.map((r) => ({ timestamp: new Date(r.timestamp), ltp: Number(r.ltp) }));
}

export async function backtestTradeConstruction(): Promise<ConstructionBacktestResult> {
  const trades = await loadConstructedTrades(config.strategyVersion);
  const totalConstructed = trades.length;

  const returns: { returnPct: number; outcome: "SL" | "TARGET" | "NEITHER" }[] = [];

  for (const trade of trades) {
    const horizonMs = trade.requiredExpiryDays * 24 * 60 * 60 * 1000;
    const horizonEnd = new Date(trade.timestamp.getTime() + horizonMs);
    const path = await getPremiumPath(trade.contractId, trade.timestamp, horizonEnd);
    if (path.length === 0) continue; // not enough snapshot data yet to score this trade

    const result = determineTradeOutcome(path, trade.stopLoss, trade.target);
    const returnPct = ((result.exitPremium - trade.entryPremium) / trade.entryPremium) * 100;

    returns.push({ returnPct, outcome: result.outcome });
  }

  const evaluable = returns.length;
  const wins = returns.filter((r) => r.returnPct > 0);
  const winRate = evaluable > 0 ? wins.length / evaluable : 0;
  const avgReturnPct = evaluable > 0 ? returns.reduce((a, r) => a + r.returnPct, 0) / evaluable : 0;
  const avgWin = wins.length > 0 ? wins.reduce((a, r) => a + r.returnPct, 0) / wins.length : 0;
  const losses = returns.filter((r) => r.returnPct <= 0);
  const avgLoss = losses.length > 0 ? losses.reduce((a, r) => a + r.returnPct, 0) / losses.length : 0;
  const expectancyPct = winRate * avgWin + (1 - winRate) * avgLoss;

  return {
    totalConstructed,
    evaluable,
    winRate,
    avgReturnPct,
    expectancyPct,
    slHitCount: returns.filter((r) => r.outcome === "SL").length,
    targetHitCount: returns.filter((r) => r.outcome === "TARGET").length,
    neitherHitCount: returns.filter((r) => r.outcome === "NEITHER").length,
  };
}

export async function runConstructionBacktest(): Promise<void> {
  // Separately count skips (contract_id is null) vs actual constructed trades.
  const skipRes = await pool.query(
    `select count(*)::int as n from trade_construction_decisions
     where strategy_version = $1 and contract_id is null`,
    [config.strategyVersion]
  );
  const skipped = skipRes.rows[0].n as number;

  const result = await backtestTradeConstruction();
  console.log(`\n[backtest] trade construction — signal -> option P&L (full snapshot-path SL/target scan)`);
  console.log(`  constructed trades: ${result.totalConstructed}, skipped signals: ${skipped}`);
  console.log(`  evaluable: ${result.evaluable}`);
  console.log(`  win rate: ${(result.winRate * 100).toFixed(1)}%`);
  console.log(`  avg return: ${result.avgReturnPct.toFixed(2)}% premium`);
  console.log(`  expectancy: ${result.expectancyPct.toFixed(2)}% premium per trade`);
  console.log(`  outcome split: SL=${result.slHitCount} TARGET=${result.targetHitCount} NEITHER=${result.neitherHitCount}`);
  if (result.neitherHitCount > 0) {
    console.log(`  note: NEITHER means no snapshot in the holding window crossed SL or target — scored at the last available premium in that window, which is a real "still open at horizon end" read, not a missing-data gap. Snapshot polling density still limits precision between polls.`);
  }
}
