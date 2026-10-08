import type pg from "pg";

export async function ensureOptionContractMetadata(pool: pg.Pool): Promise<void> {
  await pool.query("alter table option_contracts add column if not exists lot_size integer");
  await pool.query("alter table option_contracts drop constraint if exists option_contracts_lot_size_positive");
  await pool.query("alter table option_contracts add constraint option_contracts_lot_size_positive check (lot_size is null or lot_size > 0)");
}
