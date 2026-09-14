# D-predict

D-predict is a local research and market-analysis cockpit for Indian equities and NIFTY/BANKNIFTY derivatives.

It is designed around one principle: **do not turn a headline into a trade without checking the evidence around it, testing the idea against history, and measuring the model out of sample.**

## Current engineering status

**Active sprint:** Sprint 1 — Local Research Terminal & Data Foundation  
**Branch:** `sprint/1-data-foundation`  
**Direction:** Qlib-inspired research architecture, implemented natively for D-predict rather than importing Qlib wholesale.

### Sprint 1 checklist

- [x] Canonical instrument metadata: type, ISIN, provider symbol, aliases, currency and source.
- [x] Instrument discovery and activation from the dashboard.
- [x] Explicit market-data freshness contract: `LIVE`, `CACHED`, `STALE`, `OFFLINE`.
- [x] Remove synthetic live OHLC values; unavailable fields remain explicit instead of being fabricated.
- [x] Historical OHLCV validation for duplicates, chronology, numeric values, OHLC relationships, volume and expected-frequency gaps.
- [x] Qlib-inspired `DatasetSpec` / `PointInTimeDataset` contract.
- [x] Chronological train/validation/test dataset segments.
- [x] Purge gap between dataset segments to reduce future-label leakage across boundaries.
- [x] Dataset provenance checks for instrument, feature-set version, label horizon and source cutoff.
- [x] Automated tests for history validation and dataset point-in-time rules.
- [x] Baseline trainer consumes the formal point-in-time dataset contract and its purged splits.
- [x] Walk-forward validation uses a horizon-aware purge between training and validation observations.
- [ ] Connect historical validation directly to every production dataset ingestion path.
- [ ] Add reproducible dataset manifests and dataset fingerprints.
- [ ] Complete the research-terminal workflow from search → activation → data validation → dataset → prediction.
- [ ] Add prediction-ledger outcome scoring.
- [ ] Add V1 portfolio/backtest accounting with transaction costs and slippage.

## Future improvement checklist

### Data foundation

- [ ] Complete canonical provider/instrument mapping for NSE/BSE/Yahoo symbols.
- [ ] Add exchange calendars and trading-session-aware timestamp handling.
- [ ] Add corporate-action adjustment/provenance handling.
- [ ] Add point-in-time historical news and disclosure ingestion.
- [ ] Add data-quality reports and freshness monitoring per source.
- [ ] Add reproducible dataset manifests and content fingerprints.
- [ ] Add native `pgvector` storage/indexing when document volume justifies it.

### Research and modelling

- [ ] Formal feature registry with versioned feature definitions.
- [ ] Formal label registry with horizon and target semantics.
- [ ] Market Model for numerical market features.
- [ ] Event Model for news, filings and public disclosures.
- [ ] Regime Model for market/regime state.
- [ ] True Meta Model combining model outputs rather than simply calibrating one source.
- [ ] Probability calibration and calibration drift monitoring.
- [ ] Regime-specific performance evaluation.
- [ ] Prediction ledger with automatic 1d/3d/5d outcome scoring.

### Backtesting and risk

- [x] Strict expanding-window walk-forward engine.
- [x] Purged validation where label horizons require it.
- [ ] Transaction-cost and slippage model.
- [ ] Portfolio construction and position sizing layer.
- [ ] Risk limits and exposure attribution.
- [ ] Paper-trading/shadow mode before any live capital.

### Product and operations

- [ ] Reliable live ticker suggestions with exchange/company-name resolution.
- [ ] Research terminal showing data provenance and freshness beside every key value.
- [ ] Reproducible local setup and one-command health checks.
- [ ] CI coverage for Python tests and dashboard typecheck/build.
- [ ] Observability for collector/API/research failures.
- [ ] No automated live order execution until research, backtest and paper-trading gates are satisfied.

### Later, not now

- [ ] RL / FinRL experimentation after supervised and event models are demonstrably useful.
- [ ] Complex deep-learning models only after strong classical baselines are beaten out of sample.
- [ ] LLM-assisted research workflows with evidence citations and strict source separation.
- [ ] Advanced options strategy research after reliable historical options data is available.

## What the system does

D-predict combines several layers:

```text
Live / recent market data
        │
        ├── price + volume + history
        ├── option-chain structure
        ├── stored rule-based signals
        │
        ▼
Public research intelligence
        ├── financial/news headlines
        ├── cross-source agreement
        ├── freshness
        ├── NSE corporate announcements
        ├── public insider-trading disclosures
        └── SEBI/public regulatory material
        │
        ▼
Historical learning
        ├── point-in-time features
        ├── future-return labels
        ├── purged chronological splits
        ├── walk-forward validation
        ├── model calibration
        └── prediction ledger
        │
        ▼
Vector event memory
        ├── research-document embeddings
        ├── similar historical events
        ├── novelty / contradiction signals
        └── event features for ML
        │
        ▼
Meta-prediction
        ├── direction probabilities
        ├── expected return
        ├── confidence
        ├── evidence score
        └── model-quality gate
```

The research layer is intentionally **public-information only**. It does not access, request, infer, or trade on illegal material non-public information. Publicly disclosed insider transactions, exchange announcements and regulator records are valid evidence and are shown separately from general media.

## Accuracy philosophy

The objective is not to display a confident-looking number. The objective is to make the confidence reflect evidence quality and historical performance.

The current research score considers freshness, source diversity, source agreement/disagreement, higher weight for official exchange/regulatory sources, bullish versus bearish evidence, and explicit governance/regulatory risk themes.

The ML layer adds a stronger requirement: every training example is tied to a timestamp, features only use information available at that timestamp, and the future move is stored separately as the target. Dataset construction records a formal feature-set version and label horizon, validates source cutoffs, and creates chronological splits with a purge gap sized to the target horizon. The baseline trainer and walk-forward evaluator consume this contract rather than maintaining independent split logic.

**No prediction system can guarantee accuracy.** A model is only promoted after its out-of-sample performance, calibration, false-positive rate, regime-specific behaviour and robustness are measured.

## Historical learning

The repository includes a repeatable baseline training pipeline under `training/`:

- `download_historical.py` downloads raw daily history when local PostgreSQL history is insufficient.
- `validate_history.py` checks raw OHLCV history before research use.
- `dataset.py` defines the D-predict-native point-in-time dataset contract and chronological segments.
- `build_dataset.py` creates point-in-time market features and future-return labels for 1-day, 3-day and 5-day horizons and records a purge-aware dataset split.
- `train_baseline.py` trains a market classifier and return regressor from the formal dataset contract.
- `walk_forward.py` produces strictly out-of-sample predictions using expanding windows with horizon-aware purging.
- `train_meta.py` learns a conservative calibration layer over available model probabilities.
- `embed_events.py` stores and searches research-document vectors.

The baseline is deliberately simple so that it becomes a measurable benchmark. It is **not** a claim that the current model is profitable or “very accurate”. The walk-forward results are the evidence that matters.

### Windows training flow

After `init`, run:

```powershell
.\dp.ps1 train
```

The equivalent manual sequence is:

```powershell
.\collector\.venv\Scripts\python.exe -m training.download_historical --symbols NIFTY BANKNIFTY
.\collector\.venv\Scripts\python.exe -m training.validate_history data\historical\nifty.csv --frequency 1d
.\collector\.venv\Scripts\python.exe -m training.build_dataset --symbols NIFTY BANKNIFTY
.\collector\.venv\Scripts\python.exe -m training.train_baseline --symbols NIFTY BANKNIFTY
.\collector\.venv\Scripts\python.exe -m training.walk_forward --symbols NIFTY BANKNIFTY
.\collector\.venv\Scripts\python.exe -m training.train_meta --symbols NIFTY BANKNIFTY
```

Training artifacts are written under `data/training`, `data/predictions` and `models`. These generated artifacts should normally remain local rather than being committed to Git.

## Vector embeddings and event memory

Vector embeddings are used as **historical event memory**, not as a replacement for the numerical market model.

The flow is:

```text
headline / filing
      ↓
normalized research document
      ↓
embedding vector
      ↓
similar historical documents
      ↓
historical outcomes
      ↓
event features
      ↓
meta-model
```

The local implementation stores normalized vectors as JSONB so the bundled PostgreSQL image does not require a special extension. The embedding engine prefers `sentence-transformers` with `EMBEDDING_MODEL`; when that package/model is unavailable it falls back to a deterministic 384-dimensional hashing vector. The fallback is a vector representation, but semantic quality is lower than a trained sentence-embedding model.

For semantic embeddings on Windows:

```powershell
.\collector\.venv\Scripts\python.exe -m pip install sentence-transformers
.\dp.ps1 embed
```

Query the event memory with:

```powershell
.\dp.ps1 embed --query "company wins a major long-term order" --top-k 10
```

A future `pgvector` migration can add native approximate-nearest-neighbour indexing without changing the document or embedding contracts.

## Current research sources

### News

The local research service uses Yahoo Finance search/news and GDELT's document-search API for broad recent coverage. GDELT supports keyword/phrase search and rolling time windows for news discovery.

- GDELT: https://www.gdeltproject.org/
- GDELT DOC API: https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/

### Official disclosures

The dashboard provides direct access to NSE corporate announcements and NSE public Regulation 7(2) insider-trading disclosures. NSE also publishes corporate-announcement datasets and an insider-trading archive.

- NSE announcements: https://www.nseindia.com/companies-listing/corporate-filings-announcements
- NSE insider trading: https://www.nseindia.com/companies-listing/corporate-filings-insider-trading
- NSE insider-trading archive: https://www.nseindia.com/companies-listing/corporate-filings-insider-trading-archive-data
- SEBI filings: https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListing=yes&sid=3&smid=11
- SEBI insider-trading search: https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListingAll=yes&search=Insider+Trading

## Local architecture

```text
React dashboard :3000
       │
       ├────────── Local Market API :4100 ─────── PostgreSQL :5433
       │                     │                         ▲
       │                     └── live Yahoo quote     │
       │                                               │
       └────────── Research API :4200 ── Yahoo/GDELT ─┤
                                                     │
                                               Python collector
                                                     │
                                             Historical ML pipeline
```

The collector stores market data. The market API serves local data and a current quote endpoint. The research service is separate so slow or unavailable news providers cannot block the main market API. Research results are also persisted for future event learning.

## Windows local installation

Windows is the recommended developer path for this repository.

### 1. Install prerequisites

Install:

- Node.js 22 LTS or newer
- Python 3.12+
- Docker Desktop with Docker Compose
- Git

Make sure `node`, `npm`, `python`, `docker` and `git` work in PowerShell.

### 2. Clone the repository

```powershell
git clone https://github.com/akkillies1/D-predict-.git
cd D-predict-
```

### 3. Prepare the local environment

```powershell
powershell -ExecutionPolicy Bypass -File .\dp.ps1 doctor
powershell -ExecutionPolicy Bypass -File .\dp.ps1 init
```

`init` installs backend/dashboard packages, creates the collector virtual environment and installs collector dependencies. The training dependency set can be installed separately with:

```powershell
.\collector\.venv\Scripts\python.exe -m pip install -r training\requirements.txt
```

### 4. Start everything

```powershell
powershell -ExecutionPolicy Bypass -File .\dp.ps1 start
```

This starts:

```text
PostgreSQL  → 5433
Market API  → 4100
Research API → 4200
Dashboard   → 3000
Collector   → background process
```

Open:

```text
http://127.0.0.1:3000
```

### 5. Apply the ML/research schema

For an existing local database, run once:

```powershell
docker compose up -d postgres
docker compose exec -T postgres psql -U postgres -d nifty -f /docker-entrypoint-initdb.d/002-prediction-ml.sql
```

Fresh PostgreSQL volumes also receive the mounted migration automatically during initial database creation.

### 6. Check status

```powershell
powershell -ExecutionPolicy Bypass -File .\dp.ps1 status
```

### 7. Stop everything

```powershell
powershell -ExecutionPolicy Bypass -File .\dp.ps1 stop
```

See [`LOCAL_INSTALL_GUIDE.md`](LOCAL_INSTALL_GUIDE.md) and [`training/README.md`](training/README.md) for the full workflow.

## Linux / macOS

The existing `./dp` launcher starts PostgreSQL, the market API, research service, dashboard and collector. The training modules can be run with the active Python environment using the commands in `training/README.md`.

## Searching a ticker

Use the dashboard search box. Search is debounced and can discover supported Yahoo symbols even when they have not yet been activated locally.

Example:

```text
rel
```

Select a result. D-predict activates it in the local instrument table so the collector can pick it up on its next cycle.

## Live market flow

After selecting a symbol:

1. the dashboard reads the local database for stored 1-minute history;
2. the market API can fetch a current Yahoo quote;
3. the collector continues writing fresh bars;
4. the UI refreshes the market view periodically;
5. NIFTY/BANKNIFTY can additionally show the stored NSE option-chain snapshots.

The application must display `NO DATA`, `WAITING` or `OFFLINE` when the source is unavailable. It must not invent market prices.

## Research flow

Selecting a ticker also updates the research workspace.

The research service:

1. identifies the company where possible;
2. collects recent public news;
3. searches a broader GDELT news window;
4. searches for public NSE/SEBI material where indexed;
5. removes duplicate URLs;
6. scores the direction of the current public evidence;
7. measures source agreement and freshness;
8. persists research documents for later embedding;
9. highlights themes and risks;
10. provides direct links to official public disclosure pages.

The UI calls this a **Meta-prediction** because it is an attempt to assess the direction implied by the *current evidence stack*, not simply repeat one prediction source.

## Environment variables

The `.env.example` file contains safe local defaults:

```env
DATABASE_URL=postgresql://postgres:localdev@localhost:5433/nifty
API_PORT=4100
RESEARCH_PORT=4200
VITE_API_BASE_URL=http://127.0.0.1:4100
VITE_RESEARCH_BASE_URL=http://127.0.0.1:4200
OPTION_CHAIN_POLL_SECONDS=15
PRICE_BAR_POLL_SECONDS=15
COLLECTOR_INSTRUMENTS=NIFTY,BANKNIFTY
RESEARCH_NEWS_ENABLED=true
RESEARCH_CACHE_SECONDS=60
GDELT_TIMESPAN=3d
RESEARCH_MAX_ARTICLES=30
EMBEDDING_MODEL=all-MiniLM-L6-v2
```

Never commit API keys, model credentials or private credentials.

## Useful commands

Windows:

```powershell
.\dp.ps1 doctor
.\dp.ps1 init
.\dp.ps1 start
.\dp.ps1 status
.\dp.ps1 test
.\dp.ps1 stop
.\dp.ps1 api
.\dp.ps1 research
.\dp.ps1 ui
.\dp.ps1 collect

# training
.\collector\.venv\Scripts\python.exe -m training.download_historical --symbols NIFTY BANKNIFTY
.\collector\.venv\Scripts\python.exe -m training.validate_history data\historical\nifty.csv --frequency 1d
.\collector\.venv\Scripts\python.exe -m training.build_dataset --symbols NIFTY BANKNIFTY
.\collector\.venv\Scripts\python.exe -m training.train_baseline --symbols NIFTY BANKNIFTY
.\collector\.venv\Scripts\python.exe -m training.walk_forward --symbols NIFTY BANKNIFTY
.\collector\.venv\Scripts\python.exe -m training.train_meta --symbols NIFTY BANKNIFTY
.\collector\.venv\Scripts\python.exe -m training.embed_events
```

Unix-like systems:

```bash
./dp doctor
./dp init
./dp start
./dp test
./dp stop
./dp api
./dp research
./dp collect
```

## Validation

GitHub Actions validates the backend, dashboard typecheck/build, collector compile checks and training-source syntax. The dashboard install uses the repository's `--legacy-peer-deps` path because the existing `@builder.io/vite-plugin-jsx-loc` dependency has an older Vite peer range.

For local validation on Windows:

```powershell
.\dp.ps1 test
```

Before treating a model change as useful, also run the historical validation and walk-forward workflow and inspect the generated metrics. A green build is not evidence of predictive performance.

## Safety and scope

D-predict is a research tool, not a broker and not an order-execution system.

It must not:

- claim access to secret or non-public inside information;
- convert an unverified rumour into “confirmed” information;
- fabricate prices, option data or company events;
- present model confidence as certainty;
- execute orders automatically.

## Accuracy roadmap

The path to a trustworthy high-accuracy system is empirical:

- richer historical derivatives data;
- historical news/event acquisition with point-in-time timestamps;
- entity resolution for company names and aliases;
- event-study features around corporate disclosures;
- analyst-consensus revisions and estimate surprises;
- options-implied distributions where reliable data is available;
- contradiction detection across sources;
- learned source reliability;
- semantic event embeddings and similarity-weighted historical outcomes;
- probability calibration;
- regime-specific meta-models;
- strict walk-forward evaluation;
- prediction ledger with automatic outcome scoring;
- shadow mode before any capital is exposed.

The goal is not “AI that sounds smart”. The goal is a measured, auditable evidence and prediction system that can demonstrate when its forecasts are actually useful.
