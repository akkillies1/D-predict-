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

    # Configure the database BEFORE the heavyweight bootstrap. Inno Setup does not\n    # provide a reliable interactive PowerShell console, so the database wizard\n    # must own all first-run interaction through Windows dialogs.\n    $databaseSetup = Join-Path $InstallDir 'database-setup.ps1'\n    $envFile = Join-Path $stateRoot '.env'\n    if (-not (Test-Path $databaseSetup)) {\n        throw "Database setup script is missing: $databaseSetup"\n    }\n    if (-not (Test-Path $envFile)) {\n        Log 'Database configuration is missing; starting the first-run database setup wizard.'\n        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $databaseSetup\n        $databaseExitCode = $LASTEXITCODE\n        if ($databaseExitCode -ne 0) {\n            if ($databaseExitCode -eq 2) { throw 'Database configuration was cancelled by the user.' }\n            throw "Database configuration was not completed (exit code $databaseExitCode). See $logFile"\n        }\n    }\n    if (-not (Test-Path $envFile)) {\n        throw "Database setup returned success without creating $envFile."\n    }\n    $projectEnvFile = Join-Path $InstallDir '.env'\n    if (-not (Test-Path $projectEnvFile)) {\n        throw "Database setup returned success without creating $projectEnvFile."\n    }\n\n    # The Inno Setup package contains the bootstrap entrypoint and the small\n    # installer helpers. Do not download/unpack the repository here: doing so\n    # can overwrite the script that is currently executing and can leave a\n    # partially installed tree. bootstrap-windows.ps1 owns source sync,\n    # prerequisite installation, and verification.\n    $bootstrap = Join-Path $InstallDir 'bootstrap-windows.ps1'\n    if (-not (Test-Path $bootstrap)) {\n        throw "Installer bootstrap is missing: $bootstrap"\n    }\n\n    Log 'Starting the D-Predict bootstrap after database configuration.'\n    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $bootstrap -InstallDir $InstallDir -InstallerMode -SkipChecks -SourceRef $SourceRef -RefreshSource *>&1 | Tee-Object -FilePath $logFile -Append\n    $exitCode = $LASTEXITCODE\n    if ($exitCode -ne 0) {\n        throw "D-Predict prerequisite setup failed (exit code $exitCode). See $logFile"\n    }\n\n    New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null\n    $completeMarker = Join-Path $stateRoot '.install-complete'\n    if (-not (Test-Path $completeMarker)) {\n        Log "Bootstrap succeeded but the marker was not visible in this user context; writing $completeMarker."\n        Set-Content -Path $completeMarker -Value (Get-Date -Format o) -Encoding UTF8\n    }\n    if (-not (Test-Path $completeMarker)) {\n        throw "D-Predict bootstrap returned success but the completion marker could not be written: $completeMarker. See $logFile"\n    }\n    Set-Content -Path (Join-Path $stateRoot 'install-root.txt') -Value $InstallDir -Encoding UTF8\n    if ($SourceRef) {\n        Set-Content -Path (Join-Path $stateRoot 'source-ref.txt') -Value $SourceRef -Encoding UTF8\n    }
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
