// Market-wide candidate ranking, shared by the HTTP route and the AI agent's
// market_scan tool so neither can drift from the other's definition of a pick.
import type { Pool } from "pg";
import { rankMarketCandidates } from "./marketScanner.js";

const SCAN_DISCLAIMER = "Research ranking only. It is not investment advice and does not guarantee performance. Signal-grade picks require a calibrated model that cleared the OOS promotion gate; when none exists, qualifying instruments may still appear as momentum-evidence picks derived purely from realized closes (explicitly not a forward return forecast). Instruments are excluded for insufficient or stale history, or when realized momentum is not positive net of assumed cost. When the market is closed, prices are labeled as the last verified session.";

/** NSE cash session, evaluated in IST rather than the host's zone. */
export function isMarketOpen(now: Date): boolean {
  const istHour = Number(new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false }).format(now));
  const istMinute = Number(new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", minute: "2-digit" }).format(now));
  const istWeekday = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short" }).format(now);
  return ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(istWeekday) && (istHour > 9 || (istHour === 9 && istMinute >= 15)) && (istHour < 15 || (istHour === 15 && istMinute <= 30));
}

export async function runMarketScan(pool: Pool, options: { limit: number; roundTripCost: number; now?: Date }) {
  const now = options.now ?? new Date();
  const result = await pool.query(`
    select i.symbol, i.name,
      coalesce((select json_agg(json_build_object('timestamp', b.market_timestamp, 'close', b.close) order by b.market_timestamp asc)
        from price_bars b where b.instrument_id=i.instrument_id and b.timeframe='1d' and b.market_timestamp >= now() - interval '120 days'), '[]'::json) as bars,
      (select json_build_object('expectedReturn', p.expected_return, 'confidence', p.confidence, 'timestamp', p.timestamp, 'horizon', p.horizon, 'calibrationStatus', p.evidence->>'calibrationStatus', 'predictionStatus', p.evidence->>'predictionStatus', 'actionStatus', p.evidence->>'actionStatus', 'modelVersion', p.model_version)
        from prediction_ledger p where upper(p.symbol)=upper(i.symbol) and p.expected_return is not null order by p.timestamp desc limit 1) as prediction
    from instruments i
    where i.is_active=true and i.instrument_type in ('EQUITY','INDEX','ETF')
    order by i.symbol`, []);
  const inputs = result.rows.map((row) => ({ symbol: row.symbol, name: row.name, bars: Array.isArray(row.bars) ? row.bars : [], prediction: row.prediction ?? null }));
  const marketOpen = isMarketOpen(now);
  const scan = rankMarketCandidates(inputs, { maxPicks: options.limit, roundTripCost: options.roundTripCost, maxDataAgeDays: 10, marketOpen }, now);
  return { ok: true, ...scan, marketOpen, requestedPicks: options.limit, roundTripCost: options.roundTripCost, disclaimer: SCAN_DISCLAIMER };
}
