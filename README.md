# D-predict

D-predict is a local-first research and market-analysis cockpit for Indian equities and NIFTY/BANKNIFTY derivatives.

**Principle:** point-in-time data, reproducible research, explicit uncertainty, executable trade validation, and no automated live orders until research gates pass.

## Status

- Primary branch: `main`
- Active roadmap: Sprint 1 — Local Research Terminal & Data Foundation, followed by accuracy/trade-thesis and shadow-promotion gates.
- Execution: research/evaluation/simulation only; no broker orders.
- Historical-artifact state: **bootstrap required** on a fresh installation. The repository does not claim model accuracy until real historical data has been downloaded and evaluated.

## First-run real-data validation

A fresh installation can bootstrap the complete real-data research/validation chain with:

```powershell
.\collector\.venv\Scripts\python.exe -m training.run_full_validation `
  --symbols RELIANCE HDFCBANK ICICIBANK INFY TCS SBIN `
  --horizons 1d 3d 5d
```

The orchestrator downloads real daily history only when the selected local CSV is missing, validates the raw history, builds point-in-time datasets, runs purge-aware expanding walk-forward evaluation, independently scores the **executable economic window**, evaluates leakage-safe probability calibration and OOS stability, and runs the causal backtest. It never generates synthetic market data and never promotes a model.

The economic validation invariant is:

```text
prediction at T
    ↓
entry at next available historical bar
    ↓
hold requested trading-row horizon
    ↓
exit
    ↓
ONE realized outcome used for validation/backtest
```

This prevents a prediction from being counted as correct using a price move that the simulated trade could not have captured.

### Persistent local artifacts

The first run creates:

```text
data/
├── historical/                  # real downloaded/source OHLCV
├── training/                    # point-in-time datasets + manifests
├── predictions/                 # OOS prediction + realized ledgers
└── validation/
    ├── registry.json            # cheap persistent cache index
    ├── latest.json              # current bundle pointer
    ├── bundles/<bundle-id>/     # immutable validation report
    ├── *_probability_calibration.json
    ├── *_stability.json
    └── *_backtest.json          # versioned validation evidence
```

These generated market-data and validation artifacts are local research state; they are not source code and should not be committed to GitHub by default.

### Reuse instead of rerunning everything

Subsequent invocations calculate a deterministic fingerprint from the selected real historical files, dataset manifests, configuration, and validation contract. If the fingerprint and required artifacts are unchanged, the runner returns `REUSED` and does not repeat the expensive walk-forward/calibration/stability/backtest work.

Use `--force` to deliberately rebuild the validation bundle. Use `--refresh-data` when you intentionally want to redownload the selected historical source.

A live quote refresh does **not** invalidate the historical validation bundle. Validation should be rerun when historical inputs, dataset/feature definitions, model/validation contract, or strategy/risk configuration changes, or on a deliberate scheduled review.

## Sprint completion policy

A sprint is only considered **implemented** when its code path, tests and documentation exist. A sprint is only considered **validated** when its real historical artifacts have been executed and the resulting OOS report passes the applicable promotion gates. This prevents the repository from claiming model accuracy merely because the implementation exists.

### Sprint 1 — Local Research Terminal & Data Foundation

**Engineering scope: implemented.** The repository contains canonical instruments, market-data freshness, historical validation, point-in-time datasets, purge-aware walk-forward evaluation, prediction/realized-outcome scoring, risk/backtest, shadow simulation, MarketState, context primitives, signal quality, active-position primitives and the six-stock validation harness.

**Real-data validation: bootstrap pending.** `training/run_full_validation.py` is now the first-run entry point for creating the real OOS evidence required by later promotion gates.

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

## End-to-end real-artifact accuracy comparison

`training/run_accuracy_pipeline.py` accepts explicit OOS prediction ledgers and compares the canonical raw probability score with leakage-safe calibrated probabilities. It does **not** generate synthetic data, retune thresholds or promote a model.

No conclusion about calibration improvement is valid until this runner has been executed on real OOS artifacts.

## Untouched temporal holdout

`training/temporal_holdout.py` provides the final model-selection boundary. Development OOS data is evaluated separately from a later temporal holdout. The holdout must begin strictly after the latest scored development observation, must contain enough scored examples, and is evaluated without retraining or threshold retuning.

## OOS probability calibration

`training/probability_calibration.py` calibrates class probabilities using **only observations strictly prior to each prediction**. The current row can never contribute to its own calibration model. Rows without sufficient prior history remain explicitly `UNCALIBRATED`.

## Target price + time-to-target

The trade thesis treats **target price** and **time-to-target** as two separate predictions. `training/return_distribution.py` determines target price and hit probability from the OOS return distribution. `training/target_timing.py` estimates time to reach that target from historical bars.

Minute/second ETA requires minute/second historical bars and sufficient first-passage observations. Daily data cannot honestly provide minute/second precision.

## Live causal trade-thesis integration

`backend/src/tradeThesis.ts` builds a thesis from the latest point-in-time forecast, strictly prior realized-vs-forecast residuals, an expanding residual distribution, distribution-derived targets/stops and historical 1-minute first-passage events.

`GET /api/signals/latest?symbol=...` enriches the latest stored signal with `tradeThesis`. The timing-history query is explicitly cutoff at the signal timestamp, so future 1-minute bars cannot influence a historical thesis. This causal cutoff is required for trustworthy ETA estimation.

The API refuses to invent a thesis: fewer than 60 prior realized residuals returns `NO_TRADE / RETURN_DISTRIBUTION_UNCALIBRATED`. Fewer than 20 historical first-passage events returns `INSUFFICIENT_HISTORY` for ETA.

## Return distribution and trade thesis

D-Predict does not use arbitrary fixed-percentage targets. `training/return_distribution.py` constructs an expanding residual distribution from strictly prior OOS return forecasts:

`realized_return - predicted_return`

The current row is added only after its own distribution is constructed, preventing same-row leakage. Targets and stops are derived from the calibrated distribution and remain `NO_TRADE` when there is insufficient economic edge.

## Independent target/stop calibration

`training/target_calibration.py` scores predicted target and stop probabilities without retuning them from the same outcomes. It reports examples, mean predicted probability, realized hit rate, Brier score and calibration gap for T1/T2/T3 and stop events.

## IPO analysis

D-Predict includes a **Primary Market / IPO analyzer** in the dashboard.

`POST /api/ipo/analyze` accepts verified IPO/DRHP/prospectus inputs and calculates P/E, enterprise value, EV/EBITDA, EBITDA margin, profit margin, fresh-issue ratio, valuation score, business-quality score, issue-structure score, composite score, verdict and quantitative risk flags.

`db/migrations/005_ipo_analysis.sql` persists supplied inputs and generated analysis for reproducibility.

The analyzer does **not** fabricate missing information. Grey-market premium, subscription demand, anchor allocation, peer valuation and prospectus-specific qualitative risks must be supplied from verified sources before they can influence analysis.

## Multi-instrument and trade-event backtest integrity

The backtest prediction identity is `(timestamp, symbol, horizon)` when symbol metadata exists. This permits simultaneous predictions for different instruments while rejecting duplicate predictions for the same instrument and horizon.

When a calibrated return distribution exists, the same entry-to-exit economic event drives target/stop outcome and P&L, including MAE/MFE. If both stop and target are printed in the same OHLC bar, the conservative rule is stop-first because intrabar ordering is unknown.

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
- [x] First-run real historical-data bootstrap orchestrator
- [x] Executable economic-window realized outcome scoring
- [x] Persistent validation bundle fingerprint/reuse
- [x] OOS probability calibration and stability included in bootstrap bundle
- [x] Untouched temporal holdout evaluator
- [x] Leakage-safe OOS probability calibration primitive
- [x] Real-artifact raw-vs-calibrated comparison runner
- [ ] Execute first bootstrap on real historical artifacts locally
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
- [x] Causal cutoff for live first-passage timing
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
- [ ] Live broker execution
- [ ] Complex options strategy engine
