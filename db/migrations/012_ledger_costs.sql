-- Ledger cost model: store per-side transaction costs so realized/unrealized P&L
-- can be reported net of fees, like a real broker statement.
-- Gross P&L stays in realized_pnl / unrealized_pnl; net is gross minus fees.

alter table shadow_trades
    add column if not exists entry_fees numeric(14,2) not null default 0,
    add column if not exists exit_fees numeric(14,2);

alter table option_paper_trades
    add column if not exists entry_fees numeric(14,2) not null default 0,
    add column if not exists exit_fees numeric(14,2);
