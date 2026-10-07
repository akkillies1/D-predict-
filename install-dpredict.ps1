param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\D-Predict'),
    [string]$SourceRef = 'main',
    [string]$AppVersion = ''
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

# docker-compose starts the api container with `env_file: .env`, and that container
# has no host access, so the installed version reaches the update check only
# through this file.
function Set-EnvValue([string]$Path, [string]$Key, [string]$Value) {
    $lines = @()
    if (Test-Path $Path) { $lines = @(Get-Content $Path -ErrorAction SilentlyContinue) }
    $pattern = "^\s*${Key}\s*="
    $found = @($lines | Where-Object { $_ -match $pattern }).Count -gt 0
    if ($found) {
        $lines = @($lines | ForEach-Object { if ($_ -match $pattern) { "${Key}=${Value}" } else { $_ } })
    } else {
        $lines = @($lines) + "${Key}=${Value}"
    }
    $lines | Set-Content -Path $Path -Encoding UTF8
}

# Lets the dashboard's "Update now" button hand off to the host updater without a
# resident watcher; the launcher exits once the dashboard is up.
function Register-UpdateProtocol([string]$UpdaterPath) {
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $key = 'HKCU:\Software\Classes\dpredict-update'
    New-Item -Path "$key\shell\open\command" -Force | Out-Null
    Set-ItemProperty -Path $key -Name '(Default)' -Value 'URL:D-Predict Update Protocol'
    Set-ItemProperty -Path $key -Name 'URL Protocol' -Value ''
    Set-ItemProperty -Path "$key\shell\open\command" -Name '(Default)' -Value `
        ('"{0}" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{1}" -Action Apply' -f $powershell, $UpdaterPath)
}

try {
    Log "D-Predict installer starting. InstallDir=$InstallDir SourceRef=$SourceRef"
    if (-not (Test-Path $InstallDir)) {
        New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    }

    # Configure the database BEFORE the heavyweight bootstrap. Inno Setup does not
    # provide a reliable interactive PowerShell console, so the database wizard
    # must own all first-run interaction through Windows dialogs.
    $databaseSetup = Join-Path $InstallDir 'database-setup.ps1'
    $stateEnvFile = Join-Path $stateRoot '.env'
    $projectEnvFile = Join-Path $InstallDir '.env'
    if (-not (Test-Path $databaseSetup)) {
        throw "Database setup script is missing: $databaseSetup"
    }
    # A previous install can leave the machine-level state file behind while the
    # application directory has been replaced. In that case the project itself
    # is not configured yet, so force the wizard instead of silently accepting
    # an incomplete configuration.
    if (-not (Test-Path $stateEnvFile) -or -not (Test-Path $projectEnvFile)) {
        Log 'Database configuration is missing; starting the first-run database setup wizard.'
        & powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File $databaseSetup
        $databaseExitCode = $LASTEXITCODE
        if ($databaseExitCode -ne 0) {
            if ($databaseExitCode -eq 2) { throw 'Database configuration was cancelled by the user.' }
            throw "Database configuration was not completed (exit code $databaseExitCode). See $logFile"
        }
    }
    if (-not (Test-Path $stateEnvFile)) {
        throw "Database setup returned success without creating $stateEnvFile."
    }
    if (-not (Test-Path $projectEnvFile)) {
        throw "Database setup returned success without creating $projectEnvFile."
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

    Log 'Starting the D-Predict bootstrap after database configuration.'
    & powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File $bootstrap -InstallDir $InstallDir -InstallerMode -SkipChecks -SourceRef $SourceRef -RefreshSource *>&1 | Tee-Object -FilePath $logFile -Append
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "D-Predict prerequisite setup failed (exit code $exitCode). See $logFile"
    }

    New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
    $completeMarker = Join-Path $stateRoot '.install-complete'
    if (-not (Test-Path $completeMarker)) {
        Log "Bootstrap succeeded but the marker was not visible in this user context; writing $completeMarker."
        Set-Content -Path $completeMarker -Value (Get-Date -Format o) -Encoding UTF8
    }
    if (-not (Test-Path $completeMarker)) {
        throw "D-Predict bootstrap returned success but the completion marker could not be written: $completeMarker. See $logFile"
    }
    Set-Content -Path (Join-Path $stateRoot 'install-root.txt') -Value $InstallDir -Encoding UTF8
    if ($SourceRef) {
        Set-Content -Path (Join-Path $stateRoot 'source-ref.txt') -Value $SourceRef -Encoding UTF8
    }

    # Stamping the version is what makes the in-app update check possible. Neither
    # step can break a working install, so a failure here is logged and ignored.
    try {
        $version = $AppVersion -replace '^[vV]', ''
        if ($version -match '^\d+\.\d+\.\d+$') {
            Set-Content -Path (Join-Path $stateRoot 'version.txt') -Value $version -Encoding UTF8
            Set-EnvValue -Path $projectEnvFile -Key 'D_PREDICT_VERSION' -Value $version
            Log "Recorded installed version $version in $stateRoot\version.txt and $projectEnvFile."
        } else {
            Log "No usable version was supplied by the setup package (got '$AppVersion'); the update check will report the version as unknown."
        }
        $updater = Join-Path $InstallDir 'update-dpredict.ps1'
        if (Test-Path $updater) {
            Register-UpdateProtocol $updater
            Log 'Registered the dpredict-update: protocol handler.'
        } else {
            Log "Update handler was not registered because $updater is missing."
        }
    } catch {
        Log "Update-check registration failed (the installation itself is unaffected): $($_.Exception.Message)"
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
