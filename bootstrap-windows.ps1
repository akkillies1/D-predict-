$ErrorActionPreference = 'Stop'

function Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Refresh-Path {
    $env:Path = "$( [Environment]::GetEnvironmentVariable('Path','Machine') );$( [Environment]::GetEnvironmentVariable('Path','User') )"
}
function Ensure-Winget {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw 'winget is required. Install Microsoft App Installer, then run this command again.'
    }
}
function Ensure-Python312 {
    if (Get-Command py -ErrorAction SilentlyContinue) {
        try { & py -3.12 --version *> $null; if ($LASTEXITCODE -eq 0) { return } } catch {}
    }
    Step 'Installing Python 3.12'
    Ensure-Winget
    winget install --id Python.Python.3.12 --exact --accept-source-agreements --accept-package-agreements
    Refresh-Path
    if (-not (Get-Command py -ErrorAction SilentlyContinue)) { throw 'Python launcher not found after installation. Open a new PowerShell window and rerun.' }
}
function Ensure-Node22Plus {
    if (Get-Command node -ErrorAction SilentlyContinue) {
        $major = [int]((& node --version).TrimStart('v').Split('.')[0])
        if ($major -ge 22) { return }
    }
    Step 'Installing Node.js LTS'
    Ensure-Winget
    winget install --id OpenJS.NodeJS.LTS --exact --accept-source-agreements --accept-package-agreements
    Refresh-Path
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js was installed but is not on PATH. Open a new PowerShell window and rerun.' }
    $major = [int]((& node --version).TrimStart('v').Split('.')[0])
    if ($major -lt 22) { throw "Node.js 22+ is required; detected $(& node --version)." }
}

Write-Host 'D-Predict Windows bootstrap' -ForegroundColor Green
Write-Host 'Installs development dependencies and runs local checks. It does NOT download market history.'

$repoRoot = $null
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'training'))) {
    $repoRoot = $PSScriptRoot
}

if (-not $repoRoot) {
    $defaultRoot = Join-Path $HOME 'D-predict-'
    if (Test-Path (Join-Path $defaultRoot '.git')) {
        $repoRoot = $defaultRoot
    } else {
        Step 'Cloning D-predict'
        if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
            Ensure-Winget
            winget install --id Git.Git --exact --accept-source-agreements --accept-package-agreements
            Refresh-Path
        }
        git clone https://github.com/akkillies1/D-predict-.git $defaultRoot
        $repoRoot = $defaultRoot
    }
}

Set-Location $repoRoot
Ensure-Python312
Ensure-Node22Plus

Step 'Creating Python virtual environment'
$venv = Join-Path $repoRoot 'collector\.venv'
$python = Join-Path $venv 'Scripts\python.exe'
if (-not (Test-Path $python)) { & py -3.12 -m venv $venv }
& $python -m pip install --upgrade pip
& $python -m pip install -r (Join-Path $repoRoot 'collector\requirements.txt')
& $python -m pip install pytest scikit-learn

Step 'Installing backend dependencies'
npm ci --prefix (Join-Path $repoRoot 'backend')

Step 'Installing dashboard dependencies with the pinned pnpm version'
corepack enable
corepack prepare pnpm@10.4.1 --activate
pnpm --dir (Join-Path $repoRoot 'dashboard') install --frozen-lockfile

Step 'Creating local research-data directories'
foreach ($dir in @('data\historical','data\manifests','data\training','data\predictions','data\validation')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $repoRoot $dir) | Out-Null
}

Step 'Running local checks'
& $python -m compileall -q (Join-Path $repoRoot 'collector') (Join-Path $repoRoot 'training')
& $python -m pytest (Join-Path $repoRoot 'training\tests') -q
npm test --prefix (Join-Path $repoRoot 'backend')
npm test --prefix (Join-Path $repoRoot 'dashboard')
npm run check --prefix (Join-Path $repoRoot 'dashboard')
npm run build --prefix (Join-Path $repoRoot 'dashboard')

Write-Host "`nD-Predict bootstrap complete." -ForegroundColor Green
Write-Host "Location: $repoRoot"
Write-Host "Python:   $(& $python --version)"
Write-Host "Node:     $(& node --version)"
Write-Host "`nNext step:" -ForegroundColor Yellow
Write-Host "  cd `"$repoRoot`""
Write-Host '  .\run.ps1 bootstrap'
Write-Host '`nThe bootstrap command above downloads real historical data and runs validation; installation itself does not.'
