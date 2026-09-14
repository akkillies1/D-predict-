# D-predict

D-predict is a local-first research and market-analysis cockpit for Indian equities and NIFTY/BANKNIFTY derivatives.

**Principle:** point-in-time data, reproducible research, explicit uncertainty, executable trade validation, and no automated live orders until research gates pass.

## Status

- Primary branch: `main`
- Sprint: Sprint 1 — Local Research Terminal & Data Foundation
- Execution: research/evaluation/simulation only; no broker orders.

### Completed

- [x] Canonical instruments, market freshness and historical OHLCV validation.
- [x] Point-in-time datasets, purge-aware splits and deterministic manifests.
- [x] Baseline model + expanding walk-forward validation.
- [x] Prediction/realized-outcome scoring and stability promotion gates.
- [x] Causal risk-weighted backtest, drawdown and correlation limits.
- [x] Historical and restart-safe live shadow simulation.
- [x] Unified executable prediction/trade economic-event window.
- [x] Causal MarketState layer separate from BUY/SELL.
- [x] Causal benchmark/sector context primitives and tests.
- [x] Active position lifecycle ledger and exposure-release tests.
- [x] Deterministic signal-quality / `NO_TRADE` primitive and tests.

### Next gates

- [ ] Integrate context/state/quality into versioned OOS datasets.
- [ ] Wire active-position ledger into backtest/shadow engines.
- [ ] Replace cumulative exposure with active-position exposure.
- [ ] Deterministic forecast seed/version provenance.
- [ ] Cross-stock validation harness and report.
- [ ] Approved-model live prediction runner.
- [ ] Human-vs-model game mode.
- [ ] Sustained-shadow promotion gate.
- [ ] Automated execution only after all gates pass.

## MarketState

`training/market_state.py` provides descriptive causal states: `TREND_UP`, `TREND_DOWN`, `RANGE`, `RECOVERY`, `BREAKDOWN`, `HIGH_VOLATILITY`, `LOW_VOLATILITY`, `OVERSOLD_TREND`, `OVERBOUGHT_TREND`, `REVERSAL_ATTEMPT`, `INSUFFICIENT_DATA`.

MarketState is **not** a trade signal. Oversold/overbought are structural modifiers, not automatic reversal instructions.

## Point-in-time context

`training/context_features.py` computes benchmark and sector context using only observations at or before timestamp `T`: benchmark return 1/5/20, sector return 1/5/20, stock-vs-benchmark relative strength 1/5/20, 60-row stock return context and stock-vs-sector relative strength.

These primitives are **not yet wired into production training**. They must first pass cross-stock leakage and OOS validation. No news, analyst opinions or observed September-2026 outcomes are used.

## Signal quality / NO_TRADE

`training/signal_quality.py` separates model probability from signal quality. It considers forecast confidence, regime confidence, trend strength, optional relative strength/sector alignment and market-data freshness. Stale/offline data, FLAT predictions and low confidence become explicit `NO_TRADE` decisions.

This is intentionally deterministic and is not tuned against future returns.

## Active position lifecycle

`training/position_ledger.py` models portfolio state explicitly:

```text
OPEN → CLOSED
```

Each position records symbol, direction, entry/exit timestamps and prices, planned exit, weight, allocated capital, status and realized P&L. By default a symbol cannot have overlapping active positions. Closing a position releases exposure and allocated capital. This is a simulation ledger, not a broker interface.

## Economic-event invariant

Prediction correctness and trade P&L must describe the same executable event:

```text
Prediction at T
    ↓
Entry at next available bar
    ↓
Hold requested horizon
    ↓
Exit
    ↓
ONE realized event
    ├─ directional correctness
    ├─ executable trade accuracy
    ├─ return / P&L
    ├─ MAE / MFE
    └─ game score
```

The previous `T → T+horizon` versus `T+1 → T+1+horizon` mismatch has been corrected in shadow. The adversarial case where `T → T+1` rises but `T+1 → T+2` falls is covered by the shadow test suite.

## Research chain

```text
MARKET DATA
 → QUALITY / FRESHNESS
 → POINT-IN-TIME DATASET
 → TECHNICAL FEATURES + MARKET STATE
 → BENCHMARK / SECTOR CONTEXT
 → MODEL
 → PREDICTION
 → SIGNAL QUALITY / NO TRADE
 → EXECUTABLE TRADE EVENT
 → ACTIVE POSITIONS
 → RISK / EXPOSURE
 → BACKTEST
 → SHADOW
 → CALIBRATION / REGIME EVALUATION
 → PROMOTION GATE
```

## Main training modules

- `training/build_dataset.py` — existing 1d/3d/5d technical features/labels.
- `training/market_state.py` — causal market-state classification.
- `training/context_features.py` — causal benchmark/sector context.
- `training/signal_quality.py` — deterministic quality / no-trade decisions.
- `training/position_ledger.py` — active position lifecycle and exposure release.
- `training/train_baseline.py` — classical classifier/regressor.
- `training/walk_forward.py` — expanding-window OOS predictions.
- `training/score_prediction_ledger.py` — probability/accuracy metrics.
- `training/score_realized_outcomes.py` — independent realized outcomes.
- `training/analyze_prediction_stability.py` — calibration/fold/regime analysis.
- `training/accuracy_gate.py` / `training/stability_gate.py` — promotion gates.
- `training/risk.py` / `training/exposure.py` — causal risk/exposure.
- `training/backtest.py` — executable causal backtest.
- `training/shadow.py` / `training/live_shadow.py` — paper/live-shadow lifecycle.
- `training/live_shadow_feed.py` — local market connector.
- `training/shadow_metrics.py` — rolling shadow evaluation.

## Verification

The GitHub implementation has **not** been executed in the user's Windows environment in this session. Run:

```powershell
.\collector\.venv\Scripts\python.exe -m pytest training/tests
```

The new layers are not considered production-validated until the full suite and the cross-stock OOS harness pass.

## Future improvement checklist

### Research

- [x] Causal MarketState layer.
- [x] Causal benchmark/sector context primitives.
- [x] Signal-quality / `NO_TRADE` primitive.
- [x] Active position lifecycle primitive.
- [ ] Versioned feature registry.
- [ ] Versioned label registry.
- [ ] Context/state/quality integration into OOS datasets.
- [ ] Formal point-in-time Regime Model.
- [ ] Executable-outcome confidence calibration.
- [ ] Cross-stock harness: SBI, HDFC BANK, RELIANCE, ONGC, LT, ADANIPORTS.
- [ ] Human + machine research report.

### Shadow / risk / runtime

- [x] Historical shadow replay.
- [x] Restart-safe live shadow.
- [x] Live market connector.
- [x] Rolling accuracy/calibration.
- [x] Unified prediction/trade window.
- [x] Active-position ledger primitive.
- [ ] Integrate active positions into backtest/shadow.
- [ ] Active exposure accounting.
- [ ] Deterministic forecast provenance.
- [ ] Approved live prediction runner.
- [ ] Human-vs-model game.
- [ ] Sustained-shadow promotion gate.
- [ ] CI for Python tests and dashboard build.

### Later, not now

- [ ] RL / FinRL after supervised/event models prove useful OOS.
- [ ] Deep learning only after classical baselines are beaten OOS.
- [ ] LLM-assisted research with evidence citations.
- [ ] Advanced options research after reliable historical options data exists.

**No automated live execution is part of the current implementation.**
