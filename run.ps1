param(
    [ValidateSet('bootstrap','validate','test')]
    [string]$Command = 'test',
    [switch]$Force,
    [switch]$RefreshData
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Python = Join-Path $Root 'collector\.venv\Scripts\python.exe'

if (-not (Test-Path $Python)) {
    throw 'D-Predict is not bootstrapped. Run: irm https://raw.githubusercontent.com/akkillies1/D-predict-/main/bootstrap-windows.ps1 | iex'
}

Set-Location $Root

switch ($Command) {
    'bootstrap' {
        $args = @('-m','training.run_full_validation','--symbols','RELIANCE','HDFCBANK','ICICIBANK','INFY','TCS','SBIN','--horizons','1d','3d','5d')
        if ($Force) { $args += '--force' }
        if ($RefreshData) { $args += '--refresh-data' }
        & $Python @args
    }
    'validate' {
        $args = @('-m','training.run_full_validation','--symbols','RELIANCE','HDFCBANK','ICICIBANK','INFY','TCS','SBIN','--horizons','1d','3d','5d')
        if ($Force) { $args += '--force' }
        if ($RefreshData) { $args += '--refresh-data' }
        & $Python @args
    }
    'test' {
        & $Python -m pytest (Join-Path $Root 'training\tests') -q
        npm test --prefix (Join-Path $Root 'backend')
        npm test --prefix (Join-Path $Root 'dashboard')
    }
}
