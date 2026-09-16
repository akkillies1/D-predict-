# D-Predict Runtime Diagnosis and Repair

## Runtime contract

The local stack uses a deterministic port contract: PostgreSQL is exposed on `5433`, the market API on `4100`, the research API on `4200`, and the dashboard on `3000` with the existing fallback behavior if that port is occupied. The API reads `API_PORT`; it does not fall back to the dashboard's `PORT` setting.

The default Docker stack is PostgreSQL, collector, market API, research API, engine worker, and the native dashboard launched by `d-predict.sh`. The Windows launcher starts the same Docker services. PostgreSQL is the only stateful dependency. Compose waits for PostgreSQL health, while both launchers perform HTTP readiness checks for the market and research APIs before starting the dashboard.

## Integration repairs

The market API provides database-backed implementations for instrument listing and discovery, instrument creation, live and overview quotes, historical bars, options-chain snapshots, and a statistical forecast baseline. Existing signal and IPO routes remain available. Routes return explicit errors such as `NO_MARKET_DATA`, `NO_OPTION_DATA`, `NO_SIGNAL`, and `INSUFFICIENT_HISTORY`; they do not fabricate prices, signals, forecasts, or option rows.

The trade-thesis response is normalized to the dashboard's camelCase contract and confidence remains a `0..1` probability. Ordinary canonical NSE equity symbols are mapped to Yahoo identifiers such as `RELIANCE.NS`; explicit index aliases remain mapped to `^NSEI` and `^NSEBANK`.

A recurring engine worker now runs feature generation followed by signal generation, retrying after failures instead of terminating the entire stack. This closes the previous collector-to-database-to-dashboard gap in normal startup.

## Database contract

Fresh Docker and native PostgreSQL setup now apply the same complete sequence: base schema, ML/prediction migration, instrument metadata, canonical instrument metadata, IPO migration, compatible research-memory extensions, and deterministic NIFTY/BANKNIFTY seed data. The research-memory migration was consolidated so it extends the UUID-based schema from migration 002 rather than redefining `research_documents` with incompatible columns. The research service now listens on `0.0.0.0`, making it reachable from the published Docker port.

## Verification performed

The backend build and smoke test pass. The engine build and all 44 engine tests pass. The dashboard dependency installation, TypeScript check, and all 4 dashboard tests pass after removing an incompatible unused Vite plugin and regenerating the npm lockfile. The complete Python training suite passes: 99 tests, with only expected scikit-learn warnings. Shell syntax and whitespace validation pass.

Docker-based end-to-end startup was not executed in this sandbox because Docker is unavailable. The Ubuntu CI workflow now validates backend, dashboard, Python training tests, migration presence, and runtime source checks. A clean-machine Docker run remains the final environment-dependent validation.

## Recommended final validation

On Ubuntu or Windows with Docker, run the launcher against a fresh database volume and verify `/health`, `/api/instruments`, discovery for `NIFTY`, `BANKNIFTY`, and `RELIANCE`, plus the market, options, forecast, signal, and research routes. After the collector completes a provider poll, confirm that the engine worker creates feature snapshots and signals. The forecast route remains explicitly labeled `STATISTICAL_BASELINE`; it should eventually call the shared engine forecast library once that module is exposed as a reusable service component.
