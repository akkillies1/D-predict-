# D-predict

D-predict is a local-first research and market-analysis cockpit for Indian equities and NIFTY/BANKNIFTY derivatives.

**Principle:** point-in-time data, reproducible research, explicit uncertainty, executable trade validation, and no automated live orders until research gates pass.

## Windows installer — recommended

Normal Windows users do **not** need to run PowerShell commands.

1. Download the **D-Predict Installer** artifact produced by the **Windows Installer** GitHub Actions workflow.
2. Double-click **D-Predict Installer.exe**.
3. Choose where to install D-Predict and select any optional setup you want.
4. Click **Install**.
5. The installer checks/prepares the required Windows environment, installs/checks Git, Python 3.12, Node.js 22+, and Docker Desktop, downloads the D-predict source, creates the Python environment, installs backend/dashboard dependencies, creates research-data directories, and runs local verification.
6. At the final page, choose **Launch D-Predict now**. The launcher starts PostgreSQL, API, research service, dashboard and collector, then opens `http://127.0.0.1:3000`.

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
