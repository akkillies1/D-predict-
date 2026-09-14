# D-predict

D-predict is a local-first research and market-analysis cockpit for Indian equities and NIFTY/BANKNIFTY derivatives.

It is designed around one principle: **do not turn a headline into a trade without checking the evidence around it, testing the idea against history, and measuring the model out of sample.**

## Current engineering status

**Active sprint:** Sprint 1 — Local Research Terminal & Data Foundation  
**Primary branch:** `main`  
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
- [x] Vercel TypeScript fix for nullable live-market OHLC fields.
- [x] Production favicon added and linked from the dashboard HTML.
- [x] Vercel root build/output configuration added for the monorepo dashboard.
- [x] `main` is the canonical development/deployment branch.
- [x] One-command Windows local launcher starts the database, market API, collector and dashboard, performs health checks and opens the browser.
- [ ] Complete web metadata polish.
- [ ] Connect historical validation directly to every production dataset ingestion path.
- [ ] Add reproducible dataset manifests and dataset fingerprints.
- [ ] Complete the research-terminal workflow from search → activation → data validation → dataset → prediction.
- [ ] Add prediction-ledger outcome scoring.
- [ ] Add V1 portfolio/backtest accounting with transaction costs and slippage.

## Future improvement checklist

### Local-first runtime

- [x] One-command Windows launcher for the local stack.
- [x] Background startup for PostgreSQL, market API and collector through Docker Compose.
- [x] Automatic dashboard startup and browser launch.
- [x] Local health-check gate before opening the UI.
- [ ] Add a polished cross-platform launcher for macOS/Linux.
- [ ] Add graceful process supervision/restart for failed local services.
- [ ] Add a desktop-style tray/stop experience after the local runtime is stable.
- [ ] Package an optional Windows executable/installer.

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
- [x] Reproducible local setup and one-command health checks.
- [ ] CI coverage for Python tests and dashboard typecheck/build.
- [ ] Observability for collector/API/research failures.
- [ ] No automated live order execution until research, backtest and paper-trading gates are satisfied.

### Later, not now

- [ ] RL / FinRL experimentation after supervised and event models are demonstrably useful.
- [ ] Complex deep-learning models only after strong classical baselines are beaten out of sample.
- [ ] LLM-assisted research workflows with evidence citations and strict source separation.
- [ ] Advanced options strategy research after reliable historical options data is available.

## Local-first startup

The primary product target is a **single-command local application**, not a Vercel-hosted full stack.

From the repository root on Windows:

```powershell
.\d-predict.cmd
```

or:

```powershell
.\d-predict.ps1
```

The launcher:

1. checks that Docker Desktop is running;
2. creates `.env` from `.env.example` when needed;
3. starts PostgreSQL, the market API and collector in the background through Docker Compose;
4. waits for `/health` on the market API;
5. installs the dashboard dependencies from the committed `dashboard/pnpm-lock.yaml`;
6. starts the dashboard in a background PowerShell process;
7. detects the actual dashboard port if `3000` is already occupied;
8. opens the dashboard automatically in the browser.

The normal local experience should therefore become:

```text
Terminal
   │
   └── d-predict.cmd
          │
          ├── PostgreSQL :5433
          ├── Market API :4100
          ├── Collector
          ├── Research/data services
          └── Dashboard :3000+
                    │
                    ▼
                 Browser UI
```

Stop the local runtime with:

```powershell
.\stop-d-predict.ps1
```

The launcher currently targets Windows because that is the first supported development environment. The underlying services remain containerized so the architecture can later be packaged for other operating systems.

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

## Deployment

The repository is a monorepo. The production dashboard lives under `dashboard/` and builds the Vite client into `dashboard/dist/public`. A root `vercel.json` explicitly configures Vercel to install dependencies and run the dashboard build from that directory.

Vercel is **frontend-only and optional** for the current product. The primary runtime is local: PostgreSQL, collector, market API and research services run on the developer machine, with the browser dashboard connecting to localhost. A Vercel deployment does not automatically provide those backend services. If a separately hosted API is added later, it can be connected through `VITE_API_BASE_URL` / `VITE_RESEARCH_BASE_URL`.

## Windows training flow

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

## Local architecture

```text
React/Vite dashboard
       │
       ├────────── Market API :4100 ─────── PostgreSQL :5433
       │                     │
       │                     └── live Yahoo quote
       │
       └────────── Research API :4200 ── Yahoo/GDELT
                              │
                         research documents
                              │
                       Historical ML pipeline
```

The collector stores market data. The market API serves local data and a current quote endpoint. The research service is separate so slow or unavailable news providers cannot block the main market API.

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
