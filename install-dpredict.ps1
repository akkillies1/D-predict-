param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\D-Predict'),
    [string]$SourceRef = 'main'
)

$ErrorActionPreference = 'Stop'
$repoZip = "https://github.com/akkillies1/D-predict-/archive/refs/tags/$SourceRef.zip"
if ($SourceRef -eq 'main') {
    $repoZip = 'https://github.com/akkillies1/D-predict-/archive/refs/heads/main.zip'
}
$stateRoot = Join-Path $env:LOCALAPPDATA 'D-Predict'
$tempRoot = Join-Path $env:TEMP 'D-Predict-install'
$zipPath = Join-Path $tempRoot 'D-Predict-source.zip'

Write-Host 'D-Predict Setup & Repair' -ForegroundColor Green
Write-Host "Install location: $InstallDir"
Write-Host "Source ref: $SourceRef"
Write-Host ''

try {
    New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

    Write-Host 'Downloading the pinned D-Predict source from GitHub...' -ForegroundColor Cyan
    Invoke-WebRequest -Uri $repoZip -OutFile $zipPath -UseBasicParsing
    if (-not (Test-Path $zipPath)) { throw 'D-Predict source archive was not downloaded.' }

    $extractRoot = Join-Path $tempRoot 'source'
    if (Test-Path $extractRoot) { Remove-Item $extractRoot -Recurse -Force }
    Expand-Archive -Path $zipPath -DestinationPath $extractRoot -Force

    $sourceDir = Get-ChildItem -Path $extractRoot -Directory | Select-Object -First 1
    if (-not $sourceDir) { throw 'Downloaded D-Predict source archive was empty.' }
    if (-not (Test-Path (Join-Path $sourceDir.FullName 'training'))) { throw 'Downloaded source is incomplete: training directory was not found.' }
    if (-not (Test-Path (Join-Path $sourceDir.FullName 'bootstrap-windows.ps1'))) { throw 'Downloaded source is incomplete: bootstrap script was not found.' }

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Get-ChildItem -Force $sourceDir.FullName | ForEach-Object {
        $destination = Join-Path $InstallDir $_.Name
        if (Test-Path $destination) {
            if ($_.PSIsContainer) { Remove-Item $destination -Recurse -Force }
            else { Remove-Item $destination -Force }
        }
        Move-Item $_.FullName $InstallDir -Force
    }

    $bootstrap = Join-Path $InstallDir 'bootstrap-windows.ps1'
    Write-Host 'Starting prerequisite setup in a separate step...' -ForegroundColor Cyan
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $bootstrap -InstallDir $InstallDir -InstallerMode -SkipChecks -SourceRef $SourceRef
    if ($LASTEXITCODE -ne 0) { throw "D-Predict prerequisite setup failed (exit code $LASTEXITCODE)." }

    New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
    Write-Host ''
    Write-Host 'D-Predict setup completed.' -ForegroundColor Green
    Write-Host 'You can now use the D-Predict shortcut.' -ForegroundColor Cyan
}
catch {
    Write-Host ''
    Write-Host "D-Predict setup failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
finally {
    if (Test-Path $tempRoot) {
        Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
