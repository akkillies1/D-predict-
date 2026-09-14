-- Instrument metadata used by live discovery and dashboard search.
-- Safe for existing databases and fresh Docker databases.
ALTER TABLE instruments ADD COLUMN IF NOT EXISTS name text;

CREATE INDEX IF NOT EXISTS idx_instruments_symbol_search
    ON instruments (upper(symbol));
CREATE INDEX IF NOT EXISTS idx_instruments_name_search
    ON instruments (upper(name));

UPDATE instruments
SET name = CASE symbol
    WHEN 'NIFTY' THEN 'NIFTY 50'
    WHEN 'BANKNIFTY' THEN 'NIFTY Bank'
    ELSE name
END
WHERE name IS NULL;
