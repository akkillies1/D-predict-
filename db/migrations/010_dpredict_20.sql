-- D-Predict 2.0 local-first user state.
-- A single local watchlist is intentional: the desktop app has no remote user identity.
create table if not exists watchlist_items (
    symbol text primary key references instruments(symbol) on update cascade on delete cascade,
    position integer not null default 0,
    note text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists idx_watchlist_items_position on watchlist_items(position, created_at);

create table if not exists journal_entries (
    id uuid primary key default gen_random_uuid(),
    symbol text references instruments(symbol) on update cascade on delete set null,
    trade_id uuid,
    strategy text,
    thesis text,
    entry_reason text,
    exit_reason text,
    notes text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists idx_journal_entries_symbol_created on journal_entries(symbol, created_at desc);

-- Safe for repeated native setup and Docker fresh initialization.
comment on table watchlist_items is 'D-Predict 2.0 local persisted watchlist';
comment on table journal_entries is 'D-Predict 2.0 user-authored trade journal';

drop trigger if exists watchlist_items_updated_at on watchlist_items;
create or replace function dpredict_touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
create trigger watchlist_items_updated_at before update on watchlist_items for each row execute function dpredict_touch_updated_at();
drop trigger if exists journal_entries_updated_at on journal_entries;
create trigger journal_entries_updated_at before update on journal_entries for each row execute function dpredict_touch_updated_at();

create index if not exists idx_price_bars_instrument_timeframe_ts on price_bars(instrument_id, timeframe, market_timestamp desc);
