# D-predict

D-predict is a local-first research and market-analysis cockpit for Indian equities and NIFTY/BANKNIFTY derivatives.

**Principle:** point-in-time data, reproducible research, explicit uncertainty, executable trade validation, and no automated live orders until research gates pass.

## Windows installer — recommended

Normal Windows users do **not** need to run PowerShell commands.

1. Download the **D-Predict Windows Installer** from the latest GitHub Release.
2. Double-click the versioned `D-Predict-Setup-vX.Y.Z.exe`.
3. Choose where to install D-Predict.
4. Click **Install**. The EXE only installs the application files; it does **not** silently elevate, install system software, clone GitHub, or run the prerequisite bootstrap.
5. After installation, use **D-Predict Setup & Repair** from the Start Menu to provision required Windows components and the local D-Predict environment. This is an explicit second step so the installer itself stays a thin application package.
6. After setup succeeds, use **D-Predict** to start the local dashboard. If setup fails, use **D-Predict Repair & Check** to inspect the environment and logs.

The Setup & Repair helper pins its source download to the exact release being installed rather than silently cloning whatever happens to be on `main` later. Software provisioning is separate from historical research-data validation.

### Set Up Market Data

Software installation and historical research data remain separate. Historical validation is an explicit research operation and is never presented as proof of model accuracy until real historical data has been downloaded and evaluated.

For a later research bootstrap, open a PowerShell window in the installation directory and run:

```powershell
.\run.ps1 bootstrap
```

Use `-Force` to rebuild validation artifacts or `-RefreshData` to intentionally redownload historical data:

```powershell
.\run.ps1 bootstrap -Force
.\run.ps1 bootstrap -RefreshData
```

## Developer / recovery commands

The canonical Windows wrapper is `run.ps1`:

```powershell
.\run.ps1 doctor
.\run.ps1 start
.\run.ps1 status
.\run.ps1 stop
.\run.ps1 test
```
