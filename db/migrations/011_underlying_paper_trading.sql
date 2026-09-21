-- Research-only underlying instrument paper trading. No broker or live-order integration.
create table if not exists paper_accounts (
    id smallint primary key default 1 check (id = 1),
    starting_capital numeric(16,2) not null check (starting_capital > 0),
    cash numeric(16,2) not null check (cash >= 0),
    realized_pnl numeric(16,2) not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists paper_positions (
    account_id smallint not null references paper_accounts(id) on delete cascade,
    symbol text not null references instruments(symbol) on update cascade,
    quantity integer not null check (quantity > 0),
    average_price numeric(14,4) not null check (average_price > 0),
    realized_pnl numeric(16,2) not null default 0,
    current_price numeric(14,4),
    current_timestamp timestamptz,
    updated_at timestamptz not null default now(),
    primary key (account_id, symbol)
);

create table if not exists paper_orders (
    id uuid primary key default gen_random_uuid(),
    account_id smallint not null references paper_accounts(id) on delete cascade,
    symbol text not null references instruments(symbol) on update cascade,
    side text not null check (side in ('BUY','SELL','HOLD')),
    quantity integer not null check (quantity >= 0),
    fill_price numeric(14,4),
    notional numeric(16,2) not null default 0,
    fill_timestamp timestamptz,
    status text not null default 'FILLED' check (status in ('FILLED','REJECTED','RECORDED')),
    note text not null default '',
    rationale text not null default '',
    signal_snapshot jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create index if not exists idx_paper_orders_created on paper_orders(created_at desc);
create index if not exists idx_paper_orders_symbol on paper_orders(symbol, created_at desc);
create index if not exists idx_paper_positions_account on paper_positions(account_id);

comment on table paper_accounts is 'D-Predict research-only virtual cash account';
comment on table paper_positions is 'D-Predict research-only underlying positions';
comment on table paper_orders is 'D-Predict research-only order/action ledger; never routes to a broker';
