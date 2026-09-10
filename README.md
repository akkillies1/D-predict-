# Nifty Options Signal Engine

Personal research/trading tool for generating rule-based entry/exit cues on Nifty options — direction, strike/expiry, position sizing, and hedging — with backtesting inserted between each engine layer.

## Architecture

```text
Data collector (Python)  →  PostgreSQL/Supabase  →  Feature layer  →  Signal engine (TypeScript)
                                                                    →  Trade construction
                                                                    →  Risk engine
                                                                    →  Hedging engine
```

Hard rules:

- The collector never makes trading decisions.
- Every engine decision is versioned and logged with its inputs.
- Numerical outputs such as strike, lots, stop, and target come from deterministic code, never an LLM.
- AI is optional and limited to explanation, summarization, and research assistance.

## Installation paths

### Path A: Git developer installation

```bash
git clone https://github.com/akkillies1/D-predict-.git
cd D-predict-
./dp init
./dp doctor
./dp start
```

The `dp` command installs Python, engine, and backend dependencies, creates `.env`, initializes the private local PostgreSQL cluster, and starts the local API. The API listens on `http://127.0.0.1:4100` by default.

After the first initialization, the normal one-command workflow is `./dp start`. It starts the private PostgreSQL database, local API, bundled dashboard, and collector. Open `http://127.0.0.1:3000`. The collector uses Yahoo Finance for price bars and NSE for NIFTY/BANKNIFTY option chains; it does not invent values. If no row has been collected, the UI shows `NO DATA` rather than a fabricated price.

### Path B: Download without Git

Download a versioned release archive from the repository Releases page, extract it, and run:

```bash
cd d-predict
./dp init
./dp doctor
./dp start
```

A future release installer can install the archive into `~/.d-predict` and add `dp` to PATH:

```bash
curl -fsSLo dp-install.sh https://downloads.example.com/d-predict/install.sh
bash dp-install.sh
dp init
```

Do not run an installer from an untrusted URL. Releases should publish SHA-256 checksums and preserve `.env`, local database data, logs, and model artifacts during updates.

### Path C: Docker Compose

```bash
cp .env.example .env
docker compose up -d postgres collector
docker compose --profile engine run --rm engine
```

Docker keeps PostgreSQL data in a named volume and is the most reproducible path. It requires Docker Desktop or Docker Engine.

## Local CLI

```text
./dp init       Install dependencies, create .env, initialize PostgreSQL
./dp doctor     Check runtimes, dependencies, database, and configuration
./dp start      Start local PostgreSQL and the local API
./dp stop       Stop local PostgreSQL
./dp api        Run the local API in the foreground
./dp collect    Run the Python collector continuously
./dp test       Run TypeScript tests and build
./dp features   Generate feature snapshots
./dp signal     Generate signal decisions
./dp construct  Generate trade candidates
./dp backtest   Run signal backtests
./dp forecast   Run Monte Carlo forecast
./dp update     Pull Git changes and re-run initialization
```

The dashboard should use `http://127.0.0.1:4100` as its local API base URL. The API exposes `/health`, `/api/data-health`, `/api/instruments`, `/api/market/:symbol/overview`, `/api/market/:symbol/history`, `/api/signals/latest`, and `/api/options/chain`.

## Analyze an individual script

The UI ticker selector reads the local `instruments` table. Add any Yahoo symbol from the UI, for example `RELIANCE.NS`, `TCS.NS`, or `^NSEI`, and the collector will fetch its price bars on the next cycle. NIFTY and BANKNIFTY receive NSE option-chain collection; ordinary equities receive price data and are not incorrectly shown as having options data.

## Optional AI providers

The engine runs without AI. Configure optional AI through `.env`; never commit API keys.

```env
AI_MODE=disabled
AI_PROVIDER=
AI_BASE_URL=
AI_API_KEY=
AI_MODEL=
```

Supported provider targets in the planned provider-neutral adapter include:

- Local Ollama or another OpenAI-compatible local server.
- OpenRouter, including `openrouter/free` or a fixed `:free` model.
- NVIDIA hosted NIM API through the NVIDIA API Catalog.
- Other OpenAI-compatible hosted providers.

Free hosted models have changing availability, rate limits, and model selection. They should be used for explanations and development, not reproducible training labels. AI cannot calculate or approve trades.

## Vercel and backend deployment

Vercel is appropriate for the dashboard frontend and lightweight API proxy. The Python collector, PostgreSQL database, and long-running TypeScript worker should run as separate backend services. See [DEPLOYMENT.md](DEPLOYMENT.md) for the production split, backend API contract, environment variables, and safeguards.

```text
Vercel dashboard → backend API → managed PostgreSQL
                              ↘ collector worker
                              ↘ engine worker
```

Do not run the continuous collector inside a Vercel serverless function.

## Database

The local scripts create a private PostgreSQL cluster under `db/data/` on port 5433 by default:

```bash
./db/setup.sh
./db/start.sh
./db/stop.sh
```

The data directory and logs are ignored by Git. For production, use managed PostgreSQL or Supabase with automated backups.

## Current status

- [x] Canonical data schema (`db/schema.sql`)
- [x] Python collector skeleton (`collector/`)
- [x] Feature engine with PCR, max-pain, MACD, and volume z-score
- [x] Phase 1 signal engine and reason-code backtest
- [x] Phase 2 trade construction and premium-path backtest
- [x] Monte Carlo probability cone
- [x] Local PostgreSQL setup scripts
- [x] Git/ZIP/Docker installation foundation
- [x] Vercel/backend deployment documentation
- [ ] Point-in-time-safe option feature queries
- [ ] Friction-aware backtests with spread, slippage, and costs
- [ ] Meta-model for historical signal reliability
- [ ] Phase 3 risk engine
- [ ] Phase 4 hedging engine
- [ ] Broker integration and paper-trading reconciliation
