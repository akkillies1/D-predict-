# Nifty Data Collector

Python service that collects, normalizes, validates, and persists raw market
data (underlying price bars + option chain snapshots). It is the *only*
component allowed to talk to NSE/Yahoo.

**Hard rule: the collector never makes trading decisions.** It produces
trustworthy historical facts. RSI/ATR/signals/strikes are computed downstream,
in the feature layer and TS strategy engine — not here.

## Setup

```bash
pip install -r requirements.txt
cp .env.example .env   # fill in DATABASE_URL
python -m collector.main
```

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `DATABASE_URL` | Postgres/Supabase connection string | — (required) |
| `OPTION_CHAIN_POLL_SECONDS` | Poll interval for option chain | `60` |
| `PRICE_BAR_POLL_SECONDS` | Poll interval for price bars | `60` |
| `COLLECTOR_INSTRUMENTS` | Comma-separated symbols | `NIFTY` |

## Architecture

```
adapters/      NSE + Yahoo specific fetching & raw->canonical mapping
canonical/     Source-agnostic dataclasses (the contract downstream code relies on)
validation/    Business-level checks (staleness, sane bounds) before persistence
persistence/   Idempotent upserts into Postgres/Supabase
scheduler/     Poller loop, one ingestion_run_id per run for traceability
```

## Known gaps to close before relying on this for real money

- `adapters/nse.py`: field mapping and the response-timestamp parsing are
  based on NSE's typically observed shape — NSE changes this without notice,
  so add a schema-check/alert on unexpected response shape before trusting it.
- Timezone handling in both adapters is marked with `TODO` — confirm NSE's
  and yfinance's actual timezone behavior against known market events before
  relying on `market_timestamp` for backtesting.
- `scheduler/poller.py` uses a simple blocking loop for v1. Fine for a single
  personal-use collector; swap for a proper scheduler if this ever needs to
  run multiple instruments/timeframes concurrently.
- No handling yet for NSE rate-limiting/blocking beyond basic retry/backoff —
  watch logs for repeated 401s, which usually mean the polling interval is
  too aggressive.
