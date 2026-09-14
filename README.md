# D-predict

D-predict is a local-first research and market-analysis cockpit for Indian equities and NIFTY/BANKNIFTY derivatives.

**Principle:** point-in-time data, reproducible research, explicit uncertainty, executable trade validation, and no automated live orders until the research gates pass.

## Current engineering status

- Primary branch: `main`
- Active roadmap: Sprint 1 — Local Research Terminal & Data Foundation
- Execution boundary: research, evaluation and simulation only.
- No automated broker execution.

### Completed foundations

- [x] Canonical instrument metadata and discovery/activation.
- [x] Market-data freshness contract: `LIVE`, `CACHED`, `STALE`, `OFFLINE`.
- [x] No synthetic live OHLC values.
- [x] Historical OHLCV validation.
- [x] Point-in-time `DatasetSpec` / `PointInTimeDataset` with purge-aware segments.
- [x] Deterministic dataset manifests/fingerprints.
- [x] Baseline classifier/regressor and expanding-window walk-forward validation.
- [x] Prediction-ledger accuracy/probability scoring.
- [x] Independent realized-outcome scoring with `SCORED` / `PENDING` state.
- [x] Calibration/fold/regime stability analysis and promotion gates.
- [x] Causal risk-weighted backtest with friction, drawdown and correlation-aware limits.
- [x] Historical paper/shadow replay and confidence-weighted accuracy game.
- [x] Restart-safe live shadow session and real market connector.
- [x] Rolling shadow accuracy/calibration metrics.
- [x] Unified prediction-scoring and executable trade window.
- [x] Explicit causal MarketState layer separate from BUY/SELL prediction.
- [x] Point-in-time benchmark/sector context feature primitives.

### Still pending

- [ ] Integrate context features into versioned training datasets after cross-stock leakage tests.
- [ ] Signal-quality / explicit `NO_TRADE` decision layer.
- [ ] Active-position ledger with open/entry/exit/closed lifecycle.
- [ ] Active rather than cumulative exposure accounting.
- [ ] Deterministic forecast configuration/seed provenance.
- [ ] Cross-stock validation harness and human-readable research report.
- [ ] Approved-model live prediction runner.
- [ ] Interactive human-vs-model game mode.
- [ ] Sustained-shadow promotion gate.
- [ ] Automated live execution only after all gates pass.

## Market-state architecture

`training/market_state.py` provides descriptive, causal state recognition. It deliberately does **not** mean BUY or SELL.

Current states:

- `TREND_UP`, `TREND_DOWN`
- `RANGE`, `RECOVERY`, `BREAKDOWN`
- `HIGH_VOLATILITY`, `LOW_VOLATILITY`
- `OVERSOLD_TREND`, `OVERBOUGHT_TREND`
- `REVERSAL_ATTEMPT`
- `INSUFFICIENT_DATA`

Oversold/overbought are modifiers of observed structure, not reversal instructions. A stock can remain `OVERSOLD_TREND` while continuing down.

The intended separation is:

```text
MARKET STATE
  ├─ trend strength
  ├─ volatility regime
  └─ regime confidence
          ↓
MODEL PREDICTION
  ├─ direction
  └─ forecast confidence
          ↓
SIGNAL QUALITY / NO TRADE
          ↓
EXECUTABLE POSITION
```

## Point-in-time context

`training/context_features.py` provides causal benchmark and sector context primitives. At timestamp `T`, benchmark/sector returns are computed only from observations `<= T`.

It currently exposes:

- benchmark return 1/5/20 rows;
- sector return 1/5/20 rows;
- stock-vs-benchmark relative-strength differences;
- 60-row stock return context;
- stock-vs-sector 5-row relative strength;
- explicit benchmark and sector provenance.

These primitives are **not yet automatically appended to the production training feature set**. They must first pass point-in-time cross-stock validation. No external news, analyst opinions or September-2026 outcomes are used by this layer.

## Research architecture

```text
MARKET DATA
    ↓
DATA QUALITY / FRESHNESS
    ↓
POINT-IN-TIME DATASET
    ↓
TECHNICAL FEATURES + MARKET STATE
    ↓
BENCHMARK / SECTOR CONTEXT
    ↓
MODEL
    ↓
PREDICTION
    ↓
SIGNAL QUALITY / NO TRADE
    ↓
EXECUTABLE TRADE EVENT
    ↓
RISK / EXPOSURE
    ↓
BACKTEST
    ↓
PAPER / LIVE SHADOW
    ↓
CALIBRATION / REGIME EVALUATION
    ↓
PROMOTION GATE
```

## Economic-event invariant

Prediction accuracy and simulated trade P&L must measure the **same executable economic event**.

```text
Prediction at T
    ↓
Entry at next available bar
    ↓
Hold for requested horizon
    ↓
Exit
    ↓
ONE realized event
    ├─ directional correctness
    ├─ executable trade accuracy
    ├─ realized return / P&L
    ├─ MAE / MFE
    └─ game score
```

The previous failure mode was `T → T+horizon` scoring combined with `T+1 → T+1+horizon` P&L. The shadow implementations now use the executable entry/exit window for realized classification and P&L, with adversarial coverage for the case where `T → T+1` rises but `T+1 → T+2` falls.

## Risk and shadow boundary

The current risk stack includes point-in-time ATR/stop-distance sizing, confidence-edge sizing, gross/per-position limits, drawdown throttling and correlation-aware exposure controls. Missing risk data creates explicit no-trade states rather than invented values.

Default friction is 10 bps transaction cost + 5 bps slippage per side. These are engineering defaults, not claims of optimality.

The shadow engine sends zero broker orders and reports `live_orders_sent = 0`. Live market observations are persisted atomically; unresolved predictions remain pending until the executable future window exists.

## Main modules

- `training/download_historical.py` — raw daily history acquisition.
- `training/validate_history.py` — OHLCV validation.
- `training/dataset.py` — point-in-time dataset contract.
- `training/manifest.py` — deterministic provenance/fingerprints.
- `training/build_dataset.py` — existing 1d/3d/5d technical features and labels.
- `training/market_state.py` — causal market-state classification.
- `training/context_features.py` — causal benchmark/sector context primitives.
- `training/train_baseline.py` — classical market classifier/regressor.
- `training/walk_forward.py` — expanding-window OOS predictions.
- `training/score_prediction_ledger.py` — OOS probability/accuracy metrics.
- `training/score_realized_outcomes.py` — independent realized outcome scoring.
- `training/analyze_prediction_stability.py` — calibration/fold/regime analysis.
- `training/stability_gate.py` — stability promotion checks.
- `training/accuracy_gate.py` — raw-performance + stability promotion gate.
- `training/portfolio.py` — deterministic confidence-aware sizing.
- `training/risk.py` — point-in-time ATR/stop-distance risk budgeting.
- `training/backtest.py` — causal risk-weighted backtest.
- `training/exposure.py` — correlation-aware exposure attribution.
- `training/shadow.py` — historical paper/shadow replay.
- `training/live_shadow.py` — restart-safe live shadow lifecycle.
- `training/live_shadow_feed.py` — local market API connector.
- `training/shadow_metrics.py` — rolling shadow metrics/calibration.

## Verification

The GitHub changes in this session have **not** been executed in the user's Windows environment. Run:

```powershell
.\collector\.venv\Scripts\python.exe -m pytest training/tests
```

Do not treat the new market-state/context layer as validated until the suite passes locally and the cross-stock point-in-time harness has been run.

## Future improvement checklist

### Data

- [ ] Exchange calendars and session-aware timestamps.
- [ ] Corporate-action adjustment and provenance.
- [ ] Point-in-time news/disclosure ingestion.
- [ ] Source-level freshness monitoring.
- [ ] Native pgvector indexing when justified.

### Research

- [x] Explicit causal MarketState layer.
- [x] Causal benchmark/sector context primitives.
- [ ] Versioned feature registry.
- [ ] Versioned label registry.
- [ ] Context integration into OOS training datasets.
- [ ] Formal point-in-time Regime Model.
- [ ] Signal-quality / `NO_TRADE` layer.
- [ ] Confidence calibration by executable trade outcome.
- [ ] Cross-stock validation harness: SBI, HDFC BANK, RELIANCE, ONGC, LT, ADANIPORTS.
- [ ] Human-readable + machine-readable research report.

### Shadow / risk / runtime

- [x] Historical paper/shadow replay.
- [x] Restart-safe live shadow session.
- [x] Live market connector.
- [x] Rolling accuracy/calibration monitor.
- [x] Unified prediction/trade economic-event window.
- [ ] Active-position ledger.
- [ ] Active exposure accounting.
- [ ] Deterministic forecast seed/version provenance.
- [ ] Approved-model live prediction runner.
- [ ] Interactive human-vs-model game mode.
- [ ] Sustained shadow promotion gate.
- [ ] CI for Python tests and dashboard build.
- [ ] Runtime observability.

### Later, not now

- [ ] RL / FinRL after supervised/event models are demonstrably useful OOS.
- [ ] Complex deep learning only after classical baselines are beaten OOS.
- [ ] LLM-assisted research with evidence citations.
- [ ] Advanced options research after reliable historical options data exists.

**No automated live execution is part of the current implementation.**
