-- IPO research inputs and deterministic analysis outputs.
-- No market/valuation values are fabricated; callers must provide verified prospectus inputs.

create table if not exists ipo_analysis_runs (
    id uuid primary key default gen_random_uuid(),
    company_name text not null,
    symbol text,
    analysis_version text not null,
    inputs jsonb not null,
    analysis jsonb not null,
    source_urls jsonb not null default '[]'::jsonb,
    created_at timestamptz not null default now()
);

create index if not exists idx_ipo_analysis_company_time
    on ipo_analysis_runs (company_name, created_at desc);

create index if not exists idx_ipo_analysis_symbol_time
    on ipo_analysis_runs (symbol, created_at desc);
