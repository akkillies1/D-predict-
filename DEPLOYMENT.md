# Deployment Guide

## Recommended production split

Vercel should host the dashboard frontend and lightweight read-only API routes. The collector, PostgreSQL database, and TypeScript engine are backend workloads and should run separately because the collector is long-lived and requires Python, scheduled polling, and durable database access.

```text
Browser
   |
   v
Vercel: React dashboard + API proxy
   |
   v
Backend service: Node API / tRPC or REST
   |
   +--> Managed PostgreSQL / Supabase
   +--> Collector worker (Python, persistent or scheduled)
   +--> Engine worker (features, signals, backtests)
```

Do not put the collector inside a Vercel serverless function. Serverless functions are request-scoped and are not appropriate for a continuous polling loop.

## Vercel deployment

The current repository contains the deterministic engine and collector, not the separate dashboard project. After the dashboard is merged into a `dashboard/` directory or a separate frontend repository:

1. Import the dashboard project into Vercel.
2. Set the project root to `dashboard`.
3. Build with the dashboard's standard command, normally `npm run build`.
4. Configure only public frontend variables such as `NEXT_PUBLIC_API_BASE_URL` or `VITE_API_BASE_URL`.
5. Never place database URLs, broker keys, collector secrets, or AI provider keys in `NEXT_PUBLIC_*` or `VITE_*` variables.
6. Point the dashboard to the backend HTTPS URL.
7. Configure CORS on the backend for the Vercel production domain and preview domains as needed.

For Next.js, use server-side route handlers as a thin proxy if hiding the backend URL is useful. Keep all secrets in Vercel server-side environment variables, not browser-exposed variables.

## Backend deployment choices

| Choice | Best for | Tradeoffs |
|---|---|---|
| Docker Compose on a user's machine | Local development and private paper trading | Machine must remain online |
| Managed container service | Small production deployment | Requires managed PostgreSQL and secrets setup |
| Persistent VM with Docker | Full control and continuous collector | Operations, updates, backups, and monitoring are the user's responsibility |
| Web application backend with a persistent worker mode | API plus light background work | Limited CPU/RAM; verify worker and scheduler support |

For production, use managed PostgreSQL or Supabase rather than storing PostgreSQL data on an ephemeral container filesystem. Use a separate worker process for the collector and engine.

## Required backend environment variables

```env
DATABASE_URL=postgresql://...
OPTION_CHAIN_POLL_SECONDS=60
PRICE_BAR_POLL_SECONDS=60
COLLECTOR_INSTRUMENTS=NIFTY
FEATURE_SET_VERSION=v1
STRATEGY_VERSION=v1
MODEL_VERSION=phase1-rule-engine-v1
AI_MODE=disabled
AI_PROVIDER=
AI_BASE_URL=
AI_API_KEY=
AI_MODEL=
```

AI keys must remain server-side. The backend should expose only safe explanation and research endpoints. AI must not be able to write orders or bypass risk controls.

## Backend API to add before connecting the dashboard

- `GET /health` — process, database, and provider health.
- `GET /api/data-health` — freshness and ingestion-run status.
- `GET /api/market/:symbol/overview` — latest spot and feature snapshot.
- `GET /api/signals/latest` — latest signal with reason codes and versions.
- `GET /api/options/chain` — current option chain with timestamp and source.
- `GET /api/forecast` — Monte Carlo forecast and assumptions.
- `GET /api/backtests/:id` — metrics, date range, costs, and model versions.
- `POST /api/ai/explain-signal` — optional provider-backed explanation; read-only.

Add authentication, request validation, rate limiting, structured logs, and audit records before exposing these endpoints publicly.

## Local backend paths

Git users:

```bash
git clone https://github.com/akkillies1/D-predict-.git
cd D-predict-
./dp init
./dp doctor
./dp start
```

Non-Git users can install a versioned release archive or use Docker Compose. For Docker:

```bash
cp .env.example .env
docker compose up -d postgres collector
docker compose --profile engine run --rm engine
```

## Production safeguards

Before live deployment, add point-in-time feature queries, friction-aware backtests, ingestion-run monitoring, database backups, paper trading, deterministic risk limits, a kill switch, and alerting. Vercel deployment does not replace these backend controls.
