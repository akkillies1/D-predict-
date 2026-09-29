-- Sprint: buy alerts. Rows are written ONLY by the collector's radar sweep
-- after it evaluates closed-form rules against real persisted (or freshly
-- fetched) daily bars. No ML participates until an artifact passes the OOS
-- promotion gate; each alert carries the exact numbers that fired it.

create table if not exists buy_alerts (
    id                bigserial primary key,
    symbol            text not null,
    rule              text not null check (rule in ('momentum_turn', 'sma20_cross_up', 'volume_z20_spike')),
    evidence          jsonb not null,
    price             numeric not null check (price > 0),
    market_timestamp  timestamptz not null,
    new_to_radar      boolean not null default false,
    acknowledged      boolean not null default false,
    created_at        timestamptz not null default now(),
    unique (symbol, rule, market_timestamp)
);

create index if not exists idx_buy_alerts_created
    on buy_alerts (created_at desc);

create index if not exists idx_buy_alerts_symbol_rule_recent
    on buy_alerts (symbol, rule, created_at desc);
