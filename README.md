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
- [x] Causal drawdown-aware throttling integrated into the risk-weighted backtest.
- [x] Cross-instrument exposure attribution and point-in-time correlation-aware limits.
- [x] Historical paper/shadow replay with virtual capital, delayed outcome resolution and model-accuracy game scoring.
- [ ] Complete research-terminal workflow: search → activation → validation → dataset → prediction.
- [ ] Formal point-in-time Regime Model.

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

### Backtesting, shadow and risk

- [x] Expanding-window walk-forward engine.
- [x] Purged validation.
- [x] Transaction-cost and slippage-aware V1 backtest.
- [x] Deterministic portfolio sizing with per-position and total gross-exposure caps.
- [x] Volatility/stop-distance-aware risk budgeting using point-in-time historical OHLC.
- [x] Drawdown-aware portfolio throttle.
- [x] Cross-instrument exposure attribution and correlation-aware limits.
- [x] Historical paper/shadow replay with virtual capital and accuracy scoring.
- [ ] Live market shadow feed with no order placement.
- [ ] Shadow-session persistence and restart-safe state.
- [ ] Interactive dashboard/game mode for prediction decisions and delayed scoring.
- [ ] Promotion gate requiring sustained shadow accuracy/stability before any live-capital consideration.
- [ ] No automated live execution until research, backtest and paper/shadow gates pass.

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
PAPER / SHADOW SIMULATION
        ↓
LIVE MONITORING
```

The intended research chain is:

```text
Instrument → Calendar → Dataset → Feature definitions
→ Label definitions → Model → Prediction → Backtest → Shadow → Evaluation
```

## Accuracy and promotion philosophy

Accuracy is a **promotion gate**, not a cosmetic dashboard number. OOS predictions retain timestamp, symbol, horizon, fold, training cutoff, purge information, predicted class and the full probability vector.

The independent realized-outcome scorer recomputes future trading-day outcomes from historical closes. Missing future closes remain `PENDING` rather than being silently scored as failures.

The raw-performance gate currently requires at least 100 realized OOS examples, at least 2 percentage points of accuracy lift over the majority-class baseline, multiclass log loss no worse than 1.05, and directional accuracy of at least 52%.

The stability gate additionally requires, by default, maximum interpretable calibration gap ≤10 percentage points, fold accuracy standard deviation ≤10 percentage points, worst-fold lift ≥−5 percentage points, at least two interpretable regimes, and worst interpretable-regime lift ≥−5 percentage points.

These are engineering gates, **not profitability guarantees**. A model can pass them and still lose money.

## V1 portfolio backtest

`training/backtest.py` is a **causal risk-weighted evaluation engine**. It combines the OOS probability vector with the point-in-time ATR risk layer and a drawdown throttle.

Rules:

1. A prediction at timestamp `T` cannot execute at `T`; entry is the **next available historical close**.
2. `UP` opens a long trade; `DOWN` opens a short trade; `FLAT` is ignored.
3. The trade exits after the requested trading-row horizon: `1d` = 1 row, `3d` = 3 rows, `5d` = 5 rows.
4. Trades cannot overlap; signals arriving while a position is open are skipped.
5. Transaction cost and slippage are charged on both entry and exit.
6. Base position weight is the minimum of confidence-edge sizing, ATR/stop-distance risk budget, per-position cap and remaining gross cap.
7. The drawdown throttle is evaluated **before** each new position using only equity and the historical equity peak already known at that point.
8. Drawdown at or below the soft threshold leaves risk unchanged. Between soft and hard thresholds, new risk is linearly reduced. At or beyond the hard threshold, new risk is blocked.
9. Equity changes only after a trade is realized; future trades cannot affect the throttle applied to an earlier signal.
10. The engine compounds only the fraction of equity represented by the position weight, leaving the remainder unexposed.
11. Every trade records base weight, drawdown, throttle multiplier, final position weight, risk status, return and equity before/after the trade.
12. This is an evaluation engine, **not** an order-execution system.

Default friction is 10 bps transaction cost + 5 bps slippage per side. Default risk budget is 0.5% per trade, ATR period 14, 1.5× ATR stop distance, 50 bps minimum stop distance, 25% maximum position and 100% maximum gross exposure.

Default drawdown controls are a 5% soft threshold and 10% hard threshold. These are conservative engineering defaults, not claims of optimality.

Example:

```powershell
.\collector\.venv\Scripts\python.exe -m training.backtest data\predictions\nifty_1d_walk_forward.csv --history data\historical\nifty.csv --output data\predictions\nifty_1d_backtest.json
```

The generated backtest artifact should normally remain local and should not be committed as model evidence unless explicitly versioned for an audit.

## Paper / shadow trading as a game and training system

`training/shadow.py` is the first paper/shadow layer. It is deliberately **simulation-only**: it sends zero broker orders and reports `live_orders_sent = 0` in its summary.

The same prediction ledger can be replayed chronologically against historical data. Each prediction becomes a virtual decision, then its outcome is resolved only when the required future trading row exists. This creates a training/game loop:

```text
MODEL PREDICTION
      ↓
VIRTUAL DECISION
      ↓
WAIT FOR FUTURE BAR
      ↓
REALIZED OUTCOME
      ↓
ACCURACY SCORE + CONFIDENCE SCORE
      ↓
VIRTUAL P&L / EQUITY
      ↓
MODEL / HUMAN REVIEW
```

The simulator tracks:

- overall accuracy after every resolved prediction;
- directional accuracy for UP/DOWN decisions;
- confidence-weighted game score (`+confidence` for correct, `-confidence` for incorrect);
- pending predictions whose future outcome is not yet available;
- virtual capital and virtual return;
- maximum virtual drawdown;
- position weight derived from confidence edge;
- entry/exit timestamps and realized outcome;
- zero live-order count.

The **accuracy game is not a replacement for OOS validation**. It is a controlled replay/training environment that makes model quality measurable as a sequence of decisions rather than a single headline metric. It also provides the interface contract for a later live shadow feed where real market observations resolve predictions without placing orders.

Historical replay example:

```powershell
.\collector\.venv\Scripts\python.exe -m training.shadow data\predictions\nifty_1d_walk_forward.csv --history NIFTY=data\historical\nifty.csv --output data\predictions\nifty_1d_shadow.json
```

Multiple instruments can be replayed in one session by repeating `--history SYMBOL=PATH`. Missing instrument history is reported explicitly rather than replaced with synthetic prices.

The current shadow layer intentionally does **not** claim live market connectivity, persistence, broker integration, or interactive UI. Those are the next shadow-mode layers.

## Portfolio construction and risk limits

`training/portfolio.py` converts the OOS probability vector into deterministic portfolio decisions without placing orders or inventing prices.

`training/risk.py` adds point-in-time volatility budgeting. For every prediction timestamp it calculates ATR percentage from historical OHLC bars with `history_timestamp <= prediction_timestamp`. The stop distance is `max(min_stop_distance_bps, ATR% × stop_atr_multiplier)`, and the risk budget is `risk_per_trade / stop_distance`. Missing ATR history produces explicit `RISK_DATA_UNAVAILABLE` rather than guessed volatility.

`training/backtest.py` consumes that risk budget and applies a second, portfolio-level drawdown control. The drawdown peak is updated only after realized trades. No future equity, future volatility or future outcome is used to size an earlier trade.

`training/exposure.py` adds cross-instrument exposure attribution. It applies a per-symbol cap and compares each candidate instrument with already accepted exposure using rolling close-to-close return correlation calculated only from bars at or before the candidate timestamp. Correlations whose absolute value meets the configured threshold count toward the correlated-exposure budget. Missing historical exposure data produces an explicit `EXPOSURE_DATA_UNAVAILABLE` block; exceeding the correlated budget produces `CORRELATED_EXPOSURE_LIMIT`. This is deliberately a conservative V1 limit, not a full covariance optimiser.

Example:

```powershell
.\collector\.venv\Scripts\python.exe -m training.exposure data\predictions\portfolio_risk.csv --history NIFTY=data\historical\nifty.csv --history BANKNIFTY=data\historical\banknifty.csv --output data\predictions\portfolio_exposure.json
```

Default exposure controls are 50% maximum per symbol, 50% maximum exposure to the high-correlation group, a 0.70 absolute-correlation threshold and a 60-return lookback. These are engineering defaults, not claims of optimality.

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
- `portfolio.py` — deterministic confidence-aware sizing and gross-exposure controls.
- `risk.py` — point-in-time ATR/stop-distance risk budgeting.
- `backtest.py` — causal risk-weighted, drawdown-aware V1 portfolio accounting.
- `exposure.py` — cross-instrument exposure attribution and correlation-aware limits.
- `shadow.py` — historical paper/shadow replay, virtual capital and accuracy-game scoring.
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
.\collector\.venv\Scripts\python.exe -m training.shadow data\predictions\nifty_1d_walk_forward.csv --history NIFTY=data\historical\nifty.csv --output data\predictions\nifty_1d_shadow.json
```

Repeat the realized scoring, stability, backtest and shadow stages for 3d and 5d. Do not promote a model from one headline number.

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

Vercel remains frontend-only and optional.

## Testing

The repository contains Python tests under `training/tests`. Recommended local verification on Windows:

```powershell
.\collector\.venv\Scripts\python.exe -m pytest training/tests
```

The risk tests cover point-in-time ATR sizing and missing-risk-data handling. The backtest tests cover drawdown-throttle boundaries, causal risk-weighted sizing, next-close execution, overlap prevention, bad-history rejection and hard-drawdown blocking. The exposure tests cover correlation limits, uncorrelated instruments, missing history and configuration validation. The shadow tests cover historical replay accuracy, pending outcomes, probability validation and simulation-only operation.

**Verification status:** the GitHub changes were committed, but the Windows test suite has not been executed in this environment. Do not treat the new tests as passing until the command above is run locally or by CI.

## Product boundaries

D-predict is currently a research, evaluation and simulation system. It is not an automated live trading system. The intended progression is:

```text
historical data
→ supervised prediction
→ walk-forward validation
→ calibration/stability
→ event model
→ portfolio/risk model
→ paper/shadow simulation
→ live shadow monitoring
→ only then consider live automation
```

RL, FinRL, complex deep learning, LLM-driven recommendations and advanced options strategy engines remain later-stage work, not Sprint 1 shortcuts.
