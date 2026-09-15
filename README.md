# D-predict

D-predict is a local-first research and market-analysis cockpit for Indian equities and NIFTY/BANKNIFTY derivatives.

**Principle:** point-in-time data, reproducible research, explicit uncertainty, executable trade validation, and no automated live orders until research gates pass.

## Windows installer — recommended

Normal Windows users do **not** need to run PowerShell commands.

1. Download the **D-Predict Windows Installer** from the latest GitHub Release.
2. Double-click the versioned `D-Predict-Setup-vX.Y.Z.exe`.
3. Choose where to install D-Predict.
4. Click **Install**. The installer provisions the Windows prerequisites and local D-Predict environment, with a visible bootstrap log if anything fails.
5. After provisioning succeeds, D-Predict launches automatically and opens the local dashboard in your browser.
6. If provisioning cannot complete, the installer leaves the software files in place and records the exact bootstrap failure in `%LOCALAPPDATA%\D-Predict\logs\bootstrap.log`. Use **D-Predict Repair & Check** after correcting the prerequisite issue.

The installer pins its source download to the release being installed rather than silently cloning whatever happens to be on `main` later. Software provisioning is also separate from historical research-data validation.

### Set Up Market Data

The installer keeps software installation separate from historical research data. During setup you can choose **Set up market data for research (recommended)** if you want the initial historical-data bootstrap to run immediately, or leave it unchecked and do it later.

You can also use **D-Predict Repair & Check** from the Start Menu to diagnose the installation.

For a later research bootstrap, open a PowerShell window in the installation directory and run:

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

```powershell
.\run.ps1 doctor
.\run.ps1 start
.\run.ps1 status
.\run.ps1 stop
.\run.ps1 test
```
