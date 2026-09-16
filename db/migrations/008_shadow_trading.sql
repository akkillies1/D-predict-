-- Live shadow-trading ledger. Simulation only: no broker/order API is referenced.
create table if not exists shadow_trades (
    id                      uuid primary key default gen_random_uuid(),
    trade_construction_id   uuid not null references trade_construction_decisions(id),
    signal_decision_id      uuid not null references signal_decisions(id),
    contract_id             uuid not null references option_contracts(contract_id),
    status                  text not null default 'OPEN' check (status in ('OPEN','CLOSED')),
    direction               text not null check (direction in ('BULLISH','BEARISH')),
    quantity                integer not null check (quantity > 0),
    lot_size                integer not null check (lot_size > 0),
    entry_price             numeric(12,4) not null,
    entry_bid               numeric(12,4),
    entry_ask               numeric(12,4),
    entry_ltp               numeric(12,4),
    entry_timestamp         timestamptz not null,
    entry_quote_timestamp   timestamptz not null,
    stop_loss               numeric(12,4) not null,
    target                  numeric(12,4) not null,
    expiry_date             date not null,
    current_price           numeric(12,4),
    current_quote_timestamp timestamptz,
    unrealized_pnl          numeric(14,2) not null default 0,
    realized_pnl            numeric(14,2),
    exit_price              numeric(12,4),
    exit_timestamp          timestamptz,
    exit_reason             text,
    entry_metadata          jsonb not null default '{}'::jsonb,
    exit_metadata           jsonb,
    created_at              timestamptz not null default now(),
    updated_at              timestamptz not null default now(),
    unique (trade_construction_id)
);

create index if not exists idx_shadow_trades_status on shadow_trades (status, entry_timestamp desc);
create index if not exists idx_shadow_trades_contract on shadow_trades (contract_id, status);
create index if not exists idx_shadow_trades_signal on shadow_trades (signal_decision_id);

create table if not exists shadow_equity_snapshots (
    id                bigserial primary key,
    timestamp         timestamptz not null,
    starting_capital  numeric(14,2) not null,
    realized_pnl      numeric(14,2) not null,
    unrealized_pnl    numeric(14,2) not null,
    equity            numeric(14,2) not null,
    peak_equity       numeric(14,2) not null,
    drawdown          numeric(14,2) not null,
    open_trades       integer not null,
    closed_trades     integer not null,
    unique (timestamp)
);

create index if not exists idx_shadow_equity_time on shadow_equity_snapshots (timestamp desc);
