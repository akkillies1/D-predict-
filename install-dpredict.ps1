param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\D-Predict')
)

$ErrorActionPreference = 'Stop'
$repoZip = 'https://github.com/akkillies1/D-predict-/archive/refs/heads/main.zip'
$stateRoot = Join-Path $env:LOCALAPPDATA 'D-Predict'
$tempRoot = Join-Path $env:TEMP 'D-Predict-install'
$zipPath = Join-Path $tempRoot 'D-Predict-main.zip'

Write-Host 'D-Predict personal Windows installer' -ForegroundColor Green
Write-Host "Install location: $InstallDir"
Write-Host ''

try {
    New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

    Write-Host 'Downloading the current D-Predict source from GitHub...' -ForegroundColor Cyan
    Invoke-WebRequest -Uri $repoZip -OutFile $zipPath -UseBasicParsing

    if (-not (Test-Path $zipPath)) { throw 'D-Predict source archive was not downloaded.' }

    $extractRoot = Join-Path $tempRoot 'source'
    if (Test-Path $extractRoot) { Remove-Item $extractRoot -Recurse -Force }
    Expand-Archive -Path $zipPath -DestinationPath $extractRoot -Force

    $sourceDir = Get-ChildItem -Path $extractRoot -Directory | Select-Object -First 1
    if (-not $sourceDir) { throw 'Downloaded D-Predict source archive was empty.' }
    if (-not (Test-Path (Join-Path $sourceDir.FullName 'training'))) { throw 'Downloaded source is incomplete: training directory was not found.' }

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Get-ChildItem -Force $sourceDir.FullName | ForEach-Object {
        Move-Item $_.FullName $InstallDir -Force
    }

    $bootstrap = Join-Path $InstallDir 'bootstrap-windows.ps1'
    if (-not (Test-Path $bootstrap)) { throw 'D-Predict bootstrap script was not found after extraction.' }

    Write-Host 'Running D-Predict prerequisite setup...' -ForegroundColor Cyan
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $bootstrap -InstallDir $InstallDir -InstallerMode
    if ($LASTEXITCODE -ne 0) { throw "D-Predict setup failed (exit code $LASTEXITCODE)." }

    New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
    Write-Host ''
    Write-Host 'D-Predict is installed.' -ForegroundColor Green
    Write-Host 'Start it with:' -ForegroundColor Cyan
    Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File `"$InstallDir\launch-dpredict.ps1`""
    Write-Host ''
    Write-Host 'This path intentionally does not use an unsigned .exe installer.' -ForegroundColor Yellow
    Write-Host 'It is intended for personal/local use on Windows machines with Smart App Control enabled.'
}
catch {
    Write-Host ''
    Write-Host "D-Predict installation failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
finally {
    if (Test-Path $tempRoot) {
        Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
