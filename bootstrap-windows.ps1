param(
    [string]$InstallDir,
    [switch]$InstallerMode,
    [switch]$SkipChecks
)

$ErrorActionPreference = 'Stop'

function Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Refresh-Path { $env:Path = "$( [Environment]::GetEnvironmentVariable('Path','Machine') );$( [Environment]::GetEnvironmentVariable('Path','User') )" }
function Ensure-Winget { if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw 'winget is required. Install Microsoft App Installer, then run the installer again.' } }
function Ensure-Git { if (Get-Command git -ErrorAction SilentlyContinue) { return }; Step 'Installing Git'; Ensure-Winget; winget install --id Git.Git --exact --accept-source-agreements --accept-package-agreements; Refresh-Path; if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git was installed but is not available on PATH.' } }
function Ensure-Python312 {
    if (Get-Command py -ErrorAction SilentlyContinue) { try { & py -3.12 --version *> $null; if ($LASTEXITCODE -eq 0) { return } } catch {} }
    Step 'Installing Python 3.12'; Ensure-Winget; winget install --id Python.Python.3.12 --exact --accept-source-agreements --accept-package-agreements; Refresh-Path
    if (-not (Get-Command py -ErrorAction SilentlyContinue)) { throw 'Python launcher not found after installation.' }
}
function Ensure-Node22Plus {
    if (Get-Command node -ErrorAction SilentlyContinue) { $major = [int]((& node --version).TrimStart('v').Split('.')[0]); if ($major -ge 22) { return } }
    Step 'Installing Node.js LTS'; Ensure-Winget; winget install --id OpenJS.NodeJS.LTS --exact --accept-source-agreements --accept-package-agreements; Refresh-Path
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js was installed but is not on PATH.' }
    $major = [int]((& node --version).TrimStart('v').Split('.')[0]); if ($major -lt 22) { throw "Node.js 22+ is required; detected $(& node --version)." }
}
function Ensure-Docker {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Step 'Installing Docker Desktop'; Ensure-Winget; winget install --id Docker.DockerDesktop --exact --accept-source-agreements --accept-package-agreements; Refresh-Path }
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker Desktop was installed but docker is not on PATH.' }
    Step 'Checking Docker Desktop'
    if ((docker info 2>$null) -ne $null) { return }
    $desktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
    if (Test-Path $desktop) { Start-Process $desktop | Out-Null }
    for ($i = 0; $i -lt 30; $i++) { Start-Sleep -Seconds 2; docker info *> $null; if ($LASTEXITCODE -eq 0) { return } }
    throw 'Docker Desktop is installed but the Docker engine is not ready. Start Docker Desktop and rerun the installer.'
}

Write-Host 'D-Predict Windows bootstrap' -ForegroundColor Green
if ($InstallerMode) { Write-Host 'Installer mode: installing prerequisites, source and local dependencies.' }
if (-not $InstallDir) { $InstallDir = if ($PSScriptRoot) { $PSScriptRoot } else { Join-Path $HOME 'D-predict-' } }
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

Ensure-Winget
Ensure-Git
Ensure-Python312
Ensure-Node22Plus
Ensure-Docker

$repoMarker = Join-Path $InstallDir '.git'
$trainingMarker = Join-Path $InstallDir 'training'
if (-not (Test-Path $repoMarker) -or -not (Test-Path $trainingMarker)) {
    Step 'Downloading D-Predict source'
    $staging = "$InstallDir.__source"
    if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
    git clone --depth 1 https://github.com/akkillies1/D-predict-.git $staging
    $preserve = @('bootstrap-windows.ps1','dp.ps1','run.ps1','launch-dpredict.ps1')
    Get-ChildItem -Force $staging | ForEach-Object {
        if ($preserve -notcontains $_.Name) { Move-Item $_.FullName $InstallDir -Force }
    }
    Remove-Item $staging -Recurse -Force
}

Set-Location $InstallDir

Step 'Creating Python virtual environment'
$venv = Join-Path $InstallDir 'collector\.venv'
$python = Join-Path $venv 'Scripts\python.exe'
if (-not (Test-Path $python)) { & py -3.12 -m venv $venv }
& $python -m pip install --upgrade pip
& $python -m pip install -r (Join-Path $InstallDir 'collector\requirements.txt')
& $python -m pip install pytest scikit-learn

Step 'Installing backend dependencies'
npm ci --prefix (Join-Path $InstallDir 'backend')

Step 'Installing dashboard dependencies'
corepack enable
corepack prepare pnpm@10.4.1 --activate
pnpm --dir (Join-Path $InstallDir 'dashboard') install --frozen-lockfile

Step 'Creating local research-data directories'
foreach ($dir in @('data\historical','data\manifests','data\training','data\predictions','data\validation')) { New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir $dir) | Out-Null }

if (-not $SkipChecks) {
    Step 'Running local verification'
    & $python -m compileall -q (Join-Path $InstallDir 'collector') (Join-Path $InstallDir 'training')
    & $python -m pytest (Join-Path $InstallDir 'training\tests') -q
    npm test --prefix (Join-Path $InstallDir 'backend')
    npm test --prefix (Join-Path $InstallDir 'dashboard')
    npm run check --prefix (Join-Path $InstallDir 'dashboard')
    npm run build --prefix (Join-Path $InstallDir 'dashboard')
}

Write-Host "`nD-Predict installation complete." -ForegroundColor Green
Write-Host "Location: $InstallDir"
Write-Host "Python:   $(& $python --version)"
Write-Host "Node:     $(& node --version)"
Write-Host "Docker:   $(docker --version)"
Write-Host "`nHistorical market data is NOT downloaded during installation." -ForegroundColor Yellow
Write-Host "Run .\run.ps1 bootstrap when you want the real historical validation pipeline."
