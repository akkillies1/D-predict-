-- Research data lake + point-in-time document memory.
-- pgvector is optional at runtime; the tables remain useful without embeddings.

CREATE TABLE IF NOT EXISTS research_documents (
    document_id TEXT PRIMARY KEY,
    symbol TEXT,
    instrument_type TEXT,
    document_type TEXT NOT NULL,
    title TEXT NOT NULL,
    source TEXT NOT NULL,
    source_url TEXT,
    published_at TIMESTAMPTZ,
    effective_at TIMESTAMPTZ,
    retrieved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    content_sha256 TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_research_documents_symbol_time
    ON research_documents(symbol, published_at);
CREATE INDEX IF NOT EXISTS idx_research_documents_type_time
    ON research_documents(document_type, published_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_research_documents_content
    ON research_documents(content_sha256);

CREATE TABLE IF NOT EXISTS research_chunks (
    chunk_id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES research_documents(document_id) ON DELETE CASCADE,
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

-- Enable manually where the local PostgreSQL image has pgvector installed:
-- CREATE EXTENSION IF NOT EXISTS vector;
-- ALTER TABLE research_chunks ADD COLUMN IF NOT EXISTS embedding_vector vector(384);
-- CREATE INDEX IF NOT EXISTS idx_research_chunks_embedding
--   ON research_chunks USING hnsw (embedding_vector vector_cosine_ops);

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
