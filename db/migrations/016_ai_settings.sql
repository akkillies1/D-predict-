-- Sprint: optional bring-your-own-key AI assistant. One row (id = 1) holds the
-- user's own provider credentials so the backend can proxy OpenAI-compatible
-- chat requests on their behalf. Nothing here is market data: the assistant may
-- only re-explain numbers D-Predict already computed from real persisted bars.
-- The key is stored in the user's own local database volume and is never
-- returned by the API in full, only masked.

create table if not exists ai_settings (
    id          smallint primary key default 1 check (id = 1),
    provider    text not null default 'nvidia_nim',
    base_url    text not null,
    api_key     text not null,
    model       text,
    enabled     boolean not null default true,
    updated_at  timestamptz not null default now()
);
