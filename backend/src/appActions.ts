// The app's own write operations, extracted into one place so a dashboard click
// and an approved agent tool run literally the same statement — the two can never
// drift on what a write does. Nothing here is reachable without either an HTTP
// route or a user approving the agent's proposed change.
import type { Pool } from "pg";

export type WatchlistItem = { symbol: string; position: number; note: string | null };

/**
 * Registers the instrument if it is not tracked yet (activating collection for
 * it) and puts it at the end of the watchlist. Re-adding keeps the existing note
 * unless a new one is supplied.
 */
export async function addWatchlistItem(pool: Pool, symbol: string, note: string | null): Promise<WatchlistItem> {
  const result = await pool.query(
    `with instrument as (
       insert into instruments (symbol, exchange, lot_size, is_active)
       values ($1, case when $1 like '%.BO' then 'BSE' else 'NSE' end, 1, true)
       on conflict (symbol) do update set is_active=true returning symbol
     ), next_position as (
       select coalesce(max(position),-1)+1 as value from watchlist_items
     )
     insert into watchlist_items(symbol,position,note)
     select instrument.symbol,next_position.value,$2 from instrument,next_position
     on conflict(symbol) do update set note=coalesce(excluded.note,watchlist_items.note),updated_at=now()
     returning symbol,position,note`,
    [symbol, note],
  );
  const row = result.rows[0];
  return { symbol: String(row.symbol), position: Number(row.position), note: row.note == null ? null : String(row.note) };
}

/**
 * Removes the watchlist row only. Stored bars, instruments and ledger history
 * are untouched, so this is always reversible by adding the symbol again.
 */
export async function removeWatchlistItem(pool: Pool, symbol: string): Promise<boolean> {
  const result = await pool.query("delete from watchlist_items where symbol=$1", [symbol]);
  return (result.rowCount ?? 0) === 1;
}

export async function acknowledgeAlertIds(pool: Pool, ids: number[]): Promise<number[]> {
  if (!ids.length) return [];
  const result = await pool.query(
    "update buy_alerts set acknowledged = true where id = any($1::int[]) and acknowledged = false returning id",
    [ids],
  );
  return result.rows.map((row) => Number(row.id));
}

export async function acknowledgeAllAlerts(pool: Pool): Promise<number> {
  const result = await pool.query("update buy_alerts set acknowledged = true where acknowledged = false returning id");
  return result.rowCount ?? 0;
}

export async function unreadAlertCount(pool: Pool): Promise<number> {
  const result = await pool.query("select count(*)::int as count from buy_alerts where acknowledged = false");
  return Number(result.rows[0]?.count ?? 0);
}

export type MlCall = (path: string, init?: RequestInit, timeoutMs?: number) => Promise<{ status: number; body: any }>;

/** Retrains one instrument/horizon artifact and returns the raw ML response. */
export async function retrainSymbol(mlFetch: MlCall, symbol: string, horizon: string, timeoutMs: number) {
  return mlFetch(`/train/${encodeURIComponent(symbol)}?horizon=${encodeURIComponent(horizon)}`, { method: "POST" }, timeoutMs);
}

/** Long runs are allowed to finish; a training request is minutes, not seconds. */
export const TRAIN_TIMEOUT_MS = Math.max(60_000, Number(process.env.ML_TRAIN_TIMEOUT_MS ?? 600_000));
