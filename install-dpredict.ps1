param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\D-Predict'),
    [string]$SourceRef = 'main'
)

$ErrorActionPreference = 'Stop'
$stateRoot = Join-Path $env:LOCALAPPDATA 'D-Predict'
$logDir = Join-Path $stateRoot 'logs'
$logFile = Join-Path $logDir 'installer.log'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Log([string]$Message) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message"
    $line | Tee-Object -FilePath $logFile -Append
}

try {
    Log "D-Predict installer starting. InstallDir=$InstallDir SourceRef=$SourceRef"
    if (-not (Test-Path $InstallDir)) {
        New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    }

    # The Inno Setup package contains the bootstrap entrypoint and the small
    # installer helpers. Do not download/unpack the repository here: doing so
    # can overwrite the script that is currently executing and can leave a
    # partially installed tree. bootstrap-windows.ps1 owns source sync,
    # prerequisite installation, and verification.
    $bootstrap = Join-Path $InstallDir 'bootstrap-windows.ps1'
    if (-not (Test-Path $bootstrap)) {
        throw "Installer bootstrap is missing: $bootstrap"
    }

    Log 'Starting the D-Predict bootstrap.'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $bootstrap -InstallDir $InstallDir -InstallerMode -SkipChecks -SourceRef $SourceRef *>&1 | Tee-Object -FilePath $logFile -Append
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "D-Predict prerequisite setup failed (exit code $exitCode). See $logFile"
    }

    New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
    Set-Content -Path (Join-Path $stateRoot 'install-root.txt') -Value $InstallDir -Encoding UTF8
    if ($SourceRef) {
        Set-Content -Path (Join-Path $stateRoot 'source-ref.txt') -Value $SourceRef -Encoding UTF8
    }
    Log 'D-Predict setup completed successfully.'
    exit 0
}
catch {
    Log "ERROR: $($_.Exception.Message)"
    Write-Host "`nD-Predict setup failed." -ForegroundColor Red
    Write-Host "Reason: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Installer log: $logFile" -ForegroundColor Yellow
    exit 1
}
