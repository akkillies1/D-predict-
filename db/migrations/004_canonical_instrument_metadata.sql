-- Sprint 1: canonical instrument identity.
-- These fields separate the stable instrument identity from provider-specific symbols.
-- Existing installations remain compatible because every new field is nullable/defaulted.

ALTER TABLE instruments
    ADD COLUMN IF NOT EXISTS instrument_type text NOT NULL DEFAULT 'EQUITY',
    ADD COLUMN IF NOT EXISTS isin text,
    ADD COLUMN IF NOT EXISTS provider_symbol text,
    ADD COLUMN IF NOT EXISTS aliases text[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'INR',
    ADD COLUMN IF NOT EXISTS canonical_source text NOT NULL DEFAULT 'local';

ALTER TABLE instruments
    DROP CONSTRAINT IF EXISTS instruments_instrument_type_check;

ALTER TABLE instruments
    ADD CONSTRAINT instruments_instrument_type_check
    CHECK (instrument_type IN ('EQUITY', 'INDEX', 'ETF', 'FUTURE', 'OPTION'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_instruments_isin_unique
    ON instruments (isin)
    WHERE isin IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_instruments_type_active
    ON instruments (instrument_type, is_active, symbol);

CREATE INDEX IF NOT EXISTS idx_instruments_provider_symbol
    ON instruments (provider_symbol);

-- Canonical mappings for the instruments already shipped with D-predict.
UPDATE instruments
SET instrument_type = CASE symbol
    WHEN 'NIFTY' THEN 'INDEX'
    WHEN 'BANKNIFTY' THEN 'INDEX'
    ELSE instrument_type
END,
provider_symbol = CASE symbol
    WHEN 'NIFTY' THEN '^NSEI'
    WHEN 'BANKNIFTY' THEN '^NSEBANK'
    ELSE provider_symbol
END,
canonical_source = 'seed'
WHERE symbol IN ('NIFTY', 'BANKNIFTY');
