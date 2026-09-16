-- Research memory extensions compatible with 002_prediction_ml.sql.
-- research_documents is canonical there (UUID primary key, body_text payload).
-- This migration adds chunking and dataset manifest tables without redefining it.

CREATE TABLE IF NOT EXISTS research_chunks (
    chunk_id TEXT PRIMARY KEY,
    document_id UUID NOT NULL REFERENCES research_documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    embedding_model TEXT,
    embedding JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_research_chunks_document
    ON research_chunks(document_id);

CREATE TABLE IF NOT EXISTS data_manifests (
    dataset_id TEXT PRIMARY KEY,
    dataset_type TEXT NOT NULL,
    symbol TEXT,
    source TEXT NOT NULL,
    source_url TEXT,
    coverage_start TIMESTAMPTZ,
    coverage_end TIMESTAMPTZ,
    frequency TEXT NOT NULL,
    row_count BIGINT,
    content_sha256 TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    downloaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_data_manifests_symbol_type
    ON data_manifests(symbol, dataset_type);
