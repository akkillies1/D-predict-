# D-Predict 2.0 Audit and Release Scope

## Baseline

The audit was performed against `main` at the pre-2.0 `v0.1.8.5` codebase. Backend compilation and smoke tests passed, engine tests passed, dashboard typechecking/tests/build passed after implementation, and the Python collector/training/ML compile and training suite passed. Docker, PostgreSQL client tools, and PowerShell were not available in the Linux audit sandbox; therefore Windows installation and live database behavior were validated through source inspection and CI configuration, not falsely reported as locally executed.

| Area | Result | Evidence |
|---|---|---|
| Backend | PASS | `npm --prefix backend test` — build and health smoke test passed |
| Dashboard | PASS | `pnpm run check`, `pnpm test --run` — 4 tests passed, `pnpm run build` passed |
| Engine | PASS | `npm --prefix engine run build && npm --prefix engine test` — 44 tests passed |
| Python/data | PASS | `python3 -m compileall -q collector training ml-service`; `pytest training/tests` — 100 passed |
| Docker runtime | UNVERIFIED HERE | Docker CLI unavailable in the sandbox |
| Windows installer execution | UNVERIFIED HERE | PowerShell/Inno Setup unavailable in the sandbox; release workflow remains the execution environment |

## Implemented 2.0 scope

D-Predict 2.0 adds a PostgreSQL-backed local watchlist, period-aware performance analysis over persisted price bars, explicit coverage status, and a dashboard panel that reports honest empty/insufficient-data states. Metrics include absolute and percentage return, CAGR, annualized volatility, maximum drawdown, best/worst observed day, positive-day ratio, observation count, and coverage. The API keeps period and timeframe separate and never creates synthetic observations.

The native database setup now applies the option-paper migration and the D-Predict 2.0 migration. Fresh Docker initialization mounts the same 2.0 migration. The shipped Windows stop script now stops all application services rather than leaving research, ML, or engine containers running.

The installer now accepts a compile-time `MyAppSourceRef`. The release workflow passes the immutable release tag to Inno Setup, so a published installer no longer silently synchronizes mutable `main`. The release workflows accept normal semantic versions such as `v2.0.0`.

The marketing page now identifies D-Predict 2.0 and links directly to the verified Windows installer and the v2.0.0 Ubuntu/Linux release.

## API additions

| Endpoint | Purpose |
|---|---|
| `GET /api/market/:symbol/coverage?timeframe=1d` | Fresh/stale/no-data state, observation count, first/last timestamps, collection timestamp, source |
| `GET /api/market/:symbol/performance?period=1M&timeframe=1d` | Evidence-based performance metrics over persisted bars |
| `GET /api/watchlist` | Read the local persisted watchlist with latest persisted quote when available |
| `POST /api/watchlist` | Add an active database instrument to the local watchlist |
| `DELETE /api/watchlist/:symbol` | Remove a watchlist instrument |

## Important remaining limits

The instrument catalog is still only as complete as the actual database instrument master; the installer seed contains reference indices rather than a fabricated equity universe. Live broker execution is not advertised or added: option paper/shadow trading remains explicitly simulated and quote-gated. A production deployment should still add disposable-Postgres integration tests, Docker service readiness checks, and a Windows install/repair smoke job on a Windows runner.
