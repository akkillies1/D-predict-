param(
    [string]$InstallDir,
    [string]$SourceRef,
    [switch]$InstallerMode,
    [switch]$SkipChecks,
    [switch]$ElevatedChild
)

$ErrorActionPreference = 'Stop'
$StateRoot = Join-Path $env:LOCALAPPDATA 'D-Predict'
$LogDir = Join-Path $StateRoot 'logs'
$LogFile = Join-Path $LogDir 'bootstrap.log'
$CompleteMarker = Join-Path $StateRoot '.install-complete'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Log([string]$Message) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message"
    $line | Tee-Object -FilePath $LogFile -Append
}
function Step([string]$Message) { Log "==> $Message"; Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable('Path','Machine')
    $user = [Environment]::GetEnvironmentVariable('Path','User')
    $extra = @(
        (Join-Path $env:ProgramFiles 'nodejs'),
        (Join-Path ${env:ProgramFiles(x86)} 'nodejs'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs'),
        (Join-Path $env:ProgramFiles 'Git\cmd'),
        (Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin'),
        (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin')
    )
    $env:Path = (($machine -split ';') + ($user -split ';') + $extra | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique) -join ';'
}
function Invoke-Native([string]$Label, [scriptblock]$Action) {
    Step $Label
    & $Action 2>&1 | Tee-Object -FilePath $LogFile -Append
    $code = $LASTEXITCODE
    if ($code -ne 0) { throw "$Label failed (exit code $code). See $LogFile" }
}
function Ensure-Winget {
    Refresh-Path
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw 'winget is required. Install Microsoft App Installer, then run the installer again.' }
}
function Ensure-Git {
    Refresh-Path
    if (Get-Command git -ErrorAction SilentlyContinue) { return }
    Ensure-Winget
    Invoke-Native 'Installing Git' { winget install --id Git.Git --exact --scope machine --accept-source-agreements --accept-package-agreements --disable-interactivity }
    Refresh-Path
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git was installed but is not available on PATH.' }
}
function Ensure-Python312 {
    Refresh-Path
    if (Get-Command py -ErrorAction SilentlyContinue) { try { & py -3.12 --version *> $null; if ($LASTEXITCODE -eq 0) { return } } catch {} }
    Ensure-Winget
    Invoke-Native 'Installing Python 3.12' { winget install --id Python.Python.3.12 --exact --scope machine --accept-source-agreements --accept-package-agreements --disable-interactivity }
    Refresh-Path
    if (-not (Get-Command py -ErrorAction SilentlyContinue)) { throw 'Python launcher was installed but is not available on PATH.' }
    & py -3.12 --version *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.12 is not available after installation.' }
}
function Ensure-Node22Plus {
    Refresh-Path
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) {
        $major = [int]((& node --version).TrimStart('v').Split('.')[0])
        if ($major -ge 22 -and (Get-Command npm -ErrorAction SilentlyContinue)) { return }
    }
    Ensure-Winget
    Invoke-Native 'Installing Node.js LTS' { winget install --id OpenJS.NodeJS.LTS --exact --scope machine --accept-source-agreements --accept-package-agreements --disable-interactivity }
    Refresh-Path
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw 'Node.js was installed but is not available on PATH.' }
    $major = [int]((& node --version).TrimStart('v').Split('.')[0])
    if ($major -lt 22) { throw "Node.js 22+ is required; detected $(& node --version)." }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm was not found with Node.js.' }
}
function Find-DockerDesktop {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe')
    )
    return ($candidates | Where-Object { Test-Path $_ } | Select-Object -First 1)
}
function Ensure-Docker {
    Refresh-Path
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Ensure-Winget
        Invoke-Native 'Installing Docker Desktop' { winget install --id Docker.DockerDesktop --exact --scope machine --accept-source-agreements --accept-package-agreements --disable-interactivity }
        Refresh-Path
    }
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker CLI is unavailable after installation. Check Docker Desktop installation.' }
    & docker info *> $null
    if ($LASTEXITCODE -eq 0) { return }
    $desktop = Find-DockerDesktop
    if ($desktop) { Log "Starting Docker Desktop: $desktop"; Start-Process -FilePath $desktop | Out-Null }
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 2
        & docker info *> $null
        if ($LASTEXITCODE -eq 0) { return }
    }
    throw 'Docker Desktop is installed but the Docker engine did not become ready. Check WSL 2/virtualization and Docker Desktop, then run Repair & Check.'
}

try {
    Log "D-Predict bootstrap starting. InstallerMode=$InstallerMode SourceRef=$SourceRef InstallDir=$InstallDir"
    if (-not $InstallDir) { $InstallDir = if ($PSScriptRoot) { $PSScriptRoot } else { Join-Path $HOME 'D-predict-' } }
    $InstallDir = [IO.Path]::GetFullPath($InstallDir)
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -and -not $ElevatedChild) {
        Step 'Requesting administrator permission for prerequisite installation'
        $args = @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"",'-InstallDir',"`"$InstallDir`"",'-ElevatedChild')
        if ($InstallerMode) { $args += '-InstallerMode' }
        if ($SkipChecks) { $args += '-SkipChecks' }
        if ($SourceRef) { $args += @('-SourceRef',"`"$SourceRef`"") }
        $p = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -Verb RunAs -ArgumentList $args -WorkingDirectory $InstallDir -Wait -PassThru
        exit $p.ExitCode
    }

    Ensure-Winget
    Ensure-Git
    Ensure-Python312
    Ensure-Node22Plus
    Ensure-Docker

    $trainingMarker = Join-Path $InstallDir 'training'
    if (-not (Test-Path $trainingMarker)) {
        Step 'Downloading D-Predict source'
        $staging = "$InstallDir.__source"
        if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
        $cloneArgs = @('clone','--depth','1')
        if ($SourceRef) { $cloneArgs += @('--branch',$SourceRef) }
        $cloneArgs += @('https://github.com/akkillies1/D-predict-.git',$staging)
        Invoke-Native 'Downloading D-Predict source' { git @cloneArgs }
        $preserve = @('bootstrap-windows.ps1','dp.ps1','run.ps1','launch-dpredict.ps1')
        Get-ChildItem -Force $staging | ForEach-Object {
            if ($preserve -notcontains $_.Name) { Move-Item $_.FullName $InstallDir -Force }
        }
        Remove-Item $staging -Recurse -Force
    }

    Set-Location $InstallDir
    if (-not (Test-Path (Join-Path $InstallDir '.env.example'))) { throw 'Downloaded D-Predict source is incomplete: .env.example is missing.' }

    $venv = Join-Path $InstallDir 'collector\.venv'
    $python = Join-Path $venv 'Scripts\python.exe'
    if (-not (Test-Path $python)) { Invoke-Native 'Creating Python environment' { py -3.12 -m venv $venv } }
    if (-not (Test-Path $python)) { throw 'Collector Python environment could not be created.' }
    Invoke-Native 'Installing collector Python dependencies' { & $python -m pip install --upgrade pip }
    Invoke-Native 'Installing collector requirements' { & $python -m pip install -r (Join-Path $InstallDir 'collector\requirements.txt') }
    Invoke-Native 'Installing local Python test dependencies' { & $python -m pip install pytest scikit-learn }
    Invoke-Native 'Installing backend dependencies' { npm ci --prefix (Join-Path $InstallDir 'backend') }
    Invoke-Native 'Enabling Corepack' { corepack enable }
    Invoke-Native 'Activating pnpm 10.4.1' { corepack prepare pnpm@10.4.1 --activate }
    Invoke-Native 'Installing dashboard dependencies' { pnpm --dir (Join-Path $InstallDir 'dashboard') install --frozen-lockfile }

    foreach ($dir in @('data\historical','data\manifests','data\training','data\predictions','data\validation')) { New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir $dir) | Out-Null }
    New-Item -ItemType Directory -Force -Path $StateRoot | Out-Null
    Set-Content -Path (Join-Path $StateRoot 'install-root.txt') -Value $InstallDir -Encoding UTF8
    if ($SourceRef) { Set-Content -Path (Join-Path $StateRoot 'source-ref.txt') -Value $SourceRef -Encoding UTF8 }

    if (-not $SkipChecks) {
        Invoke-Native 'Python compile verification' { & $python -m compileall -q (Join-Path $InstallDir 'collector') (Join-Path $InstallDir 'training') }
        Invoke-Native 'Training tests' { & $python -m pytest (Join-Path $InstallDir 'training\tests') -q }
        Invoke-Native 'Backend tests' { npm test --prefix (Join-Path $InstallDir 'backend') }
        Invoke-Native 'Dashboard tests' { npm test --prefix (Join-Path $InstallDir 'dashboard') }
        Invoke-Native 'Dashboard type check' { npm run check --prefix (Join-Path $InstallDir 'dashboard') }
        Invoke-Native 'Dashboard production build' { npm run build --prefix (Join-Path $InstallDir 'dashboard') }
    }

    Set-Content -Path $CompleteMarker -Value (Get-Date -Format o) -Encoding UTF8
    Log 'D-Predict bootstrap completed successfully.'
    Write-Host "`nD-Predict installation complete." -ForegroundColor Green
    Write-Host "Location: $InstallDir"
    Write-Host "Bootstrap log: $LogFile"
    exit 0
}
catch {
    Remove-Item $CompleteMarker -Force -ErrorAction SilentlyContinue
    Log "ERROR: $($_.Exception.Message)"
    Write-Host "`nD-Predict installation failed." -ForegroundColor Red
    Write-Host "Reason: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Bootstrap log: $LogFile" -ForegroundColor Yellow
    exit 1
}
