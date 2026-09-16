# D-Predict Database Deployment

D-Predict uses PostgreSQL-compatible storage and is designed so the user controls where the database lives.

## Supported deployment modes

### 1. Local PostgreSQL

All core D-Predict data can remain on the user's machine. The user may choose a data root such as:

`D:/D-PredictData`

The runtime database can then live under that root instead of consuming the system drive.

The Docker development stack honors `D_PREDICT_DATA_DIR` and binds the PostgreSQL data directory to:

`<D_PREDICT_DATA_DIR>/postgres`

If the variable is not set, development falls back to `./data/runtime`.

### 2. Supabase Cloud

The user may connect D-Predict to their own Supabase project. D-Predict does not require a D-Predict-owned cloud database.

Set `DATABASE_MODE=supabase_cloud` and provide the user's PostgreSQL `DATABASE_URL` and, where required by future Supabase features, their Supabase project URL/keys.

### 3. Self-hosted Supabase

The user may run Supabase on their own PC, server, NAS, VPS, or other infrastructure and point D-Predict at that PostgreSQL instance.

Set `DATABASE_MODE=supabase_self_hosted` and provide the user's PostgreSQL `DATABASE_URL`.

## Application architecture rule

The business logic must remain independent of the deployment mode.

The following should not be duplicated between local PostgreSQL and Supabase modes:

- market-data schema
- features
- signals
- forecasts
- backtests
- research records
- prediction ledger
- risk calculations

The database deployment choice belongs at the infrastructure/configuration boundary.

## User choice

The eventual Windows first-run flow should present:

- Local PostgreSQL
- Supabase Cloud
- Self-hosted Supabase

For Local PostgreSQL, the user should be able to select the data directory with a folder picker. The selected directory must be persisted as configuration and reused on later launches.

The application must not silently move large database files back to `C:` or Docker-managed storage.

## Offline behaviour

Local PostgreSQL mode must work without internet access except when fresh external market data is requested. Existing data, features, signals, models, and research remain available locally.

Supabase Cloud naturally requires network connectivity to access the remote database. Self-hosted mode depends on whether the user's own Supabase instance is reachable.

## Security

- Never commit Supabase secrets.
- Never expose the PostgreSQL service publicly unless the user explicitly configures that deployment.
- Prefer localhost binding for local PostgreSQL.
- Do not hard-code production credentials.
- Keep service-role credentials out of the browser/client bundle.

## Current implementation status

This document establishes the deployment contract. The Docker development stack already supports a configurable host data directory and the engine Compose environment is consolidated into a single mapping. The Windows first-run data-directory picker and full runtime database-provider abstraction remain implementation work and must be completed before describing all three modes as fully supported in the released installer.
