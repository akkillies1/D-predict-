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

## Untouched temporal holdout

`training/temporal_holdout.py` provides the final model-selection boundary. Development OOS data is evaluated separately from a later temporal holdout. The holdout must begin strictly after the latest scored development observation, must contain enough scored examples, and is evaluated without retraining or threshold retuning.

Example:

```powershell
.\collector\.venv\Scripts\python.exe -m training.temporal_holdout data\predictions\development_realized.csv data\predictions\holdout_realized.csv --min-examples 100 --output data\reports\temporal_holdout.json
```

The holdout reports accuracy, balanced accuracy, majority-baseline lift, log loss and directional accuracy. `HOLDOUT_ONLY` means the artifact was evaluated under the holdout contract; it is not a claim that the model is profitable or ready for live trading.

## OOS probability calibration

`training/probability_calibration.py` calibrates class probabilities using **only observations strictly prior to each prediction**. The current row can never contribute to its own calibration model. Isotonic calibration is applied separately to DOWN, FLAT and UP probabilities and the calibrated vector is renormalized to sum to one.

Rows without sufficient prior history remain explicitly `UNCALIBRATED`. The calibration report is evaluation-only: it reports log loss, multiclass Brier score, mean confidence, empirical accuracy and calibration gap. It does not retune thresholds from the same outcomes or claim that calibrated probabilities are accurate until independent future validation confirms them.

Example:

```powershell
.\collector\.venv\Scripts\python.exe -m training.probability_calibration data\predictions\realized.csv --min-history 100 --output data\reports\probability_calibration.json
```

## Target price + time-to-target

The trade thesis now treats **target price** and **time-to-target** as two separate predictions. `training/return_distribution.py` determines the target price and its hit probability from the OOS return distribution. `training/target_timing.py` estimates the time required to reach that exact target using an empirical first-passage-time distribution from historical bars.

The timing engine reports:

- median ETA (`p50`)
- probable ETA range (`p25`–`p75`)
- seconds
- minutes
- hours
- days
- number of historical target-hit events used
- data resolution used for the estimate

`training/trade_thesis_timing.py` attaches this information to every T1/T2/T3 target without changing the target price itself.

Example presentation:

```text
TARGET 1: ₹1,238
Probability: 68%
Expected time: 2h 35m
Likely range: 1h 20m – 4h 10m

TARGET 2: ₹1,215
Probability: 47%
Expected time: 1d 2h
Likely range: 8h – 2d 6h
```

This is deliberately **not** fake precision. If the source data is daily, D-Predict cannot honestly claim that a target will be reached in 17 minutes 42 seconds. Minute/second-level ETA requires minute/second-level historical bars and sufficient first-passage observations. If there is insufficient history, the result is explicitly `INSUFFICIENT_HISTORY`.

The economic meaning is first-passage time: starting from an equivalent historical entry, how long did it actually take for price to reach the same favorable return threshold? It is an ETA distribution, not a guaranteed arrival timestamp.

## Return distribution and trade thesis

D-Predict does not use arbitrary fixed-percentage targets. `training/return_distribution.py` constructs an expanding residual distribution from strictly prior OOS return forecasts:

`realized_return - predicted_return`

The current row is added only after its own distribution is constructed, preventing same-row leakage. Production requires the default minimum history of 60 observations before a distribution becomes calibrated.

Targets and stops are derived from the calibrated return distribution and remain `NO_TRADE` when there is insufficient economic edge. The target probabilities are hypotheses until independently validated.

## Independent target/stop calibration

`training/target_calibration.py` scores predicted target and stop probabilities without retuning them from the same outcomes. It reports examples, mean predicted probability, realized hit rate, Brier score and calibration gap for T1/T2/T3 and stop events.

A calibration report never promotes or changes probabilities automatically. If a 65% target only hits 42% out of sample, the system records that failure rather than tuning the number until it looks correct.

## Multi-instrument and trade-event backtest integrity

The backtest prediction ledger treats `(timestamp, symbol, horizon)` as the prediction identity when symbol metadata is present. This permits simultaneous predictions for different instruments while still rejecting duplicate predictions for the same instrument and horizon.

When a prediction carries a calibrated return distribution, the backtest now derives T1 and stop prices from that distribution and resolves the **same entry-to-exit economic event** for target/stop outcome and P&L. It records target-hit, stop-hit, MAE and MFE. If both stop and target are printed in the same OHLC bar, the conservative rule is stop-first because intrabar ordering is unknown.

If an older prediction ledger has no calibrated distribution, the legacy requested-horizon close exit remains available for compatibility. It must not be interpreted as distribution-aware validation.

The backtest remains causal: prediction at T enters at the next available close, applies transaction costs/slippage and uses point-in-time risk information. It is an evaluation engine, not a broker executor.

## Risk and shadow gates

The current research chain includes:

```text
POINT-IN-TIME FEATURES
        ↓
DIRECTION + RETURN FORECAST
        ↓
OOS PROBABILITY CALIBRATION
        ↓
CALIBRATED PRICE DISTRIBUTION
        ↓
TARGET PRICE + TIME-TO-TARGET
        ↓
STOP / HORIZON
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

The economic event must remain consistent across forecast scoring, target/stop scoring, time-to-target scoring, executable trade accuracy, P&L, MAE and MFE.

## Future improvement checklist

### Accuracy
- [x] Untouched temporal holdout evaluator
- [x] Leakage-safe OOS probability calibration primitive
- [ ] Validate calibrated probabilities on an untouched future period
- [ ] Use an untouched temporal holdout for final model selection on real historical artifacts
- [ ] Compare candidates using trade-level and return-level metrics, not accuracy alone
- [ ] Conditional residual distributions by causal regime/volatility state
- [ ] Relative-strength and sector-context integration into model training
- [ ] Evaluate `NO_TRADE` as a first-class outcome

### Trade thesis
- [x] Distribution-derived targets/stops integrated into executable backtest
- [x] Empirical first-passage time-to-target estimator
- [x] T1/T2/T3 ETA integration
- [x] MAE/MFE and first-hit target/stop event recording
- [ ] Persist deterministic forecast/model/dataset provenance
- [ ] Validate target probabilities on independent future periods
- [ ] Validate time-to-target probabilities on independent future periods
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
