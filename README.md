# D-predict

D-predict is a local research and market-analysis cockpit for Indian equities and NIFTY/BANKNIFTY derivatives.

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
- [x] Fix Vercel dashboard typecheck failure caused by nullable live-market OHLC fields.
- [x] Keep `main` as the canonical development/deployment branch.
- [ ] Add a production favicon and complete web metadata polish.
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

## Deployment note

The production dashboard is deployed at `https://dpredict.dcodeinteriors.com/`. The dashboard is expected to remain buildable by Vercel's TypeScript check. Live market fields such as `open`, `high` and `low` may legitimately be `null` when an upstream provider does not supply them; the UI must render those states explicitly rather than asserting that the values exist.

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
