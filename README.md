# D-predict

D-predict is a local-first research and market-analysis cockpit for Indian equities and NIFTY/BANKNIFTY derivatives.

**Principle:** point-in-time data, reproducible research, explicit uncertainty, executable trade validation, and no automated live orders until research gates pass.

## Status

- Primary branch: `main`
- Active roadmap: Sprint 1 — Local Research Terminal & Data Foundation, followed by accuracy/trade-thesis and shadow-promotion gates.
- Execution: research/evaluation/simulation only; no broker orders.

## Sprint completion policy

A sprint is only considered **implemented** when its code path, tests and documentation exist. A sprint is only considered **validated** when its real historical artifacts have been executed and the resulting OOS report passes the applicable promotion gates. This prevents the repository from claiming model accuracy merely because the implementation exists.

### Sprint 1 — Local Research Terminal & Data Foundation

**Engineering scope: implemented.** The repository contains canonical instruments, market-data freshness, historical validation, point-in-time datasets, purge-aware walk-forward evaluation, prediction/realized-outcome scoring, risk/backtest, shadow simulation, MarketState, context primitives, signal quality, active-position primitives and the six-stock validation harness.

**Validation scope: data-dependent.** The six-stock OOS run, model comparison and final promotion decision still require the user's real local historical/prediction artifacts. CI validates the code and tests, not market performance.

### Sprint 2 — Accuracy & Trade Thesis

**Engineering scope: implemented primitives.** The repository now contains bounded model comparison, OOS return forecasts, leakage-free return distributions, distribution-derived targets/stops, independent target/stop calibration scoring and deterministic trade-thesis construction.

**Validation scope: data-dependent.** No candidate model, target probability or trade thesis is promoted until independent OOS results prove the improvement.

### Sprint 3 — Risk, Shadow & Promotion

**Engineering scope: implemented primitives.** Risk budgeting, drawdown throttling, correlation limits, position lifecycle, historical shadow and restart-safe live shadow are present.

**Promotion scope: intentionally gated.** Active-position integration, sustained-shadow evidence, deterministic forecast provenance and an approved live prediction runner remain promotion gates. Automated broker execution remains out of scope until those gates pass.

## Completed

- [x] Canonical instruments, market freshness and historical OHLCV validation.
- [x] Point-in-time datasets, purge-aware splits and deterministic manifests.
- [x] Baseline model + expanding walk-forward validation.
- [x] Walk-forward OOS ledger now includes an independent `predicted_return` forecast and return MAE/RMSE/bias.
- [x] Leakage-free prior-OOS residual distribution primitive with explicit `UNCALIBRATED`/`CALIBRATED` status.
- [x] Deterministic distribution-derived target/stop and trade-thesis primitive; not yet promoted as calibrated until independent OOS hit-rate tests pass.
- [x] Independent target/stop calibration scoring primitive; it scores fixed probabilities without tuning them from the same outcomes.
- [x] Leakage/adversarial tests proving the current outcome cannot calibrate its own distribution.
- [x] Prediction/realized-outcome scoring and stability promotion gates.
- [x] Causal risk-weighted backtest, drawdown and correlation limits.
- [x] Historical and restart-safe live shadow simulation.
- [x] Unified executable prediction/trade economic-event window.
- [x] Causal MarketState layer separate from BUY/SELL.
- [x] Causal benchmark/sector context primitives and tests.
- [x] Active position lifecycle ledger and exposure-release tests.
- [x] Deterministic signal-quality / `NO_TRADE` primitive and tests.
- [x] Cross-stock point-in-time validation harness and confidence/regime report generation.
- [x] Hardened CI tests for the portfolio confidence boundary and floating-point position P&L assertions.
- [x] Lightweight purge-aware OOS model comparison diagnostic.

## Accuracy-first model comparison

`training/model_compare.py` benchmarks four lightweight classical candidates using the same expanding-window, purge-aware OOS folds as the baseline:

- `hist_gradient_boosting` — current production baseline.
- `extra_trees` — randomized tree ensemble.
- `random_forest` — conservative bagged tree ensemble.
- `logistic_ridge` — linear classification/regression baseline with scaling.

The comparison reports classification accuracy, balanced accuracy and log loss plus return MAE/RMSE for every fold. Tree ensembles are deliberately bounded to keep the research path comfortable on a simple CPU laptop.

Example:

```powershell
.\collector\.venv\Scripts\python.exe -m training.model_compare --symbols RELIANCE ONGC LT ADANIPORTS SBI HDFCBANK --horizons 1d 3d 5d --folds 5
```

The output is written to `data/reports/*_model_comparison.json`.

**Important:** this is an OOS diagnostic, not an automatic model selector. Choosing the best candidate after looking at the same OOS results would contaminate the evaluation. Candidate promotion requires an untouched temporal holdout and comparison of the complete trade thesis, not just classifier accuracy.

## Independent target/stop calibration

`training/target_calibration.py` scores target and stop probabilities against an already-realized executable-event ledger. It reports hit rate, mean predicted probability, Brier score and calibration gap for T1/T2/T3 and the stop.

The evaluator requires `entry_time > prediction_time` and never retunes target probabilities from the evaluated outcomes. Therefore a result such as `T1 predicted 65%, realized 42%` is reported as a calibration failure rather than silently changing the probability to 42%.

Example:

```powershell
.\collector\.venv\Scripts\python.exe -m training.target_calibration data\reports\target_events.csv --output data\reports\target_calibration.json
```

## Next promotion gates

- [ ] Establish the current OOS baseline across the six-stock harness before selecting any new model.
- [ ] Compare lightweight classical candidates on identical walk-forward folds and horizons using real local artifacts.
- [ ] Select a candidate only through an independent temporal holdout protocol.
- [ ] Integrate distribution/thesis into the OOS prediction pipeline without using future outcomes.
- [ ] Validate target/stop probabilities independently OOS.
- [ ] Measure return-distribution coverage, interval width and conditional calibration by horizon/regime/confidence.
- [ ] Wire active-position ledger into backtest/shadow engines.
- [ ] Replace cumulative exposure with active-position exposure.
- [ ] Deterministic forecast seed/version provenance.
- [ ] Run the six-stock harness on the user's local historical/prediction artifacts and review failures.
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

The cross-stock harness currently labels the sector field as a **peer proxy** when a native sector-index history is unavailable. It never silently presents a peer stock as a true sector index.

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

The previous `T → T+horizon` versus `T+1 → T+1+horizon` mismatch has been corrected in shadow. The adversarial case where `T → T+1` rises but `T+1 → T+2` falls is covered by the shadow test suite and the cross-stock harness.

## Cross-stock validation

`training/cross_stock_validation.py` evaluates existing OOS prediction ledgers for:

```text
SBI
HDFCBANK
RELIANCE
ONGC
LT
ADANIPORTS
```

The harness does **not** retrain or tune the model. For every prediction timestamp it records causal MarketState, benchmark/peer-sector context, forecast confidence, executable entry/exit prices, friction-adjusted trade return, directional correctness, executable trade accuracy, MAE and MFE. It also produces confidence-bucket and regime/volatility performance summaries.

Run after the relevant local historical and walk-forward prediction artifacts exist:

```powershell
.\collector\.venv\Scripts\python.exe -m training.cross_stock_validation --horizon 1d
```

Outputs are written under `data/reports/`. The report explicitly records missing symbols/artifacts instead of inventing results.

## Return distribution and trade thesis

`training/return_distribution.py` is the first implementation of the trade-thesis layer. It consumes OOS predictions containing `predicted_return` and builds an expanding residual distribution from:

```text
actual_return - predicted_return
```

Only residuals from strictly earlier predictions for the same symbol and horizon are eligible. The current row's outcome is appended **after** its distribution is constructed, preventing same-row leakage. Before the minimum history is reached, the row is explicitly `UNCALIBRATED` and cannot produce an executable thesis.

Targets are derived from distribution quantiles corresponding to configurable hit probabilities, rather than fixed `+5%`/`-5%` rules. The stop is likewise derived from an adverse-tail probability. The initial v1 target probabilities are `65%`, `45%`, and `25%`; these are design parameters, not claimed calibration results. They must be independently validated out of sample before being treated as trustworthy probabilities.

The thesis primitive produces:

```text
Direction
Signal
Decision
Entry
Expected return
Target 1 / Target 2 / Target 3 + probabilities
Stop + probability
Risk/reward to Target 1
Horizon
Model probability / confidence
Distribution status
Thesis version
```

`EXECUTABLE` is only possible when the distribution is calibrated, the prediction is directional, the distribution provides at least one favorable target and a valid adverse stop. Otherwise the result is explicit `NO_TRADE`.

This module is currently a research primitive. It is **not yet integrated into the production prediction UI, backtest or shadow engine**, and its probabilities are not yet promotion-approved.

## Research chain

```text
MARKET DATA
 → QUALITY / FRESHNESS
 → POINT-IN-TIME DATASET
 → TECHNICAL FEATURES + MARKET STATE
 → BENCHMARK / SECTOR CONTEXT
 → MODEL
 → PREDICTION
 → RETURN FORECAST
 → RETURN DISTRIBUTION
 → SIGNAL QUALITY / NO TRADE
 → TRADE THESIS
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
- `training/cross_stock_validation.py` — six-stock point-in-time executable validation/report.
- `training/train_baseline.py` — classical classifier/regressor.
- `training/walk_forward.py` — expanding-window OOS direction and return forecasts.
- `training/model_compare.py` — bounded classical model comparison on identical purge-aware OOS folds.
- `training/return_distribution.py` — leakage-free OOS residual distribution and thesis construction.
- `training/target_calibration.py` — independent target/stop probability scoring.
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

The GitHub implementation has **not** been executed in the user's Windows environment in this session. The repository has CI coverage for backend tests, dashboard tests/typecheck/build, collector compilation, and the full Python training test suite. CI is the authoritative remote execution check when a new `main` commit runs successfully.

Local verification remains:

```powershell
.\collector\.venv\Scripts\python.exe -m pytest training/tests
```

Then run the model comparison after the required local datasets exist:

```powershell
.\collector\.venv\Scripts\python.exe -m training.model_compare --symbols RELIANCE ONGC LT ADANIPORTS SBI HDFCBANK --horizons 1d 3d 5d --folds 5
```

Do not treat generated reports as evidence of model improvement until the artifacts are present, the tests pass, and the report is reviewed for missing-data failures and point-in-time integrity.

## Future improvement checklist

### Research

- [x] Causal MarketState layer.
- [x] Causal benchmark/sector context primitives.
- [x] Signal-quality / `NO_TRADE` primitive.
- [x] Active position lifecycle primitive.
- [x] Cross-stock validation harness.
- [x] OOS predicted-return ledger foundation.
- [x] Leakage-free return-distribution primitive.
- [x] Leakage/adversarial distribution tests.
- [x] Lightweight purge-aware model comparison diagnostic.
- [x] Independent target/stop calibration scoring primitive.
- [ ] Versioned feature registry.
- [ ] Versioned label registry.
- [ ] Context/state/quality integration into OOS datasets.
- [ ] Native sector-index histories rather than peer proxies.
- [ ] Formal point-in-time Regime Model.
- [ ] Independent target/stop probability validation on real untouched OOS events.
- [ ] Distribution coverage and interval-width validation.
- [ ] Complete production Trade Thesis integration.
- [ ] Executable-outcome confidence calibration.
- [ ] Independent model-selection/promotion protocol.
- [ ] Human-readable + machine-readable research report review against baseline.

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
- [x] CI for Python tests and dashboard build.

### Later, not now

- [ ] RL / FinRL after supervised/event models prove useful OOS.
- [ ] Deep learning only after classical baselines are beaten OOS.
- [ ] LLM-assisted research with evidence citations.
- [ ] Advanced options research after reliable historical options data exists.

**No automated live execution is part of the current implementation.**
