import { pool, getInstrumentId } from "../db.js";
import { config } from "../config.js";
import { findAtmContract, getSpotPriceAt } from "./optionChainRepo.js";

// --- Tunable v1 heuristics. These are guesses, not conclusions — revisit
// once constructionBacktest.ts has real numbers to react to. ---
const MIN_CONFIDENCE_TO_TRADE = 0.6; // below this: skip rather than force a low-conviction trade
const THETA_BUFFER_DAYS = 2; // extra days beyond the raw holding horizon, to avoid entering right into rapid decay
const HOLDING_HORIZON_DAYS = 2; // matches the horizon Phase 1's signal backtest is evaluated against
const SL_PREMIUM_PCT = 0.3; // stop at 30% premium loss
const TARGET_PREMIUM_PCT = 0.6; // target at 60% premium gain (~2:1 reward:risk on premium)

interface UnconstructedSignal {
  signalId: string;
  instrumentId: string;
  timestamp: Date;
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
  confidence: number;
  expectedMove: number | null;
}

async function loadUnconstructedSignals(instrumentId: string): Promise<UnconstructedSignal[]> {
  const res = await pool.query(
    `select s.id as "signalId", s.instrument_id as "instrumentId", s.timestamp,
            s.direction, s.confidence, fs.expected_move as "expectedMove"
     from signal_decisions s
     left join feature_snapshots fs on fs.id = s.input_snapshot_id
     where s.instrument_id = $1
       and s.strategy_version = $2
       and not exists (
         select 1 from trade_construction_decisions tc where tc.signal_decision_id = s.id
       )
     order by s.timestamp asc`,
    [instrumentId, config.strategyVersion]
  );
  return res.rows.map((r) => ({
    signalId: r.signalId,
    instrumentId: r.instrumentId,
    timestamp: new Date(r.timestamp),
    direction: r.direction,
    confidence: Number(r.confidence),
    expectedMove: r.expectedMove !== null ? Number(r.expectedMove) : null,
  }));
}

async function recordSkip(signalId: string, timestamp: Date, reasonCodes: string[]): Promise<void> {
  // Recorded with a null contract so the reason is queryable later — a
  // signal that never became a trade is as important to the record as one
  // that did, otherwise the decision log has silent gaps.
  await pool.query(
    `insert into trade_construction_decisions (
       signal_decision_id, timestamp, strategy_version, contract_id,
       reason_codes, parameters
     ) values ($1,$2,$3,null,$4,$5)`,
    [signalId, timestamp, config.strategyVersion, reasonCodes, JSON.stringify({ skipped: true })]
  );
}

async function constructForSignal(signal: UnconstructedSignal): Promise<void> {
  if (signal.direction === "NEUTRAL") {
    await recordSkip(signal.signalId, signal.timestamp, ["NEUTRAL_NO_TRADE"]);
    return;
  }

  if (signal.confidence < MIN_CONFIDENCE_TO_TRADE) {
    await recordSkip(signal.signalId, signal.timestamp, ["LOW_CONFIDENCE_SKIP"]);
    return;
  }

  const spot = await getSpotPriceAt(signal.instrumentId, signal.timestamp);
  if (spot === null) {
    await recordSkip(signal.signalId, signal.timestamp, ["NO_SPOT_PRICE_AVAILABLE"]);
    return;
  }

  const optionType = signal.direction === "BULLISH" ? "CE" : "PE";
  const requiredExpiryDays = HOLDING_HORIZON_DAYS + THETA_BUFFER_DAYS;

  const contract = await findAtmContract(
    signal.instrumentId,
    optionType,
    spot,
    signal.timestamp,
    requiredExpiryDays
  );

  if (contract === null) {
    await recordSkip(signal.signalId, signal.timestamp, ["NO_SUITABLE_CONTRACT_FOUND"]);
    return;
  }

  const entryPremium = contract.ltp ?? (contract.bid !== null && contract.ask !== null ? (contract.bid + contract.ask) / 2 : null);
  if (entryPremium === null || entryPremium <= 0) {
    await recordSkip(signal.signalId, signal.timestamp, ["NO_VALID_PREMIUM"]);
    return;
  }

  const entryLow = contract.bid ?? entryPremium;
  const entryHigh = contract.ask ?? entryPremium;
  const stopLoss = entryPremium * (1 - SL_PREMIUM_PCT);
  const target = entryPremium * (1 + TARGET_PREMIUM_PCT);

  await pool.query(
    `insert into trade_construction_decisions (
       signal_decision_id, timestamp, strategy_version, contract_id,
       entry_low, entry_high, stop_loss, target, expected_move,
       required_expiry_days, reason_codes, parameters
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      signal.signalId,
      signal.timestamp,
      config.strategyVersion,
      contract.contractId,
      entryLow,
      entryHigh,
      stopLoss,
      target,
      signal.expectedMove,
      requiredExpiryDays,
      [`${optionType}_ATM`, "SL_30PCT_PREMIUM", "TARGET_60PCT_PREMIUM"],
      JSON.stringify({
        spot,
        strike: contract.strike,
        expiryDate: contract.expiryDate,
        daysToExpiry: contract.daysToExpiry,
        entryPremium,
      }),
    ]
  );

  console.log(
    `[construction] signal=${signal.signalId} ${signal.direction} -> ${optionType} ${contract.strike} exp=${contract.expiryDate} entry~${entryPremium.toFixed(2)} SL=${stopLoss.toFixed(2)} target=${target.toFixed(2)}`
  );
}

export async function runTradeConstructionEngine(): Promise<void> {
  for (const symbol of config.instruments) {
    const instrumentId = await getInstrumentId(symbol);
    const signals = await loadUnconstructedSignals(instrumentId);
    for (const signal of signals) {
      await constructForSignal(signal);
    }
  }
}
