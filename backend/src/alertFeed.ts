// Shared shape for buy_alerts rows so the REST routes and the WebSocket hub
// always emit identical JSON. Evidence numbers come straight from the
// collector's closed-form rules (collector/radar.py) — nothing here invents
// probabilities or model signals; every alert is an auditable rule trigger.
import type { Pool } from "pg";

export interface AlertRow {
  id: string | number;
  symbol: string;
  rule: string;
  evidence: unknown;
  price: string | number | null;
  market_timestamp: Date | string | null;
  new_to_radar: boolean;
  acknowledged: boolean;
  created_at: Date | string | null;
}

function iso(value: unknown): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function mapAlertRow(row: AlertRow) {
  return {
    id: Number(row.id),
    symbol: row.symbol,
    rule: row.rule,
    evidence: row.evidence ?? {},
    price: row.price == null ? null : Number(row.price),
    marketTimestamp: iso(row.market_timestamp),
    newToRadar: row.new_to_radar === true,
    acknowledged: row.acknowledged === true,
    createdAt: iso(row.created_at),
  };
}

const ALERT_COLUMNS = `id, symbol, rule, evidence, price, market_timestamp,
  new_to_radar, acknowledged, created_at`;

export async function fetchRecentAlerts(pool: Pool, limit: number, symbol: string | null): Promise<AlertRow[]> {
  const result = symbol
    ? await pool.query(
        `select ${ALERT_COLUMNS} from buy_alerts where symbol = $1 order by created_at desc, id desc limit $2`,
        [symbol, limit],
      )
    : await pool.query(
        `select ${ALERT_COLUMNS} from buy_alerts order by created_at desc, id desc limit $1`,
        [limit],
      );
  return result.rows;
}

export async function fetchAlertsSince(pool: Pool, lastId: number): Promise<AlertRow[]> {
  const result = await pool.query(
    `select ${ALERT_COLUMNS} from buy_alerts where id > $1 order by id asc limit 25`,
    [lastId],
  );
  return result.rows;
}
