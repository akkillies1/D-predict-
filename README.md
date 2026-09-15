# D-predict

D-predict is a local-first research and market-analysis cockpit for Indian equities and NIFTY/BANKNIFTY derivatives.

**Principle:** point-in-time data, reproducible research, explicit uncertainty, executable trade validation, and no automated live orders until research gates pass.

## Windows installer — recommended

Normal Windows users do **not** need to run PowerShell commands.

1. Download the `D-Predict-Setup` artifact produced by the **Windows Installer** GitHub Actions workflow.
2. Double-click `D-Predict-Setup.exe`.
3. Choose the installation folder and shortcut options.
4. Click **Install**.
5. The installer installs/checks Git, Python 3.12, Node.js 22+, Docker Desktop, downloads the D-predict source, creates the Python environment, installs backend/dashboard dependencies, creates research-data directories, and runs local verification.
6. At the final page choose **Launch D-Predict**. The launcher starts PostgreSQL, API, research service, dashboard and collector, then opens `http://127.0.0.1:3000`.

The installer intentionally does **not** download historical market data. That is a separate first-run research operation because it can take substantial time and must remain distinguishable from software installation.

### First-run historical research bootstrap

After installation, open **D-Predict Setup / Doctor** or a PowerShell window in the installation directory and run:

```powershell
.\run.ps1 bootstrap
```

This downloads real historical data when required and runs the complete validation chain. Use `-Force` to rebuild validation artifacts or `-RefreshData` to intentionally redownload historical data:

```powershell
.\run.ps1 bootstrap -Force
.\run.ps1 bootstrap -RefreshData
```

The repository does not claim model accuracy until real historical data has been downloaded and evaluated.

## Developer / recovery commands

The canonical Windows wrapper is `run.ps1`:

```text
run.ps1 doctor
run.ps1 init
run.ps1 start
run.ps1 stop
run.ps1 restart
run.ps1 status
run.ps1 test
run.ps1 bootstrap
run.ps1 update
```

`dp.ps1` remains the lower-level service launcher. The double-click `launch-dpredict.ps1` entry point is what the installer shortcuts use.

## Windows one-command bootstrap (fallback)

For development machines where an installer is not desired:

```powershell
irm https://raw.githubusercontent.com/akkillies1/D-predict-/main/bootstrap-windows.ps1 | iex
```

The bootstrap installs/checks Git, Python 3.12, Node.js 22+ and Docker Desktop, prepares the local source/dependencies and runs compile/test/build checks. It does **not** download market history.

## Status

- Primary branch: `main`
- Active roadmap: Sprint 1 — Local Research Terminal & Data Foundation, followed by accuracy/trade-thesis and shadow-promotion gates.
- Execution: research/evaluation/simulation only; no broker orders.
- Historical-artifact state: **bootstrap required** on a fresh installation.

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
