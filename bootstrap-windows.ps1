param(
    [string]$InstallDir,
    [switch]$InstallerMode,
    [switch]$SkipChecks
)

$ErrorActionPreference = 'Stop'

function Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable('Path','Machine')
    $user = [Environment]::GetEnvironmentVariable('Path','User')
    $extra = @(
        (Join-Path $env:ProgramFiles 'nodejs'),
        (Join-Path ${env:ProgramFiles(x86)} 'nodejs'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs'),
        (Join-Path $env:ProgramFiles 'Git\cmd'),
        (Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin')
    )
    $env:Path = (($machine -split ';') + ($user -split ';') + $extra | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique) -join ';'
}
function Ensure-Winget {
    Refresh-Path
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw 'winget is required. Install Microsoft App Installer, then run the installer again.' }
}
function Ensure-Git {
    Refresh-Path
    if (Get-Command git -ErrorAction SilentlyContinue) { return }
    Step 'Installing Git'
    Ensure-Winget
    & winget install --id Git.Git --exact --accept-source-agreements --accept-package-agreements --disable-interactivity
    if ($LASTEXITCODE -ne 0) { throw "Git installation failed (exit code $LASTEXITCODE)." }
    Refresh-Path
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git was installed but is not available on PATH. Restart Windows and rerun the installer.' }
}
function Ensure-Python312 {
    Refresh-Path
    if (Get-Command py -ErrorAction SilentlyContinue) { try { & py -3.12 --version *> $null; if ($LASTEXITCODE -eq 0) { return } } catch {} }
    Step 'Installing Python 3.12'
    Ensure-Winget
    & winget install --id Python.Python.3.12 --exact --accept-source-agreements --accept-package-agreements --disable-interactivity
    if ($LASTEXITCODE -ne 0) { throw "Python 3.12 installation failed (exit code $LASTEXITCODE)." }
    Refresh-Path
    if (-not (Get-Command py -ErrorAction SilentlyContinue)) { throw 'Python launcher was installed but is not available. Restart Windows and rerun the installer.' }
    & py -3.12 --version *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.12 is not available after installation.' }
}
function Ensure-Node22Plus {
    Refresh-Path
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) {
        $major = [int]((& node --version).TrimStart('v').Split('.')[0])
        if ($major -ge 22) { return }
    }
    Step 'Installing Node.js LTS'
    Ensure-Winget
    & winget install --id OpenJS.NodeJS.LTS --exact --accept-source-agreements --accept-package-agreements --disable-interactivity
    if ($LASTEXITCODE -ne 0) { throw "Node.js LTS installation failed (exit code $LASTEXITCODE)." }
    Refresh-Path
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw 'Node.js was installed but is not available on PATH. Restart Windows and rerun the installer.' }
    $major = [int]((& node --version).TrimStart('v').Split('.')[0])
    if ($major -lt 22) { throw "Node.js 22+ is required; detected $(& node --version)." }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm was not found with Node.js. Repair Node.js and rerun the installer.' }
}
function Ensure-Docker {
    Refresh-Path
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Step 'Installing Docker Desktop'
        Ensure-Winget
        & winget install --id Docker.DockerDesktop --exact --accept-source-agreements --accept-package-agreements --disable-interactivity
        if ($LASTEXITCODE -ne 0) { throw "Docker Desktop installation failed (exit code $LASTEXITCODE)." }
        Refresh-Path
    }
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker Desktop was installed but docker is not available on PATH. Restart Windows and rerun the installer.' }
    Step 'Checking Docker Desktop'
    & docker info *> $null
    if ($LASTEXITCODE -eq 0) { return }
    $desktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
    if (Test-Path $desktop) { Start-Process $desktop | Out-Null }
    for ($i = 0; $i -lt 45; $i++) {
        Start-Sleep -Seconds 2
        & docker info *> $null
        if ($LASTEXITCODE -eq 0) { return }
    }
    throw 'Docker Desktop is installed but the Docker engine is not ready. Start Docker Desktop and rerun the installer.'
}

Write-Host 'D-Predict Windows bootstrap' -ForegroundColor Green
if ($InstallerMode) { Write-Host 'Installer mode: installing prerequisites, source and local dependencies.' }
if (-not $InstallDir) { $InstallDir = if ($PSScriptRoot) { $PSScriptRoot } else { Join-Path $HOME 'D-predict-' } }
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

try {
    Ensure-Winget
    Ensure-Git
    Ensure-Python312
    Ensure-Node22Plus
    Ensure-Docker

    $repoMarker = Join-Path $InstallDir '.git'
    $trainingMarker = Join-Path $InstallDir 'training'
    if (-not (Test-Path $trainingMarker)) {
        Step 'Downloading D-Predict source'
        $staging = "$InstallDir.__source"
        if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
        & git clone --depth 1 https://github.com/akkillies1/D-predict-.git $staging
        if ($LASTEXITCODE -ne 0) { throw "D-Predict source download failed (exit code $LASTEXITCODE)." }
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
    if (-not (Test-Path $python)) { throw 'Collector Python virtual environment could not be created.' }
    & $python -m pip install --upgrade pip
    if ($LASTEXITCODE -ne 0) { throw 'Failed to upgrade pip.' }
    & $python -m pip install -r (Join-Path $InstallDir 'collector\requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Failed to install collector Python dependencies.' }
    & $python -m pip install pytest scikit-learn
    if ($LASTEXITCODE -ne 0) { throw 'Failed to install local Python test dependencies.' }

    Step 'Installing backend dependencies'
    & npm ci --prefix (Join-Path $InstallDir 'backend')
    if ($LASTEXITCODE -ne 0) { throw 'Failed to install backend dependencies.' }

    Step 'Installing dashboard dependencies'
    & corepack enable
    if ($LASTEXITCODE -ne 0) { throw 'Failed to enable Corepack.' }
    & corepack prepare pnpm@10.4.1 --activate
    if ($LASTEXITCODE -ne 0) { throw 'Failed to activate pnpm 10.4.1.' }
    & pnpm --dir (Join-Path $InstallDir 'dashboard') install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'Failed to install dashboard dependencies.' }

    Step 'Creating local research-data directories'
    foreach ($dir in @('data\historical','data\manifests','data\training','data\predictions','data\validation')) { New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir $dir) | Out-Null }

    if (-not $SkipChecks) {
        Step 'Running local verification'
        & $python -m compileall -q (Join-Path $InstallDir 'collector') (Join-Path $InstallDir 'training')
        if ($LASTEXITCODE -ne 0) { throw 'Python compile verification failed.' }
        & $python -m pytest (Join-Path $InstallDir 'training\tests') -q
        if ($LASTEXITCODE -ne 0) { throw 'Training tests failed.' }
        & npm test --prefix (Join-Path $InstallDir 'backend')
        if ($LASTEXITCODE -ne 0) { throw 'Backend tests failed.' }
        & npm test --prefix (Join-Path $InstallDir 'dashboard')
        if ($LASTEXITCODE -ne 0) { throw 'Dashboard tests failed.' }
        & npm run check --prefix (Join-Path $InstallDir 'dashboard')
        if ($LASTEXITCODE -ne 0) { throw 'Dashboard type/check verification failed.' }
        & npm run build --prefix (Join-Path $InstallDir 'dashboard')
        if ($LASTEXITCODE -ne 0) { throw 'Dashboard production build failed.' }
    }

    Write-Host "`nD-Predict installation complete." -ForegroundColor Green
    Write-Host "Location: $InstallDir"
    Write-Host "Python:   $(& $python --version)"
    Write-Host "Node:     $(& node --version)"
    Write-Host "Docker:   $(& docker --version)"
    Write-Host "`nHistorical market data is NOT downloaded during installation." -ForegroundColor Yellow
    Write-Host "Run .\run.ps1 bootstrap when you want the real historical validation pipeline."
    exit 0
}
catch {
    Write-Host "`nD-Predict installation failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'No partial success is reported. Fix the prerequisite shown above and run the installer again.' -ForegroundColor Yellow
    exit 1
}
