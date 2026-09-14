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

### Sprint 2 — Accuracy & Trade Thesis

**Engineering scope: implemented.** The repository contains bounded classical model comparison, OOS return forecasts, leakage-free return distributions, distribution-derived targets/stops, independent target/stop calibration scoring and deterministic trade-thesis construction.

**Validation scope: data-dependent.** No candidate is promoted from implementation tests alone. Model selection and target/stop probabilities require untouched temporal validation and independent OOS calibration evidence.

### Sprint 3 — Risk, Shadow & Promotion

**Engineering scope: implemented.** The repository contains risk budgeting, drawdown throttling, cross-instrument correlation limits, position lifecycle primitives, historical shadow simulation and restart-safe live shadow state.

**Promotion scope: pending sustained evidence.** Active-position integration, deterministic forecast provenance, sustained shadow performance and an approved live prediction runner remain required before any live execution. Broker execution remains out of scope.

## Accuracy-first model comparison

`training/model_compare.py` benchmarks lightweight classical candidates on identical purge-aware expanding OOS folds:

- HistGradientBoosting
- ExtraTrees
- RandomForest
- Logistic/Ridge

The comparison is diagnostic rather than an automatic promotion mechanism. The final model must be selected on development OOS evidence and then evaluated once on an untouched temporal holdout.

Example:

```powershell
.\collector\.venv\Scripts\python.exe -m training.model_compare --symbols RELIANCE ONGC LT ADANIPORTS SBI HDFCBANK --horizons 1d 3d 5d --folds 5
```

## Return distribution and trade thesis

D-Predict does not use arbitrary fixed-percentage targets. `training/return_distribution.py` constructs an expanding residual distribution from strictly prior OOS return forecasts:

`realized_return - predicted_return`

The current row is added only after its own distribution is constructed, preventing same-row leakage. Production requires the default minimum history of 60 observations before a distribution becomes calibrated.

Targets and stops are derived from the calibrated return distribution and remain `NO_TRADE` when there is insufficient economic edge. The target probabilities are hypotheses until independently validated.

## Independent target/stop calibration

`training/target_calibration.py` scores predicted target and stop probabilities without retuning them from the same outcomes. It reports examples, mean predicted probability, realized hit rate, Brier score and calibration gap for T1/T2/T3 and stop events.

A calibration report never promotes or changes probabilities automatically. If a 65% target only hits 42% out of sample, the system records that failure rather than tuning the number until it looks correct.

## Multi-instrument backtest integrity

The backtest prediction ledger now treats `(timestamp, symbol, horizon)` as the prediction identity when symbol metadata is present. This permits simultaneous predictions for different instruments while still rejecting duplicate predictions for the same instrument and horizon. This is required before the portfolio backtest can be trusted across multiple stocks.

The backtest remains causal: prediction at T enters at the next available close, holds for the requested trading-row horizon, applies transaction costs/slippage and uses point-in-time risk information. It is an evaluation engine, not a broker executor.

## Risk and shadow gates

The current research chain includes:

```text
POINT-IN-TIME FEATURES
        ↓
DIRECTION + RETURN FORECAST
        ↓
CALIBRATED DISTRIBUTION
        ↓
TARGET / STOP / HORIZON
        ↓
TRADE THESIS
        ↓
SIGNAL QUALITY / NO_TRADE
        ↓
POSITION + RISK
        ↓
BACKTEST / SHADOW
        ↓
INDEPENDENT VALIDATION
        ↓
PROMOTION GATE
```

The economic event must remain consistent across forecast scoring, target/stop scoring, executable trade accuracy, P&L, MAE and MFE.

## Future improvement checklist

### Accuracy
- [ ] Untouched temporal holdout for final model selection
- [ ] Compare candidates using trade-level and return-level metrics, not accuracy alone
- [ ] Calibrate class probabilities on strictly OOS data
- [ ] Conditional residual distributions by causal regime/volatility state
- [ ] Relative-strength and sector-context integration into model training
- [ ] Evaluate `NO_TRADE` as a first-class outcome

### Trade thesis
- [ ] Persist deterministic forecast/model/dataset provenance
- [ ] Integrate distribution-derived targets/stops into the executable backtest
- [ ] Validate target probabilities on independent future periods
- [ ] Add MAE/MFE and first-hit target/stop event ledger
- [ ] Validate risk/reward after realistic friction

### Promotion
- [ ] Sustained live-shadow evidence
- [ ] Active-position ledger integrated into all execution simulations
- [ ] Resource limits verified on a simple laptop
- [ ] Approved live prediction runner
- [ ] Broker execution only after all research gates pass

### Not now
- [ ] Reinforcement learning / FinRL
- [ ] Large deep-learning models
- [ ] LLM-generated trading recommendations
- [ ] Automated live broker execution
- [ ] Complex options strategy engine

## Verification

CI runs backend tests, dashboard tests/typecheck/build, collector compilation and the full Python training test suite. A green CI run proves engineering integrity; it does not by itself prove predictive accuracy or trading profitability.
