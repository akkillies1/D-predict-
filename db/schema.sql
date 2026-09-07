-- ============================================================================
-- Nifty Options Signal Engine — Canonical Data Schema
-- Target: Supabase / PostgreSQL 15+
--
-- Layers:
--   1. Reference     — instruments, contracts, sessions (slow-changing)
--   2. Raw / Immutable — price_bars, option_snapshots, events (append-only)
--   3. Derived        — feature_snapshots (computed indicators, safe to recompute/drop)
--   4. Decisions      — one table per engine stage, fully reproducible
-- ============================================================================

create extension if not exists "pgcrypto"; -- for gen_random_uuid()

-- ----------------------------------------------------------------------------
-- 1. REFERENCE DATA
-- ----------------------------------------------------------------------------

create table instruments (
    instrument_id   uuid primary key default gen_random_uuid(),
    symbol          text not null unique,          -- 'NIFTY', 'BANKNIFTY'
    exchange        text not null default 'NSE',
    lot_size        integer not null,               -- current lot size; see note below
    tick_size       numeric(10,4) not null default 0.05,
    is_active       boolean not null default true,
    created_at      timestamptz not null default now()
);

-- NSE revises lot sizes periodically. Keep history instead of overwriting,
-- so old backtests still use the lot size that was actually in force.
create table instrument_lot_size_history (
    id              uuid primary key default gen_random_uuid(),
    instrument_id   uuid not null references instruments(instrument_id),
    lot_size        integer not null,
    effective_from  date not null,
    effective_to    date,                            -- null = still current
    created_at      timestamptz not null default now(),
    unique (instrument_id, effective_from)
);

create table market_sessions (
    session_date    date primary key,
    is_trading_day  boolean not null default true,
    session_open    timestamptz,
    session_close   timestamptz,
    notes           text                             -- e.g. 'muhurat trading', 'holiday'
);

create type option_type as enum ('CE', 'PE');

create table option_contracts (
    contract_id     uuid primary key default gen_random_uuid(),
    instrument_id   uuid not null references instruments(instrument_id),
    expiry_date     date not null,
    strike          numeric(10,2) not null,
    option_type     option_type not null,
    created_at      timestamptz not null default now(),
    unique (instrument_id, expiry_date, strike, option_type)
);

create index idx_option_contracts_lookup
    on option_contracts (instrument_id, expiry_date, option_type, strike);

-- ----------------------------------------------------------------------------
-- 2. RAW / IMMUTABLE MARKET DATA
--    Insert-only. Never update a historical row — if a correction is needed,
--    insert a new row and mark the old one via a separate audit process.
-- ----------------------------------------------------------------------------

create table price_bars (
    id                bigserial primary key,
    instrument_id     uuid not null references instruments(instrument_id),
    market_timestamp  timestamptz not null,           -- actual market time of the bar
    collected_at      timestamptz not null default now(), -- when the collector ingested it
    timeframe         text not null,                  -- '1m','5m','1d', etc.
    open              numeric(12,4) not null,
    high              numeric(12,4) not null,
    low               numeric(12,4) not null,
    close             numeric(12,4) not null,
    volume            bigint,
    source            text not null,                  -- 'yfinance','nse', etc.
    source_version    text,                            -- adapter/version that produced this row
    ingestion_run_id  uuid,                            -- ties row to a specific collector run
    -- idempotency boundary: market time + source, NOT ingestion time
    unique (instrument_id, timeframe, market_timestamp, source)
);

create index idx_price_bars_lookup
    on price_bars (instrument_id, timeframe, market_timestamp desc);

create table option_snapshots (
    id                bigserial primary key,
    contract_id       uuid not null references option_contracts(contract_id),
    market_timestamp  timestamptz not null,            -- actual market time of the snapshot
    collected_at      timestamptz not null default now(), -- when the collector ingested it
    ltp               numeric(12,4),
    bid               numeric(12,4),
    ask               numeric(12,4),
    volume            bigint,
    oi                bigint,
    oi_change         bigint,
    iv                numeric(8,4),
    delta             numeric(8,4),
    gamma             numeric(10,6),
    theta             numeric(10,4),
    vega              numeric(10,4),
    source            text not null,
    source_version    text,
    ingestion_run_id  uuid,
    -- idempotency boundary: market time + source, NOT ingestion time.
    -- Prevents a re-poll of the same moment from creating a duplicate row.
    unique (contract_id, market_timestamp, source)
);

-- This table is by far the highest-volume table (every strike x every poll).
-- This composite index is what every backtest/feature query will hit.
create index idx_option_snapshots_lookup
    on option_snapshots (contract_id, market_timestamp desc);

create type event_importance as enum ('LOW', 'MEDIUM', 'HIGH');

create table events (
    id              bigserial primary key,
    timestamp       timestamptz not null,
    event_type      text not null,                   -- 'RBI_POLICY','BUDGET','FED','EARNINGS', etc.
    importance      event_importance not null,
    description     text,
    created_at      timestamptz not null default now()
);

create index idx_events_timestamp on events (timestamp);

-- ----------------------------------------------------------------------------
-- 3. DERIVED FEATURE LAYER
--    Computed from raw data. Safe to drop and recompute — never a source of truth.
-- ----------------------------------------------------------------------------

create table feature_snapshots (
    id              bigserial primary key,
    instrument_id   uuid not null references instruments(instrument_id),
    timestamp       timestamptz not null,
    feature_set_version text not null,               -- bump when calc logic changes
    trend           text,                             -- 'UP','DOWN','SIDEWAYS'
    momentum        numeric(10,4),
    rsi             numeric(6,2),
    atr             numeric(12,4),
    expected_move   numeric(12,4),                    -- max(ATR-derived, IV-implied)
    iv_rank         numeric(6,2),
    regime          text,                             -- 'TRENDING','RANGE','HIGH_VOL', etc.
    pcr             numeric(8,4),
    max_pain_strike numeric(10,2),
    raw_features    jsonb,                             -- catch-all for anything not modeled yet
    created_at      timestamptz not null default now(),
    unique (instrument_id, timestamp, feature_set_version)
);

create index idx_feature_snapshots_lookup
    on feature_snapshots (instrument_id, timestamp desc);

-- ----------------------------------------------------------------------------
-- 4. DECISION LOG
--    One table per engine stage. Every row must be enough, on its own,
--    to answer: "why did the engine decide this, at this moment, with this data?"
-- ----------------------------------------------------------------------------

create type direction as enum ('BULLISH', 'BEARISH', 'NEUTRAL');

create table signal_decisions (
    id                  uuid primary key default gen_random_uuid(),
    instrument_id       uuid not null references instruments(instrument_id),
    timestamp           timestamptz not null,
    strategy_version    text not null,
    model_version       text not null,
    input_snapshot_id   bigint references feature_snapshots(id),
    direction           direction not null,
    confidence          numeric(5,4) not null,         -- 0.0000–1.0000
    regime              text,
    reason_codes        text[],                          -- e.g. {'EMA_CROSS_UP','OI_CONFIRMS'}
    parameters          jsonb,
    created_at          timestamptz not null default now()
);

create table trade_construction_decisions (
    id                  uuid primary key default gen_random_uuid(),
    signal_decision_id  uuid not null references signal_decisions(id),
    timestamp           timestamptz not null,
    strategy_version    text not null,
    contract_id         uuid references option_contracts(contract_id),
    entry_low           numeric(12,4),
    entry_high          numeric(12,4),
    stop_loss           numeric(12,4),
    target              numeric(12,4),
    expected_move       numeric(12,4),
    required_expiry_days integer,
    reason_codes        text[],
    parameters          jsonb,
    created_at          timestamptz not null default now()
);

create table risk_decisions (
    id                      uuid primary key default gen_random_uuid(),
    trade_construction_id   uuid not null references trade_construction_decisions(id),
    timestamp               timestamptz not null,
    strategy_version        text not null,
    capital                 numeric(14,2) not null,
    risk_pct                numeric(5,4) not null,
    max_rupee_risk          numeric(14,2) not null,
    lot_size_used           integer not null,
    max_lots_allowed        integer not null,
    approved                boolean not null,
    rejection_reason        text,                        -- populated when approved = false
    constraints_checked     jsonb,                        -- exposure/premium/daily-loss/correlation caps
    created_at              timestamptz not null default now()
);

create type option_structure as enum ('NAKED', 'VERTICAL_SPREAD', 'EVENT_HEDGE');

create table execution_decisions (
    id                      uuid primary key default gen_random_uuid(),
    risk_decision_id        uuid not null references risk_decisions(id),
    timestamp               timestamptz not null,
    structure               option_structure not null,
    primary_contract_id     uuid references option_contracts(contract_id),
    hedge_contract_id       uuid references option_contracts(contract_id), -- null if naked
    lots                    integer not null,
    max_loss                numeric(14,2),
    max_profit              numeric(14,2),
    risk_reward_ratio        numeric(8,4),
    reason_codes            text[],
    created_at              timestamptz not null default now()
);

create type exit_reason as enum (
    'PRICE_STOP', 'PROFIT_TARGET', 'TIME_STOP',
    'VOLATILITY_STOP', 'THESIS_INVALIDATION', 'EMERGENCY_STOP'
);

create table exit_decisions (
    id                      uuid primary key default gen_random_uuid(),
    execution_decision_id   uuid not null references execution_decisions(id),
    timestamp               timestamptz not null,
    exit_reason             exit_reason not null,
    exit_price              numeric(12,4),
    realized_pnl            numeric(14,2),
    days_to_expiry_at_exit  integer,
    notes                   text,
    created_at              timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- Convenience view: reconstruct a full decision chain in one query
-- ----------------------------------------------------------------------------

create view v_full_decision_chain as
select
    s.id            as signal_id,
    s.timestamp     as signal_ts,
    s.direction,
    s.confidence,
    tc.id           as trade_construction_id,
    tc.contract_id,
    tc.entry_low, tc.entry_high, tc.stop_loss, tc.target,
    rd.id           as risk_decision_id,
    rd.approved,
    rd.max_lots_allowed,
    ex.id           as execution_id,
    ex.structure,
    ex.lots,
    ex.max_loss,
    ex.max_profit,
    xd.exit_reason,
    xd.realized_pnl
from signal_decisions s
left join trade_construction_decisions tc on tc.signal_decision_id = s.id
left join risk_decisions rd on rd.trade_construction_id = tc.id
left join execution_decisions ex on ex.risk_decision_id = rd.id
left join exit_decisions xd on xd.execution_decision_id = ex.id;
