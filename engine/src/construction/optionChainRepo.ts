import { pool, getSpotPriceAt } from "../db.js";

export { getSpotPriceAt };

export interface ContractCandidate {
  contractId: string;
  strike: number;
  expiryDate: string;
  daysToExpiry: number;
  ltp: number | null;
  bid: number | null;
  ask: number | null;
}

/**
 * Finds the ATM (closest-strike) contract of the given option type, for the
 * nearest expiry that satisfies a minimum days-to-expiry requirement.
 * Returns null if no expiry/strike/snapshot combination is available yet —
 * callers must treat that as "cannot construct a trade", not silently skip it.
 */
export async function findAtmContract(
  instrumentId: string,
  optionType: "CE" | "PE",
  spotPrice: number,
  asOf: Date,
  minDaysToExpiry: number
): Promise<ContractCandidate | null> {
  const res = await pool.query(
    `with candidate_expiries as (
       select distinct expiry_date
       from option_contracts
       where instrument_id = $1
         and expiry_date >= (date($2) + ($3 || ' days')::interval)
       order by expiry_date asc
       limit 1
     ),
     latest_snapshot as (
       select distinct on (os.contract_id)
         os.contract_id, os.ltp, os.bid, os.ask
       from option_snapshots os
       join option_contracts oc on oc.contract_id = os.contract_id
       where oc.instrument_id = $1
         and oc.option_type = $4
         and oc.expiry_date = (select expiry_date from candidate_expiries)
         and os.market_timestamp <= $2
       order by os.contract_id, os.market_timestamp desc
     )
     select oc.contract_id as "contractId", oc.strike, oc.expiry_date as "expiryDate",
            (oc.expiry_date - date($2)) as "daysToExpiry",
            ls.ltp, ls.bid, ls.ask
     from option_contracts oc
     join latest_snapshot ls on ls.contract_id = oc.contract_id
     where oc.instrument_id = $1
       and oc.option_type = $4
       and oc.expiry_date = (select expiry_date from candidate_expiries)
     order by abs(oc.strike - $5) asc
     limit 1`,
    [instrumentId, asOf.toISOString(), minDaysToExpiry, optionType, spotPrice]
  );

  if (res.rows.length === 0) return null;
  const r = res.rows[0];
  return {
    contractId: r.contractId,
    strike: Number(r.strike),
    expiryDate: r.expiryDate,
    daysToExpiry: Number(r.daysToExpiry),
    ltp: r.ltp !== null ? Number(r.ltp) : null,
    bid: r.bid !== null ? Number(r.bid) : null,
    ask: r.ask !== null ? Number(r.ask) : null,
  };
}
