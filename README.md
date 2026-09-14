# D-predict

D-predict is a local-first research and market-analysis cockpit for Indian equities and NIFTY/BANKNIFTY derivatives.

**Principle:** do not turn a headline into a trade without checking evidence, testing against history, and measuring the model out of sample.

## Current engineering status

- **Active sprint:** Sprint 1 — Local Research Terminal & Data Foundation
- **Primary branch:** `main`
- **Architecture:** Qlib-inspired research workflow implemented natively for D-predict.
- **Execution boundary:** research, evaluation and simulation only. No automated live orders.

### Sprint 1 checklist

- [x] Canonical instrument metadata and dashboard instrument discovery/activation.
- [x] Explicit market-data freshness contract: `LIVE`, `CACHED`, `STALE`, `OFFLINE`.
- [x] No synthetic live OHLC values.
- [x] Historical OHLCV validation.
- [x] Point-in-time `DatasetSpec` / `PointInTimeDataset` contract with purge-aware segments.
- [x] Deterministic dataset provenance/fingerprints.
- [x] Baseline classifier/regressor.
- [x] Expanding-window walk-forward validation.
- [x] Prediction-ledger accuracy/probability scoring.
- [x] Independent realized-outcome scoring with `SCORED` / `PENDING` state.
- [x] Raw-performance promotion gate.
- [x] Calibration/fold-stability/evaluation-only regime analysis.
- [x] Stability-aware promotion gate.
- [x] V1 causal portfolio backtest with costs/slippage.
- [x] Confidence-aware portfolio construction and gross-exposure limits.
- [x] Point-in-time ATR/risk budgeting.
- [x] Drawdown-aware risk throttling.
- [x] Cross-instrument correlation-aware exposure limits.
- [x] Historical paper/shadow replay with virtual capital and accuracy-game scoring.
- [x] Restart-safe live shadow session state and delayed outcome resolver.
- [ ] Direct live market connector into the shadow session.
- [ ] Live prediction runner using the approved model.
- [ ] Rolling shadow accuracy/calibration/drift dashboard.
- [ ] Interactive human-vs-model game mode.
- [ ] Sustained-shadow promotion gate.
- [ ] Automated live execution only after all research/backtest/shadow gates pass.

## Research architecture

```text
MARKET DATA + RESEARCH DATA
        ↓
POINT-IN-TIME DATA LAYER
        ↓
NUMERICAL + EVENT FEATURES
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
LIVE SHADOW MONITORING
        ↓
EVALUATION / PROMOTION GATE
        ↓
ONLY THEN: LIVE AUTOMATION
```

Intended research chain:

```text
Instrument → Calendar → Dataset → Feature definitions
→ Label definitions → Model → Prediction → Backtest → Shadow → Evaluation
```

## Accuracy and promotion philosophy

Accuracy is a promotion gate, not a cosmetic dashboard number. OOS predictions retain timestamp, symbol, horizon, fold, training cutoff, purge information, predicted class and the full probability vector.

The independent realized-outcome scorer recomputes future outcomes from historical closes. Missing future closes remain `PENDING`. The raw gate requires, by default, at least 100 realized OOS examples, ≥2 percentage points accuracy lift over the majority baseline, log loss ≤1.05 and directional accuracy ≥52%.

The stability gate adds calibration, fold and regime stability requirements. These are engineering gates, not profitability guarantees.

## Backtest and risk boundary

`training/backtest.py` is evaluation-only. A prediction at `T` cannot execute at `T`; entry uses the next available historical close. UP is long, DOWN is short, FLAT is ignored. Trades use requested trading-row horizons, cannot overlap, include entry/exit friction, and use causal risk information only.

The risk stack includes point-in-time ATR/stop-distance budgeting, confidence-edge sizing, gross/per-position limits, drawdown throttling and cross-instrument correlation-aware exposure controls. Missing historical risk/exposure data creates explicit no-trade states rather than invented values.

Default friction is 10 bps transaction cost + 5 bps slippage per side. These are conservative engineering defaults, not claims of optimality.

## Paper / shadow trading as a game and training system

`training/shadow.py` provides historical replay. It sends zero broker orders and reports `live_orders_sent = 0`. Predictions become virtual decisions, wait for future bars, then receive a realized outcome and confidence-weighted game score.

```text
MODEL PREDICTION
      ↓
VIRTUAL DECISION
      ↓
WAIT FOR FUTURE BAR
      ↓
REALIZED OUTCOME
      ↓
ACCURACY + CONFIDENCE SCORE
      ↓
VIRTUAL P&L / EQUITY / DRAWDOWN
      ↓
MODEL + HUMAN REVIEW
```

The replay tracks accuracy after every resolved prediction, directional accuracy, confidence-weighted game score, pending outcomes, virtual equity/return, drawdown, position weight and entry/exit provenance.

The game is not a replacement for OOS validation. It is a controlled training environment and the contract for live shadow monitoring.

## Live shadow mode

`training/live_shadow.py` is the next layer. It accepts **real timestamped market observations and model predictions from an upstream process**, persists them atomically, and resolves predictions only after the required future observations exist. It has no broker client and no order-placement path.

The session is restart-safe: state is written to a temporary file, flushed/fsynced and atomically replaced. Prediction timestamps are unique per symbol. Market bars are immutable by `(symbol, timestamp)`; conflicting duplicates are rejected. Unresolved predictions remain `PENDING`.

Event stream format is JSONL:

```json
{"type":"bar","timestamp":"2026-09-15T10:00:00Z","symbol":"NIFTY","close":25000}
{"type":"prediction","timestamp":"2026-09-15T10:00:00Z","symbol":"NIFTY","horizon":"1d","prediction":"UP","market_probability_down":0.1,"market_probability_flat":0.1,"market_probability_up":0.8}
```

Run locally:

```powershell
.\collector\.venv\Scripts\python.exe -m training.live_shadow data\shadow\events.jsonl --state data\shadow\session.json --session-id nifty-training
```

The live-shadow module is intentionally an adapter/session boundary. It does **not** claim that the existing market collector or model is already wired to it. The next implementation step is that connector, followed by the rolling accuracy/calibration monitor and dashboard/game mode.

## Main training modules

- `download_historical.py` — raw daily history acquisition.
- `validate_history.py` — OHLCV validation.
- `dataset.py` — point-in-time dataset contract.
- `manifest.py` — deterministic provenance/fingerprint manifests.
- `build_dataset.py` — 1d/3d/5d point-in-time features and labels.
- `train_baseline.py` — classical market classifier/regressor.
- `walk_forward.py` — strict expanding-window OOS predictions.
- `score_prediction_ledger.py` — OOS accuracy/probability metrics.
- `score_realized_outcomes.py` — independent realized outcome scoring.
- `analyze_prediction_stability.py` — calibration/fold/regime analysis.
- `stability_gate.py` — stability promotion checks.
- `accuracy_gate.py` — raw-performance + stability promotion gate.
- `portfolio.py` — deterministic confidence-aware sizing.
- `risk.py` — point-in-time ATR/stop-distance risk budgeting.
- `backtest.py` — causal risk-weighted, drawdown-aware V1 backtest.
- `exposure.py` — cross-instrument exposure attribution/correlation limits.
- `shadow.py` — historical paper/shadow replay and accuracy game.
- `live_shadow.py` — restart-safe live observations, delayed resolution and virtual P&L.
- `train_meta.py` — conservative calibration/meta layer.
- `embed_events.py` — research-document vector memory.

## Windows verification

The GitHub implementation and tests have been added, but the Windows test suite has **not** been executed from the user's local environment in this session. Verify locally with:

```powershell
.\collector\.venv\Scripts\python.exe -m pytest training/tests
```

Do not treat the new live-shadow implementation as verified until that command passes locally.

## Local-first runtime

The primary product target is a single-command local application. Windows launchers are available through `d-predict.cmd` / `d-predict.ps1`. The launcher starts the existing PostgreSQL/market API/collector stack and dashboard. The research service is not yet claimed as a Compose runtime service.

Vercel is optional frontend/demo infrastructure, not the primary research runtime.

## Future improvement checklist

### Data

- [ ] Complete NSE/BSE/Yahoo canonical provider mapping.
- [ ] Exchange calendars and trading-session-aware timestamps.
- [ ] Corporate-action adjustment and provenance.
- [ ] Point-in-time news/disclosure ingestion.
- [ ] Source-level data-quality/freshness monitoring.
- [ ] Native pgvector indexing when justified.

### Research

- [ ] Versioned feature registry.
- [ ] Versioned label registry.
- [ ] Market Model.
- [ ] Event Model.
- [ ] Formal point-in-time Regime Model.
- [ ] True Meta Model.
- [ ] Calibration-drift monitoring.
- [ ] Provenance/freshness-aware research terminal.
- [ ] Reliable live ticker suggestions with exchange/company-name resolution.

### Shadow / risk / runtime

- [x] Historical paper/shadow replay.
- [x] Restart-safe live shadow session engine.
- [ ] Live market connector.
- [ ] Live prediction runner.
- [ ] Rolling accuracy/calibration/drift monitor.
- [ ] Interactive dashboard/game mode.
- [ ] Human-vs-model scorecards.
- [ ] Sustained shadow promotion gate.
- [ ] Research service in Compose.
- [ ] Graceful service restart/supervision.
- [ ] Cross-platform launcher.
- [ ] CI for Python tests plus dashboard typecheck/build.
- [ ] Runtime observability.

### Later, not now

- [ ] RL / FinRL after supervised/event models are demonstrably useful.
- [ ] Complex deep learning only after classical baselines are beaten OOS.
- [ ] LLM-assisted research with evidence citations.
- [ ] Advanced options research after reliable historical options data exists.

**No automated live execution is part of the current implementation.**