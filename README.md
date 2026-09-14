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

**Engineering scope: implemented.** The repository contains bounded classical model comparison, OOS return forecasts, leakage-free return distributions, distribution-derived targets/stops, empirical target timing, independent target/stop calibration scoring and deterministic trade-thesis construction.

**Validation scope: data-dependent.** No candidate is promoted from implementation tests alone. Model selection, target/stop probabilities and time-to-target probabilities require untouched temporal validation and independent OOS calibration evidence.

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

## End-to-end real-artifact accuracy comparison

`training/run_accuracy_pipeline.py` accepts explicit OOS prediction ledgers and compares the canonical raw probability score with leakage-safe calibrated probabilities. It does **not** generate synthetic data, retune thresholds or promote a model.

Example:

```powershell
.\collector\.venv\Scripts\python.exe -m training.run_accuracy_pipeline `
  --ledger data\predictions\RELIANCE_1d_walk_forward.csv `
  --ledger data\predictions\HDFCBANK_1d_walk_forward.csv `
  --ledger data\predictions\ICICIBANK_1d_walk_forward.csv `
  --ledger data\predictions\INFY_1d_walk_forward.csv `
  --ledger data\predictions\TCS_1d_walk_forward.csv `
  --ledger data\predictions\SBIN_1d_walk_forward.csv `
  --min-calibration-history 100 `
  --output data\reports\accuracy_comparison.json
```

The actual universe can be any sufficiently liquid equities, indices or options for which D-Predict has reliable historical artifacts. Options should be evaluated separately by contract/expiry/horizon and must not be mixed into an equity model merely because their labels look similar.

The comparison is:

```text
RAW PROBABILITY
      ↓
CALIBRATED PROBABILITY
      ↓
RETURN FORECAST
      ↓
TARGET / STOP DISTRIBUTION
      ↓
TIME-TO-TARGET
      ↓
EXECUTABLE ENTRY/EXIT
      ↓
FRICTION-ADJUSTED P&L
```

No conclusion about calibration improvement is valid until this runner has been executed on real OOS artifacts.

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

The trade thesis treats **target price** and **time-to-target** as two separate predictions. `training/return_distribution.py` determines the target price and its hit probability from the OOS return distribution. `training/target_timing.py` estimates the time required to reach that exact target using an empirical first-passage-time distribution from historical bars.

The timing engine reports median ETA (`p50`), probable ETA range (`p25`–`p75`), seconds, minutes, hours, days, historical target-hit sample count and data resolution.

`training/trade_thesis_timing.py` attaches this information to every T1/T2/T3 target without changing the target price itself.

If the source data is daily, D-Predict cannot honestly claim minute/second precision. Minute/second ETA requires minute/second historical bars and sufficient first-passage observations. Insufficient evidence is explicitly reported rather than filled with a guess.

## Live causal trade-thesis integration

The previous dashboard-only implementation has now been connected to the actual local API path.

`backend/src/tradeThesis.ts` builds a thesis from the latest point-in-time `prediction_ledger` forecast, strictly prior realized-vs-forecast residuals, an expanding residual distribution, distribution-derived target/stop levels and historical 1-minute first-passage events.

`GET /api/signals/latest?symbol=...` now enriches the latest stored signal with `tradeThesis` automatically. The result is cached briefly so the dashboard's frequent refresh does not repeatedly perform the full timing scan.

The API refuses to invent a thesis: fewer than 60 prior realized residuals returns `NO_TRADE / RETURN_DISTRIBUTION_UNCALIBRATED`. Fewer than 20 historical first-passage events with 1-minute bars returns `INSUFFICIENT_HISTORY` for ETA.

The terminal displays entry, expected move, probability, horizon, T1/T2/T3, target probabilities, ETA, ETA range, stop and risk/reward.

## Return distribution and trade thesis

D-Predict does not use arbitrary fixed-percentage targets. `training/return_distribution.py` constructs an expanding residual distribution from strictly prior OOS return forecasts:

`realized_return - predicted_return`

The current row is added only after its own distribution is constructed, preventing same-row leakage. Production requires the default minimum history of 60 observations before a distribution becomes calibrated.

Targets and stops are derived from the calibrated return distribution and remain `NO_TRADE` when there is insufficient economic edge. The target probabilities are hypotheses until independently validated.

## Independent target/stop calibration

`training/target_calibration.py` scores predicted target and stop probabilities without retuning them from the same outcomes. It reports examples, mean predicted probability, realized hit rate, Brier score and calibration gap for T1/T2/T3 and stop events.

A calibration report never promotes or changes probabilities automatically. If a 65% target only hits 42% out of sample, the system records that failure rather than tuning the number until it looks correct.

## IPO analysis

D-Predict now includes a **Primary Market / IPO analyzer** in the dashboard.

The API endpoint is:

`POST /api/ipo/analyze`

It accepts verified IPO/DRHP/prospectus inputs and calculates:

- P/E
- enterprise value
- EV/EBITDA
- EBITDA margin
- profit margin
- fresh-issue ratio
- valuation score
- business-quality score
- issue-structure score
- composite score
- `ATTRACTIVE`, `WATCH` or `CAUTION` verdict
- quantitative risk flags

The migration `db/migrations/005_ipo_analysis.sql` persists the supplied inputs and generated analysis for reproducibility.

The IPO analyzer does **not** fabricate missing information. It is a screening model, not an automatic investment recommendation. Grey-market premium, subscription demand, anchor allocation, peer valuation, promoter quality, litigation and prospectus-specific qualitative risks must be supplied from verified sources before they can influence the analysis.

## Multi-instrument and trade-event backtest integrity

The backtest prediction ledger treats `(timestamp, symbol, horizon)` as the prediction identity when symbol metadata is present. This permits simultaneous predictions for different instruments while still rejecting duplicate predictions for the same instrument and horizon.

When a prediction carries a calibrated return distribution, the backtest derives T1 and stop prices from that distribution and resolves the **same entry-to-exit economic event** for target/stop outcome and P&L. It records target-hit, stop-hit, MAE and MFE. If both stop and target are printed in the same OHLC bar, the conservative rule is stop-first because intrabar ordering is unknown.

If an older prediction ledger has no calibrated distribution, the legacy requested-horizon close exit remains available for compatibility. It must not be interpreted as distribution-aware validation.

## Risk and shadow gates

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

## Future improvement checklist

### Accuracy
- [x] Untouched temporal holdout evaluator
- [x] Leakage-safe OOS probability calibration primitive
- [x] Real-artifact raw-vs-calibrated comparison runner
- [ ] Execute comparison on real historical artifacts
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
- [x] Live API trade-thesis integration
- [x] Dashboard target/ETA presentation
- [x] MAE/MFE and first-hit target/stop event recording
- [ ] Persist deterministic forecast/model/dataset provenance end-to-end
- [ ] Validate target probabilities on independent future periods
- [ ] Validate time-to-target probabilities on independent future periods
- [ ] Validate risk/reward after realistic friction

### IPO
- [x] IPO valuation/business/structure screening API
- [x] IPO dashboard
- [x] IPO analysis persistence schema
- [ ] Add verified prospectus document ingestion
- [ ] Add sourced peer-comparison engine
- [ ] Add subscription/anchor/allocation evidence
- [ ] Add independently sourced qualitative risk scoring

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
