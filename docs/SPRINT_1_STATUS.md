# Sprint 1 — Local Research Terminal & Data Foundation

Tracking issue: #1  
Implementation branch: `sprint/1-data-foundation`

## Completed

- Canonical instrument metadata migration with provider mapping, ISIN, aliases, asset type, currency and provenance.
- Docker and local setup migration support.
- Native point-in-time dataset contracts (`DatasetSpec`, `DatasetSegment`, `PointInTimeDataset`).
- Historical OHLCV validator covering timestamp hygiene, duplicates, chronology, OHLC relationships, volume and unexpected gaps.
- Normalized TypeScript market quote contract with explicit `LIVE`, `CACHED`, `STALE` and `OFFLINE` states.

## Next

1. Integrate the market quote contract into `/api/market/:symbol/live` and stored-market responses.
2. Add canonical instrument search/provider mappings to the API.
3. Connect historical validation to dataset construction.
4. Add reproducible train/validation/test segment generation.
5. Build the research-terminal workflow around the selected canonical instrument.
6. Add prediction-ledger outcome scoring and walk-forward backtest metrics.

## Acceptance

A Windows local run must support:

`search → activate → collect/serve data → validate history → build point-in-time dataset → predict → walk-forward backtest`

No synthetic market values are permitted. Missing or stale upstream data must be represented explicitly.
