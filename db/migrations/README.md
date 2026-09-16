# D-Predict database migrations

Fresh Docker databases apply the schema and all migrations automatically during initial PostgreSQL volume creation. Native PostgreSQL setup applies the same files in the same order through `db/setup.sh`:

1. `schema.sql`
2. `002_prediction_ml.sql`
3. `003_instrument_metadata.sql`
4. `004_canonical_instrument_metadata.sql`
5. `005_ipo_analysis.sql`
6. `006_research_data.sql`
7. `006_seed_instruments.sql`

The two `006` files are both idempotent and are mounted with explicit Docker filenames. `006_research_data.sql` extends the canonical UUID-based research schema from migration 002; it does not redefine `research_documents`.

For an existing local database, apply migrations explicitly and in order. For example:

```bash
docker compose exec -T postgres psql -U postgres -d nifty -f /docker-entrypoint-initdb.d/005-ipo-analysis.sql
docker compose exec -T postgres psql -U postgres -d nifty -f /docker-entrypoint-initdb.d/006-research-data.sql
docker compose exec -T postgres psql -U postgres -d nifty -f /docker-entrypoint-initdb.d/006-seed-instruments.sql
```

Migration 004 establishes the canonical instrument identity fields: `instrument_type`, `isin`, `provider_symbol`, `aliases`, `currency`, and `canonical_source`. These fields allow D-Predict to keep one stable instrument identity while mapping it to provider-specific symbols.
