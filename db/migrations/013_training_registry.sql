-- Automatic, instrument-agnostic training infrastructure.
-- Three tables give the training scheduler an explicit, queryable record of
-- every run, every per-instrument outcome, and every model version produced.
-- Nothing here overwrites an existing model: model_registry is append-only and
-- the live artifact path is derived from (symbol, horizon, feature_set_version),
-- so a retrain that produces the same signature is a no-op rather than a dup.

-- One row per training operation (a batch over the active universe, or a
-- single manual retrain). `trigger` distinguishes how it was started.
create table if not exists training_runs (
    training_run_id text primary key,
    trigger text not null check (trigger in ('AUTO_NEW_DATA', 'SCHEDULED', 'MANUAL')),
    status text not null default 'RUNNING'
        check (status in ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED')),
    started_at timestamptz not null default now(),
    completed_at timestamptz,
    instruments_total integer not null default 0,
    instruments_trained integer not null default 0,
    instruments_up_to_date integer not null default 0,
    instruments_skipped integer not null default 0,
    instruments_failed integer not null default 0,
    horizons text[] not null default '{1d}',
    summary jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create index if not exists idx_training_runs_started_at on training_runs (started_at desc);

-- One row per (run, instrument, horizon) outcome. `status` uses the explicit
-- lifecycle vocabulary from the spec so the UI never shows an ambiguous state.
create table if not exists training_run_instruments (
    id bigserial primary key,
    training_run_id text not null references training_runs (training_run_id) on delete cascade,
    symbol text not null,
    horizon text not null,
    instrument_type text,
    status text not null
        check (status in ('DISCOVERED', 'WAITING_FOR_DATA', 'INSUFFICIENT_HISTORY',
                          'TRAINING', 'TRAINED', 'UP_TO_DATE', 'STALE', 'FAILED',
                          'SKIPPED', 'DORMANT')),
    reason text,
    bars_available integer,
    bars_required integer,
    latest_bar timestamptz,
    training_end timestamptz,
    model_version text,
    promotion_ready boolean,
    meta_ready boolean,
    oos_accuracy numeric,
    accuracy_lift_ci_low numeric,
    duration_ms integer,
    error text,
    started_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz not null default now()
);

create index if not exists idx_training_run_instruments_run on training_run_instruments (training_run_id);
create index if not exists idx_training_run_instruments_symbol on training_run_instruments (symbol, horizon, created_at desc);

-- Append-only model registry. Every trained version is recorded; none is ever
-- overwritten. `status` tracks the promotion lifecycle. Because no promotion
-- pipeline is wired yet, trained models land as CANDIDATE (passed the gate) or
-- DORMANT (failed the gate) — never PRODUCTION — keeping the baseline honest.
create table if not exists model_registry (
    id bigserial primary key,
    symbol text not null,
    horizon text not null,
    instrument_type text,
    model_version text not null,
    feature_set_version text not null,
    dataset_version text,
    training_run_id text references training_runs (training_run_id) on delete set null,
    artifact_path text,
    bars integer,
    training_start timestamptz,
    training_end timestamptz,
    oos_accuracy numeric,
    oos_majority_baseline numeric,
    oos_log_loss numeric,
    oos_directional_accuracy numeric,
    accuracy_lift_ci_low numeric,
    log_loss_ci_high numeric,
    directional_accuracy_ci_low numeric,
    calibration_verified boolean,
    calibration_gap numeric,
    calibration_brier numeric,
    meta_ready boolean,
    meta_oos_auc numeric,
    meta_auc_ci_low numeric,
    meta_selected_coverage numeric,
    meta_accuracy_lift_ci_low numeric,
    promotion_ready boolean not null default false,
    status text not null default 'DORMANT'
        check (status in ('EXPERIMENT', 'CANDIDATE', 'SHADOW', 'PRODUCTION',
                          'REJECTED', 'DORMANT', 'RETIRED')),
    metrics jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    unique (symbol, horizon, model_version)
);

create index if not exists idx_model_registry_symbol on model_registry (symbol, horizon, created_at desc);
create index if not exists idx_model_registry_status on model_registry (status);
