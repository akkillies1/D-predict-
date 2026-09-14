# D-predict

D-predict is a local-first research and market-analysis cockpit for Indian equities and NIFTY/BANKNIFTY derivatives.

The governing principle is simple: **do not turn a headline into a trade without checking the evidence, testing the idea against history, and measuring the model out of sample.**

## Current engineering status

**Active sprint:** Sprint 1 — Local Research Terminal & Data Foundation  
**Primary branch:** `main`  
**Direction:** Qlib-inspired research architecture, implemented natively for D-predict rather than importing Qlib wholesale.

### Sprint 1 checklist

- [x] Canonical instrument metadata and dashboard instrument discovery/activation.
- [x] Explicit market-data freshness contract: `LIVE`, `CACHED`, `STALE`, `OFFLINE`.
- [x] No synthetic live OHLC values; unavailable fields remain explicit.
- [x] Historical OHLCV validation for chronology, duplicates, numeric values, OHLC relationships, volume and frequency gaps.
- [x] Qlib-inspired `DatasetSpec` / `PointInTimeDataset` contract with purge-aware chronological segments.
- [x] Dataset provenance checks and deterministic SHA-256 manifests.
- [x] Baseline classifier/regressor using the formal point-in-time dataset contract.
- [x] Strict expanding-window walk-forward validation with horizon-aware purge.
- [x] Prediction-ledger accuracy and probability-quality scoring.
- [x] Independent realized 1d/3d/5d outcome scoring with explicit `SCORED` / `PENDING` state.
- [x] Conservative raw-performance promotion gate.
- [x] Confidence, calibration, fold-stability and evaluation-only regime-proxy analysis.
- [x] Stability-aware final model promotion gate.
- [x] V1 non-overlapping portfolio backtest with transaction costs and slippage.
- [x] Deterministic portfolio construction with confidence-aware sizing and gross-exposure limits.
- [x] Point-in-time volatility/ATR-aware risk budgeting with explicit missing-risk-data handling.
- [ ] Complete research-terminal workflow: search → activation → validation → dataset → prediction.
- [ ] Formal point-in-time Regime Model.
- [ ] Cross-instrument portfolio risk attribution and correlation-aware limits.
- [ ] Drawdown-aware portfolio throttle.
- [ ] Paper/shadow trading.

## Future improvement checklist

### Data foundation

- [ ] Complete canonical NSE/BSE/Yahoo instrument/provider mapping.
- [ ] Exchange calendars and trading-session-aware timestamps.
- [ ] Corporate-action adjustment and provenance.
- [ ] Point-in-time historical news/disclosure ingestion.
- [ ] Source-level data-quality and freshness monitoring.
- [ ] Native `pgvector` indexing when document volume justifies it.

### Research and modelling

- [ ] Versioned feature registry.
- [ ] Versioned label registry.
- [ ] Market Model for numerical features.
- [ ] Event Model for news, filings and public disclosures.
- [ ] Formal point-in-time Regime Model.
- [ ] True Meta Model combining model outputs.
- [ ] Calibration and calibration-drift monitoring.
- [ ] Research terminal with provenance/freshness beside key values.
- [ ] Reliable live ticker suggestions with exchange/company-name resolution.

### Backtesting and risk

- [x] Expanding-window walk-forward engine.
- [x] Purged validation.
- [x] Transaction-cost and slippage-aware V1 backtest.
- [x] Deterministic portfolio sizing with per-position and total gross-exposure caps.
- [x] Volatility/stop-distance-aware risk budgeting using point-in-time historical OHLC.
- [ ] Portfolio risk limits and exposure attribution across instruments.
- [ ] Drawdown-aware portfolio throttle.
- [ ] Paper-trading/shadow mode before any live capital.
- [ ] No automated live execution until research, backtest and paper-trading gates pass.

### Local-first runtime

- [x] One-command Windows launcher.
- [x] Background PostgreSQL, market API and collector startup through Compose.
- [x] Dashboard startup, port detection and browser launch.
- [x] Local API health-check gate.
- [ ] Start and health-check the research service in Compose.
- [ ] Graceful restart/supervision for failed services.
- [ ] Cross-platform launcher.
- [ ] Optional Windows installer.
- [ ] CI for Python tests plus dashboard typecheck/build.
- [ ] Runtime observability for collector/API/research failures.

### Later, not now

- [ ] RL / FinRL after supervised and event models are demonstrably useful.
- [ ] Complex deep learning only after classical baselines are beaten out of sample.
- [ ] LLM-assisted research with evidence citations and strict source separation.
- [ ] Advanced options research after reliable historical options data exists.

## Local-first startup

The primary product target is a **single-command local application**, not a Vercel-hosted full stack.

Windows:

```powershell
.\d-predict.cmd
```

or:

```powershell
.\d-predict.ps1
```

The launcher checks Docker, creates `.env` from `.env.example` when needed, starts PostgreSQL/market API/collector, waits for `/health`, starts the dashboard, detects an available dashboard port and opens the browser. The current launcher does **not** claim the research API as a running Compose service yet.

Stop with:

```powershell
.\stop-d-predict.ps1
```

Vercel remains frontend-only and optional.

## Research architecture

```text
MARKET DATA + RESEARCH DATA
        ↓
POINT-IN-TIME DATA LAYER
        ↓
NUMERICAL FEATURES + EVENT FEATURES
        ↓
MARKET MODEL + EVENT MODEL
        ↓
META MODEL
        ↓
PREDICTION LEDGER
        ↓
DECISION ENGINE
        ↓
BACKTEST
        ↓
PAPER TRADING
        ↓
LIVE MONITORING
```

The intended research chain is:

```text
Instrument → Calendar → Dataset → Feature definitions
→ Label definitions → Model → Prediction → Backtest → Evaluation
```

The research layer is public-information only. Public exchange announcements, regulator records and disclosed insider transactions may be used as evidence; illegal material non-public information is not requested, inferred or traded on.

## Accuracy and promotion philosophy

Accuracy is a **promotion gate**, not a cosmetic dashboard number. OOS predictions retain timestamp, symbol, horizon, fold, training cutoff, purge information, predicted class and the full probability vector.

The independent realized-outcome scorer recomputes future trading-day outcomes from historical closes. Missing future closes remain `PENDING` rather than being silently scored as failures.

The raw-performance gate currently requires at least 100 realized OOS examples, at least 2 percentage points of accuracy lift over the majority-class baseline, multiclass log loss no worse than 1.05, and directional accuracy of at least 52%.

The stability gate additionally requires, by default, maximum interpretable calibration gap ≤10 percentage points, fold accuracy standard deviation ≤10 percentage points, worst-fold lift ≥−5 percentage points, at least two interpretable regimes, and worst interpretable-regime lift ≥−5 percentage points.

These are engineering gates, **not profitability guarantees**. A model can pass them and still lose money.

## V1 portfolio backtest

`training/backtest.py` is deliberately conservative and uses only the OOS prediction ledger plus historical closes.

Rules:

1. A prediction at timestamp `T` cannot execute at `T`; entry is the **next available historical close**.
2. `UP` opens a long trade; `DOWN` opens a short trade; `FLAT` is ignored.
3. The trade exits after the requested trading-row horizon: `1d` = 1 row, `3d` = 3 rows, `5d` = 5 rows.
4. Trades cannot overlap; signals arriving while a position is open are skipped.
5. Transaction cost and slippage are charged on both entry and exit.
6. The engine compounds portfolio equity trade by trade and reports total return, CAGR, max drawdown, win rate, profit factor and an annualized per-trade Sharpe proxy.
7. This is an evaluation engine, **not** an order-execution system.

Default friction is 10 bps transaction cost + 5 bps slippage per side. These values are CLI-configurable and must be replaced with evidence-backed assumptions before using the results for a promotion decision.

Example:

```powershell
.\collector\.venv\Scripts\python.exe -m training.backtest data\predictions\nifty_1d_walk_forward.csv --history data\historical\nifty.csv --output data\predictions\nifty_1d_backtest.json
```

The generated backtest artifact should normally remain local and should not be committed as model evidence unless explicitly versioned for an audit.

## Portfolio construction and risk limits

`training/portfolio.py` converts the OOS probability vector into deterministic portfolio decisions without placing orders or inventing prices.

The current V1 rules are deliberately simple:

1. `FLAT` predictions produce no position.
2. `UP`/`DOWN` predictions must meet a configurable minimum class probability, default 55%.
3. Position weight scales with the probability edge above the neutral 1/3 class prior.
4. A hard per-position cap defaults to 25% of portfolio capital.
5. A hard total gross-exposure cap defaults to 100%.
6. Once the gross cap is consumed, later candidates receive zero additional exposure.
7. Every decision records timestamp, symbol, horizon, prediction, confidence, requested limits and resulting gross exposure.

`training/risk.py` adds the next layer without inventing volatility. For every prediction timestamp it calculates ATR percentage from historical OHLC bars with `history_timestamp <= prediction_timestamp`. The stop distance is `max(min_stop_distance_bps, ATR% × stop_atr_multiplier)`, and the risk budget is `risk_per_trade / stop_distance`. Final weight is the minimum of the confidence-edge weight, volatility-derived risk budget, position cap and remaining gross exposure. If insufficient history exists for ATR, the result is an explicit `RISK_DATA_UNAVAILABLE` no-trade rather than a guessed volatility value.

This remains an evaluation/risk layer. It does not place orders, use future bars, or claim that ATR is a complete portfolio risk model. Cross-instrument exposure attribution and drawdown-aware throttling are still pending.

Example:

```powershell
.\collector\.venv\Scripts\python.exe -m training.portfolio data\predictions\nifty_1d_walk_forward.csv --output data\predictions\nifty_1d_portfolio.json
.\collector\.venv\Scripts\python.exe -m training.risk data\predictions\nifty_1d_walk_forward.csv --history data\historical\nifty.csv --output data\predictions\nifty_1d_risk.json
```

## Historical learning pipeline

The main training modules are:

- `download_historical.py` — raw daily history acquisition.
- `validate_history.py` — OHLCV validation.
- `dataset.py` — point-in-time dataset contract.
- `manifest.py` — deterministic provenance/fingerprint manifests.
- `build_dataset.py` — 1d/3d/5d point-in-time features and labels.
- `train_baseline.py` — classical market classifier and return regressor.
- `walk_forward.py` — strict expanding-window OOS predictions.
- `score_prediction_ledger.py` — OOS accuracy/probability metrics.
- `score_realized_outcomes.py` — independent realized outcome scoring.
- `analyze_prediction_stability.py` — calibration/fold/regime analysis.
- `stability_gate.py` — stability promotion checks.
- `accuracy_gate.py` — raw-performance + required stability promotion gate.
- `backtest.py` — V1 transaction-cost/slippage-aware portfolio accounting.
- `portfolio.py` — deterministic confidence-aware sizing and gross-exposure controls.
- `risk.py` — point-in-time ATR/stop-distance risk budgeting.
- `train_meta.py` — conservative calibration/meta layer.
- `embed_events.py` — research-document vector memory.

## Windows training/evaluation flow

```powershell
.\collector\.venv\Scripts\python.exe -m training.download_historical --symbols NIFTY BANKNIFTY
.\collector\.venv\Scripts\python.exe -m training.validate_history data\historical\nifty.csv --frequency 1d
.\collector\.venv\Scripts\python.exe -m training.build_dataset --symbols NIFTY BANKNIFTY
.\collector\.venv\Scripts\python.exe -m training.train_baseline --symbols NIFTY BANKNIFTY
.\collector\.venv\Scripts\python.exe -m training.walk_forward --symbols NIFTY BANKNIFTY
.\collector\.venv\Scripts\python.exe -m training.score_prediction_ledger data\predictions\nifty_1d_walk_forward.csv
.\collector\.venv\Scripts\python.exe -m training.score_realized_outcomes data\predictions\nifty_1d_walk_forward.csv --history data\historical\nifty.csv --output data\predictions\nifty_1d_realized.csv
.\collector\.venv\Scripts\python.exe -m training.analyze_prediction_stability data\predictions\nifty_1d_realized.csv --history data\historical\nifty.csv --output data\predictions\nifty_1d_stability.json
.\collector\.venv\Scripts\python.exe -m training.stability_gate data\predictions\nifty_1d_stability.json --output data\predictions\nifty_1d_stability_gate.json
.\collector\.venv\Scripts\python.exe -m training.accuracy_gate data\predictions\nifty_1d_realized.csv --stability-report data\predictions\nifty_1d_stability.json
.\collector\.venv\Scripts\python.exe -m training.backtest data\predictions\nifty_1d_walk_forward.csv --history data\historical\nifty.csv --output data\predictions\nifty_1d_backtest.json
.\collector\.venv\Scripts\python.exe -m training.portfolio data\predictions\nifty_1d_walk_forward.csv --output data\predictions\nifty_1d_portfolio.json
.\collector\.venv\Scripts\python.exe -m training.risk data\predictions\nifty_1d_walk_forward.csv --history data\historical\nifty.csv --output data\predictions\nifty_1d_risk.json
```

Repeat the realized scoring, stability, backtest, portfolio and risk stages for 3d and 5d. Do not promote a model from one headline aggregate number.

## Environment

`.env.example` contains local defaults for PostgreSQL, market API, research API, dashboard API base URLs, collectors and research caching. Never commit API keys or private credentials.

## Testing

The repository contains Python tests under `training/tests`. Recommended local verification on Windows:

```powershell
.\collector\.venv\Scripts\python.exe -m pytest training/tests
```

No claim is made here that the local Windows test suite has passed unless it has actually been run in the user's environment or through CI.

## Product boundaries

D-predict is currently a research and evaluation system. It is not an automated live trading system. The intended progression is:

```text
historical data
→ supervised prediction
→ walk-forward validation
→ calibration/stability
→ event model
→ portfolio/risk model
→ paper trading
→ only then consider live automation
```

RL, FinRL, complex deep learning, LLM-driven recommendations and advanced options strategy engines remain later-stage work, not Sprint 1 shortcuts.
