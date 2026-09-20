import { pool } from "../db.js";
import { classifyRealizedReturn, horizonDays } from "./predictionResolutionLogic.js";

export async function resolvePendingPredictions(): Promise<{ resolved: number; stillPending: number }> {
  const pending = await pool.query(`
    select p.id, p.symbol, p.timestamp, p.horizon, p.model_version,
           entry.market_timestamp as entry_timestamp, entry.close as entry_close,
           exit_bar.market_timestamp as exit_timestamp, exit_bar.close as exit_close
    from prediction_ledger p
    join instruments i on i.symbol = p.symbol
    join lateral (
      select pb.market_timestamp, pb.close
      from price_bars pb
      where pb.instrument_id = i.instrument_id
        and pb.timeframe = '1d'
        and pb.market_timestamp >= p.timestamp
      order by pb.market_timestamp asc
      limit 1
    ) entry on true
    join lateral (
      select pb.market_timestamp, pb.close
      from price_bars pb
      where pb.instrument_id = i.instrument_id
        and pb.timeframe = '1d'
        and pb.market_timestamp > entry.market_timestamp
      order by pb.market_timestamp asc
      offset greatest(0, cast(regexp_replace(p.horizon, '[^0-9]', '', 'g') as integer) - 1)
      limit 1
    ) exit_bar on true
    where p.evaluated_at is null
      and p.timestamp < now()
      and p.horizon ~ '^[1-9][0-9]*d$'
    order by p.timestamp asc
    limit 500
  `);

  let resolved = 0;
  for (const row of pending.rows) {
    const entryClose = Number(row.entry_close);
    const exitClose = Number(row.exit_close);
    const realizedReturn = entryClose > 0 ? exitClose / entryClose - 1 : Number.NaN;
    if (!Number.isFinite(realizedReturn)) continue;
    const realizedClass = classifyRealizedReturn(realizedReturn);
    const days = horizonDays(String(row.horizon));
    if (!days) continue;
    const resolutionEvidence = {
      resolutionVersion: "next-trading-bar-v1",
      resolutionMethod: "latest persisted daily close after prediction timestamp",
      horizonTradingDays: days,
      entryTimestamp: new Date(row.entry_timestamp).toISOString(),
      exitTimestamp: new Date(row.exit_timestamp).toISOString(),
      entryClose,
      exitClose,
    };
    await pool.query(
      `update prediction_ledger
       set outcome_return=$2, outcome_class=$3, evaluated_at=now(),
           evidence=evidence || $4::jsonb
       where id=$1 and evaluated_at is null`,
      [row.id, realizedReturn, realizedClass, JSON.stringify({ resolution: resolutionEvidence })],
    );
    resolved += 1;
  }

  const pendingCount = await pool.query("select count(*)::int as count from prediction_ledger where evaluated_at is null");
  return { resolved, stillPending: Number(pendingCount.rows[0]?.count ?? 0) };
}
