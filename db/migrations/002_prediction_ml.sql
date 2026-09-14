-- D-Predict ML / research memory layer
-- Safe for the bundled PostgreSQL 16 image: vectors are stored as JSONB first.
-- A later pgvector migration can add native ANN indexes without changing the contracts.

create table if not exists research_documents (
    id                  uuid primary key default gen_random_uuid(),
    instrument_id       uuid references instruments(instrument_id),
    symbol              text,
    published_at        timestamptz not null,
    source              text not null,
    source_url          text,
    title               text not null,
    body_text           text,
    event_type          text,
    stance              text,
    importance          text,
    content_hash        text unique,
    source_version      text,
    metadata            jsonb not null default '{}'::jsonb,
    created_at          timestamptz not null default now()
);

create index if not exists idx_research_documents_symbol_time
    on research_documents (symbol, published_at desc);
create index if not exists idx_research_documents_source_time
    on research_documents (source, published_at desc);

create table if not exists event_embeddings (
    document_id         uuid primary key references research_documents(id) on delete cascade,
    embedding_provider  text not null,
    embedding_model     text not null,
    dimensions          integer not null,
    embedding           jsonb not null,
    normalized_text     text not null,
    created_at           timestamptz not null default now()
);

create index if not exists idx_event_embeddings_model
    on event_embeddings (embedding_provider, embedding_model);

create table if not exists training_examples (
    id                  uuid primary key default gen_random_uuid(),
    symbol              text not null,
    timestamp           timestamptz not null,
    feature_set_version text not null,
    horizon             text not null,
    features            jsonb not null,
    event_features      jsonb not null default '{}'::jsonb,
    target_return       numeric(14,8),
    target_class        text,
    target_max_up       numeric(14,8),
    target_max_down     numeric(14,8),
    source_cutoff       timestamptz not null,
    created_at          timestamptz not null default now(),
    unique (symbol, timestamp, feature_set_version, horizon)
);

create index if not exists idx_training_examples_lookup
    on training_examples (symbol, horizon, timestamp desc);

create table if not exists model_runs (
    id                  uuid primary key default gen_random_uuid(),
    model_name          text not null,
    model_version       text not null,
    feature_set_version text not null,
    train_start         timestamptz,
    train_end           timestamptz,
    validation_start    timestamptz,
    validation_end      timestamptz,
    metrics             jsonb not null default '{}'::jsonb,
    parameters          jsonb not null default '{}'::jsonb,
    artifact_path       text,
    created_at          timestamptz not null default now()
);

create index if not exists idx_model_runs_name_time
    on model_runs (model_name, created_at desc);

create table if not exists prediction_ledger (
    id                  uuid primary key default gen_random_uuid(),
    symbol              text not null,
    timestamp           timestamptz not null,
    horizon             text not null,
    model_version       text not null,
    market_probability  numeric(8,6),
    event_probability   numeric(8,6),
    meta_probability    numeric(8,6),
    expected_return     numeric(14,8),
    confidence          numeric(8,6),
    regime              text,
    evidence             jsonb not null default '{}'::jsonb,
    input_snapshot      jsonb not null default '{}'::jsonb,
    outcome_return      numeric(14,8),
    outcome_class       text,
    evaluated_at        timestamptz,
    created_at          timestamptz not null default now()
);

create index if not exists idx_prediction_ledger_symbol_time
    on prediction_ledger (symbol, timestamp desc);
create index if not exists idx_prediction_ledger_horizon_time
    on prediction_ledger (horizon, timestamp desc);
