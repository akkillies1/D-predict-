import { Pool } from "pg";
import { config } from "./config.js";

export const pool = new Pool({ connectionString: config.databaseUrl });

export async function getInstrumentId(symbol: string): Promise<string> {
  const res = await pool.query(
    "select instrument_id from instruments where symbol = $1",
    [symbol]
  );
  if (res.rows.length === 0) {
    throw new Error(`Unknown instrument: ${symbol}. Seed it into instruments first.`);
  }
  return res.rows[0].instrument_id;
}

/** Latest known close at or before a timestamp. Shared by the signal engine
 * (max-pain comparison), construction engine (ATM strike lookup), and
 * forecast engine (simulation starting price) so they all agree on "current
 * price" rather than each running a slightly different query. */
export async function getSpotPriceAt(instrumentId: string, timestamp: Date, timeframe = "1m"): Promise<number | null> {
  const res = await pool.query(
    `select close from price_bars
     where instrument_id = $1 and timeframe = $2 and market_timestamp <= $3
     order by market_timestamp desc limit 1`,
    [instrumentId, timeframe, timestamp]
  );
  return res.rows.length > 0 ? Number(res.rows[0].close) : null;
}

/** Daily closes rolled up from intraday bars (the collector only stores
 * '1m'), oldest first. Used anywhere daily-timeframe history is needed:
 * backtesting and the Monte Carlo forecast's volatility calibration. */
export async function getDailyClosesFromIntraday(
  instrumentId: string,
  sourceTimeframe = "1m"
): Promise<{ timestamp: Date; close: number }[]> {
  const res = await pool.query(
    `select
       date_trunc('day', market_timestamp) as day,
       (array_agg(close order by market_timestamp desc))[1] as close,
       max(market_timestamp) as last_ts
     from price_bars
     where instrument_id = $1 and timeframe = $2
     group by day
     order by day asc`,
    [instrumentId, sourceTimeframe]
  );
  return res.rows.map((r) => ({ timestamp: new Date(r.last_ts), close: Number(r.close) }));
}
