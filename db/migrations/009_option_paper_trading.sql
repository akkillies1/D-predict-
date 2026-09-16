-- User-controlled option paper trading ledger.
-- Every fill is derived from the latest persisted option quote; no synthetic price is accepted.
create table if not exists option_paper_trades (
    id                       uuid primary key default gen_random_uuid(),
    contract_id              uuid not null references option_contracts(contract_id),
    symbol                   text not null,
    expiry_date              date not null,
    strike                   numeric(12,4) not null,
    option_type              text not null check (option_type in ('CE','PE')),
    side                     text not null check (side in ('BUY','SELL')),
    status                   text not null default 'OPEN' check (status in ('OPEN','CLOSED')),
    lots                     integer not null check (lots > 0),
    lot_size                 integer not null check (lot_size > 0),
    quantity                 integer not null check (quantity > 0),
    entry_price              numeric(12,4) not null,
    entry_bid               numeric(12,4),
    entry_ask               numeric(12,4),
    entry_ltp               numeric(12,4),
    entry_quote_timestamp    timestamptz not null,
    entry_timestamp          timestamptz not null default now(),
    current_price            numeric(12,4),
    current_quote_timestamp  timestamptz,
    unrealized_pnl           numeric(14,2) not null default 0,
    realized_pnl             numeric(14,2),
    exit_price               numeric(12,4),
    exit_quote_timestamp     timestamptz,
    exit_timestamp           timestamptz,
    exit_reason              text,
    created_at               timestamptz not null default now(),
    updated_at               timestamptz not null default now()
);

create index if not exists idx_option_paper_status on option_paper_trades (status, entry_timestamp desc);
create index if not exists idx_option_paper_contract on option_paper_trades (contract_id, status);
