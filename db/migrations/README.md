# D-predict database migrations

Fresh Docker databases apply migrations automatically during initial PostgreSQL volume creation.

For an existing local PostgreSQL volume, apply new migrations explicitly:

```powershell
docker compose exec -T postgres psql -U postgres -d nifty -f /docker-entrypoint-initdb.d/003-instrument-metadata.sql
docker compose exec -T postgres psql -U postgres -d nifty -f /docker-entrypoint-initdb.d/004-canonical-instrument-metadata.sql
```

Migration 004 establishes the Sprint 1 canonical instrument identity fields:

- `instrument_type`
- `isin`
- `provider_symbol`
- `aliases`
- `currency`
- `canonical_source`

These fields allow D-predict to keep one stable instrument identity while mapping it to provider-specific symbols.
