param(
    [ValidateSet('bootstrap','validate','test','start','stop','restart','status','doctor','init','update','help')]
    [string]$Command = 'help',
    [switch]$Force,
    [switch]$RefreshData
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

switch ($Command) {
    'bootstrap' {
        $Python = Join-Path $Root 'collector\.venv\Scripts\python.exe'
        if (-not (Test-Path $Python)) { throw 'D-Predict is not installed. Run the Windows installer first.' }
        $args = @('-m','training.run_full_validation','--symbols','RELIANCE','HDFCBANK','ICICIBANK','INFY','TCS','SBIN','--horizons','1d','3d','5d')
        if ($Force) { $args += '--force' }
        if ($RefreshData) { $args += '--refresh-data' }
        & $Python @args
        exit $LASTEXITCODE
    }
    'validate' { & $MyInvocation.MyCommand.Path -Command bootstrap -Force:$Force -RefreshData:$RefreshData; exit $LASTEXITCODE }
    'update' {
        if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git is required for update.' }
        git pull --ff-only
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        & (Join-Path $Root 'bootstrap-windows.ps1') -InstallDir $Root
        exit $LASTEXITCODE
    }
    'restart' { & (Join-Path $Root 'dp.ps1') stop; & (Join-Path $Root 'dp.ps1') start; exit $LASTEXITCODE }
    'help' { & (Join-Path $Root 'dp.ps1'); exit 0 }
    default { & (Join-Path $Root 'dp.ps1') $Command; exit $LASTEXITCODE }
}
