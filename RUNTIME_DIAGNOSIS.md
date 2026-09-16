# D-Predict Runtime Diagnosis and Repair

## Runtime contract

The local stack now uses a deterministic port contract: PostgreSQL is exposed on `5433`, the market API on `4100`, the research API on `4200`, and the dashboard on `3000` (with Vite's existing fallback behavior if that port is occupied). The API reads `API_PORT`; it no longer falls back to the dashboard's `PORT` setting.

The default Docker stack is PostgreSQL, collector, market API, research API, and dashboard launched by `d-predict.sh`. PostgreSQL is the only stateful dependency. The API and research service wait on PostgreSQL health through Compose dependency conditions, while the launcher performs HTTP readiness checks before starting the dashboard.

## API coverage repaired

The market API now provides database-backed implementations for instrument listing and discovery, instrument creation, live and overview quotes, historical bars, options-chain snapshots, and a statistical forecast baseline. Existing signal and IPO routes remain available. Routes return explicit errors such as `NO_MARKET_DATA`, `NO_OPTION_DATA`, `NO_SIGNAL`, and `INSUFFICIENT_HISTORY`; they do not fabricate prices, signals, forecasts, or option rows.

`/health` distinguishes a configured, healthy database from an empty market-data store. An empty fresh installation can therefore report a healthy service while honestly reporting `marketData: unavailable`.

Fresh PostgreSQL databases seed `NIFTY` and `BANKNIFTY` through `db/migrations/006_seed_instruments.sql`. The seed is mounted by Docker and used by the native PostgreSQL setup script, so both supported initialization paths have the same baseline instrument catalog.

## Verification performed

The backend TypeScript build and its smoke test pass. Shell syntax checks pass for the Ubuntu launcher and native database setup script. Dashboard type checking was not run because dashboard dependencies are not installed in the current sandbox. Docker Compose runtime validation could not be run because Docker is unavailable in the current sandbox; the Ubuntu CI workflow should run this on an Ubuntu runner with Docker installed.

## Suggested next validation

On a clean Ubuntu machine with Docker, run `./d-predict.sh`, then verify `/health`, `/api/instruments`, discovery for `NIFTY` and `BANKNIFTY`, and the market-data routes after the collector has completed at least one successful provider poll. For release quality, add a disposable Postgres integration job to CI and run the full endpoint matrix against seeded data plus a collector fixture. The forecast route is intentionally labeled a statistical baseline; it should be replaced with the engine's shared forecast module once that module is exposed as a reusable library rather than duplicating its database adapter.
