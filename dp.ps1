$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$StateRoot = Join-Path $env:LOCALAPPDATA "D-Predict"
$Run = Join-Path $StateRoot ".run"
$EnvFile = Join-Path $StateRoot ".env"
$ComposeFile = Join-Path $Root "docker-compose.yml"

function Info($m) { Write-Host "[d-predict] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[d-predict] $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "[d-predict] $m" -ForegroundColor Red; exit 1 }
function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path','Machine')
  $user = [Environment]::GetEnvironmentVariable('Path','User')
  $env:Path = "$machine;$user"
  $candidates = @(
    (Join-Path $env:ProgramFiles 'nodejs'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs'),
    (Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin')
  )
  foreach ($dir in $candidates) {
    if ($dir -and (Test-Path $dir) -and (($env:Path -split ';') -notcontains $dir)) { $env:Path = "$dir;$env:Path" }
  }
}
function Need($name) {
  Refresh-Path
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { Die "Missing '$name'. Run D-Predict Repair & Check." }
}
function Ensure-ComposeFile {
  if (-not (Test-Path $ComposeFile)) { Die "D-Predict installation is incomplete: docker-compose.yml is missing from $Root. Run D-Predict Repair & Check." }
}
function Invoke-Compose([string[]]$ComposeArgs) {
  Ensure-ComposeFile
  & docker compose -f $ComposeFile @ComposeArgs
  if ($LASTEXITCODE -ne 0) { Die "Docker Compose command failed (exit code $LASTEXITCODE)." }
}
function Ensure-RunDir { New-Item -ItemType Directory -Force $Run | Out-Null }
function Import-EnvFile([string]$Path) {
  if (-not (Test-Path $Path)) { return $false }
  Get-Content $Path | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
      $parts = $line.Split('=',2)
      [Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim(), 'Process')
    }
  }
  return $true
}
function Ensure-Env {
  New-Item -ItemType Directory -Force $StateRoot | Out-Null
  if (Test-Path $EnvFile) {
    [void](Import-EnvFile $EnvFile)
    return
  }
  $rootEnv = Join-Path $Root ".env"
  if (Test-Path $rootEnv) {
    Copy-Item $rootEnv $EnvFile -Force
    [void](Import-EnvFile $EnvFile)
    Info "Loaded local environment configuration."
    return
  }
  $example = Join-Path $Root ".env.example"
  if (Test-Path $example) {
    Copy-Item $example $EnvFile -Force
    [void](Import-EnvFile $EnvFile)
    Info "Created runtime environment from .env.example."
    return
  }
  Warn "Install source does not contain .env.example; using built-in local defaults."
  $defaults = @{
    DATABASE_URL = 'postgresql://postgres:localdev@localhost:5433/nifty'
    NIFTY_DB_PORT = '5433'
    POSTGRES_PORT = '5433'
    POSTGRES_PASSWORD = 'localdev'
    API_PORT = '4100'
    RESEARCH_PORT = '4200'
    PORT = '3000'
    CORS_ORIGIN = 'http://127.0.0.1:3000,http://localhost:3000'
    VITE_API_BASE_URL = 'http://127.0.0.1:4100'
    VITE_RESEARCH_BASE_URL = 'http://127.0.0.1:4200'
    OPTION_CHAIN_POLL_SECONDS = '15'
    PRICE_BAR_POLL_SECONDS = '15'
    COLLECTOR_INSTRUMENTS = 'NIFTY,BANKNIFTY'
    RESEARCH_NEWS_ENABLED = 'true'
    RESEARCH_CACHE_SECONDS = '60'
    GDELT_TIMESPAN = '3d'
    RESEARCH_MAX_ARTICLES = '30'
    EMBEDDING_MODEL = 'all-MiniLM-L6-v2'
    FEATURE_SET_VERSION = 'v1'
    STRATEGY_VERSION = 'v1'
    MODEL_VERSION = 'phase1-rule-engine-v1'
    AI_MODE = 'disabled'
    AI_PROVIDER = ''
    AI_BASE_URL = ''
    AI_API_KEY = ''
    AI_MODEL = ''
  }
  $defaults.GetEnumerator() | ForEach-Object { [Environment]::SetEnvironmentVariable($_.Key, $_.Value, 'Process') }
  $defaults.GetEnumerator() | ForEach-Object { "{0}={1}" -f $_.Key, $_.Value } | Set-Content -Path $EnvFile -Encoding UTF8
}
function Ensure-DockerReady {
  Refresh-Path
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    $bootstrap = Join-Path $Root 'bootstrap-windows.ps1'
    if (Test-Path $bootstrap) {
      Info "Docker is not on PATH; repairing local prerequisites..."
      & powershell -NoProfile -ExecutionPolicy Bypass -File $bootstrap -InstallDir $Root -InstallerMode -SkipChecks
      Refresh-Path
    }
  }
  Need docker
  docker info *> $null
  if ($LASTEXITCODE -eq 0) { return }
  $desktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
  if (Test-Path $desktop) {
    Info "Starting Docker Desktop..."
    Start-Process $desktop | Out-Null
  }
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    docker info *> $null
    if ($LASTEXITCODE -eq 0) { return }
  }
  Die "Docker Desktop is installed but the Docker engine is not ready. Start Docker Desktop and try again."
}
function Ensure-Tooling {
  Refresh-Path
  $missing = @()
  foreach ($name in @('node','npm','docker')) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { $missing += $name }
  }
  $pythonExe = Join-Path $Root 'collector\.venv\Scripts\python.exe'
  if ($missing.Count -gt 0 -or -not (Test-Path $pythonExe)) {
    $bootstrap = Join-Path $Root 'bootstrap-windows.ps1'
    if (-not (Test-Path $bootstrap)) { Die "D-Predict installation is incomplete: bootstrap-windows.ps1 is missing." }
    Info "Required local components are missing; running automatic repair..."
    & powershell -NoProfile -ExecutionPolicy Bypass -File $bootstrap -InstallDir $Root -InstallerMode -SkipChecks
    if ($LASTEXITCODE -ne 0) { Die "Automatic prerequisite repair failed. Run D-Predict Repair & Check." }
    Refresh-Path
  }
  Need node
  Need npm
  Need docker
  if (-not (Test-Path $pythonExe)) { Die "Collector Python environment is missing. Run D-Predict Repair & Check." }
}
function Start-Detached($name, $command) {
  Ensure-RunDir
  Refresh-Path
  $p = Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-NoExit','-Command',$command -WorkingDirectory $Root -PassThru
  Set-Content -Path (Join-Path $Run "$name.pid") -Value $p.Id
  Info "$name started (PID $($p.Id))"
}
function Invoke-Init {
  Ensure-Env
  Ensure-Tooling
  Info "Installing backend dependencies..."
  npm --prefix backend install
  Info "Installing dashboard dependencies..."
  npm --prefix dashboard install --legacy-peer-deps
  $venv = Join-Path $Root "collector\.venv"
  if (-not (Test-Path (Join-Path $venv "Scripts\python.exe"))) { python -m venv $venv }
  & (Join-Path $venv "Scripts\python.exe") -m pip install --upgrade pip
  & (Join-Path $venv "Scripts\python.exe") -m pip install -r (Join-Path $Root "collector\requirements.txt")
  Info "Initialization complete."
}
function Invoke-Doctor {
  Ensure-Env
  Refresh-Path
  foreach ($c in @('node','npm','python','py','docker')) { if (Get-Command $c -ErrorAction SilentlyContinue) { Info "${c}: available" } else { Warn "${c}: missing" } }
  Info ".env: $EnvFile"
  if (Test-Path (Join-Path $Root "backend\node_modules")) { Info "backend dependencies: installed" } else { Warn "backend dependencies: missing" }
  if (Test-Path (Join-Path $Root "dashboard\node_modules")) { Info "dashboard dependencies: installed" } else { Warn "dashboard dependencies: missing" }
  if (Test-Path (Join-Path $Root "collector\.venv\Scripts\python.exe")) { Info "collector Python environment: installed" } else { Warn "collector Python environment: missing" }
  if (Get-Command docker -ErrorAction SilentlyContinue) { Ensure-ComposeFile; docker compose -f $ComposeFile version | Out-Host }
}
function Invoke-Start {
  Ensure-Env
  Ensure-Tooling
  Ensure-DockerReady
  Ensure-ComposeFile
  Ensure-RunDir
  Info "Starting PostgreSQL..."
  Invoke-Compose @('up','-d','postgres')
  Info "Starting API..."
  Start-Detached "api" "npm --prefix backend run dev"
  Info "Starting research service..."
  Start-Detached "research" "npm --prefix backend exec -- tsx src/research-server.ts"
  Info "Starting dashboard..."
  Start-Detached "ui" "npm --prefix dashboard run dev"
  Info "Starting collector..."
  $python = Join-Path $Root "collector\.venv\Scripts\python.exe"
  if (-not (Test-Path $python)) { Die "Collector environment missing. Run D-Predict Repair & Check." }
  Start-Detached "collector" "& '$python' -m collector.main"
  Info "Local dashboard: http://127.0.0.1:3000"
  Info "Local API:       http://127.0.0.1:4100/health"
  Info "Research API:    http://127.0.0.1:4200/health"
}
function Invoke-Stop {
  foreach ($name in @('api','research','ui','collector')) {
    $pidFile = Join-Path $Run "$name.pid"
    if (Test-Path $pidFile) {
      $pidValue = Get-Content $pidFile | Select-Object -First 1
      try { Stop-Process -Id ([int]$pidValue) -Force -ErrorAction Stop; Info "$name stopped" } catch { }
      Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }
  }
  if (Get-Command docker -ErrorAction SilentlyContinue) { Ensure-ComposeFile; docker compose -f $ComposeFile stop postgres | Out-Host }
}
function Invoke-Status {
  Ensure-Env
  if (Get-Command docker -ErrorAction SilentlyContinue) { Ensure-ComposeFile; docker compose -f $ComposeFile ps | Out-Host }
  foreach ($name in @('api','research','ui','collector')) {
    $pidFile = Join-Path $Run "$name.pid"
    if (Test-Path $pidFile) {
      $pidValue = Get-Content $pidFile | Select-Object -First 1
      $running = Get-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue
      Write-Host "$name`: " -NoNewline
      if ($running) { Write-Host "running (PID $pidValue)" -ForegroundColor Green } else { Write-Host "stopped" -ForegroundColor Yellow }
    }
  }
}
function Invoke-Test {
  Ensure-Tooling
  npm --prefix backend test
  npm --prefix dashboard run check
  npm --prefix dashboard run build
}

Ensure-Env
$Command = if ($args.Count) { $args[0].ToLowerInvariant() } else { "help" }
switch ($Command) {
  "init" { Invoke-Init }
  "doctor" { Invoke-Doctor }
  "start" { Invoke-Start }
  "stop" { Invoke-Stop }
  "status" { Invoke-Status }
  "test" { Invoke-Test }
  "api" { Ensure-Tooling; npm --prefix backend run dev }
  "research" { Ensure-Tooling; npm --prefix backend exec -- tsx src/research-server.ts }
  "ui" { Ensure-Tooling; npm --prefix dashboard run dev }
  "collect" { Ensure-Tooling; $python = Join-Path $Root "collector\.venv\Scripts\python.exe"; & $python -m collector.main }
  default {
    Write-Host "D-Predict Windows launcher"
    Write-Host "Usage: .\dp.ps1 <command>"
    Write-Host "  init     Install dependencies and prepare local environment"
    Write-Host "  doctor   Check local prerequisites"
    Write-Host "  start    Start PostgreSQL, API, research, dashboard and collector"
    Write-Host "  stop     Stop local services"
    Write-Host "  status   Show service status"
    Write-Host "  test     Build and test backend/dashboard"
  }
}
